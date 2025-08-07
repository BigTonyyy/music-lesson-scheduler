const admin = require('firebase-admin');
const path = require('path');

// Path to your service account key JSON file
const serviceAccount = require(path.resolve(__dirname, 'firebase-service-account.json'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

module.exports = admin;
