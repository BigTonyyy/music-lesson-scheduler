const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');
const cron = require('node-cron');
const { refreshTokenIfNeeded } = require('./googleAuth');
const { DateTime } = require('luxon');
const prisma = new PrismaClient();

async function sendStudentReminders() {
    console.log('🔔 Sending student reminders...');

    const teachers = await prisma.user.findMany({
        where: {
            role: 'TEACHER',
            googleToken: { not: null },
            calendarId: { not: null }
        }
    });

    const now = new Date();
    const baseTime = now.getTime() + 48 * 60 * 60 * 1000;
    
    const in48HoursStart = new Date(baseTime - 30 * 1000); // 48h minus 30 sec
    const in48HoursEnd = new Date(baseTime + 30 * 1000);   // 48h plus 30 sec
    

    console.log('🕓 Reminder Time Window');
    console.log('   now:              ', now.toISOString());
    console.log('   48h window start: ', in48HoursStart.toISOString());
    console.log('   48h window end:   ', in48HoursEnd.toISOString());

    for (const teacher of teachers) {
        try {
            const authClient = await refreshTokenIfNeeded(teacher.googleToken);
            const calendar = google.calendar({ version: 'v3', auth: authClient });
            const gmail = google.gmail({ version: 'v1', auth: authClient });

            const eventsRes = await calendar.events.list({
                calendarId: teacher.calendarId,
                timeMin: in48HoursStart.toISOString(),
                timeMax: in48HoursEnd.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
            });

            const events = eventsRes.data.items || [];

            for (const event of events) {
                console.log(`📆 Event Summary: ${event.summary}`);
                console.log(`   event.id: ${event.id}`);
                console.log(`   start: ${event.start?.dateTime || event.start?.date}`);
                console.log(`   end:   ${event.end?.dateTime || event.end?.date}`);

                // 🔒 Skip all-day events
                if (!event.start?.dateTime) {
                    console.log(`⏭️ Skipping all-day event: ${event.summary}`);
                    continue;
                }

                // 🎯 Enforce exact match to the 2-minute window
                const eventStart = DateTime.fromISO(event.start.dateTime);
                const windowStart = DateTime.fromJSDate(in48HoursStart);
                const windowEnd = DateTime.fromJSDate(in48HoursEnd);

                if (eventStart < windowStart || eventStart > windowEnd) {
                    console.log(`⏭️ Skipping: ${event.summary} at ${eventStart.toISO()} — outside 48h window`);
                    continue;
                }

                const summary = event.summary || '';
                const studentName = summary.split(' ')[0];
                const student = await prisma.user.findFirst({
                    where: {
                        role: 'STUDENT',
                        OR: [
                            { firstName: { contains: studentName } },
                            { lastName: { contains: studentName } }
                        ],
                        teacherId: teacher.calendarSlug
                    }
                });

                if (student?.email) {
                    const subject = 'Reminder: Lesson in 2 Days';
                    const text = `Hi ${student.firstName},

This is a friendly reminder that you have a lesson with ${teacher.firstName} on ${eventStart.toLocaleString(DateTime.DATETIME_MED)}.

See you then!

– ${teacher.firstName}
`;

                    const raw = Buffer.from(
                        `To: ${student.email}\r\n` +
                        `Subject: ${subject}\r\n\r\n` +
                        `${text}`
                    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

                    await gmail.users.messages.send({
                        userId: 'me',
                        requestBody: {
                            raw
                        }
                    });

                    console.log(`📧 Reminder sent to ${student.email}`);
                }
            }
        } catch (err) {
            console.error(`❌ Reminder failed for teacher ${teacher.email}: ${err.message}`);
        }
    }
}


async function sendWeeklyScheduleEmail() {
    console.log('📅 Running weekly teacher schedule job...');

    const teachers = await prisma.user.findMany({
        where: {
            role: 'TEACHER',
            googleToken: { not: null },
            officeEmail: { not: null }
        }
    });

    for (const teacher of teachers) {
        try {
            const auth = await refreshTokenIfNeeded(teacher.googleToken);

            const calendar = google.calendar({ version: 'v3', auth });

            const startOfWeek = new Date();
            const endOfWeek = new Date();
            startOfWeek.setHours(0, 0, 0, 0);
            endOfWeek.setDate(endOfWeek.getDate() + 7);

            const eventsRes = await calendar.events.list({
                calendarId: teacher.calendarId || 'primary',
                timeMin: startOfWeek.toISOString(),
                timeMax: endOfWeek.toISOString(),
                singleEvents: true,
                orderBy: 'startTime',
            });

            const events = eventsRes.data.items || [];

            const scheduleByDay = {};

            for (const event of events) {
                const start = DateTime.fromISO(event.start.dateTime || event.start.date);
                const end = DateTime.fromISO(event.end.dateTime || event.end.date);
                const weekday = start.toFormat('cccc');

                if (!scheduleByDay[weekday]) {
                    scheduleByDay[weekday] = [];
                }

                scheduleByDay[weekday].push([start, end]);
            }

            function mergeTimeBlocks(blocks) {
                if (blocks.length === 0) return [];

                blocks.sort((a, b) => a[0] - b[0]);

                const merged = [blocks[0]];
                for (let i = 1; i < blocks.length; i++) {
                    const [lastStart, lastEnd] = merged[merged.length - 1];
                    const [currentStart, currentEnd] = blocks[i];

                    if (currentStart <= lastEnd) {
                        merged[merged.length - 1][1] = DateTime.max(lastEnd, currentEnd);
                    } else {
                        merged.push([currentStart, currentEnd]);
                    }
                }
                return merged;
            }

            const formattedDays = Object.entries(scheduleByDay).map(([day, blocks]) => {
                const mergedBlocks = mergeTimeBlocks(blocks);
                const timeStrings = mergedBlocks.map(([start, end]) => {
                    return `${start.toFormat('h:mm')}-${end.toFormat('h:mm a')}`;
                });
                return `${day}: ${timeStrings.join(', ')}`;
            });

            const body = formattedDays.length
                ? formattedDays.join('\n')
                : 'No upcoming events.';

            const gmail = google.gmail({ version: 'v1', auth });

            const subject = `Weekly Schedule for ${teacher.firstName || teacher.email}`;
            const messageText = `Hello,\n\nHere is my schedule for this week:\n\n${body}\n\nBest,\n${teacher.firstName}`;

            const rawMessage = createRawEmail({
                to: teacher.officeEmail,
                from: teacher.email,
                subject,
                text: messageText
            });

            await gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: rawMessage
                }
            });

            console.log(`📤 Sent schedule for ${teacher.email} → ${teacher.officeEmail}`);

        } catch (err) {
            console.error(`❌ Failed for ${teacher.email}:`, err.message);
        }
    }
}

// Helper to encode message in base64 for Gmail API
function createRawEmail({ to, from, subject, text }) {
    const message = [
        `To: ${to}`,
        `From: ${from}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        text
    ].join('\n');

    return Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// CRON SCHEDULING
// 🔁 Weekly email (e.g., Sunday 5pm): change to '0 17 * * 0' for production
cron.schedule('0 17 * * 0', async () => {
    await sendWeeklyScheduleEmail();
});


// 🔔 Student reminder: every hour at minute 0
cron.schedule('* * * * *', sendStudentReminders);

console.log('⏰ Scheduler running using Gmail API...');
