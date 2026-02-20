// server.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const adminRoutes = require("./routes/admin");
const vendorRoutes = require("./routes/vendors");
const userRoutes = require("./routes/users");
const uploadRoutes = require("./routes/upload");
const slotLockingRoutes = require("./routes/slotLocking");

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for image uploads
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use("/api", adminRoutes);
app.use("/api", vendorRoutes);
app.use("/api", userRoutes);
app.use("/api", uploadRoutes);
app.use("/api", slotLockingRoutes);

app.get("/", (req, res) => {
    res.send("Backend is Running");
});
// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // Automatic cleanup of expired slot locks every 60 minutes
  const { db } = require("./firebase/firebase");
  const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  const cleanupExpiredLocks = async () => {
    try {
      const now = new Date();
      const expiredSnapshot = await db
        .collection("slot_locks")
        .where("status", "==", "locked")
        .where("expiresAt", "<=", now)
        .get();

      if (expiredSnapshot.empty) {
        console.log("[Lock Cleanup] No expired locks found");
        return;
      }

      const batch = db.batch();
      expiredSnapshot.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      console.log(`[Lock Cleanup] Cleaned up ${expiredSnapshot.size} expired locks`);
    } catch (err) {
      console.error("[Lock Cleanup] Error:", err.message);
    }
  };

  // Run initial cleanup after 1 minute, then every hour
  setTimeout(cleanupExpiredLocks, 60 * 1000);
  setInterval(cleanupExpiredLocks, CLEANUP_INTERVAL_MS);
});
