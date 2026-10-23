const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const createApp = require('../app');
const User = require('../models/user');
const Task = require('../models/task');
const { connectDatabase } = require('../config/database');
const { createFixtures } = require('./helpers/fixtures');
const { serve } = require('./helpers/http');

test('Atlas GET integration', { timeout: 120000 }, async function (t) {
    const fixtures = createFixtures();
    t.after(async function () {
        try {
            if (mongoose.connection.readyState === 1) {
                await fixtures.cleanup();
                t.diagnostic('All read-test-owned records were removed and absence was verified.');
            }
        } finally {
            await mongoose.disconnect();
        }
    });
    try {
        await connectDatabase();
    } catch {
        throw new Error('Atlas setup failed. Check network access, MONGODB_URI, and existing index compatibility.');
    }
    const base = await serve(t, createApp());
    const users = [];
    const tasks = [];
    for (let i = 0; i < 105; i++) {
        const name = 'Read fixture ' + String(i).padStart(3, '0');
        users.push(fixtures.user({ name }));
        tasks.push(fixtures.task({
            name, completed: i % 2 === 0, description: i % 3 === 0 ? 'Group A' : 'Group B',
            deadline: Date.UTC(2026, 10, 3) + i * 60000
        }));
    }
    await User.insertMany(users);
    await Task.insertMany(tasks);

    const resources = [
        { path: 'users', documents: users, Model: User },
        { path: 'tasks', documents: tasks, Model: Task }
    ];

    async function request(path, query = {}, status = 200) {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            params.set(key, JSON.stringify(value));
        }
        return requestRaw(path, params, status);
    }

    async function requestRaw(path, params, status = 200) {
        const response = await fetch(base + '/api/' + path + '?' + params);
        assert.equal(response.status, status, path + '?' + params);
        const body = await response.json();
        assert.deepEqual(Object.keys(body).sort(), ['data', 'message']);
        assert.equal(typeof body.message, 'string');
        if (status === 200) {
            assert.equal(body.message, 'OK');
        } else {
            assert.equal(body.data, null);
            if (status === 404) {
                assert.equal(body.message, (path.startsWith('users') ? 'User' : 'Task') + ' not found.');
            } else {
                assert.match(body.message, /^Invalid query(?: filter| parameter: (?:where|sort|select|skip|limit|count))?\.$/);
            }
        }
        return body.data;
    }

    function expected(documents) {
        return documents.map(document => JSON.parse(JSON.stringify(document)));
    }

    function ids(documents) {
        return documents.map(document => document._id.toString());
    }

    for (const { path, documents, Model } of resources) {
        const scope = { _id: { $in: ids(documents) } };

        await t.test(path + ': all 32 optional-parameter combinations on scoped fixtures', async function () {
            const matches = documents.slice(2);
            const values = { sort: { name: -1 }, select: { name: 1, _id: 0 }, skip: 2, limit: 3, count: true };
            const names = Object.keys(values);
            for (let mask = 0; mask < 32; mask++) {
                const query = { where: { ...scope, name: { $gte: documents[2].name } } };
                names.forEach((name, bit) => { if (mask & (1 << bit)) query[name] = values[name]; });
                const result = await request(path, query);
                if (query.count) {
                    assert.equal(result, matches.length);
                    continue;
                }
                const start = query.skip || 0;
                const maximum = query.limit || (path === 'tasks' ? 100 : matches.length);
                assert.equal(result.length, Math.min(maximum, matches.length - start));
                assert.equal(new Set(result.map(row => row.name)).size, result.length);
                assert.ok(result.every(row => matches.some(document => document.name === row.name)));
                if (query.select) for (const row of result) assert.deepEqual(Object.keys(row), ['name']);
                if (query.sort) {
                    const page = [...matches].reverse().slice(start, start + maximum);
                    assert.deepEqual(result, query.select ? page.map(document => ({ name: document.name })) : expected(page));
                }
            }
            t.diagnostic(path + ': verified 32 scoped query combinations, including count before pagination.');
        });

        await t.test(path + ': default limits, explicit limits, and pagination', async function () {
            const defaultData = await request(path, { where: scope, sort: { name: 1 } });
            assert.deepEqual(defaultData, expected(path === 'tasks' ? documents.slice(0, 100) : documents));
            assert.deepEqual(await request(path, { where: scope, sort: { name: 1 }, limit: 0 }), expected(documents));
            assert.deepEqual(await request(path, { where: scope, sort: { name: 1 }, limit: 103 }), expected(documents.slice(0, 103)));
            assert.deepEqual(await request(path, { where: scope, sort: { name: 1 }, skip: 2, limit: 3 }), expected(documents.slice(2, 5)));
            assert.deepEqual(await request(path, { where: scope, sort: { name: 1 }, skip: 104, limit: 5 }), expected(documents.slice(104)));
            assert.deepEqual(await request(path, { where: scope, skip: 105 }), []);
            assert.deepEqual(await request(path, { where: scope, skip: 200 }), []);
            for (const limit of [99, 100, 101]) {
                assert.deepEqual(await request(path, { where: scope, sort: { name: 1 }, limit }), expected(documents.slice(0, limit)));
            }
            for (const skip of [99, 100, 101, 106]) {
                assert.deepEqual(await request(path, { where: scope, sort: { name: 1 }, skip, limit: 1 }), expected(documents.slice(skip, skip + 1)));
            }
            assert.deepEqual(await request(path, { where: scope, skip: Number.MAX_SAFE_INTEGER, limit: Number.MAX_SAFE_INTEGER }), []);
            assert.deepEqual(await request(path, { where: scope, sort: { name: 1 }, limit: Number.MAX_SAFE_INTEGER }), expected(documents));
        });

        await t.test(path + ': filters and ascending/descending sorts', async function () {
            const subset = [documents[1], documents[4], documents[8]];
            assert.deepEqual(await request(path, { where: { _id: { $in: ids(subset) } }, sort: { name: -1 } }), expected([...subset].reverse()));
            assert.deepEqual(await request(path, { where: { ...scope, name: documents[4].name } }), expected([documents[4]]));
            assert.deepEqual(await request(path, {
                where: { ...scope, name: { $gte: documents[2].name, $lt: documents[5].name } }, sort: { name: 1 }
            }), expected(documents.slice(2, 5)));
            const compound = path === 'tasks' ? { completed: 1, name: -1 } : { name: -1, _id: 1 };
            const sorted = path === 'tasks'
                ? [...documents].sort((a, b) => Number(a.completed) - Number(b.completed) || b.name.localeCompare(a.name))
                : [...documents].reverse();
            assert.deepEqual(await request(path, { where: scope, sort: compound, limit: 0 }), expected(sorted));
        });

        await t.test(path + ': projection and all six parameters together', async function () {
            const selected = await request(path, {
                where: { ...scope, name: { $gte: documents[1].name } }, sort: { name: -1 },
                select: { name: 1, _id: 0 }, skip: 2, limit: 3, count: false
            });
            assert.deepEqual(selected, [102, 101, 100].map(i => ({ name: documents[i].name })));
            const excluded = await request(path, { where: { _id: documents[0]._id }, select: { name: 0, _id: 0 } });
            const full = expected([documents[0]])[0];
            delete full.name;
            delete full._id;
            assert.deepEqual(excluded, [full]);
            assert.deepEqual(await request(path, { where: { _id: documents[0]._id }, select: { _id: 1 } }), [{ _id: documents[0]._id.toString() }]);
            assert.deepEqual(await request(path, { where: { _id: documents[0]._id }, select: { __v: 1, _id: 0 } }), [{}]);
        });

        await t.test(path + ': count precedes pagination and empty matches return 200', async function () {
            assert.equal(await request(path, { where: scope, count: true }), 105);
            assert.equal(await request(path, {
                where: scope, sort: { name: -1 }, select: { name: 1, _id: 0 }, skip: 200, limit: 1, count: true
            }), 105);
            assert.equal(await request(path, { where: { ...scope, name: documents[0].name }, count: true }), 1);
            const empty = { ...scope, name: 'No fixture has this name' };
            assert.deepEqual(await request(path, { where: empty }), []);
            assert.equal(await request(path, { where: empty, count: true }), 0);
            const missing = new mongoose.Types.ObjectId().toString();
            assert.deepEqual(await request(path, { where: { _id: missing } }), []);
            assert.equal(await request(path, { where: { _id: missing }, count: true }), 0);
        });

        await t.test(path + ': detail projections and ignored query parameters', async function () {
            const detail = path + '/' + documents[0]._id;
            assert.deepEqual(await request(detail), expected([documents[0]])[0]);
            assert.deepEqual(await request(detail, { select: { name: 1, _id: 0 } }), { name: documents[0].name });
            const full = expected([documents[0]])[0];
            delete full._id;
            assert.deepEqual(await request(detail, { select: { _id: 0 } }), full);
            assert.deepEqual(await request(detail, { select: { __v: 1, _id: 0 } }), {});
            const ignored = new URLSearchParams({ where: '{', sort: '{', skip: 'bad', limit: '-1', count: 'bad', unknown: 'bad' });
            ignored.append('where', 'also bad');
            assert.deepEqual(await requestRaw(detail, ignored), expected([documents[0]])[0]);
            const unknown = new URLSearchParams({ where: JSON.stringify({ _id: documents[0]._id }), unknown: 'bad' });
            unknown.append('unknown', 'also bad');
            assert.deepEqual(await requestRaw(path, unknown), expected([documents[0]]));
        });

        await t.test(path + ': missing IDs take priority over invalid select', async function () {
            const existing = path + '/' + documents[0]._id;
            const missing = path + '/' + new mongoose.Types.ObjectId();
            await request(missing, {}, 404);
            await request(path + '/not-an-id', {}, 404);
            for (const select of ['{', 'null', '[]', '{"name":1,"dateCreated":0}']) {
                await requestRaw(existing, new URLSearchParams({ select }), 400);
                await requestRaw(missing, new URLSearchParams({ select }), 404);
                await requestRaw(path + '/not-an-id', new URLSearchParams({ select }), 404);
            }
            await requestRaw(existing, new URLSearchParams([['select', '{}'], ['select', '{}']]), 400);
            await requestRaw(missing, new URLSearchParams([['select', '{}'], ['select', '{}']]), 404);
        });

        await t.test(path + ': invalid filters and projections return safe 400 errors', async function () {
            for (const where of [{ _id: 'malformed' }, { name: { $unsupported: 1 } }, { $unsupported: 1 }, { name: { $regex: '[' } }]) {
                await request(path, { where }, 400);
                await request(path, { where, count: true }, 400);
            }
            for (const [name, value] of [['where', '{'], ['sort', '{'], ['select', '{'], ['skip', 'bad'], ['limit', 'bad']]) {
                await requestRaw(path, new URLSearchParams({ count: 'true', [name]: value }), 400);
            }
            await request(path, { where: scope, select: { name: 1, 'name.first': 1 } }, 400);
            await request(path, { where: scope, select: { $invalid: 1 } }, 400);
            assert.equal(await Model.countDocuments(scope), 105);
        });
    }

    await t.test('tasks: boolean/date filters combine with sort, select, and pagination', async function () {
        const where = {
            _id: { $in: ids(tasks) }, completed: false,
            deadline: { $gte: tasks[3].deadline.toISOString(), $lte: tasks[9].deadline.toISOString() }
        };
        assert.deepEqual(await request('tasks', {
            where, sort: { deadline: -1 }, select: { name: 1, deadline: 1, _id: 0 }, skip: 1, limit: 2
        }), [7, 5].map(i => ({ name: tasks[i].name, deadline: tasks[i].deadline.toISOString() })));
        assert.equal(await request('tasks', { where, count: true, skip: 50, limit: 1 }), 4);
    });
});
