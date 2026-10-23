const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../../models/user');
const Task = require('../../models/task');
const { normalizeUserInput, normalizeTaskInput } = require('../../lib/validation');

function createFixtures() {
    const userIds = [];
    const taskIds = [];
    const runId = randomUUID();

    function user(fields = {}) {
        const _id = new mongoose.Types.ObjectId();
        userIds.push(_id);
        return new User({
            ...normalizeUserInput({ name: 'Foundation user', email: runId + '-' + _id + '@example.test', ...fields }),
            _id
        });
    }

    function task(fields = {}) {
        const _id = new mongoose.Types.ObjectId();
        taskIds.push(_id);
        return new Task({
            ...normalizeTaskInput({ name: 'Foundation task', deadline: '2026-11-03T12:00:00.000Z', ...fields }).fields,
            _id
        });
    }

    async function cleanup() {
        // Never delete by a broad name/email prefix or clear a collection.
        const results = await Promise.allSettled([
            Task.deleteMany({ _id: { $in: taskIds } }),
            User.deleteMany({ _id: { $in: userIds } })
        ]);
        const failures = results.filter(result => result.status === 'rejected');
        if (failures.length) {
            throw new Error('Test fixture cleanup failed. Owned IDs: ' + JSON.stringify({ userIds, taskIds }));
        }
        const remainingUsers = await User.countDocuments({ _id: { $in: userIds } });
        const remainingTasks = await Task.countDocuments({ _id: { $in: taskIds } });
        if (remainingUsers || remainingTasks) {
            throw new Error('Test fixtures remain. Owned IDs: ' + JSON.stringify({ userIds, taskIds }));
        }
    }

    function trackTask(id) {
        if (!taskIds.some(existing => existing.toString() === id.toString())) {
            taskIds.push(new mongoose.Types.ObjectId(id));
        }
    }

    function trackUser(id) {
        if (!userIds.some(existing => existing.toString() === id.toString())) {
            userIds.push(new mongoose.Types.ObjectId(id));
        }
    }

    return { user, task, trackTask, trackUser, cleanup };
}

module.exports = { createFixtures };
