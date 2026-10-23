const User = require('../models/user');
const Task = require('../models/task');
const { validateUrlId } = require('../lib/validation');
const { HttpError } = require('../lib/errors');

function mountPutChecks(app) {
    for (const [path, Model, resource] of [['users', User, 'User'], ['tasks', Task, 'Task']]) {
        app.put('/api/' + path, function () {
            throw new HttpError(404, 'Resource not found.');
        });
        app.put('/api/' + path + '/:id', async function (req, res, next) {
            const id = validateUrlId(req.params.id, resource);
            if (!await Model.exists({ _id: id })) {
                throw new HttpError(404, resource + ' not found.');
            }
            // Handlers recheck inside the transaction after parsing the body.
            next();
        });
    }
}

module.exports = { mountPutChecks };
