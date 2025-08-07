const admin = require('../config/firebase');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

exports.loginUser = async (req, res) => {
    const { token } = req.body;

    if (!token) {
        return res.status(400).json({ error: 'Token is required' });
    }

    try {
        // Verify Firebase ID token
        const decodedToken = await admin.auth().verifyIdToken(token);
        const { email, name, uid } = decodedToken;

        // Check if user exists
        let user = await prisma.user.findUnique({
            where: { email },
        });

        // If not, create a new user
        if (!user) {
            // Generate a simple slug from the email (before @)
            const slugBase = email.split('@')[0];
            let slug = slugBase;
            let count = 1;

            // Ensure slug is unique
            while (await prisma.user.findUnique({ where: { calendarSlug: slug } })) {
                slug = `${slugBase}${count++}`;
            }

            user = await prisma.user.create({
                data: {
                    email,
                    name: name || null,
                    calendarSlug: slug,
                    plan: 'free',
                },
            });
        }

        res.json({ user });
    } catch (err) {
        console.error('Firebase login error:', err);
        res.status(401).json({ error: 'Invalid or expired Firebase token' });
    }
};
