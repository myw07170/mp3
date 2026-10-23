const router = require('express').Router();
const Task = require('../models/task');
const { createReadHandlers } = require('../lib/reads');

const { list, detail } = createReadHandlers(Task, 'Task', 100);
router.get('/', list);
router.get('/:id', detail);

// Task writes are implemented in the task-write phase.
module.exports = router;
