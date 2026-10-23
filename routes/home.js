const router = require('express').Router();
const { sendResponse } = require('../lib/response');

router.get('/', function (req, res) {
    sendResponse(res, 200, 'OK', { status: 'API is running.' });
});

module.exports = router;
