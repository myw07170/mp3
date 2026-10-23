const { HttpError } = require('./errors');

const objectIdPattern = /^[a-fA-F0-9]{24}$/;

function isResourceId(value) {
    return typeof value === 'string' && objectIdPattern.test(value);
}

function validateUrlId(value, resource) {
    if (!isResourceId(value)) {
        throw new HttpError(404, resource + ' not found.');
    }
    return value.toLowerCase();
}

function validateBodyId(value, field) {
    if (!isResourceId(value)) {
        throw new HttpError(400, field + ' must contain a valid resource ID.');
    }
    return value.toLowerCase();
}

function validateBody(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new HttpError(400, 'Request body must be an object.');
    }
}

function stringField(body, field, required, defaultValue) {
    if (!Object.hasOwn(body, field)) {
        if (!required) {
            return defaultValue;
        }
        throw new HttpError(400, field + ' is required.');
    }
    const value = body[field];
    if (typeof value !== 'string' || (required && value.trim().length === 0)) {
        throw new HttpError(400, field + ' must be ' + (required ? 'a nonempty string.' : 'a string.'));
    }
    return value;
}

function normalizeUserInput(body) {
    validateBody(body);
    const name = stringField(body, 'name', true);
    const email = stringField(body, 'email', true);
    const pendingTasks = Object.hasOwn(body, 'pendingTasks') ? body.pendingTasks : [];
    if (!Array.isArray(pendingTasks)) {
        throw new HttpError(400, 'pendingTasks must be an array of resource IDs.');
    }
    const ids = pendingTasks.map(function (id) {
        return validateBodyId(id, 'pendingTasks');
    });
    return { name, email, pendingTasks: [...new Set(ids)] };
}

function normalizeTaskInput(body) {
    validateBody(body);
    const name = stringField(body, 'name', true);
    const deadline = body.deadline;
    if ((typeof deadline !== 'string' && typeof deadline !== 'number') ||
        (typeof deadline === 'string' && deadline.trim().length === 0) ||
        (typeof deadline === 'number' && !Number.isFinite(deadline))) {
        throw new HttpError(400, 'deadline must be a valid date string or millisecond timestamp.');
    }
    const parsedDeadline = new Date(deadline);
    if (!Number.isFinite(parsedDeadline.getTime())) {
        throw new HttpError(400, 'deadline must be a valid date string or millisecond timestamp.');
    }
    const description = stringField(body, 'description', false, '');
    const completed = Object.hasOwn(body, 'completed') ? body.completed : false;
    if (typeof completed !== 'boolean') {
        throw new HttpError(400, 'completed must be a boolean.');
    }
    const assignedUser = stringField(body, 'assignedUser', false, '');
    const assignedUserNameProvided = Object.hasOwn(body, 'assignedUserName');
    const assignedUserName = stringField(body, 'assignedUserName', false, 'unassigned');
    if (assignedUser === '' && assignedUserName !== 'unassigned') {
        throw new HttpError(400, 'An unassigned task must use the name "unassigned".');
    }

    const fields = {
        name,
        description,
        deadline: parsedDeadline,
        completed,
        assignedUser: assignedUser === '' ? '' : validateBodyId(assignedUser, 'assignedUser')
    };
    // Resolve an omitted name from the referenced user before saving an assigned task.
    if (assignedUser === '' || assignedUserNameProvided) {
        fields.assignedUserName = assignedUserName;
    }
    return { fields, assignedUserNameProvided };
}

module.exports = { isResourceId, validateUrlId, validateBodyId, normalizeUserInput, normalizeTaskInput };
