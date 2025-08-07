const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const SLOT_DURATION_MINUTES = 30;

const {
    insertEventToGoogleCalendar,
    getAuthorizedClientForUser
} = require('../googleAuth');

const { google } = require('googleapis');

// 📅 Get Teacher Appointments
exports.getAppointments = async (req, res) => {
    const { teacherSlug } = req.params;

    try {
        const teacher = await prisma.user.findUnique({
            where: {
                calendarSlug: {
                    equals: teacherSlug,
                    mode: 'insensitive'
                }
            },
        });

        if (!teacher) {
            return res.status(404).json({ error: 'Teacher not found' });
        }

        if (!teacher.googleToken) {
            return res.status(400).json({ error: 'Google Calendar not connected.' });
        }

        const client = await getAuthorizedClientForUser(teacher.id);
        const calendar = google.calendar({ version: 'v3', auth: client });
        const calendarId = teacher.calendarId || 'primary';

        const now = new Date();
        const nextMonth = new Date();
        nextMonth.setMonth(now.getMonth() + 1);

        const { data } = await calendar.events.list({
            calendarId,
            timeMin: now.toISOString(),
            timeMax: nextMonth.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        const appointments = (data.items || []).map(event => ({
            summary: event.summary,
            startTime: event.start.dateTime || event.start.date,
            endTime: event.end.dateTime || event.end.date,
        }));

        res.json({
            teacher: {
                id: teacher.id,
                name: teacher.name,
                slug: teacher.calendarSlug,
                plan: teacher.plan,
                googleConnected: !!teacher.googleToken
            },
            appointments,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
};


// ✅ Book Appointment
exports.createAppointment = async (req, res) => {
    const {
        teacherId,
        studentName,
        studentEmail,
        startTime,
        endTime,
    } = req.body;

    try {
        try {
            await insertEventToGoogleCalendar({
                userId: teacherId,
                summary: `Lesson with ${studentName}`,
                description: `Music lesson with ${studentName} (${studentEmail})`,
                startTime,
                endTime
            });
        } catch (calendarErr) {
            console.error('⚠️ Failed to sync with Google Calendar:', calendarErr);
        }

        res.status(201).json({ appointment });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not create appointment' });
    }
};

// 🧠 Get Available Slots
exports.getAvailableSlots = async (req, res) => {
    const { teacherSlug } = req.params;
    const { date } = req.query;

    if (!date) return res.status(400).json({ error: 'Date is required (YYYY-MM-DD)' });

    try {
        const teacher = await prisma.user.findFirst({
            where: {
                calendarSlug: {
                    equals: teacherSlug,
                    mode: 'insensitive'
                }
            }
        });

        if (!teacher) return res.status(404).json({ error: 'Teacher not found' });

        // If calendar not connected, return warning
        if (!teacher.googleToken) {
            return res.json({
                availableSlots: [],
                warning: 'Google Calendar not connected for this teacher.',
            });
        }

        // 🔑 Load authorized Google client
        let client;
        try {
            client = await getAuthorizedClientForUser(teacher.id);
        } catch (err) {
            return res.status(400).json({ error: 'Failed to authorize with Google Calendar' });
        }

        const startOfDay = new Date(`${date}T00:00:00.000Z`);
        const endOfDay = new Date(`${date}T23:59:59.999Z`);

        const calendar = google.calendar({ version: 'v3', auth: client });
        const calendarId = teacher.calendarId || 'primary';

        let googleEvents = [];
        try {
            const { data } = await calendar.events.list({
                calendarId,
                timeMin: startOfDay.toISOString(),
                timeMax: endOfDay.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
            });

            googleEvents = (data.items || []).map(event => ({
                startTime: new Date(event.start.dateTime || event.start.date),
                endTime: new Date(event.end.dateTime || event.end.date),
            }));
        } catch (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to fetch events from Google Calendar' });
        }

        });

        const dayStart = new Date(`${date}T10:00:00.000Z`);
        const dayEnd = new Date(`${date}T18:00:00.000Z`);

        const slots = [];
        let current = new Date(dayStart);

        while (current < dayEnd) {
            const next = new Date(current.getTime() + SLOT_DURATION_MINUTES * 60000);


            const overlapsGoogle = googleEvents.some(e =>
                e.startTime < next && e.endTime > current
            );

            if (!overlapsGoogle) {
                slots.push({
                    startTime: current.toISOString(),
                    endTime: next.toISOString(),
                });
            }

            current = next;
        }

        res.json({ availableSlots: slots });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error calculating available slots' });
    }
};
