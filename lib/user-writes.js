const User = require('../models/user');
const Task = require('../models/task');
const { HttpError } = require('./errors');
const { normalizeUserInput, validateUrlId } = require('./validation');
const { runInTransaction } = require('./transaction');
const { sendResponse } = require('./response');

async function findUser(id, session) {
    const user = await User.findById(id).session(session);
    if (user === null) {
        throw new HttpError(404, 'User not found.');
    }
    return user;
}

async function validateReferences(fields, currentId, session) {
    const emailFilter = { email: fields.email };
    if (currentId !== undefined) emailFilter._id = { $ne: currentId };
    if (await User.exists(emailFilter).session(session)) {
        throw new HttpError(400, 'Email is already in use.');
    }
    const tasks = await Task.find({ _id: { $in: fields.pendingTasks } }).session(session);
    // Check every ID before checking completion, independently of list order.
    if (tasks.length !== fields.pendingTasks.length) {
        throw new HttpError(404, 'Task not found.');
    }
    if (tasks.some(task => task.completed)) {
        throw new HttpError(400, 'pendingTasks cannot contain completed tasks.');
    }
    return tasks;
}

async function synchronizeTasks(user, oldPending, requestedTasks, session) {
    const id = user._id.toString();
    const requestedIds = user.pendingTasks.toObject();
    const requestedSet = new Set(requestedIds);
    const removedIds = oldPending.filter(taskId => !requestedSet.has(taskId));
    if (removedIds.length) {
        await Task.updateMany({ _id: { $in: removedIds }, assignedUser: id, completed: false }, {
            $set: { assignedUser: '', assignedUserName: 'unassigned' }
        }, { session });
    }
    const previousOwners = [...new Set(requestedTasks.map(task => task.assignedUser))]
        .filter(owner => owner !== '' && owner !== id);
    if (previousOwners.length) {
        await User.updateMany({ _id: { $in: previousOwners } }, {
            $pull: { pendingTasks: { $in: requestedIds } }
        }, { session });
    }
    if (requestedIds.length) {
        await Task.updateMany({ _id: { $in: requestedIds } }, {
            $set: { assignedUser: id, assignedUserName: user.name }
        }, { session });
    }
    // Completed tasks are absent from pendingTasks but must follow a rename too.
    await Task.updateMany({ assignedUser: id }, { $set: { assignedUserName: user.name } }, { session });
}

async function create(req, res) {
    const fields = normalizeUserInput(req.body);
    const user = await runInTransaction(async function (session) {
        const tasks = await validateReferences(fields, undefined, session);
        const document = new User(fields);
        await document.save({ session });
        await synchronizeTasks(document, [], tasks, session);
        return document;
    });
    return sendResponse(res, 201, 'User created.', user);
}

async function replace(req, res) {
    const id = validateUrlId(req.params.id, 'User');
    const user = await runInTransaction(async function (session) {
        const document = await findUser(id, session);
        const fields = normalizeUserInput(req.body);
        const tasks = await validateReferences(fields, id, session);
        const oldPending = document.pendingTasks.toObject();
        document.set(fields);
        await document.save({ session });
        await synchronizeTasks(document, oldPending, tasks, session);
        return document;
    });
    return sendResponse(res, 200, 'User updated.', user);
}

async function remove(req, res) {
    const id = validateUrlId(req.params.id, 'User');
    await runInTransaction(async function (session) {
        const user = await findUser(id, session);
        await user.deleteOne({ session });
        await Task.updateMany({ assignedUser: id }, {
            $set: { assignedUser: '', assignedUserName: 'unassigned' }
        }, { session });
    });
    return sendResponse(res, 200, 'User deleted.', null);
}

module.exports = { create, replace, remove };
