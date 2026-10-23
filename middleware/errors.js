const { HttpError, toHttpError } = require('../lib/errors');
const { sendResponse } = require('../lib/response');

function notFound(req, res, next) {
    next(new HttpError(404, 'Resource not found.'));
}

function errorHandler(error, req, res, next) {
    if (res.headersSent) {
        return next(error);
    }
    const publicError = toHttpError(error);
    return sendResponse(res, publicError.status, publicError.message, null);
}

module.exports = { notFound, errorHandler };
