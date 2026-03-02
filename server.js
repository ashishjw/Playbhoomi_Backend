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

  // Booking reminder notifications — runs every 2 hours
  const { createNotification } = require("./utils/notificationHelper");
  const REMINDER_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

  const sendBookingReminders = async () => {
    try {
      const now = new Date();
      const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const dateStr = twoHoursLater.toISOString().split("T")[0];

      const bookingsSnapshot = await db
        .collection("bookings")
        .where("date", "==", dateStr)
        .where("bookingStatus", "==", "confirmed")
        .get();

      if (bookingsSnapshot.empty) {
        console.log("[Reminder] No bookings found for reminder window");
        return;
      }

      let sent = 0;
      for (const doc of bookingsSnapshot.docs) {
        const booking = doc.data();
        if (!booking.timeSlot) continue;

        const [start] = booking.timeSlot.split(" - ");
        const [slotHour, slotMin] = start.split(":").map(Number);
        const slotTime = new Date(twoHoursLater);
        slotTime.setHours(slotHour, slotMin, 0, 0);

        const diff = slotTime.getTime() - now.getTime();
        const isWithin2Hours = diff > 0 && diff <= 2 * 60 * 60 * 1000 + 15 * 60 * 1000;
        if (!isWithin2Hours) continue;

        await createNotification(
          booking.userId,
          "⏰ Booking Reminder",
          `Reminder: Your booking at ${booking.turfName} (${booking.turfLocation}) is today at ${booking.timeSlot}.`,
          "booking_reminder",
          { bookingId: doc.id, turfName: booking.turfName, timeSlot: booking.timeSlot }
        );
        sent++;
      }

      console.log(`[Reminder] Sent ${sent} reminder notification(s)`);
    } catch (err) {
      console.error("[Reminder] Error sending reminders:", err.message);
    }
  };

  // Run reminder check every 2 hours
  setInterval(sendBookingReminders, REMINDER_INTERVAL_MS);
});
