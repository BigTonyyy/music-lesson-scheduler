const router = require('express').Router();
const {
    getAppointments,
    createAppointment,
    getAvailableSlots
} = require('../controllers/calendarController');

// ORDER MATTERS — specific route first
router.get('/:teacherSlug/available-slots', getAvailableSlots);
router.get('/:teacherSlug', getAppointments); // <-- must come AFTER
router.post('/book', createAppointment);

module.exports = router;
