const admin = require("firebase-admin");
// const serviceAccount = require("./serviceAccountKey.json"); //Uncomment if using a local service account key
// const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// });
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = admin.firestore();

// Configure Firestore settings to prevent timeout issues
const settings = {
  timestampsInSnapshots: true,
  ignoreUndefinedProperties: true,
};
db.settings(settings);
const auth = admin.auth();
module.exports = { admin, db, auth };