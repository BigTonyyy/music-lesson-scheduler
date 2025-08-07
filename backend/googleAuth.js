const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
];
let oAuth2Client;

function loadOAuthClient() {
    const content = fs.readFileSync(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.web;
    oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    return oAuth2Client;
}

function getAuthUrl(mode = 'login', role = 'STUDENT') {
    const scopes = [
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
    ];

    if (role === 'TEACHER') {
        scopes.push('https://www.googleapis.com/auth/calendar');
        scopes.push('https://www.googleapis.com/auth/gmail.send');
    } else {
        // Students get readonly access to calendar events
        scopes.push('https://www.googleapis.com/auth/calendar.events.readonly');
    }

    return oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: mode === 'create' ? 'consent' : 'select_account',
        scope: scopes,
        state: `${mode}:${role}`
    });
}




async function setCredentialsFromCode(code) {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log('Tokens:', {
        access_token: tokens.access_token ? 'present' : 'missing',
        scope: tokens.scope,
        token_type: tokens.token_type,
    });
    oAuth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const { data: profile } = await oauth2.userinfo.get();
    const email = profile.email;
    let user = await prisma.user.findUnique({ where: { email } });
    let newUser = false;
    if (!user) {
        // Split profile.name into firstName and lastName (simple split on last space)
        const [firstName, ...lastNameParts] = profile.name.split(' ');
        const lastName = lastNameParts.join(' ');
        user = await prisma.user.create({
            data: {
                email,
                firstName: firstName || '', // First part as firstName
                lastName: lastName || '',   // Remaining parts as lastName
                role: 'STUDENT',            // Default role
                googleToken: tokens,
                calendarId: 'primary',
                calendarSlug: generateUniqueSlug(firstName), // Use firstName for slug
            },
        });
        newUser = true;
    } else {
        await prisma.user.update({
            where: { email },
            data: { googleToken: tokens },
        });
    }
    return { userId: user.id, newUser };
}
// Move generateUniqueSlug here or import from index.js
function generateUniqueSlug(firstName) {
    const randomNum = Math.floor(1000 + Math.random() * 9000); // Generates 1000-9999
    return firstName.replace(/[^a-zA-Z0-9]/g, '') + '-' + randomNum;
}

// Rest of the file remains unchanged
function getCalendarClient(auth) {
    return google.calendar({ version: 'v3', auth });
}

async function getAuthorizedClientForUser(userId) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.googleToken) throw new Error('Google token not found for user.');
    const client = loadOAuthClient();
    client.setCredentials(user.googleToken);
    return client;
}

async function insertEventToGoogleCalendar({ userId, summary, description, startTime, endTime }) {
    const auth = await getAuthorizedClientForUser(userId);
    const calendar = getCalendarClient(auth);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const calendarId = user?.calendarId || 'primary';
    const event = {
        summary,
        description,
        start: {
            dateTime: new Date(startTime).toISOString(),
            timeZone: 'America/Los_Angeles',
        },
        end: {
            dateTime: new Date(endTime).toISOString(),
            timeZone: 'America/Los_Angeles',
        },
    };
    await calendar.events.insert({
        calendarId,
        resource: event,
    });
}

async function listBusySlotsFromGoogleCalendar({ userId, date }) {
    const auth = await getAuthorizedClientForUser(userId);
    const calendar = getCalendarClient(auth);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const calendarId = user?.calendarId || 'primary';
    const start = new Date(`${date}T00:00:00-07:00`).toISOString();
    const end = new Date(`${date}T23:59:59-07:00`).toISOString();
    const res = await calendar.freebusy.query({
        requestBody: {
            timeMin: start,
            timeMax: end,
            timeZone: 'America/Los_Angeles',
            items: [{ id: calendarId }],
        },
    });
    return res.data.calendars[calendarId].busy || [];
}
function getOAuthClientWithToken(token) {
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

async function refreshTokenIfNeeded(token) {
    const client = getOAuthClientWithToken(token);

    try {
        // Attempt to refresh if necessary
        await client.getAccessToken();  // This will auto-refresh if expired
        return client;
    } catch (err) {
        console.error('❌ Failed to refresh token:', err.message);
        throw err;
    }
}

module.exports = {
    loadOAuthClient,
    getAuthUrl,
    setCredentialsFromCode,
    getCalendarClient,
    getAuthorizedClientForUser,
    insertEventToGoogleCalendar,
    listBusySlotsFromGoogleCalendar,
    getOAuthClientWithToken,
    refreshTokenIfNeeded
};

