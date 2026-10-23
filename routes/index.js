const express = require('express');

module.exports = function mountRoutes(app) {
    const router = express.Router();
    router.use('/', require('./home'));
    router.use('/users', require('./users'));
    router.use('/tasks', require('./tasks'));
    app.use('/api', router);
};
