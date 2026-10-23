const mongoose = require('mongoose');

function runInTransaction(work) {
    // The callback may be retried. Pass session to every operation, await them
    // sequentially, and send the HTTP response only after this promise resolves.
    return mongoose.connection.transaction(function (session) {
        return work(session);
    }, { readPreference: 'primary' });
}

module.exports = { runInTransaction };
