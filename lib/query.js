const { HttpError } = require('./errors');

function invalidParameter(name) {
    return new HttpError(400, 'Invalid query parameter: ' + name + '.');
}

function parseParameter(query, name, fallback) {
    if (!Object.hasOwn(query, name)) {
        return fallback;
    }
    if (typeof query[name] !== 'string') {
        throw invalidParameter(name);
    }
    try {
        return JSON.parse(query[name]);
    } catch {
        throw invalidParameter(name);
    }
}

function parseObject(query, name) {
    const value = parseParameter(query, name, {});
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidParameter(name);
    }
    return value;
}

function parseSelect(query) {
    const select = parseObject(query, 'select');
    let includes = false;
    let excludes = false;
    for (const [field, value] of Object.entries(select)) {
        if (value !== 0 && value !== 1) {
            throw invalidParameter('select');
        }
        if (field !== '_id') {
            includes ||= value === 1;
            excludes ||= value === 0;
        }
    }
    if (includes && excludes) {
        throw invalidParameter('select');
    }
    return select;
}

function parseInteger(query, name, fallback) {
    const value = parseParameter(query, name, fallback);
    if (!Number.isSafeInteger(value) || value < 0) {
        throw invalidParameter(name);
    }
    return value;
}

function parseCollectionQuery(query, defaultLimit) {
    const where = parseObject(query, 'where');
    const sort = parseObject(query, 'sort');
    if (Object.values(sort).some(value => value !== 1 && value !== -1)) {
        throw invalidParameter('sort');
    }
    const select = parseSelect(query);
    const skip = parseInteger(query, 'skip', 0);
    const limit = parseInteger(query, 'limit', defaultLimit);
    const count = parseParameter(query, 'count', false);
    if (typeof count !== 'boolean') {
        throw invalidParameter('count');
    }
    return { where, sort, select, skip, limit, count };
}

module.exports = { parseCollectionQuery, parseSelect };
