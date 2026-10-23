const mongoose = require('mongoose');
const schemaOptions = require('./options');
const { isResourceId } = require('../lib/validation');

const taskSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        validate: value => value.trim().length > 0
    },
    description: { type: String, default: '' },
    deadline: { type: Date, required: true },
    completed: { type: Boolean, default: false },
    assignedUser: {
        type: String,
        default: '',
        validate: value => value === '' || isResourceId(value)
    },
    assignedUserName: { type: String, default: 'unassigned' }
}, schemaOptions());

module.exports = mongoose.model('Task', taskSchema);
