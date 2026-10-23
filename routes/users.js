const router = require('express').Router();
const User = require('../models/user');
const { createReadHandlers } = require('../lib/reads');
const { create, replace, remove } = require('../lib/user-writes');

const { list, detail } = createReadHandlers(User, 'User', 0);
router.get('/', list);
router.get('/:id', detail);

router.post('/', create);
router.put('/:id', replace);
router.delete('/:id', remove);
module.exports = router;
