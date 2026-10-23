const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const createApp = require('../app');
const Task = require('../models/task');
const User = require('../models/user');
const { connectDatabase } = require('../config/database');
const { createFixtures } = require('./helpers/fixtures');
const { serve } = require('./helpers/http');

test('Atlas Task write integration', { timeout: 180000 }, async function (t) {
    const fixtures = createFixtures();
    const taskIds = new Set();
    t.after(async function () {
        try {
            if (mongoose.connection.readyState === 1) {
                await fixtures.cleanup();
                t.diagnostic('All task-write-owned User and Task records were removed and absence was verified.');
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
    // Capture server-generated IDs before insertion, including aborted POST attempts.
    const originalSave = Task.prototype.save;
    t.mock.method(Task.prototype, 'save', function (...args) {
        fixtures.trackTask(this._id);
        taskIds.add(this._id.toString());
        return originalSave.apply(this, args);
    });
    const base = await serve(t, createApp());
    const users = [fixtures.user({ name: 'Task owner A' }), fixtures.user({ name: 'Task owner B' }), fixtures.user({ name: 'Unrelated owner' })];
    await User.insertMany(users);
    const userIds = users.map(user => user._id.toString());
    const [ownerA, ownerB] = userIds;
    const required = { name: 'Task write fixture', deadline: '2026-11-03T12:00:00.000Z' };
    const missingId = new mongoose.Types.ObjectId().toString();

    async function snapshot() {
        return {
            users: await User.find({ _id: { $in: userIds } }).sort({ _id: 1 }).lean(),
            tasks: await Task.find({ _id: { $in: [...taskIds] } }).sort({ _id: 1 }).lean()
        };
    }

    async function consistent() {
        const state = await snapshot();
        for (const user of state.users) {
            const pending = state.tasks.filter(task => task.assignedUser === user._id.toString() && !task.completed);
            assert.deepEqual([...user.pendingTasks].sort(), pending.map(task => task._id.toString()).sort());
            assert.equal(new Set(user.pendingTasks).size, user.pendingTasks.length);
        }
        for (const task of state.tasks) {
            const owner = state.users.find(user => user._id.toString() === task.assignedUser);
            assert.equal(task.assignedUserName, owner ? owner.name : 'unassigned');
            assert.ok(owner || task.assignedUser === '');
        }
    }

    async function request(method, id, body, status = method === 'POST' ? 201 : 200) {
        const response = await fetch(base + '/api/tasks' + (id === undefined ? '' : '/' + id), {
            method,
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        });
        const result = await response.json();
        assert.equal(response.status, status, method + ' ' + id + ': ' + JSON.stringify(result));
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.deepEqual(Object.keys(result).sort(), ['data', 'message']);
        assert.equal(typeof result.message, 'string');
        if (status >= 400 || method === 'DELETE') {
            assert.equal(result.data, null);
        } else {
            assert.equal(Object.hasOwn(result.data, '__v'), false);
            assert.deepEqual(result.data, JSON.parse(JSON.stringify(await Task.findById(result.data._id))));
        }
        if (status === 500) assert.equal(result.message, 'Internal server error.');
        if (method === 'DELETE' && status === 200) assert.equal(result.message, 'Task deleted.');
        await consistent();
        return result.data;
    }

    // Sentinels ensure synchronization preserves other tasks on every owner.
    for (const assignedUser of userIds) {
        await request('POST', undefined, { ...required, name: 'Unrelated pending task', assignedUser });
    }

    await t.test('POST defaults, protected fields, creation dates, and assignment names', async function () {
        const before = Date.now();
        const unassigned = await request('POST', undefined, {
            ...required, _id: missingId, dateCreated: '1999-01-01', __v: 80, unknown: 'ignored'
        });
        assert.notEqual(unassigned._id, missingId);
        assert.ok(Date.parse(unassigned.dateCreated) >= before && Date.parse(unassigned.dateCreated) <= Date.now());
        assert.equal(unassigned.description, '');
        assert.equal(unassigned.completed, false);
        assert.equal(unassigned.assignedUser, '');
        assert.equal(unassigned.assignedUserName, 'unassigned');
        assert.equal(Object.hasOwn(unassigned, 'unknown'), false);
        const assigned = await request('POST', undefined, { ...required, assignedUser: ownerA.toUpperCase() });
        assert.equal(assigned.assignedUser, ownerA);
        assert.equal(assigned.assignedUserName, users[0].name);
        const completed = await request('POST', undefined, {
            ...required, assignedUser: ownerB, assignedUserName: users[1].name, completed: true
        });
        assert.equal(completed.assignedUser, ownerB);
        assert.equal(completed.completed, true);
    });

    await t.test('assignment, repeated assignment, transfer, and explicit unassignment', async function () {
        const task = await request('POST', undefined, required);
        const assigned = await request('PUT', task._id.toUpperCase(), { ...required, assignedUser: ownerA });
        assert.equal(assigned.assignedUserName, users[0].name);
        await request('PUT', task._id, { ...required, assignedUser: ownerA, assignedUserName: users[0].name });
        const moved = await request('PUT', task._id, { ...required, assignedUser: ownerB });
        assert.equal(moved.assignedUser, ownerB);
        assert.equal(moved.assignedUserName, users[1].name);
        const cleared = await request('PUT', task._id, { ...required, assignedUser: '' });
        assert.equal(cleared.assignedUser, '');
        assert.equal(cleared.assignedUserName, 'unassigned');
    });

    await t.test('completion, transfer while completed, and reopening', async function () {
        const task = await request('POST', undefined, { ...required, assignedUser: ownerA });
        const done = await request('PUT', task._id, { ...required, assignedUser: ownerA, completed: true });
        assert.equal(done.assignedUser, ownerA);
        assert.equal(done.completed, true);
        await request('PUT', task._id, { ...required, assignedUser: ownerA, completed: true });
        await request('PUT', task._id, { ...required, assignedUser: ownerB, completed: true });
        const reopened = await request('PUT', task._id, { ...required, assignedUser: ownerB, completed: false });
        assert.equal(reopened.completed, false);
        assert.equal(reopened.assignedUser, ownerB);
    });

    await t.test('PUT resets all omitted optional fields and preserves dateCreated', async function () {
        const task = await request('POST', undefined, {
            ...required, description: 'Old description', assignedUser: ownerA, completed: true
        });
        const replaced = await request('PUT', task._id, {
            name: 'Replacement task', deadline: 0, _id: missingId, dateCreated: '1999-01-01', extra: true
        });
        assert.equal(replaced._id, task._id);
        assert.equal(replaced.dateCreated, task.dateCreated);
        assert.equal(replaced.name, 'Replacement task');
        assert.equal(replaced.deadline, new Date(0).toISOString());
        assert.equal(replaced.description, '');
        assert.equal(replaced.completed, false);
        assert.equal(replaced.assignedUser, '');
        assert.equal(replaced.assignedUserName, 'unassigned');
        assert.equal(Object.hasOwn(replaced, 'extra'), false);
        const pending = await request('POST', undefined, { ...required, assignedUser: ownerB });
        await request('PUT', pending._id, required);
        const done = await request('POST', undefined, { ...required, assignedUser: ownerA, completed: true });
        const reopened = await request('PUT', done._id, { ...required, assignedUser: ownerA });
        assert.equal(reopened.completed, false);
    });

    await t.test('POST and PUT reject invalid fields and references without changes', async function () {
        const task = await request('POST', undefined, { ...required, assignedUser: ownerA });
        const invalid = [
            {}, { ...required, name: '' }, { ...required, name: ' ' }, { ...required, name: 12 },
            { name: 'Missing deadline' }, { ...required, deadline: null }, { ...required, deadline: true },
            { ...required, deadline: [] }, { ...required, deadline: '' }, { ...required, deadline: 'invalid' },
            { ...required, description: 1 }, { ...required, description: null },
            { ...required, completed: 'false' }, { ...required, completed: 0 }, { ...required, completed: null },
            { ...required, assignedUser: 1 }, { ...required, assignedUser: null }, { ...required, assignedUser: 'bad' },
            { ...required, assignedUserName: null }, { ...required, assignedUserName: 1 },
            { ...required, assignedUserName: users[0].name },
            { ...required, assignedUser: ownerB, assignedUserName: users[0].name },
            { ...required, assignedUser: ownerB, assignedUserName: '' },
            { ...required, assignedUser: missingId, completed: 'false' }, []
        ];
        for (const method of ['POST', 'PUT']) {
            const before = await snapshot();
            for (const body of invalid) {
                await request(method, method === 'POST' ? undefined : task._id, body, 400);
                assert.deepEqual(await snapshot(), before);
            }
            await request(method, method === 'POST' ? undefined : task._id, { ...required, assignedUser: missingId }, 404);
            assert.deepEqual(await snapshot(), before);
        }
    });

    await t.test('missing task URLs take precedence over invalid writable fields', async function () {
        const before = await snapshot();
        for (const id of ['bad', missingId]) {
            await request('PUT', id, { name: 1, assignedUser: 'bad' }, 404);
            await request('DELETE', id, undefined, 404);
        }
        await request('PUT', undefined, required, 404);
        await request('DELETE', undefined, undefined, 404);
        assert.deepEqual(await snapshot(), before);
    });

    await t.test('DELETE pending, completed, and unassigned tasks and reject repeat deletion', async function () {
        for (const fields of [{ assignedUser: ownerA }, { assignedUser: ownerB, completed: true }, {}]) {
            const task = await request('POST', undefined, { ...required, ...fields });
            await request('DELETE', task._id, undefined);
            assert.equal(await Task.findById(task._id), null);
            const get = await fetch(base + '/api/tasks/' + task._id);
            assert.equal(get.status, 404);
            assert.deepEqual(await get.json(), { message: 'Task not found.', data: null });
            await request('DELETE', task._id, undefined, 404);
        }
    });

    await t.test('POST rolls back an inserted task and a persisted pending-list update', async function (t) {
        const before = await snapshot();
        const original = User.updateOne;
        let insertedId;
        let injected = false;
        t.mock.method(User, 'updateOne', async function (filter, update, options) {
            assert.ok(options.session.inTransaction());
            const result = await original.call(this, filter, update, options);
            assert.equal(result.modifiedCount, 1);
            insertedId = update.$addToSet.pendingTasks;
            assert.ok(await Task.findById(insertedId).session(options.session));
            assert.ok((await User.findById(ownerA).session(options.session)).pendingTasks.includes(insertedId));
            injected = true;
            throw new Error('Intentional POST rollback: private-marker mongodb://sensitive');
        });
        await request('POST', undefined, { ...required, assignedUser: ownerA }, 500);
        assert.ok(insertedId);
        assert.equal(injected, true);
        assert.equal(await Task.findById(insertedId), null);
        assert.deepEqual(await snapshot(), before);
    });

    await t.test('PUT rolls back task transfer and both persisted user updates', async function (t) {
        const task = await request('POST', undefined, { ...required, assignedUser: ownerA });
        const before = await snapshot();
        const original = User.updateOne;
        const operations = [];
        let injected = false;
        t.mock.method(User, 'updateOne', async function (filter, update, options) {
            assert.ok(options.session.inTransaction());
            const result = await original.call(this, filter, update, options);
            assert.equal(result.modifiedCount, 1);
            operations.push(update.$pull ? 'remove' : 'add');
            if (update.$addToSet) {
                assert.equal((await Task.findById(task._id).session(options.session)).assignedUser, ownerB);
                assert.equal((await User.findById(ownerA).session(options.session)).pendingTasks.includes(task._id), false);
                assert.ok((await User.findById(ownerB).session(options.session)).pendingTasks.includes(task._id));
                injected = true;
                throw new Error('Intentional PUT rollback: private-marker mongodb://sensitive');
            }
            return result;
        });
        await request('PUT', task._id, { ...required, assignedUser: ownerB, description: 'Must roll back' }, 500);
        assert.deepEqual(operations, ['remove', 'add']);
        assert.equal(injected, true);
        assert.deepEqual(await snapshot(), before);
    });

    await t.test('DELETE rolls back the task deletion and persisted pending-list removal', async function (t) {
        const task = await request('POST', undefined, { ...required, assignedUser: ownerA });
        const before = await snapshot();
        const original = User.updateOne;
        let removed = false;
        t.mock.method(User, 'updateOne', async function (filter, update, options) {
            assert.ok(options.session.inTransaction());
            const result = await original.call(this, filter, update, options);
            assert.equal(result.modifiedCount, 1);
            assert.equal(await Task.findById(task._id).session(options.session), null);
            assert.equal((await User.findById(ownerA).session(options.session)).pendingTasks.includes(task._id), false);
            removed = true;
            throw new Error('Intentional DELETE rollback: private-marker mongodb://sensitive');
        });
        await request('DELETE', task._id, undefined, 500);
        assert.equal(removed, true);
        assert.deepEqual(await snapshot(), before);
    });

    await t.test('write endpoints still work after scoped failure mocks are restored', async function () {
        const task = await request('POST', undefined, { ...required, assignedUser: ownerA });
        await request('PUT', task._id, { ...required, assignedUser: ownerB });
        await request('DELETE', task._id, undefined);
    });
});
