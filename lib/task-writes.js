const Task = require('../models/task');
const User = require('../models/user');
const { HttpError } = require('./errors');
const { normalizeTaskInput, validateUrlId } = require('./validation');
const { runInTransaction } = require('./transaction');
const { sendResponse } = require('./response');

async function findTask(id, session) {
    const task = await Task.findById(id).session(session);
    if (task === null) {
        throw new HttpError(404, 'Task not found.');
    }
    return task;
}

async function resolveAssignment(input, session) {
    const { fields, assignedUserNameProvided } = input;
    if (fields.assignedUser !== '') {
        const user = await User.findById(fields.assignedUser).session(session);
        if (user === null) {
            throw new HttpError(404, 'User not found.');
        }
        if (assignedUserNameProvided && fields.assignedUserName !== user.name) {
            throw new HttpError(400, 'assignedUserName must match the assigned user.');
        }
        fields.assignedUserName = user.name;
        // A read alone can miss a concurrent rename or deletion. Touch the user
        // so a conflicting transaction retries with a fresh assignee snapshot.
        await User.updateOne({ _id: user._id }, { $inc: { __v: 1 } }, { session });
    }
    return fields;
}

async function synchronizePending(task, previousOwner, session) {
    const id = task._id.toString();
    if (previousOwner !== '' && (previousOwner !== task.assignedUser || task.completed)) {
        await User.updateOne({ _id: previousOwner }, { $pull: { pendingTasks: id } }, { session });
    }
    if (task.assignedUser !== '' && !task.completed) {
        await User.updateOne({ _id: task.assignedUser }, { $addToSet: { pendingTasks: id } }, { session });
    }
}

async function create(req, res) {
    // Keep normalization outside the retryable callback without sharing mutable fields.
    const input = normalizeTaskInput(req.body);
    const task = await runInTransaction(async function (session) {
        const fields = await resolveAssignment({ ...input, fields: { ...input.fields } }, session);
        const document = new Task(fields);
        await document.save({ session });
        await synchronizePending(document, '', session);
        return document;
    });
    return sendResponse(res, 201, 'Task created.', task);
}

async function replace(req, res) {
    const id = validateUrlId(req.params.id, 'Task');
    const task = await runInTransaction(async function (session) {
        const document = await findTask(id, session);
        const previousOwner = document.assignedUser;
        const fields = await resolveAssignment(normalizeTaskInput(req.body), session);
        document.set(fields);
        await document.save({ session });
        await synchronizePending(document, previousOwner, session);
        return document;
    });
    return sendResponse(res, 200, 'Task updated.', task);
}

async function remove(req, res) {
    const id = validateUrlId(req.params.id, 'Task');
    await runInTransaction(async function (session) {
        const task = await findTask(id, session);
        await task.deleteOne({ session });
        if (task.assignedUser !== '') {
            await User.updateOne({ _id: task.assignedUser }, { $pull: { pendingTasks: id } }, { session });
        }
    });
    return sendResponse(res, 200, 'Task deleted.', null);
}

module.exports = { create, replace, remove };
