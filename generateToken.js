// generateToken.js
require("dotenv").config();
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

// ✅ Using Firebase config from environment variables
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

async function getIdToken() {
  try {
    const userCredential = await signInWithEmailAndPassword(
      auth,
      "testuser@gmail.com", // a valid user created in Firebase Auth
      "yourPassword123"
    );

    const idToken = await userCredential.user.getIdToken();
    console.log("✅ Firebase ID Token:\n", idToken);
  } catch (err) {
    console.error("❌ Error getting token:", err.message);
  }
}

getIdToken();
