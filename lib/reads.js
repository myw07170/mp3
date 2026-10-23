const { HttpError } = require('./errors');
const { sendResponse } = require('./response');
const { validateUrlId } = require('./validation');
const { parseCollectionQuery, parseSelect } = require('./query');

// Only explicit query-syntax failures are client errors. Database availability,
// authorization, and unexpected failures must still reach the 500 handler.
// BadValue, FailedToParse, invalid field paths, projection path collisions,
// and invalid regular-expression syntax.
const queryErrorCodes = new Set([2, 9, 16410, 31249, 31250, 51091]);

async function executeRead(query) {
    try {
        return await query.exec();
    } catch (error) {
        if (error.name === 'MongoServerError' && queryErrorCodes.has(error.code)) {
            throw new HttpError(400, 'Invalid query.');
        }
        throw error;
    }
}

function prepareFilter(query, Model) {
    // Casting can reject unsupported field operators with ordinary Error
    // instances. Classify these before executing any database operation.
    try {
        query.cast(Model);
    } catch {
        throw new HttpError(400, 'Invalid query filter.');
    }
    return query;
}

function createReadHandlers(Model, resource, defaultLimit) {
    async function list(req, res) {
        const { where, sort, select, skip, limit, count } = parseCollectionQuery(req.query, defaultLimit);
        const query = count ? Model.countDocuments(where) : Model.find(where);
        prepareFilter(query, Model);
        if (!count) {
            query.sort(sort).select(select).skip(skip).limit(limit);
        }
        return sendResponse(res, 200, 'OK', await executeRead(query));
    }

    async function detail(req, res) {
        const id = validateUrlId(req.params.id, resource);
        let select;
        try {
            select = parseSelect(req.query);
        } catch (error) {
            if (!(error instanceof HttpError)) {
                throw error;
            }
            // A missing resource takes priority over an invalid projection.
            const exists = await executeRead(Model.exists({ _id: id }));
            if (!exists) {
                throw new HttpError(404, resource + ' not found.');
            }
            throw error;
        }
        let document;
        try {
            document = await executeRead(Model.findById(id).select(select));
        } catch (error) {
            if (error instanceof HttpError && error.status === 400 &&
                !await executeRead(Model.exists({ _id: id }))) {
                throw new HttpError(404, resource + ' not found.');
            }
            throw error;
        }
        if (document === null) {
            throw new HttpError(404, resource + ' not found.');
        }
        return sendResponse(res, 200, 'OK', document);
    }

    return { list, detail };
}

module.exports = { createReadHandlers };
