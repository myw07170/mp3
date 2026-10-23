const express = require('express');
const mountRoutes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errors');

function createApp() {
    const app = express();

    app.use(function allowCrossDomain(req, res, next) {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Headers', 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept');
        res.header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
        if (req.method === 'OPTIONS') {
            return res.status(204).end();
        }
        next();
    });
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    mountRoutes(app);
    app.use(notFound);
    app.use(errorHandler);

    return app;
}

module.exports = createApp;
