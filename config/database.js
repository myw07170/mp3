const mongoose = require('mongoose');
const dns = require('node:dns/promises');
const User = require('../models/user');
const Task = require('../models/task');

async function connectDatabase() {
    require('dotenv').config({ quiet: true });
    if (!process.env.MONGODB_URI) {
        throw new Error('Database connection is not configured.');
    }

    // Preserve the resolver and timeout used by the working local setup.
    dns.setServers(['8.8.8.8']);
    await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000
    });
    // A unique schema option requires a completed database index build.
    await Promise.all([User.init(), Task.init()]);
    return mongoose.connection;
}

module.exports = { connectDatabase };
