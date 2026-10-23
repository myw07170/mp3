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

    await t.test('unimplemented routes and unknown paths return JSON 404', async function () {
        for (const path of ['/api/users', '/api/tasks', '/api/users/missing', '/api/tasks/missing', '/unknown']) {
            const response = await fetch(base + path);
            assert.equal(response.status, 404);
            assert.deepEqual(await response.json(), { message: 'Resource not found.', data: null });
        }
    });

    await t.test('malformed JSON returns 400 without parser details', async function () {
        const response = await fetch(base + '/api/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"private-marker":'
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { message: 'Request body must contain valid JSON.', data: null });
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
