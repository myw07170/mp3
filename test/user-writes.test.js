const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const createApp = require('../app');
const User = require('../models/user');
const Task = require('../models/task');
const { connectDatabase } = require('../config/database');
const { createFixtures } = require('./helpers/fixtures');
const { serve } = require('./helpers/http');

test('Atlas User write and cross-resource integration', { timeout: 240000 }, async function (t) {
    const fixtures = createFixtures();
    const userIds = new Set();
    const taskIds = new Set();
    t.after(async function () {
        try {
            if (mongoose.connection.readyState === 1) {
                await fixtures.cleanup();
                t.diagnostic('All user-write-owned User and Task records were removed and absence was verified.');
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
    for (const [Model, ids, track] of [[User, userIds, fixtures.trackUser], [Task, taskIds, fixtures.trackTask]]) {
        const save = Model.prototype.save;
        // Track server-generated IDs before insertion, including aborted requests.
        t.mock.method(Model.prototype, 'save', function (...args) {
            ids.add(this._id.toString());
            track(this._id);
            return save.apply(this, args);
        });
    }
    const base = await serve(t, createApp());
    const missingId = new mongoose.Types.ObjectId().toString();
    const taskBody = { name: 'User-write task', deadline: '2026-11-03T12:00:00.000Z', description: 'Keep this description' };
    function userBody(fields = {}) {
        return { name: 'User-write owner', email: randomUUID() + '@example.test', ...fields };
    }
    function plain(document) {
        return JSON.parse(JSON.stringify(document));
    }
    async function snapshot() {
        const [users, tasks] = await Promise.all([
            User.find({ _id: { $in: [...userIds] } }).sort({ _id: 1 }).lean(),
            Task.find({ _id: { $in: [...taskIds] } }).sort({ _id: 1 }).lean()
        ]);
        return { users, tasks };
    }
    async function consistent() {
        const { users, tasks } = await snapshot();
        for (const user of users) {
            const expected = tasks.filter(task => task.assignedUser === user._id.toString() && !task.completed);
            assert.deepEqual([...user.pendingTasks].sort(), expected.map(task => task._id.toString()).sort());
            assert.equal(new Set(user.pendingTasks).size, user.pendingTasks.length);
        }
        for (const task of tasks) {
            const owner = users.find(user => user._id.toString() === task.assignedUser);
            assert.ok(owner || task.assignedUser === '');
            assert.equal(task.assignedUserName, owner ? owner.name : 'unassigned');
        }
    }
    function publicData(value) {
        if (value === null || typeof value !== 'object') return;
        assert.equal(Object.hasOwn(value, '__v'), false);
        for (const child of Object.values(value)) publicData(child);
    }
    async function request(method, path, body, status = method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200, message) {
        const response = await fetch(base + '/api/' + path, {
            method,
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        });
        assert.equal(response.status, status, method + ' ' + path);
        if (status === 204) {
            assert.equal(await response.text(), '');
            await consistent();
            return null;
        }
        const result = await response.json();
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.deepEqual(Object.keys(result).sort(), ['data', 'message']);
        assert.equal(typeof result.message, 'string');
        publicData(result.data);
        if (message !== undefined) assert.equal(result.message, message);
        if (status >= 400) {
            assert.equal(result.data, null);
        } else if (method === 'POST' || method === 'PUT') {
            const resource = path.startsWith('users') ? 'User' : 'Task';
            const Model = resource === 'User' ? User : Task;
            assert.equal(result.message, resource + (method === 'POST' ? ' created.' : ' updated.'));
            assert.deepEqual(result.data, plain(await Model.findById(result.data._id)));
        } else {
            assert.equal(result.message, 'OK');
        }
        if (status === 500) assert.equal(result.message, 'Internal server error.');
        await consistent();
        return result.data;
    }
    function createUser(fields = {}) {
        return request('POST', 'users', userBody(fields));
    }
    function createTask(fields = {}) {
        return request('POST', 'tasks', { ...taskBody, ...fields });
    }
    async function savedTask(id) {
        return plain(await Task.findById(id));
    }
    async function savedUser(id) {
        return plain(await User.findById(id));
    }

    const spectator = await createUser({ name: 'Unrelated user sentinel' });
    const spectatorPending = await createTask({ assignedUser: spectator._id });
    const spectatorCompleted = await createTask({ assignedUser: spectator._id, completed: true });
    const spectatorBefore = {
        user: await savedUser(spectator._id),
        pending: await savedTask(spectatorPending._id),
        completed: await savedTask(spectatorCompleted._id)
    };

    await t.test('POST defaults, timestamps, protected fields, and case-sensitive email', async function () {
        const before = Date.now();
        const email = 'Case-' + randomUUID() + '@example.test';
        const user = await createUser({
            name: '  Preserved user name  ', email, _id: missingId, dateCreated: '1999-01-01', __v: 70, unknown: true
        });
        assert.notEqual(user._id, missingId);
        assert.equal(user.name, '  Preserved user name  ');
        assert.equal(user.email, email);
        assert.deepEqual(user.pendingTasks, []);
        assert.ok(Date.parse(user.dateCreated) >= before && Date.parse(user.dateCreated) <= Date.now());
        assert.equal(Object.hasOwn(user, 'unknown'), false);
        const sameName = await createUser({ name: user.name, email: email.toLowerCase() });
        assert.equal(sameName.name, user.name);
        assert.notEqual(sameName._id, user._id);
    });

    await t.test('POST acquires unassigned tasks and takes over tasks from multiple owners', async function () {
        const a = await createUser({ name: 'POST former owner A' });
        const b = await createUser({ name: 'POST former owner B' });
        const first = await createTask({ assignedUser: a._id });
        const second = await createTask({ assignedUser: b._id });
        const keepA = await createTask({ assignedUser: a._id });
        const keepB = await createTask({ assignedUser: b._id });
        const free = await createTask();
        const requested = [second._id.toUpperCase(), free._id, first._id, second._id];
        const user = await createUser({ name: 'POST new owner', pendingTasks: requested });
        assert.deepEqual(user.pendingTasks, [second._id, free._id, first._id]);
        assert.deepEqual((await savedUser(a._id)).pendingTasks, [keepA._id]);
        assert.deepEqual((await savedUser(b._id)).pendingTasks, [keepB._id]);
        for (const task of [first, second, free]) {
            assert.deepEqual(await savedTask(task._id), { ...task, assignedUser: user._id, assignedUserName: user.name });
        }
    });

    await t.test('PUT replaces pendingTasks, retaining, releasing, and acquiring tasks', async function () {
        const owner = await createUser();
        const b = await createUser();
        const c = await createUser();
        const retained = await createTask({ assignedUser: owner._id });
        const removed = await createTask({ assignedUser: owner._id });
        const done = await createTask({ assignedUser: owner._id, completed: true });
        const fromB = await createTask({ assignedUser: b._id });
        const fromC = await createTask({ assignedUser: c._id });
        const keepB = await createTask({ assignedUser: b._id });
        const keepC = await createTask({ assignedUser: c._id });
        const free = await createTask();
        const body = {
            name: owner.name, email: owner.email, pendingTasks: [fromC._id.toUpperCase(), retained._id, free._id, fromB._id, free._id],
            _id: missingId, dateCreated: '1999-01-01', extra: true
        };
        const replaced = await request('PUT', 'users/' + owner._id.toUpperCase(), body);
        assert.deepEqual(replaced.pendingTasks, [fromC._id, retained._id, free._id, fromB._id]);
        assert.equal(replaced._id, owner._id);
        assert.equal(replaced.dateCreated, owner.dateCreated);
        assert.equal(Object.hasOwn(replaced, 'extra'), false);
        assert.deepEqual(await savedTask(removed._id), { ...removed, assignedUser: '', assignedUserName: 'unassigned' });
        assert.deepEqual(await savedTask(done._id), done);
        assert.deepEqual((await savedUser(b._id)).pendingTasks, [keepB._id]);
        assert.deepEqual((await savedUser(c._id)).pendingTasks, [keepC._id]);
        assert.deepEqual(await request('PUT', 'users/' + owner._id, body), replaced);
    });

    await t.test('rename follows retained, acquired, and completed tasks without renaming released tasks', async function () {
        const user = await createUser({ name: 'Original owner name' });
        const retained = await createTask({ assignedUser: user._id });
        const released = await createTask({ assignedUser: user._id });
        const completed = await createTask({ assignedUser: user._id, completed: true });
        const free = await createTask();
        const name = 'Renamed owner';
        await request('PUT', 'users/' + user._id, { name, email: user.email, pendingTasks: [retained._id, free._id] });
        for (const task of [retained, free, completed]) {
            assert.deepEqual(await savedTask(task._id), { ...task, assignedUser: user._id, assignedUserName: name });
        }
        assert.deepEqual(await savedTask(released._id), { ...released, assignedUser: '', assignedUserName: 'unassigned' });
        const before = await snapshot();
        await request('PUT', 'tasks/' + completed._id, {
            ...taskBody, assignedUser: user._id, assignedUserName: user.name, completed: true
        }, 400, 'assignedUserName must match the assigned user.');
        assert.deepEqual(await snapshot(), before);
        const reopened = await request('PUT', 'tasks/' + completed._id, { ...taskBody, assignedUser: user._id });
        assert.equal(reopened.assignedUserName, name);
        assert.equal(reopened.completed, false);
    });

    await t.test('omitted and explicit empty pendingTasks release pending tasks and retain completed ownership', async function () {
        const user = await createUser();
        const first = await createTask({ assignedUser: user._id });
        const second = await createTask({ assignedUser: user._id });
        const completed = await createTask({ assignedUser: user._id, completed: true });
        const name = 'Owner with empty pending list';
        const cleared = await request('PUT', 'users/' + user._id, { name, email: user.email });
        assert.deepEqual(cleared.pendingTasks, []);
        assert.equal(cleared.dateCreated, user.dateCreated);
        for (const task of [first, second]) assert.equal((await savedTask(task._id)).assignedUser, '');
        assert.deepEqual(await savedTask(completed._id), { ...completed, assignedUserName: name });
        const third = await createTask({ assignedUser: user._id });
        await request('PUT', 'users/' + user._id, { name, email: user.email, pendingTasks: [] });
        assert.equal((await savedTask(third._id)).assignedUser, '');
        assert.equal((await savedTask(completed._id)).assignedUser, user._id);
    });

    await t.test('DELETE preserves and unassigns pending/completed tasks, including a completed-only owner', async function () {
        for (const completionStates of [[false, true], [true], []]) {
            const user = await createUser();
            const tasks = [];
            for (const completed of completionStates) tasks.push(await createTask({ assignedUser: user._id, completed }));
            await request('DELETE', 'users/' + user._id);
            assert.equal(await User.findById(user._id), null);
            for (const task of tasks) {
                assert.deepEqual(await savedTask(task._id), { ...task, assignedUser: '', assignedUserName: 'unassigned' });
            }
            await request('GET', 'users/' + user._id, undefined, 404, 'User not found.');
            await request('DELETE', 'users/' + user._id, undefined, 404, 'User not found.');
            await request('POST', 'tasks', { ...taskBody, assignedUser: user._id }, 404, 'User not found.');
        }
    });

    await t.test('invalid User bodies and malformed references leave both collections unchanged', async function () {
        const user = await createUser();
        await createTask({ assignedUser: user._id });
        const invalid = [
            undefined, null, [], true, 'invalid', {}, { email: user.email }, { name: user.name },
            { ...user, name: '' }, { ...user, name: ' ' }, { ...user, name: 1 }, { ...user, name: null },
            { ...user, email: '' }, { ...user, email: ' ' }, { ...user, email: 1 }, { ...user, email: null },
            { ...user, pendingTasks: null }, { ...user, pendingTasks: {} }, { ...user, pendingTasks: 'bad' },
            { ...user, pendingTasks: ['bad'] }, { ...user, pendingTasks: [1] }, { ...user, pendingTasks: [null] }
        ];
        const before = await snapshot();
        for (const method of ['POST', 'PUT']) {
            for (const body of invalid) {
                await request(method, method === 'POST' ? 'users' : 'users/' + user._id, body, 400);
                assert.deepEqual(await snapshot(), before);
            }
        }
    });

    await t.test('FAQ precedence covers URL resources, formats, duplicates, missing tasks, and completion', async function () {
        const user = await createUser();
        const duplicate = await createUser();
        const pending = await createTask({ assignedUser: user._id });
        const completed = await createTask({ assignedUser: user._id, completed: true });
        const before = await snapshot();
        for (const id of ['bad', missingId]) {
            await request('PUT', 'users/' + id, { name: 1, email: duplicate.email, pendingTasks: ['bad'] }, 404, 'User not found.');
            await request('DELETE', 'users/' + id, undefined, 404, 'User not found.');
        }
        await request('PUT', 'users', userBody(), 404, 'Resource not found.');
        await request('DELETE', 'users', undefined, 404, 'Resource not found.');
        for (const method of ['POST', 'PUT']) {
            const path = method === 'POST' ? 'users' : 'users/' + user._id;
            const fields = method === 'POST' ? userBody() : { name: user.name, email: user.email };
            await request(method, path, { ...fields, email: duplicate.email, pendingTasks: ['bad'] }, 400,
                'pendingTasks must contain a valid resource ID.');
            for (const pendingTasks of [[missingId], [completed._id]]) {
                await request(method, path, { ...fields, email: duplicate.email, pendingTasks }, 400, 'Email is already in use.');
            }
            for (const pendingTasks of [[pending._id, missingId], [completed._id, missingId], [missingId, completed._id]]) {
                await request(method, path, { ...fields, pendingTasks }, 404, 'Task not found.');
            }
            await request(method, path, { ...fields, pendingTasks: [pending._id, completed._id] }, 400,
                'pendingTasks cannot contain completed tasks.');
        }
        assert.deepEqual(await snapshot(), before);
    });

    await t.test('the actual unique index rejects duplicate POST/PUT when the precheck misses a conflict', async function (t) {
        const user = await createUser();
        const duplicate = await createUser();
        const other = await createUser();
        const task = await createTask({ assignedUser: other._id });
        const before = await snapshot();
        const save = User.prototype.save;
        const duplicateKeys = [];
        t.mock.method(User, 'exists', function () {
            return { session: async function (session) {
                assert.ok(session.inTransaction());
                return null;
            } };
        });
        t.mock.method(User.prototype, 'save', async function (...args) {
            try {
                return await save.apply(this, args);
            } catch (error) {
                if (error.code === 11000) duplicateKeys.push(error.keyPattern);
                throw error;
            }
        });
        for (const method of ['POST', 'PUT']) {
            await request(method, method === 'POST' ? 'users' : 'users/' + user._id, {
                name: 'Rejected duplicate', email: duplicate.email, pendingTasks: [task._id]
            }, 400, 'Email is already in use.');
            assert.deepEqual(await snapshot(), before);
        }
        assert.deepEqual(duplicateKeys, [{ email: 1 }, { email: 1 }]);
    });

    await t.test('POST rolls back the inserted user, task acquisitions, and both former owners', async function (t) {
        const a = await createUser();
        const b = await createUser();
        const first = await createTask({ assignedUser: a._id });
        const second = await createTask({ assignedUser: b._id });
        const free = await createTask();
        await createTask({ assignedUser: a._id });
        await createTask({ assignedUser: b._id });
        const before = await snapshot();
        const original = Task.updateMany;
        const fields = userBody({ name: 'Aborted POST owner', pendingTasks: [first._id, second._id, free._id] });
        let insertedId;
        let injected = false;
        t.mock.method(Task, 'updateMany', async function (filter, update, options) {
            assert.ok(options.session.inTransaction());
            const result = await original.call(this, filter, update, options);
            if (filter.assignedUser && !Object.hasOwn(update.$set, 'assignedUser')) {
                insertedId = filter.assignedUser;
                const user = await User.findById(insertedId).session(options.session);
                assert.equal(user.email, fields.email);
                assert.deepEqual(user.pendingTasks.toObject(), fields.pendingTasks);
                for (const task of [first, second, free]) {
                    const stored = await Task.findById(task._id).session(options.session);
                    assert.equal(stored.assignedUser, insertedId);
                    assert.equal(stored.assignedUserName, fields.name);
                }
                for (const [owner, task] of [[a, first], [b, second]]) {
                    assert.equal((await User.findById(owner._id).session(options.session)).pendingTasks.includes(task._id), false);
                }
                injected = true;
                throw new Error('Intentional User POST rollback: private-marker mongodb://sensitive');
            }
            return result;
        });
        await request('POST', 'users', fields, 500);
        assert.equal(injected, true);
        assert.equal(await User.findById(insertedId), null);
        assert.deepEqual(await snapshot(), before);
    });

    await t.test('PUT rolls back replacement, release, takeover, and completed-task rename', async function (t) {
        const user = await createUser({ name: 'Rollback original name' });
        const other = await createUser();
        const retained = await createTask({ assignedUser: user._id });
        const released = await createTask({ assignedUser: user._id });
        const completed = await createTask({ assignedUser: user._id, completed: true });
        const acquired = await createTask({ assignedUser: other._id });
        const free = await createTask();
        const before = await snapshot();
        const original = Task.updateMany;
        const fields = userBody({ name: 'Aborted replacement name', pendingTasks: [retained._id, acquired._id, free._id] });
        let injected = false;
        t.mock.method(Task, 'updateMany', async function (filter, update, options) {
            assert.ok(options.session.inTransaction());
            const result = await original.call(this, filter, update, options);
            if (filter.assignedUser === user._id && !Object.hasOwn(update.$set, 'assignedUser')) {
                assert.equal(result.modifiedCount, 1);
                const storedUser = await User.findById(user._id).session(options.session);
                assert.equal(storedUser.name, fields.name);
                assert.equal(storedUser.email, fields.email);
                assert.deepEqual(storedUser.pendingTasks.toObject(), fields.pendingTasks);
                assert.equal((await Task.findById(released._id).session(options.session)).assignedUser, '');
                assert.equal((await Task.findById(completed._id).session(options.session)).assignedUserName, fields.name);
                assert.equal((await User.findById(other._id).session(options.session)).pendingTasks.includes(acquired._id), false);
                for (const task of [retained, acquired, free]) {
                    assert.equal((await Task.findById(task._id).session(options.session)).assignedUser, user._id);
                }
                injected = true;
                throw new Error('Intentional User PUT rollback: private-marker mongodb://sensitive');
            }
            return result;
        });
        await request('PUT', 'users/' + user._id, fields, 500);
        assert.equal(injected, true);
        assert.deepEqual(await snapshot(), before);
    });

    await t.test('DELETE rolls back user removal and unassignment of pending/completed tasks', async function (t) {
        const user = await createUser();
        const pending = await createTask({ assignedUser: user._id });
        const completed = await createTask({ assignedUser: user._id, completed: true });
        const before = await snapshot();
        const original = Task.updateMany;
        let injected = false;
        t.mock.method(Task, 'updateMany', async function (filter, update, options) {
            assert.ok(options.session.inTransaction());
            const result = await original.call(this, filter, update, options);
            assert.equal(result.modifiedCount, 2);
            assert.equal(await User.findById(user._id).session(options.session), null);
            for (const task of [pending, completed]) {
                const stored = await Task.findById(task._id).session(options.session);
                assert.equal(stored.assignedUser, '');
                assert.equal(stored.assignedUserName, 'unassigned');
            }
            injected = true;
            throw new Error('Intentional User DELETE rollback: private-marker mongodb://sensitive');
        });
        await request('DELETE', 'users/' + user._id, undefined, 500);
        assert.equal(injected, true);
        assert.deepEqual(await snapshot(), before);
    });

    await t.test('all 10 operations work together after failure mocks are restored', async function () {
        const a = await createUser({ name: 'Sequence owner A' });
        const pending = await createTask({ assignedUser: a._id });
        const completed = await createTask({ assignedUser: a._id, completed: true });
        const userQuery = new URLSearchParams({ where: JSON.stringify({ _id: a._id }) });
        const taskScope = { _id: { $in: [pending._id, completed._id] } };
        const taskQuery = new URLSearchParams({ where: JSON.stringify(taskScope), sort: '{"completed":1}' });
        assert.equal((await request('GET', 'users?' + userQuery))[0]._id, a._id);
        assert.deepEqual((await request('GET', 'tasks?' + taskQuery)).map(task => task._id), [pending._id, completed._id]);
        assert.deepEqual(await request('GET', 'users/' + a._id + '?select=' + encodeURIComponent('{"name":1}')),
            { _id: a._id, name: a.name });
        assert.deepEqual(await request('GET', 'tasks/' + completed._id), completed);
        const b = await createUser({ name: 'Sequence owner B', pendingTasks: [pending._id] });
        await request('PUT', 'users/' + a._id, { name: 'Sequence renamed A', email: a.email });
        await request('PUT', 'users/' + b._id, { name: 'Sequence renamed B', email: b.email, pendingTasks: [pending._id] });
        await request('PUT', 'tasks/' + pending._id, { ...taskBody, assignedUser: b._id, completed: true });
        await request('PUT', 'tasks/' + pending._id, { ...taskBody, assignedUser: b._id, completed: false });
        await request('PUT', 'tasks/' + completed._id, { ...taskBody, assignedUser: a._id, completed: false });
        await request('PUT', 'users/' + b._id, { name: 'Sequence renamed B', email: b.email, pendingTasks: [completed._id] });
        assert.equal((await savedTask(pending._id)).assignedUser, '');
        assert.deepEqual((await savedUser(a._id)).pendingTasks, []);
        await request('DELETE', 'tasks/' + pending._id);
        await request('DELETE', 'users/' + b._id);
        assert.equal((await savedTask(completed._id)).assignedUser, '');
        await request('GET', 'users/' + b._id, undefined, 404, 'User not found.');
        await request('GET', 'tasks/' + pending._id, undefined, 404, 'Task not found.');
        const countQuery = new URLSearchParams({ where: JSON.stringify(taskScope), count: 'true' });
        assert.equal(await request('GET', 'tasks?' + countQuery), 1);
        await request('DELETE', 'users/' + a._id);
        await request('DELETE', 'tasks/' + completed._id);
        assert.deepEqual(await request('GET', 'users?' + userQuery), []);
        assert.deepEqual(await request('GET', 'tasks?' + taskQuery), []);
        assert.equal(await request('GET', 'tasks?' + countQuery), 0);
        assert.deepEqual({
            user: await savedUser(spectator._id),
            pending: await savedTask(spectatorPending._id),
            completed: await savedTask(spectatorCompleted._id)
        }, spectatorBefore);
    });
});
