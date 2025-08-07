const router = require('express').Router();
const { loginUser } = require('../controllers/authController');

router.post('/login', loginUser);

module.exports = router;
