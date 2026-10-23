const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { connectDatabase } = require('../config/database');
const { normalizeUserInput, normalizeTaskInput } = require('../lib/validation');
const { runInTransaction } = require('../lib/transaction');
const { errorHandler } = require('../middleware/errors');
const { createFixtures } = require('./helpers/fixtures');
const { serve } = require('./helpers/http');

test('Atlas foundation integration', { timeout: 120000 }, async function (t) {
    const fixtures = createFixtures();
    t.after(async function () {
        try {
            if (mongoose.connection.readyState === 1) {
                await fixtures.cleanup();
                t.diagnostic('All test-owned User and Task records were removed and absence was verified.');
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

    await t.test('persisted defaults and server-generated creation dates', async function () {
        const before = Date.now();
        const user = fixtures.user({ dateCreated: '1999-01-01' });
        const task = fixtures.task({ dateCreated: '1999-01-01' });
        await user.save();
        await task.save();
        const savedUser = await User.findById(user._id);
        const savedTask = await Task.findById(task._id);
        const after = Date.now();
        for (const document of [savedUser, savedTask]) {
            assert.ok(document.dateCreated.getTime() >= before && document.dateCreated.getTime() <= after);
            assert.equal(Object.hasOwn(document.toJSON(), '__v'), false);
            assert.equal(document.get('updatedAt'), undefined);
        }
        assert.deepEqual(savedUser.pendingTasks.toObject(), []);
        assert.equal(savedTask.description, '');
        assert.equal(savedTask.completed, false);
        assert.equal(savedTask.assignedUser, '');
        assert.equal(savedTask.assignedUserName, 'unassigned');

        const userCreated = savedUser.dateCreated.getTime();
        const taskCreated = savedTask.dateCreated.getTime();
        savedUser.set(normalizeUserInput({ name: 'Updated foundation user', email: savedUser.email, dateCreated: '2000-01-01' }));
        savedTask.set(normalizeTaskInput({ name: 'Updated foundation task', deadline: 0, dateCreated: '2000-01-01' }).fields);
        savedUser.dateCreated = new Date('2001-01-01');
        savedTask.dateCreated = new Date('2001-01-01');
        await savedUser.save();
        await savedTask.save();
        assert.equal((await User.findById(user._id)).dateCreated.getTime(), userCreated);
        assert.equal((await Task.findById(task._id)).dateCreated.getTime(), taskCreated);
        assert.equal((await User.findById(user._id)).name, 'Updated foundation user');
        assert.equal((await Task.findById(task._id)).deadline.getTime(), 0);
    });

    await t.test('the unique email index rejects a duplicate and HTTP maps it to 400', async function (t) {
        const first = fixtures.user();
        await first.save();
        const duplicate = fixtures.user({ email: first.email });
        let duplicateError;
        await assert.rejects(duplicate.save(), function (error) {
            duplicateError = error;
            return error.code === 11000;
        });
        assert.equal(await User.countDocuments({ email: first.email }), 1);
        assert.equal(await User.findById(duplicate._id), null);

        const sameName = fixtures.user({ name: first.name });
        await sameName.save();
        assert.equal((await User.findById(sameName._id)).name, first.name);
        const app = express();
        app.get('/duplicate', async function () { throw duplicateError; });
        app.use(errorHandler);
        const base = await serve(t, app);
        const response = await fetch(base + '/duplicate');
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), { message: 'Email is already in use.', data: null });
    });

    await t.test('transactions commit multiple documents using the supplied session', async function () {
        const user = fixtures.user();
        const task = fixtures.task();
        const result = await runInTransaction(async function (session) {
            assert.ok(session.inTransaction());
            await user.save({ session });
            await task.save({ session });
            return 'committed';
        });
        assert.equal(result, 'committed');
        assert.ok(await User.findById(user._id));
        assert.ok(await Task.findById(task._id));
    });

    await t.test('a failed transaction rolls back existing updates and new records', async function () {
        const user = fixtures.user();
        const task = fixtures.task();
        await user.save();
        await task.save();
        const beforeUser = await User.findById(user._id).lean();
        const beforeTask = await Task.findById(task._id).lean();
        const newUser = fixtures.user();
        const newTask = fixtures.task();
        const failure = new Error('Intentional rollback test.');
        await assert.rejects(runInTransaction(async function (session) {
            await User.updateOne({ _id: user._id }, { $set: { name: 'Should roll back' } }, { session });
            await Task.updateOne({ _id: task._id }, { $set: { description: 'Should roll back' } }, { session });
            await newUser.save({ session });
            await newTask.save({ session });
            throw failure;
        }), error => error === failure);
        assert.deepEqual(await User.findById(user._id).lean(), beforeUser);
        assert.deepEqual(await Task.findById(task._id).lean(), beforeTask);
        assert.equal(await User.findById(newUser._id), null);
        assert.equal(await Task.findById(newTask._id), null);
    });
});
