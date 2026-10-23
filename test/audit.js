const mongoose = require('mongoose');
const { connectDatabase } = require('../config/database');
const { auditDatabase, auditSummary } = require('./helpers/integrity');

async function main() {
    try {
        await connectDatabase();
        console.log(JSON.stringify(auditSummary(await auditDatabase())));
    } catch {
        console.error('Database audit failed. Check database access and configuration.');
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
}

main();
