const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const createApp = require('../app');
const User = require('../models/user');
const { HttpError } = require('../lib/errors');
const { sendResponse } = require('../lib/response');
const { normalizeUserInput } = require('../lib/validation');
const { errorHandler } = require('../middleware/errors');
const { serve } = require('./helpers/http');

test('API foundation HTTP responses', async function (t) {
    const base = await serve(t, createApp());

    await t.test('home returns a harmless status envelope', async function () {
        const response = await fetch(base + '/api');
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /application\/json/);
        assert.deepEqual(await response.json(), { message: 'OK', data: { status: 'API is running.' } });
    });

    await t.test('unknown paths and collection writes without a resource ID return JSON 404', async function () {
        for (const path of ['/unknown', '/api/unknown', '/api/users/extra/path', '/api/tasks/extra/path']) {
            const response = await fetch(base + path);
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), { message: 'Resource not found.', data: null });
        }
        for (const path of ['/api/users', '/api/tasks']) {
            for (const method of ['PUT', 'DELETE']) {
                const response = await fetch(base + path, { method });
                assert.equal(response.status, 404);
                assert.deepEqual(await response.json(), { message: 'Resource not found.', data: null });
            }
        }
    });

    await t.test('malformed detail IDs return resource-specific 404 before select validation', async function () {
        for (const [path, resource] of [['users', 'User'], ['tasks', 'Task']]) {
            const response = await fetch(base + '/api/' + path + '/missing?select=invalid');
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), { message: resource + ' not found.', data: null });
        }
    });

    await t.test('malformed JSON returns 400 without parser details', async function () {
        const response = await fetch(base + '/api/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"private-marker":'
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { message: 'Request body must contain valid JSON.', data: null });
    });

    await t.test('POST rejects missing input and malformed detail writes return 404', async function () {
        for (const [path, resource] of [['users', 'User'], ['tasks', 'Task']]) {
            const response = await fetch(base + '/api/' + path, { method: 'POST' });
            assert.equal(response.status, 400);
            assert.deepEqual(await response.json(), { message: 'Request body must be an object.', data: null });
            for (const method of ['PUT', 'DELETE']) {
                const missing = await fetch(base + '/api/' + path + '/missing', {
                    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 12 })
                });
                assert.equal(missing.status, 404);
                assert.deepEqual(await missing.json(), { message: resource + ' not found.', data: null });
            }
        }
    });

    await t.test('CORS preflight returns a bodyless 204', async function () {
        const response = await fetch(base + '/api/users', { method: 'OPTIONS' });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        assert.equal(await response.text(), '');
    });
});

test('error middleware handles synchronous and asynchronous failures safely', async function (t) {
    const app = express();
    app.use(express.json());
    const failures = [
        ['application', new HttpError(404, 'User not found.'), 404, 'User not found.'],
        ['validation', await new User().validate().catch(error => error), 400, 'Invalid request fields.'],
        ['cast', new mongoose.Error.CastError('ObjectId', 'private-marker', '_id'), 400, 'Invalid request fields.'],
        ['duplicate', new mongoose.mongo.MongoServerError({
            code: 11000, errmsg: 'private-marker', keyPattern: { email: 1 }
        }), 400, 'Email is already in use.'],
        ['unexpected', new Error('private-marker mongodb://sensitive'), 500, 'Internal server error.']
    ];
    for (const [path, error] of failures) {
        app.get('/' + path, async function () { throw error; });
    }
    app.post('/validate', function (req, res) {
        sendResponse(res, 200, 'OK', normalizeUserInput(req.body));
    });
    app.get('/empty', function (req, res) { sendResponse(res, 204, 'Ignored', { ignored: true }); });
    app.use(errorHandler);
    const base = await serve(t, app);

    for (const [path, , status, message] of failures) {
        const response = await fetch(base + '/' + path);
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { message, data: null });
    }
    const invalid = await fetch(base + '/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 42, email: 'test@example.test' })
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { message: 'name must be a nonempty string.', data: null });
    const empty = await fetch(base + '/empty');
    assert.equal(empty.status, 204);
    assert.equal(await empty.text(), '');
});

test('collection routes reject invalid query parameters before database access', async function (t) {
    const base = await serve(t, createApp());
    const invalid = [
        ['where', '{'], ['sort', '{'], ['select', '{'], ['skip', 'not-json'], ['limit', 'not-json'], ['count', 'not-json'],
        ['where', '[]'], ['sort', '{"name":0}'], ['select', '{"name":1,"email":0}'],
        ['skip', '-1'], ['limit', '1.5'], ['count', '"true"']
    ];
    for (const resource of ['users', 'tasks']) {
        for (const name of ['skip', 'limit']) {
            for (const value of ['-1', '1.5', 'true', 'null', '[]', '"2"', '9007199254740992', '1e309']) {
                const params = new URLSearchParams({ [name]: value, count: 'true' });
                const response = await fetch(base + '/api/' + resource + '?' + params);
                assert.equal(response.status, 400);
                assert.deepEqual(await response.json(), { message: 'Invalid query parameter: ' + name + '.', data: null });
            }
        }
        for (const [name, value] of invalid) {
            const params = new URLSearchParams({ [name]: value });
            const response = await fetch(base + '/api/' + resource + '?' + params);
            assert.equal(response.status, 400, resource + ': ' + params);
            assert.deepEqual(await response.json(), { message: 'Invalid query parameter: ' + name + '.', data: null });
        }
        for (const name of ['where', 'sort', 'select', 'skip', 'limit', 'count']) {
            const params = new URLSearchParams([[name, '{}'], [name, '{}']]);
            const response = await fetch(base + '/api/' + resource + '?' + params);
            assert.equal(response.status, 400);
            assert.equal((await response.json()).data, null);
        }
    }
});

test('read routes preserve safe 500 responses for database failures', async function (t) {
    t.mock.method(mongoose.Query.prototype, 'exec', async function () {
        throw new Error('private-marker mongodb://sensitive');
    });
    const base = await serve(t, createApp());
    for (const resource of ['users', 'tasks']) {
        for (const suffix of ['', '?count=true', '/0123456789abcdef01234567', '/0123456789abcdef01234567?select=bad']) {
            const response = await fetch(base + '/api/' + resource + suffix);
            assert.equal(response.status, 500);
            assert.deepEqual(await response.json(), { message: 'Internal server error.', data: null });
        }
    }
});
