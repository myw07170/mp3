const router = require('express').Router();
const Task = require('../models/task');
const { createReadHandlers } = require('../lib/reads');
const { create, replace, remove } = require('../lib/task-writes');

const { list, detail } = createReadHandlers(Task, 'Task', 100);
router.get('/', list);
router.get('/:id', detail);

router.post('/', create);
router.put('/:id', replace);
router.delete('/:id', remove);
module.exports = router;
