const router = require('express').Router();
const User = require('../models/user');
const { createReadHandlers } = require('../lib/reads');

const { list, detail } = createReadHandlers(User, 'User', 0);
router.get('/', list);
router.get('/:id', detail);

// User writes are implemented in the user-write phase.
module.exports = router;
