const mongoose = require('mongoose');
const schemaOptions = require('./options');
const { isResourceId } = require('../lib/validation');

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        validate: value => value.trim().length > 0
    },
    email: {
        type: String,
        required: true,
        unique: true,
        validate: value => value.trim().length > 0
    },
    pendingTasks: {
        type: [String],
        default: () => [],
        validate: value => Array.isArray(value) && value.every(isResourceId)
    }
}, schemaOptions());

module.exports = mongoose.model('User', userSchema);
