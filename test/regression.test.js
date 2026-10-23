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
const { snapshot, assertIntegrity, auditDatabase, auditSummary } = require('./helpers/integrity');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function bounded(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Regression barrier timed out.')), 15000);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

test('Atlas HTTP regression', { timeout: 240000 }, async function (t) {
    const fixtures = createFixtures();
    let activeScope;
    let baseline;
    t.after(async function () {
        try {
            if (mongoose.connection.readyState === 1) {
                await fixtures.cleanup();
                t.diagnostic('All regression-owned User and Task records were removed and absence was verified.');
                const after = await auditDatabase();
                t.diagnostic('Database audit after cleanup: ' + JSON.stringify(auditSummary(after)));
                assert.deepEqual(after, baseline, 'The database audit must return to its pre-fixture state.');
            }
        } finally {
            await mongoose.disconnect();
        }
    });
    try {
        await connectDatabase();
    } catch {
        throw new Error('Atlas setup failed. Check network access and MONGODB_URI.');
    }
    baseline = await auditDatabase();
    t.diagnostic('Database audit before fixtures: ' + JSON.stringify(auditSummary(baseline)));
    for (const [Model, key, track] of [[User, 'userIds', fixtures.trackUser], [Task, 'taskIds', fixtures.trackTask]]) {
        const save = Model.prototype.save;
        t.mock.method(Model.prototype, 'save', function (...args) {
            track(this._id);
            if (activeScope) activeScope[key].add(this._id.toString());
            return save.apply(this, args);
        });
    }
    const base = await serve(t, createApp());
    const missingId = new mongoose.Types.ObjectId().toString();
    const taskBody = { name: 'Regression task', deadline: '2026-11-03T12:00:00.000Z' };
    function userBody(extra = {}) {
        return { name: 'Regression owner', email: randomUUID() + '@example.test', ...extra };
    }
    async function http(method, path, body, expected, raw = false) {
        const response = await fetch(base + '/api/' + path, {
            method, signal: AbortSignal.timeout(30000),
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: raw ? body : JSON.stringify(body) })
        });
        if (expected !== undefined) assert.equal(response.status, expected, method + ' ' + path);
        if (response.status === 204) {
            assert.equal(await response.text(), '');
            return { status: response.status };
        }
        const result = await response.json();
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.deepEqual(Object.keys(result).sort(), ['data', 'message']);
        assert.equal(typeof result.message, 'string');
        assert.equal(JSON.stringify(result.data).includes('"__v":'), false);
        if (response.status >= 400) assert.equal(result.data, null);
        if (response.status === 500) assert.equal(result.message, 'Internal server error.');
        return { status: response.status, ...result };
    }
    async function createUser(extra = {}) {
        return (await http('POST', 'users', userBody(extra), 201)).data;
    }
    async function createTask(extra = {}) {
        return (await http('POST', 'tasks', { ...taskBody, ...extra }, 201)).data;
    }
    async function scenario(name, work) {
        await t.test(name, async function (sub) {
            const scope = { userIds: new Set(), taskIds: new Set() };
            activeScope = scope;
            try {
                await work(sub, scope);
                await assertIntegrity(scope);
            } finally {
                activeScope = undefined;
            }
        });
    }

    for (const [path, Model] of [['users', User], ['tasks', Task]]) {
        await scenario(path + ': URL lookup precedes malformed PUT JSON', async function (sub, scope) {
            const document = path === 'users' ? await createUser() : await createTask();
            const before = await snapshot(scope);
            for (const suffix of ['/bad', '/' + missingId, '']) {
                await http('PUT', path + suffix, '{"name":', 404, true);
            }
            await http('PUT', path + '/' + document._id, '{"name":', 400, true);
            await http('POST', path, '{"name":', 400, true);
            assert.deepEqual(await snapshot(scope), before);
            assert.ok(await Model.findById(document._id));
        });

        await scenario(path + ': missing detail precedes server-rejected projection', async function () {
            const document = path === 'users' ? await createUser() : await createTask();
            for (const select of [{ name: 1, 'name.first': 1 }, { $invalid: 1 }]) {
                const params = new URLSearchParams({ select: JSON.stringify(select) });
                await http('GET', path + '/' + document._id + '?' + params, undefined, 400);
                await http('GET', path + '/' + missingId + '?' + params, undefined, 404);
            }
        });
    }

    await scenario('deadline boundaries reject invalid values before missing assignees', async function (sub, scope) {
        const valid = [];
        for (const deadline of [0, -8640000000000000, 8640000000000000]) {
            const task = await createTask({ deadline });
            assert.equal(task.deadline, new Date(deadline).toISOString());
            valid.push(task);
        }
        const before = await snapshot(scope);
        for (const method of ['POST', 'PUT']) {
            for (const deadline of [8640000000000001, -8640000000000001, Number.MAX_SAFE_INTEGER, '', 'invalid', null, {}, true]) {
                const result = await http(method, method === 'POST' ? 'tasks' : 'tasks/' + valid[0]._id,
                    { ...taskBody, deadline, assignedUser: missingId }, 400);
                assert.equal(result.message, 'deadline must be a valid date string or millisecond timestamp.');
                assert.deepEqual(await snapshot(scope), before);
            }
        }
    });

    await scenario('successful email replacement releases the old email without changing task fields', async function (sub, scope) {
        const user = await createUser();
        const pending = await createTask({ assignedUser: user._id });
        const completed = await createTask({ assignedUser: user._id, completed: true });
        const email = randomUUID() + '@example.test';
        const result = await http('PUT', 'users/' + user._id, { name: user.name, email, pendingTasks: [pending._id] }, 200);
        assert.equal(result.data.email, email);
        assert.equal(result.data.dateCreated, user.dateCreated);
        await createUser({ email: user.email });
        const before = await snapshot(scope);
        const duplicate = await http('PUT', 'users/' + user._id, { name: user.name, email: user.email }, 400);
        assert.equal(duplicate.message, 'Email is already in use.');
        assert.deepEqual(await snapshot(scope), before);
        assert.deepEqual(JSON.parse(JSON.stringify(await Task.findById(pending._id))), pending);
        assert.deepEqual(JSON.parse(JSON.stringify(await Task.findById(completed._id))), completed);
    });

    await scenario('combined field and reference errors preserve precedence and stored versions', async function (sub, scope) {
        const user = await createUser();
        const duplicate = await createUser();
        const task = await createTask({ assignedUser: user._id });
        const before = await snapshot(scope);
        const cases = [
            ['POST', 'tasks', { ...taskBody, deadline: true, assignedUser: missingId }, 400, 'deadline must be a valid date string or millisecond timestamp.'],
            ['PUT', 'tasks/' + task._id, { ...taskBody, name: false, assignedUser: missingId }, 400, 'name must be a nonempty string.'],
            ['POST', 'tasks', { ...taskBody, assignedUser: missingId, assignedUserName: 'Unknown name' }, 404, 'User not found.'],
            ['PUT', 'tasks/' + task._id, { ...taskBody, assignedUser: user._id, assignedUserName: 'Wrong name' }, 400, 'assignedUserName must match the assigned user.'],
            ['POST', 'users', { name: 12, email: duplicate.email, pendingTasks: [missingId] }, 400, 'name must be a nonempty string.'],
            ['PUT', 'users/' + user._id, { name: user.name, email: duplicate.email, pendingTasks: ['bad'] }, 400, 'pendingTasks must contain a valid resource ID.']
        ];
        for (const [method, path, body, status, message] of cases) {
            assert.equal((await http(method, path, body, status)).message, message);
            assert.deepEqual(await snapshot(scope), before);
        }
    });

    await scenario('Task POST retries one transient failure without duplicate records or pending entries', async function (sub, scope) {
        const user = await createUser();
        const before = await snapshot(scope);
        const original = User.updateOne;
        const attempts = [];
        let injected = false;
        sub.mock.method(User, 'updateOne', async function (filter, update, options) {
            const result = await original.call(this, filter, update, options);
            if (update.$addToSet) {
                const id = update.$addToSet.pendingTasks;
                attempts.push(id);
                if (!injected) {
                    assert.ok(options.session.inTransaction());
                    assert.ok(await Task.findById(id).session(options.session));
                    assert.ok((await User.findById(user._id).session(options.session)).pendingTasks.includes(id));
                    injected = true;
                    const failure = new mongoose.mongo.MongoServerError({ errmsg: 'Intentional transient test failure.' });
                    failure.addErrorLabel('TransientTransactionError');
                    throw failure;
                }
            }
            return result;
        });
        const task = await createTask({ assignedUser: user._id });
        assert.equal(injected, true);
        assert.equal(attempts.length, 2);
        assert.notEqual(attempts[0], task._id);
        assert.equal(await Task.findById(attempts[0]), null);
        const after = await assertIntegrity(scope);
        assert.equal(after.tasks.length, 1);
        assert.deepEqual(after.users[0].pendingTasks, [task._id]);
        assert.equal(after.users[0].__v, before.users[0].__v + 1);
    });

    await scenario('User PUT retries a transient failure after release, takeover, and completed rename', async function (sub) {
        const user = await createUser({ name: 'Before retry' });
        const other = await createUser();
        const released = await createTask({ assignedUser: user._id });
        const completed = await createTask({ assignedUser: user._id, completed: true });
        const acquired = await createTask({ assignedUser: other._id });
        const original = Task.updateMany;
        let attempts = 0;
        let injected = false;
        sub.mock.method(Task, 'updateMany', async function (filter, update, options) {
            const result = await original.call(this, filter, update, options);
            if (filter.assignedUser === user._id && !Object.hasOwn(update.$set, 'assignedUser')) {
                attempts++;
                if (!injected) {
                    assert.equal((await Task.findById(released._id).session(options.session)).assignedUser, '');
                    assert.equal((await Task.findById(acquired._id).session(options.session)).assignedUser, user._id);
                    assert.equal((await Task.findById(completed._id).session(options.session)).assignedUserName, 'After retry');
                    assert.deepEqual((await User.findById(other._id).session(options.session)).pendingTasks.toObject(), []);
                    injected = true;
                    const failure = new mongoose.mongo.MongoServerError({ errmsg: 'Intentional transient test failure.' });
                    failure.addErrorLabel('TransientTransactionError');
                    throw failure;
                }
            }
            return result;
        });
        const replaced = await http('PUT', 'users/' + user._id,
            { name: 'After retry', email: user.email, pendingTasks: [acquired._id] }, 200);
        assert.equal(injected, true);
        assert.equal(attempts, 2);
        assert.equal(replaced.data.dateCreated, user.dateCreated);
        assert.deepEqual(replaced.data.pendingTasks, [acquired._id]);
        assert.equal((await Task.findById(released._id)).assignedUser, '');
        assert.equal((await Task.findById(completed._id)).assignedUserName, 'After retry');
    });

    await scenario('concurrent duplicate emails allow exactly one creation and takeover', async function () {
        const previous = await createUser();
        const task = await createTask({ assignedUser: previous._id });
        const body = userBody({ pendingTasks: [task._id] });
        const results = await Promise.all([http('POST', 'users', body), http('POST', 'users', body)]);
        assert.deepEqual(results.map(result => result.status).sort(), [201, 400]);
        const winner = results.find(result => result.status === 201).data;
        assert.equal(results.find(result => result.status === 400).message, 'Email is already in use.');
        assert.equal(await User.countDocuments({ email: body.email }), 1);
        assert.equal((await Task.findById(task._id)).assignedUser, winner._id);
        assert.deepEqual((await User.findById(previous._id)).pendingTasks.toObject(), []);
    });

    await scenario('extended cross-resource lifecycle preserves every committed reference', async function (sub, scope) {
        async function step(...args) {
            const result = await http(...args);
            await assertIntegrity(scope);
            return result.data;
        }
        const sentinel = await createUser({ name: 'Unrelated regression sentinel' });
        const sentinelPending = await createTask({ assignedUser: sentinel._id });
        const sentinelDone = await createTask({ assignedUser: sentinel._id, completed: true });
        const sentinelScope = { userIds: new Set([sentinel._id]), taskIds: new Set([sentinelPending._id, sentinelDone._id]) };
        const sentinelBefore = await snapshot(sentinelScope);
        const a = await step('POST', 'users', userBody({ name: 'Lifecycle A' }), 201);
        const b = await step('POST', 'users', userBody({ name: 'Lifecycle B' }), 201);
        const pending = await step('POST', 'tasks', { ...taskBody, assignedUser: a._id }, 201);
        const done = await step('POST', 'tasks', { ...taskBody, assignedUser: a._id, completed: true }, 201);
        const free = await step('POST', 'tasks', taskBody, 201);
        const usersQuery = new URLSearchParams({ where: JSON.stringify({ _id: { $in: [a._id, b._id] } }), select: '{"name":1}' });
        assert.equal((await step('GET', 'users?' + usersQuery, undefined, 200)).length, 2);
        assert.deepEqual(await step('GET', 'users/' + a._id + '?select=' + encodeURIComponent('{"name":1,"_id":0}'), undefined, 200), { name: a.name });
        assert.deepEqual(await step('GET', 'tasks/' + done._id + '?select=' + encodeURIComponent('{"__v":1,"_id":0}'), undefined, 200), {});
        await step('PUT', 'users/' + a._id, { name: 'Lifecycle renamed A', email: a.email, pendingTasks: [pending._id] }, 200);
        await step('PUT', 'tasks/' + done._id, { ...taskBody, assignedUser: b._id, completed: true }, 200);
        const c = await step('POST', 'users', userBody({ name: 'Lifecycle C', pendingTasks: [pending._id, free._id] }), 201);
        await step('PUT', 'users/' + c._id, { name: 'Lifecycle renamed C', email: c.email, pendingTasks: [pending._id] }, 200);
        await step('PUT', 'tasks/' + done._id, { ...taskBody, assignedUser: b._id, completed: false }, 200);
        await step('PUT', 'users/' + c._id, { name: 'Lifecycle renamed C', email: c.email, pendingTasks: [pending._id, done._id] }, 200);
        await step('PUT', 'tasks/' + pending._id, { ...taskBody, assignedUser: c._id, completed: true }, 200);
        await step('PUT', 'users/' + c._id, { name: 'Lifecycle final C', email: c.email }, 200);
        assert.equal((await Task.findById(done._id)).assignedUser, '');
        const reopened = await step('PUT', 'tasks/' + pending._id, { ...taskBody, assignedUser: c._id }, 200);
        assert.equal(reopened.assignedUserName, 'Lifecycle final C');
        await step('DELETE', 'users/' + c._id, undefined, 204);
        const before = await snapshot(scope);
        await step('PUT', 'tasks/' + pending._id, { ...taskBody, assignedUser: c._id }, 404);
        assert.deepEqual(await snapshot(scope), before);
        await step('DELETE', 'tasks/' + pending._id, undefined, 204);
        await step('GET', 'users/' + c._id, undefined, 404);
        await step('GET', 'tasks/' + pending._id, undefined, 404);
        const taskQuery = new URLSearchParams({ where: JSON.stringify({ _id: { $in: [pending._id, done._id, free._id] } }), count: 'true' });
        assert.equal(await step('GET', 'tasks?' + taskQuery, undefined, 200), 2);
        for (const id of [done._id, free._id]) await step('DELETE', 'tasks/' + id, undefined, 204);
        for (const id of [a._id, b._id]) await step('DELETE', 'users/' + id, undefined, 204);
        taskQuery.set('count', 'false');
        assert.deepEqual(await step('GET', 'tasks?' + taskQuery, undefined, 200), []);
        assert.deepEqual(await snapshot(sentinelScope), sentinelBefore);
    });

    for (const operation of ['rename', 'delete']) {
        for (const pausedRequest of ['task', 'user']) {
            await scenario('overlap: ' + operation + ', pause ' + pausedRequest + ' after reading the user', async function (sub, scope) {
                const user = await createUser({ name: 'Overlap original name' });
                const read = deferred();
                const release = deferred();
                const exec = mongoose.Query.prototype.exec;
                let paused = false;
                let reads = 0;
                sub.mock.method(mongoose.Query.prototype, 'exec', async function (...args) {
                    const result = await exec.apply(this, args);
                    if (this.model === User && this.op === 'findOne' && this.getOptions().session &&
                        String(this.getFilter()._id) === user._id) {
                        reads++;
                        if (!paused) {
                            paused = true;
                            read.resolve();
                            await bounded(release.promise);
                        }
                    }
                    return result;
                });
                const requests = [];
                const taskRequest = () => http('POST', 'tasks', { ...taskBody, assignedUser: user._id, completed: true });
                const userRequest = () => operation === 'rename'
                    ? http('PUT', 'users/' + user._id, { name: 'Overlap renamed owner', email: user.email })
                    : http('DELETE', 'users/' + user._id);
                let taskResult;
                let userResult;
                try {
                    const first = (pausedRequest === 'task' ? taskRequest : userRequest)();
                    requests.push(first);
                    await bounded(read.promise);
                    const second = (pausedRequest === 'task' ? userRequest : taskRequest)();
                    requests.push(second);
                    const secondResult = await bounded(second);
                    release.resolve();
                    const firstResult = await bounded(first);
                    [taskResult, userResult] = pausedRequest === 'task' ? [firstResult, secondResult] : [secondResult, firstResult];
                } finally {
                    release.resolve();
                    await Promise.allSettled(requests);
                }
                assert.equal(userResult.status, operation === 'rename' ? 200 : 204);
                if (operation === 'rename') {
                    assert.equal(taskResult.status, 201);
                    const stored = await Task.findById(taskResult.data._id);
                    assert.equal(stored.assignedUserName, 'Overlap renamed owner');
                    assert.equal(stored.completed, true);
                } else if (pausedRequest === 'task') {
                    assert.equal(taskResult.status, 404);
                    assert.equal(await Task.countDocuments({ _id: { $in: [...scope.taskIds] } }), 0);
                } else {
                    assert.equal(taskResult.status, 201);
                    const stored = await Task.findById(taskResult.data._id);
                    assert.equal(stored.assignedUser, '');
                    assert.equal(stored.assignedUserName, 'unassigned');
                }
                assert.ok(reads >= 3, 'A conflicted transaction must reread the assignee/resource.');
            });
        }
    }
});
