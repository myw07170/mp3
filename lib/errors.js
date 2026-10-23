class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}

function toHttpError(error) {
    if (error instanceof HttpError) {
        return error;
    }
    if (error instanceof URIError && error.status === 400 &&
        error.message.startsWith('Failed to decode param')) {
        return new HttpError(404, 'Resource not found.');
    }
    if (error && error.type === 'entity.parse.failed') {
        return new HttpError(400, 'Request body must contain valid JSON.');
    }
    if (error && error.type === 'entity.too.large') {
        return new HttpError(413, 'Request body is too large.');
    }
    if (error && error.code === 11000) {
        const isEmail = Object.hasOwn(error.keyPattern || {}, 'email') ||
            Object.hasOwn(error.keyValue || {}, 'email');
        return new HttpError(400, isEmail ? 'Email is already in use.' : 'A value is already in use.');
    }
    if (error && (error.name === 'ValidationError' || error.name === 'CastError')) {
        return new HttpError(400, 'Invalid request fields.');
    }
    return new HttpError(500, 'Internal server error.');
}

module.exports = { HttpError, toHttpError };
