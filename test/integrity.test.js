const { test } = require('node:test');
const assert = require('node:assert/strict');
const { referenceViolations } = require('./helpers/integrity');

const graph = {
    users: [{ _id: 'owner', name: 'Owner', pendingTasks: ['pending'] }],
    tasks: [
        { _id: 'pending', completed: false, assignedUser: 'owner', assignedUserName: 'Owner' },
        { _id: 'completed', completed: true, assignedUser: 'owner', assignedUserName: 'Owner' },
        { _id: 'free', completed: false, assignedUser: '', assignedUserName: 'unassigned' }
    ]
};

test('reference auditor accepts pending, completed, and unassigned tasks', function () {
    assert.deepEqual(referenceViolations(graph.users, graph.tasks), []);
    assert.deepEqual(referenceViolations([], []), []);
});

test('reference auditor detects broken references in either direction', function () {
    const cases = [
        ['missing_pending_task', state => state.users[0].pendingTasks.push('missing')],
        ['duplicate_pending', state => state.users[0].pendingTasks.push('pending')],
        ['invalid_pending_task', state => state.users[0].pendingTasks.push('completed')],
        ['assignment_name', state => { state.tasks[0].assignedUserName = 'Wrong owner'; }],
        ['missing_assignee', state => { state.tasks[0].assignedUser = 'missing'; }],
        ['pending_membership', state => { state.users[0].pendingTasks = []; }],
        ['unassigned_name', state => { state.tasks[2].assignedUserName = 'Wrong owner'; }],
        ['invalid_pending_list', state => { state.users[0].pendingTasks = null; }]
    ];
    for (const [type, change] of cases) {
        const state = structuredClone(graph);
        change(state);
        assert.ok(referenceViolations(state.users, state.tasks).some(violation => violation.type === type), type);
    }
    assert.deepEqual(referenceViolations(graph.users, graph.tasks), []);
});
