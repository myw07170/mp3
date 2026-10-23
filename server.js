const mongoose = require('mongoose');
const createApp = require('./app');
const { connectDatabase } = require('./config/database');

async function start() {
    console.log('Connecting to MongoDB...');
    await connectDatabase();
    console.log('MongoDB connected');

    const app = createApp();
    const port = process.env.PORT || 3000;
    const server = await new Promise(function (resolve, reject) {
        const listener = app.listen(port, function () {
            resolve(listener);
        });
        listener.once('error', reject);
    });
    console.log('Server running on port ' + server.address().port);
    return server;
}

if (require.main === module) {
    start().catch(async function () {
        console.error('Server startup failed. Check the database connection, indexes, and port configuration.');
        await mongoose.disconnect().catch(function () {});
        process.exitCode = 1;
    });
}

module.exports = { start };
