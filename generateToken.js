// generateToken.js
const { initializeApp } = require("firebase/app");
const { getAuth, signInWithEmailAndPassword } = require("firebase/auth");

// ✅ Paste your web config here from Firebase → Project Settings → General
const firebaseConfig = {
  apiKey: "AIzaSyDH5ZEws-7_iIyuEWbMtCmJhiXvcVv5NwU",
  authDomain: "venuebackend-e7230.firebaseapp.com",
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
