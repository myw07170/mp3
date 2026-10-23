const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HttpError } = require('../lib/errors');
const { parseCollectionQuery, parseSelect } = require('../lib/query');

function rejectsQuery(query) {
    assert.throws(() => parseCollectionQuery(query, 100), error => error instanceof HttpError && error.status === 400);
}

test('collection defaults distinguish task and user limits', function () {
    assert.deepEqual(parseCollectionQuery({}, 100), {
        where: {}, sort: {}, select: {}, skip: 0, limit: 100, count: false
    });
    assert.equal(parseCollectionQuery({}, 0).limit, 0);
    assert.equal(parseCollectionQuery({ limit: '0' }, 100).limit, 0);
});

test('all six JSON parameters can be combined', function () {
    const where = { completed: false, _id: { $in: ['0123456789abcdef01234567'] } };
    const sort = { deadline: -1, name: 1 };
    const select = { name: 1, _id: 0 };
    const input = {
        where: JSON.stringify(where), sort: JSON.stringify(sort), select: JSON.stringify(select),
        skip: '2', limit: '3', count: 'false'
    };
    assert.deepEqual(parseCollectionQuery(input, 100), { where, sort, select, skip: 2, limit: 3, count: false });
    assert.equal(parseCollectionQuery({ ...input, count: 'true' }, 100).count, true);
});

test('every relevant parameter rejects malformed JSON and duplicate values', function () {
    for (const name of ['where', 'sort', 'select', 'skip', 'limit', 'count']) {
        rejectsQuery({ [name]: '{' });
        rejectsQuery({ [name]: '' });
        rejectsQuery({ [name]: ['{}', '{}'] });
    }
});

test('object parameters reject scalars, arrays, and null', function () {
    for (const name of ['where', 'sort', 'select']) {
        for (const value of ['null', 'true', '1', '[]', '"name"']) {
            rejectsQuery({ [name]: value });
        }
    }
});

test('sort accepts only numeric ascending and descending directions', function () {
    for (const value of [0, 2, 'asc', '1', true, null, {}, []]) {
        rejectsQuery({ sort: JSON.stringify({ name: value }) });
    }
    assert.deepEqual(parseCollectionQuery({ sort: '{"name":-1}' }, 100).sort, { name: -1 });
});

test('projection accepts inclusion, exclusion, and the ID exception', function () {
    for (const select of [{}, { name: 1 }, { name: 0 }, { name: 1, _id: 0 }, { name: 0, _id: 1 }, { _id: 0 }]) {
        assert.deepEqual(parseSelect({ select: JSON.stringify(select) }), select);
    }
    for (const select of [{ name: 1, email: 0 }, { name: true }, { name: '1' }, { name: 2 }, { name: null }, { name: { $slice: 1 } }]) {
        rejectsQuery({ select: JSON.stringify(select) });
    }
});

test('pagination accepts only nonnegative safe integers', function () {
    for (const name of ['skip', 'limit']) {
        for (const value of ['-1', '1.5', 'true', 'null', '[]', '"2"', '9007199254740992', '1e309']) {
            rejectsQuery({ [name]: value });
        }
        assert.equal(parseCollectionQuery({ [name]: '0' }, 100)[name], 0);
        assert.equal(parseCollectionQuery({ [name]: '9007199254740991' }, 100)[name], Number.MAX_SAFE_INTEGER);
    }
});

test('count must be boolean and does not bypass validation of other parameters', function () {
    for (const value of ['0', '1', 'null', '[]', '{}', '"true"']) {
        rejectsQuery({ count: value });
    }
    for (const name of ['where', 'sort', 'select', 'skip', 'limit']) {
        rejectsQuery({ count: 'true', [name]: 'invalid' });
    }
});

test('unknown parameters and non-select detail parameters are ignored', function () {
    assert.deepEqual(parseCollectionQuery({ unknown: ['invalid', 'invalid'] }, 100), parseCollectionQuery({}, 100));
    assert.deepEqual(parseSelect({ where: '{', sort: '{', skip: 'bad', limit: 'bad', count: 'bad', unknown: '{}' }), {});
});
