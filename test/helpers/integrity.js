const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const User = require('../../models/user');
const Task = require('../../models/task');

function referenceViolations(users, tasks) {
    const violations = [];
    const owners = new Map(users.map(user => [String(user._id), user]));
    const work = new Map(tasks.map(task => [String(task._id), task]));
    for (const user of users) {
        const userId = String(user._id);
        if (!Array.isArray(user.pendingTasks)) {
            violations.push({ type: 'invalid_pending_list', userId });
            continue;
        }
        const seen = new Set();
        for (const taskId of user.pendingTasks) {
            if (seen.has(taskId)) violations.push({ type: 'duplicate_pending', userId, taskId: String(taskId) });
            seen.add(taskId);
            const task = work.get(taskId);
            if (!task) violations.push({ type: 'missing_pending_task', userId, taskId: String(taskId) });
            else if (task.completed !== false || task.assignedUser !== userId || task.assignedUserName !== user.name) {
                violations.push({ type: 'invalid_pending_task', userId, taskId: String(taskId) });
            }
        }
    }
    for (const task of tasks) {
        const taskId = String(task._id);
        if (task.assignedUser === '') {
            if (task.assignedUserName !== 'unassigned') violations.push({ type: 'unassigned_name', taskId });
            continue;
        }
        const user = owners.get(task.assignedUser);
        if (!user) {
            violations.push({ type: 'missing_assignee', taskId, userId: String(task.assignedUser) });
            continue;
        }
        if (task.assignedUserName !== user.name) violations.push({ type: 'assignment_name', taskId, userId: String(user._id) });
        const occurrences = (Array.isArray(user.pendingTasks) ? user.pendingTasks : []).filter(id => id === taskId).length;
        if (occurrences !== (task.completed ? 0 : 1)) {
            violations.push({ type: 'pending_membership', taskId, userId: String(user._id) });
        }
    }
    return violations;
}

async function snapshot(scope, session) {
    const users = User.find(scope ? { _id: { $in: [...scope.userIds] } } : {}).sort({ _id: 1 }).lean();
    const tasks = Task.find(scope ? { _id: { $in: [...scope.taskIds] } } : {}).sort({ _id: 1 }).lean();
    if (session) {
        users.session(session);
        tasks.session(session);
    }
    // Transaction operations must be sequential, including read-only audits.
    return { users: await users, tasks: await tasks };
}

async function assertIntegrity(scope) {
    const state = await snapshot(scope);
    assert.deepEqual(referenceViolations(state.users, state.tasks), []);
    return state;
}

async function auditDatabase() {
    return mongoose.connection.transaction(async function (session) {
        const state = await snapshot(undefined, session);
        return {
            users: state.users.length,
            tasks: state.tasks.length,
            violations: referenceViolations(state.users, state.tasks)
        };
    }, { readConcern: { level: 'snapshot' }, readPreference: 'primary' });
}

function auditSummary(audit) {
    return { users: audit.users, tasks: audit.tasks, violationCount: audit.violations.length, violations: audit.violations.slice(0, 20) };
}

module.exports = { referenceViolations, snapshot, assertIntegrity, auditDatabase, auditSummary };
