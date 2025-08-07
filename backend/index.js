require('./scheduler');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const session = require('express-session'); // Ensure this is installed
const { google } = require('googleapis');
const {
    loadOAuthClient,
    getAuthUrl,
    setCredentialsFromCode,
    getAuthorizedClientForUser
} = require('./googleAuth');
const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
];
const app = express();
const prisma = new PrismaClient();
const SLOT_DURATION_MINUTES = 30;
const path = require('path');

// Middleware
app.use(express.json()); // Parse JSON bodies
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true in production with HTTPS
}));
app.use(cors());

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});
app.use(express.static(path.join(__dirname, 'public')));
// Load Google OAuth client
loadOAuthClient();

// 🔑 Start Google OAuth
// 🔑 Start Google OAuth
app.get('/auth/google', (req, res) => {
    const mode = req.query.mode || 'login'; // 'create' or 'login'
    const role = req.query.role || 'STUDENT'; // Default to STUDENT
    const isTeacher = role.toUpperCase() === 'TEACHER';

    const authUrl = getAuthUrl(mode, isTeacher); // Pass both
    res.redirect(authUrl);
});



// 🔐 OAuth callback
app.get('/oauth2callback', async (req, res) => {
    const oAuth2Client = loadOAuthClient();
    const { code, state } = req.query;
    if (!code) return res.send('Authentication failed');
    try {
        const { userId, newUser } = await setCredentialsFromCode(code);
        const user = await prisma.user.findUnique({ where: { id: userId } });
        req.session.user = { id: userId, email: user.email }; // Set session user
        if (state === 'create' || newUser) {
            res.redirect('/complete-profile.html');
        } else {
            res.redirect('/index.html');
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('❌ Authentication failed');
    }
});
function generateUniqueSlug(email) {
    return email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + '-' + Date.now();
}


// 👤 Get Teacher Info
app.get('/calendar/:teacherSlug', async (req, res) => {
    const { teacherSlug } = req.params;

    try {
        const teacher = await prisma.user.findUnique({
            where: { calendarSlug: teacherSlug },
        });

        if (!teacher) {
            return res.status(404).json({ error: 'Teacher not found' });
        }

        res.json({
            teacher: {
                id: teacher.id,
                name: teacher.name,
                slug: teacher.calendarSlug,
                plan: teacher.plan,
                googleConnected: !!teacher.googleToken,
                calendarId: teacher.calendarId || 'primary'
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error loading teacher' });
    }
});

// 🧠 Available Slots — from Google Calendar only
app.get('/calendar/:teacherSlug/available-slots', async (req, res) => {
    const { teacherSlug } = req.params;
    const { date } = req.query;

    if (!date) return res.status(400).json({ error: 'Missing date (YYYY-MM-DD)' });

    try {
        const teacher = await prisma.user.findUnique({
            where: { calendarSlug: teacherSlug },
        });

        if (!teacher) return res.status(404).json({ error: 'Teacher not found' });
        if (!teacher.googleToken) {
            return res.json({
                availableSlots: [],
                warning: 'Google Calendar not connected for this teacher.',
            });
        }

        const client = await getAuthorizedClientForUser(teacher.id);
        const calendar = google.calendar({ version: 'v3', auth: client });

        const timeZone = 'America/Los_Angeles';
        const { DateTime } = require('luxon');

        // Full calendar day in local time zone (midnight to 11:59 PM)
        const dayStart = DateTime.fromISO(date, { zone: timeZone }).startOf('day');
        const dayEnd = dayStart.endOf('day');
        if (dayStart.weekday === 6 || dayStart.weekday === 7) {
            return res.json({
                availableSlots: [],
                message: 'No availability on weekends.'
            });
        }
        // Convert to UTC for the calendar API
        const startOfDay = dayStart.toUTC().toJSDate();
        const endOfDay = dayEnd.toUTC().toJSDate();



        const calendarList = await calendar.calendarList.list();
        const allCalendars = calendarList.data.items || [];

        let googleEvents = [];

        for (const cal of allCalendars) {
            try {
                const { data } = await calendar.events.list({
                    calendarId: cal.id,
                    timeMin: startOfDay,
                    timeMax: endOfDay,
                    singleEvents: true,
                    orderBy: 'startTime',
                });

                const events = (data.items || []).map(event => {
                    // 🔴 Skip all-day events (those with only `date`)
                    if (!event.start.dateTime || !event.end.dateTime) return null;

                    return {
                        startTime: new Date(event.start.dateTime),
                        endTime: new Date(event.end.dateTime),
                    };
                }).filter(Boolean); // remove nulls

                googleEvents.push(...events);
            } catch (err) {
                console.warn(`⚠️ Could not fetch from calendar ${cal.id}: ${err.message}`);
            }
        }



        const workingStartStr = teacher.workingStart || '10:00';
        const workingEndStr = teacher.workingEnd || '18:00';

        const workingStart = DateTime.fromISO(`${date}T${workingStartStr}`, { zone: timeZone }).toUTC();
        const workingEnd = DateTime.fromISO(`${date}T${workingEndStr}`, { zone: timeZone }).toUTC();

        const slots = [];
        let current = workingStart;

        while (current.plus({ minutes: SLOT_DURATION_MINUTES }) <= workingEnd) {
            const next = current.plus({ minutes: SLOT_DURATION_MINUTES });

            const overlaps = googleEvents.some(event => {
                const evStart = DateTime.fromJSDate(event.startTime).toUTC();
                const evEnd = DateTime.fromJSDate(event.endTime).toUTC();

                return evStart < next && evEnd > current;
            });

            if (!overlaps) {
                slots.push({
                    startTime: current.toISO(),
                    endTime: next.toISO()
                });
            }


            current = next;
        }

        res.json({ availableSlots: slots });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not fetch available slots' });
    }
});


// ✅ Book Appointment — write only to Google Calendar
app.post('/calendar/book', async (req, res) => {
    const { teacherId, studentId, studentName, studentEmail, startTime, endTime } = req.body;

    if (!teacherId || !studentId || !studentName || !studentEmail || !startTime || !endTime) {
        return res.status(400).json({ error: 'Missing fields in request' });
    }

    try {
        // 👤 Fetch teacher info
        const teacher = await prisma.user.findUnique({
            where: { id: teacherId },
        });
        if (!teacher || teacher.role !== 'TEACHER') {
            return res.status(404).json({ error: 'Teacher not found' });
        }

        // 👤 Validate student
        const student = await prisma.user.findUnique({
            where: { id: studentId },
        });
        if (!student || student.role !== 'STUDENT') {
            return res.status(404).json({ error: 'Student not found' });
        }

        // ⏳ Enforce 24-hour advance booking restriction
        const { DateTime } = require('luxon');
        const now = DateTime.utc();
        const lessonStart = DateTime.fromISO(startTime).toUTC();
        const hoursUntilLesson = lessonStart.diff(now, 'hours').hours;

        if (hoursUntilLesson < 24) {
            return res.status(403).json({
                error: 'Bookings must be made at least 24 hours in advance.',
            });
        }

        // 📅 Create Google Calendar event
        const calendarId = teacher.calendarId || 'primary';
        const client = await getAuthorizedClientForUser(teacherId);
        const calendar = google.calendar({ version: 'v3', auth: client });

        const event = await calendar.events.insert({
            calendarId,
            requestBody: {
                summary: `${studentName}`,
                description: `Music lesson with ${studentName} (${studentEmail}, Student ID: ${studentId})`,
                start: { dateTime: startTime },
                end: { dateTime: endTime },
                extendedProperties: {
                    private: {
                        studentId: studentId.toString(),
                    },
                },
            },
        });

        // ✉️ Send confirmation email to officeEmail and CC teacher
        try {
            const gmail = google.gmail({ version: 'v1', auth: client });

            const formattedStart = DateTime.fromISO(startTime).setZone('America/Los_Angeles').toFormat("cccc, LLLL d 'at' h:mm a");
            const formattedEnd = DateTime.fromISO(endTime).setZone('America/Los_Angeles').toFormat("h:mm a");

            const subject = `New Lesson Booked: ${student.firstName} ${student.lastName}`;
            const messageText = `Hello,

${student.firstName} ${student.lastName} has booked a lesson.

Scheduled Time: ${formattedStart} to ${formattedEnd}

Student Email: ${student.email}

Best,
${teacher.firstName}`;

            const raw = Buffer.from(
                `To: ${teacher.officeEmail}\r\n` +
                `Cc: ${teacher.email}\r\n` +
                `Subject: ${subject}\r\n` +
                `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
                `${messageText}`
            ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw }
            });

            console.log(`📧 Booking confirmation sent to ${teacher.officeEmail}`);
        } catch (err) {
            console.warn(`⚠️ Failed to send booking email: ${err.message}`);
        }

        res.status(201).json({ message: '✅ Appointment created in Google Calendar' });

    } catch (err) {
        console.error('⚠️ Google Calendar insert failed:', err.message);
        res.status(500).json({ error: 'Failed to create appointment in Google Calendar' });
    }
});



const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// GET /calendar/:slug/events
app.get('/calendar/:teacherSlug/events', async (req, res) => {
    const { teacherSlug } = req.params;
    const { start, end } = req.query;
    try {
        // Validate query parameters
        if (!start || !end) {
            return res.status(400).json({ error: 'Missing start or end query parameters' });
        }
        // Ensure start and end are valid RFC3339 dates
        const timeMin = new Date(`${start}T00:00:00Z`).toISOString();
        const timeMax = new Date(`${end}T23:59:59Z`).toISOString();
        if (isNaN(new Date(timeMin)) || isNaN(new Date(timeMax))) {
            return res.status(400).json({ error: 'Invalid start or end date format' });
        }

        // 👤 Fetch teacher info to get calendarId
        const teacher = await prisma.user.findUnique({
            where: { calendarSlug: teacherSlug },
        });
        if (!teacher || !teacher.googleToken) {
            return res.json([]);
        }

        // 📅 Get authorized Google Calendar client
        const client = await getAuthorizedClientForUser(teacher.id);
        if (!client) {
            return res.status(401).json({ error: 'Failed to authenticate with Google Calendar' });
        }
        const calendar = google.calendar({ version: 'v3', auth: client });
        const calendarId = teacher.calendarId || 'primary';

        // 📅 Fetch events from Google Calendar
        const { data } = await calendar.events.list({
            calendarId,
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: 'startTime',
        });

        // Map events to include required fields
        const events = (data.items || []).map(event => ({
            summary: event.summary || '(No title)',
            startTime: event.start.dateTime || event.start.date,
            endTime: event.end.dateTime || event.end.date,
            eventId: event.id,
            studentId: event.extendedProperties?.private?.studentId || null,
        }));

        res.json(events);
    } catch (err) {
        console.error('Failed to fetch events:', JSON.stringify(err, null, 2));
        res.status(500).json([]);
    }
});
app.get('/teachers', async (req, res) => {
    try {
        const teachers = await prisma.user.findMany({
            where: { role: 'TEACHER' },
            select: { id: true, firstName: true, lastName: true }
        });
        res.json({ teachers });
    } catch (err) {
        console.error('Error fetching teachers:', err);
        res.status(500).json({ error: 'Failed to fetch teachers' });
    }
});

app.post('/signup', async (req, res) => {
    const {
        name,
        email,
        password,
        role,
        calendarSlug,
        workingStart,
        workingEnd,
        teacherId
    } = req.body;

    try {
        const passwordHash = await bcrypt.hash(password, 10);

        const user = await prisma.user.create({
            data: {
                name,
                email,
                passwordHash,
                role,
                calendarSlug: role === 'TEACHER' ? calendarSlug : null,
                workingStart: role === 'TEACHER' ? workingStart : null,
                workingEnd: role === 'TEACHER' ? workingEnd : null,
                teacher: role === 'STUDENT' ? { connect: { id: teacherId } } : undefined
            }
        });

        res.status(201).json({ userId: user.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Signup failed' });
    }
});

app.post('/complete-profile', async (req, res) => {
    const { officeEmail, firstName, lastName, role, workingStart, workingEnd, teacherId, calendarId } = req.body || {};
    try {
        const email = req.session?.user?.email;
        if (!email) return res.status(401).json({ error: 'Not signed in' });
        const existingUser = await prisma.user.findUnique({ where: { email } });
        if (!existingUser) return res.status(404).json({ error: 'User not found' });
        if (!firstName || !lastName || !role) return res.status(400).json({ error: 'First name, last name, and role are required' });
        if (role === 'TEACHER' && (!workingStart || !workingEnd)) return res.status(400).json({ error: 'Working start and end required for teachers' });
        if (role === 'TEACHER' && !calendarId) return res.status(400).json({ error: 'Calendar ID required for teachers' });
        if (role === 'TEACHER' && !officeEmail) return res.status(400).json({ error: 'Office Email required for teachers' });
        if (role === 'STUDENT' && !teacherId) return res.status(400).json({ error: 'Teacher selection required for students' });

        let calendarSlug = null;
        let teacherCalendarSlug = null;
        if (role === 'TEACHER') {
            calendarSlug = generateUniqueSlug(firstName);
        } else if (role === 'STUDENT') {
            const teacher = await prisma.user.findUnique({ where: { id: teacherId } });
            if (!teacher || teacher.role !== 'TEACHER') return res.status(400).json({ error: 'Invalid teacher selection' });
            teacherCalendarSlug = teacher.calendarSlug;
            if (!teacherCalendarSlug) return res.status(400).json({ error: 'Teacher has no calendar slug' }); // Debug
        }

        const updatedUser = await prisma.user.update({
            where: { id: existingUser.id },
            data: {
                firstName,
                lastName,
                role,
                calendarSlug: role === 'TEACHER' ? calendarSlug : null,
                workingStart: role === 'TEACHER' ? workingStart : null,
                calendarId: role === 'TEACHER' ? calendarId : null,
                workingEnd: role === 'TEACHER' ? workingEnd : null,
                teacherId: role === 'STUDENT' ? teacherCalendarSlug : null,
                officeEmail: role === 'TEACHER' ? officeEmail : null,
            }
        });
        req.session.user = { id: existingUser.id, email: existingUser.email };
        res.json({ message: 'Profile updated', user: updatedUser });
    } catch (err) {
        console.error('❌ Failed to complete profile:', err.message);
        res.status(500).json({ error: 'Server error completing profile' });
    }
});

function generateUniqueSlug(firstName) {
    const randomNum = Math.floor(1000 + Math.random() * 9000); // Generates 1000-9999
    return firstName.replace(/[^a-zA-Z0-9]/g, '') + '-' + randomNum;
}


app.get('/me', async (req, res) => {
    try {
        const userId = req.session?.user?.id; // Match session structure
        if (!userId) {
            return res.status(401).json({ error: 'Not signed in' });
        }
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                plan: true,
                googleToken: true,
                createdAt: true,
                role: true,
                calendarSlug: true,
                workingStart: true,
                workingEnd: true,
                teacherId: true,
                calendarId: true,
                officeEmail: true
            }
        });
        if (user.role === 'TEACHER' && user.calendarId) {
            const client = await getAuthorizedClientForUser(user.id);
            const calendar = google.calendar({ version: 'v3', auth: client });
            try {
                const calendarData = await calendar.calendarList.get({
                    calendarId: user.calendarId,
                });
                user.calendarSummary = calendarData.data.summary;
            } catch (err) {
                console.error("Error fetching calendar summary:", err.message);
                user.calendarSummary = 'Unknown Calendar';
            }
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ user });
    } catch (err) {
        console.error('❌ Failed to get user:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Logout failed:', err);
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.redirect('/');
    });
});

app.get('/settings/personal', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) {
            return res.redirect('/');
        }
        res.sendFile(path.join(__dirname, 'public', 'personal-info.html'));
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.get('/settings/account', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) {
            return res.redirect('/');
        }
        res.sendFile(path.join(__dirname, 'public', 'account-info.html'));
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

app.delete('/calendar/cancel', async (req, res) => {
    const { eventId, studentId, teacherId } = req.body;

    if (!eventId || !studentId || !teacherId) {
        return res.status(400).json({ error: 'Missing eventId, studentId, or teacherId' });
    }

    try {
        // 👤 Fetch teacher info
        const teacher = await prisma.user.findUnique({
            where: { id: teacherId },
        });
        if (!teacher || teacher.role !== 'TEACHER') {
            return res.status(404).json({ error: 'Teacher not found' });
        }

        // 👤 Validate student
        const student = await prisma.user.findUnique({
            where: { id: studentId },
        });
        if (!student || student.role !== 'STUDENT') {
            return res.status(404).json({ error: 'Student not found' });
        }

        // 🔐 Verify authenticated user matches studentId
        if (!req.session?.user || req.session.user.id !== studentId) {
            return res.status(403).json({ error: 'Unauthorized: Invalid student ID' });
        }

        const calendarId = teacher.calendarId || 'primary';
        const client = await getAuthorizedClientForUser(teacherId);
        const calendar = google.calendar({ version: 'v3', auth: client });

        // 📅 Fetch event to verify studentId and get event details
        const event = await calendar.events.get({
            calendarId,
            eventId,
        });

        if (
            !event.data.extendedProperties?.private?.studentId ||
            event.data.extendedProperties.private.studentId !== studentId.toString()
        ) {
            return res.status(403).json({ error: 'Unauthorized: You cannot cancel this event' });
        }

        // ⏳ Enforce 24-hour cancellation window
        const { DateTime } = require('luxon');
        const startTimeISO = event.data.start?.dateTime || event.data.start?.date;
        if (!startTimeISO) {
            return res.status(400).json({ error: 'Event start time is missing' });
        }

        const now = DateTime.utc();
        const eventStart = DateTime.fromISO(startTimeISO).toUTC();
        const hoursUntilEvent = eventStart.diff(now, 'hours').hours;

        if (hoursUntilEvent < 24) {
            return res.status(403).json({
                error: 'Cancellations are not allowed within 24 hours of the lesson start time.',
            });
        }

        // 🗑️ Delete Google Calendar event
        await calendar.events.delete({
            calendarId,
            eventId,
        });

        // ✉️ Send email to teacher to notify of cancellation
        try {
            const gmail = google.gmail({ version: 'v1', auth: client });

            const endTimeISO = event.data.end?.dateTime || event.data.end?.date;
            const startTime = DateTime.fromISO(startTimeISO).setZone('America/Los_Angeles').toFormat("cccc, LLLL d 'at' h:mm a");
            const endTime = endTimeISO
                ? DateTime.fromISO(endTimeISO).setZone('America/Los_Angeles').toFormat("h:mm a")
                : 'an unknown time';

            const subject = `Lesson Cancelled: ${student.firstName} ${student.lastName}`;
            const messageText = `Hello,

${student.firstName} ${student.lastName} has cancelled their lesson scheduled from ${startTime} to ${endTime}.

Thank you,
${teacher.firstName}`;

            const raw = Buffer.from(
                `To: ${teacher.officeEmail}\r\n` +
                `Cc: ${teacher.email}\r\n` +
                `Subject: ${subject}\r\n` +
                `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
                `${messageText}`
            ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: { raw }
            });

            console.log(`📧 Cancellation notice sent to ${teacher.officeEmail}`);
        } catch (err) {
            console.warn(`⚠️ Failed to send cancellation email: ${err.message}`);
        }

        res.status(200).json({ message: '✅ Lesson cancelled' });

    } catch (err) {
        console.error('⚠️ Google Calendar delete failed:', err.message);
        res.status(500).json({ error: 'Failed to cancel lesson' });
    }
});



app.get('/google-calendars/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const auth = await getAuthorizedClientForUser(userId);
        const calendar = google.calendar({ version: 'v3', auth });
        const result = await calendar.calendarList.list();
        const calendars = result.data.items.map(cal => ({
            id: cal.id,
            summary: cal.summary
        }));
        res.json({ calendars });
    } catch (err) {
        console.error('❌ Failed to fetch calendar list:', err);
        res.status(500).json({ error: 'Failed to fetch calendar list' });
    }
});

app.patch('/google-calendars/:userId', async (req, res) => {
    const { userId } = req.params;
    const { calendarId } = req.body;
    try {
        await prisma.user.update({
            where: { id: userId },
            data: { calendarId }
        });
        res.status(200).json({ message: 'Calendar updated' });
    } catch (err) {
        console.error('❌ Failed to update calendar:', err);
        res.status(500).json({ error: 'Failed to update calendar' });
    }
});
