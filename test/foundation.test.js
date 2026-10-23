const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { HttpError, toHttpError } = require('../lib/errors');
const {
    isResourceId, validateUrlId, validateBodyId, normalizeUserInput, normalizeTaskInput
} = require('../lib/validation');

const userBody = { name: 'Foundation user', email: 'MixedCase@example.test' };
const taskBody = { name: 'Foundation task', deadline: '2026-11-03T12:00:00.000Z' };
const firstId = '0123456789abcdef01234567';
const secondId = 'fedcba9876543210fedcba98';

function rejectsInput(work, status = 400) {
    assert.throws(work, error => error instanceof HttpError && error.status === status);
}

test('application and server imports do not connect, listen, or log', function () {
    const result = spawnSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const mongoose = require('mongoose');
        require('./app');
        require('./server');
        assert.equal(mongoose.connection.readyState, 0);
    `], { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
});

test('startup failure exits without exposing connection configuration', function () {
    const secret = 'invalid-connection-with-private-marker';
    const result = spawnSync(process.execPath, ['server.js'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
        env: { ...process.env, MONGODB_URI: secret }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Server startup failed/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-marker|MongoParseError|mongodb:\/\//);
    assert.doesNotMatch(result.stdout, /Server running/);
});

test('minimal user input preserves strings and supplies an independent pending list', async function () {
    const fields = normalizeUserInput(userBody);
    assert.deepEqual(fields, { ...userBody, pendingTasks: [] });
    fields.pendingTasks.push(firstId);
    assert.deepEqual(normalizeUserInput(userBody).pendingTasks, []);
    const user = new User(normalizeUserInput(userBody));
    await user.validate();
    assert.deepEqual(user.pendingTasks.toObject(), []);
});

test('minimal task input supplies the required defaults', async function () {
    const { fields, assignedUserNameProvided } = normalizeTaskInput(taskBody);
    assert.deepEqual(fields, {
        name: taskBody.name, deadline: new Date(taskBody.deadline),
        description: '', completed: false, assignedUser: '', assignedUserName: 'unassigned'
    });
    assert.equal(assignedUserNameProvided, false);
    const task = new Task(fields);
    await task.validate();
    assert.equal(task.completed, false);
    assert.equal(task.assignedUser, '');
    assert.equal(task.assignedUserName, 'unassigned');
    assert.equal(task.description, '');
});

test('required strings are checked before any Mongoose coercion', function () {
    for (const value of [undefined, null, '', ' \t ', 12, true, [], {}, ['name']]) {
        rejectsInput(() => normalizeUserInput({ ...userBody, name: value }));
        rejectsInput(() => normalizeUserInput({ ...userBody, email: value }));
        rejectsInput(() => normalizeTaskInput({ ...taskBody, name: value }));
    }
    rejectsInput(() => normalizeUserInput({ email: userBody.email }));
    rejectsInput(() => normalizeUserInput({ name: userBody.name }));
    rejectsInput(() => normalizeTaskInput({ deadline: taskBody.deadline }));
});

test('non-object request bodies are rejected', function () {
    for (const body of [undefined, null, [], 'body', 42, false]) {
        rejectsInput(() => normalizeUserInput(body));
        rejectsInput(() => normalizeTaskInput(body));
    }
});

test('deadline accepts date strings and finite millisecond timestamps', function () {
    for (const value of [taskBody.deadline, '2026-11-03', 0, 1793707200000]) {
        assert.equal(normalizeTaskInput({ ...taskBody, deadline: value }).fields.deadline.getTime(), new Date(value).getTime());
    }
    for (const value of [undefined, null, '', ' ', 'not-a-date', false, [], {}, new Date(), NaN, Infinity, -Infinity, 1e20]) {
        rejectsInput(() => normalizeTaskInput({ ...taskBody, deadline: value }));
    }
    rejectsInput(() => normalizeTaskInput({ name: taskBody.name }));
});

test('optional task fields reject null and values of the wrong type', function () {
    for (const field of ['description', 'assignedUser', 'assignedUserName']) {
        for (const value of [null, undefined, 42, false, [], {}]) {
            rejectsInput(() => normalizeTaskInput({ ...taskBody, [field]: value }));
        }
    }
    for (const value of [null, undefined, 'false', 'true', 0, 1, [], {}]) {
        rejectsInput(() => normalizeTaskInput({ ...taskBody, completed: value }));
    }
    assert.equal(normalizeTaskInput({ ...taskBody, completed: true }).fields.completed, true);
});

test('body references must be IDs and pending lists are deduplicated in order', function () {
    const original = [firstId.toUpperCase(), secondId, firstId];
    assert.deepEqual(normalizeUserInput({ ...userBody, pendingTasks: original }).pendingTasks, [firstId, secondId]);
    assert.equal(original[0], firstId.toUpperCase());
    for (const value of [null, undefined, firstId, {}, 42]) {
        rejectsInput(() => normalizeUserInput({ ...userBody, pendingTasks: value }));
    }
    for (const id of ['invalid', '123456789012', 'z'.repeat(24), null, 42, {}, []]) {
        rejectsInput(() => normalizeUserInput({ ...userBody, pendingTasks: [id] }));
        rejectsInput(() => normalizeTaskInput({ ...taskBody, assignedUser: id }));
    }
});

test('assignment name presence is preserved for later reference resolution', function () {
    const omitted = normalizeTaskInput({ ...taskBody, assignedUser: firstId.toUpperCase() });
    assert.equal(omitted.fields.assignedUser, firstId);
    assert.equal(omitted.assignedUserNameProvided, false);
    assert.equal(Object.hasOwn(omitted.fields, 'assignedUserName'), false);
    const explicit = normalizeTaskInput({ ...taskBody, assignedUser: firstId, assignedUserName: 'Owner' });
    assert.equal(explicit.assignedUserNameProvided, true);
    assert.equal(explicit.fields.assignedUserName, 'Owner');
    rejectsInput(() => normalizeTaskInput({ ...taskBody, assignedUserName: 'Owner' }));
    assert.equal(normalizeTaskInput({ ...taskBody, assignedUserName: 'unassigned' }).assignedUserNameProvided, true);
});

test('normalization drops protected and unknown fields without mutating input', function () {
    const extra = { _id: firstId, dateCreated: '1999-01-01', __v: 7, unrelated: true };
    const userInput = { ...userBody, ...extra };
    const taskInput = { ...taskBody, ...extra };
    const userFields = normalizeUserInput(userInput);
    const { fields: taskFields } = normalizeTaskInput(taskInput);
    for (const field of Object.keys(extra)) {
        assert.equal(Object.hasOwn(userFields, field), false);
        assert.equal(Object.hasOwn(taskFields, field), false);
    }
    assert.equal(userInput.dateCreated, extra.dateCreated);
    assert.equal(taskInput.dateCreated, extra.dateCreated);
});

test('full replacement input resets optional fields instead of merging old values', function () {
    const user = new User(normalizeUserInput({ ...userBody, pendingTasks: [firstId] }));
    user.set(normalizeUserInput(userBody));
    assert.deepEqual(user.pendingTasks.toObject(), []);
    const task = new Task(normalizeTaskInput({
        ...taskBody, description: 'Old description', completed: true,
        assignedUser: firstId, assignedUserName: 'Old owner'
    }).fields);
    task.set(normalizeTaskInput(taskBody).fields);
    assert.equal(task.description, '');
    assert.equal(task.completed, false);
    assert.equal(task.assignedUser, '');
    assert.equal(task.assignedUserName, 'unassigned');
});

test('malformed URL IDs use 404 while malformed body references use 400', function () {
    for (const id of [undefined, '', 'missing', 'x'.repeat(24), '123456789012', 42, new mongoose.Types.ObjectId()]) {
        assert.equal(isResourceId(id), false);
        rejectsInput(() => validateUrlId(id, 'User'), 404);
        rejectsInput(() => validateBodyId(id, 'pendingTasks'), 400);
    }
    assert.equal(validateUrlId(firstId.toUpperCase(), 'Task'), firstId);
    assert.equal(validateBodyId(firstId.toUpperCase(), 'assignedUser'), firstId);
});

test('schemas enforce required values and generate only immutable creation timestamps', async function () {
    for (const Model of [User, Task]) {
        const error = await new Model().validate().catch(error => error);
        assert.ok(error.errors.name);
        assert.ok(error.errors[Model === User ? 'email' : 'deadline']);
        assert.equal(Model.schema.path('dateCreated').options.immutable, true);
        assert.equal(Model.schema.path('updatedAt'), undefined);
    }
    await assert.rejects(new User({ name: ' ', email: ' ' }).validate());
    await assert.rejects(new Task({ name: ' ', deadline: 'invalid' }).validate());
    await assert.rejects(new User({ ...userBody, pendingTasks: ['invalid'] }).validate());
    await assert.rejects(new Task({ ...taskBody, assignedUser: 'invalid' }).validate());
    assert.equal(User.schema.indexes().some(([keys, options]) => keys.email === 1 && options.unique === true), true);
    assert.equal(User.schema.indexes().some(([keys, options]) => keys.name === 1 && options.unique === true), false);
});

test('document serialization retains IDs and omits the database version', function () {
    for (const document of [new User(normalizeUserInput(userBody)), new Task(normalizeTaskInput(taskBody).fields)]) {
        document.__v = 17;
        const json = JSON.parse(JSON.stringify(document));
        assert.equal(typeof json._id, 'string');
        assert.equal(Object.hasOwn(json, '__v'), false);
        assert.equal(Object.hasOwn(document.toObject(), '__v'), false);
    }
});

test('database and validation errors become safe public messages', async function () {
    const duplicate = new mongoose.mongo.MongoServerError({
        code: 11000, errmsg: 'private database detail', keyPattern: { email: 1 },
        keyValue: { email: 'private@example.test' }
    });
    const cases = [
        [duplicate, 400, 'Email is already in use.'],
        [await new User().validate().catch(error => error), 400, 'Invalid request fields.'],
        [new mongoose.Error.CastError('ObjectId', 'private', '_id'), 400, 'Invalid request fields.'],
        [new Error('private database detail'), 500, 'Internal server error.']
    ];
    for (const [error, status, message] of cases) {
        const mapped = toHttpError(error);
        assert.equal(mapped.status, status);
        assert.equal(mapped.message, message);
    }
    const applicationError = new HttpError(404, 'User not found.');
    assert.equal(toHttpError(applicationError), applicationError);
});
