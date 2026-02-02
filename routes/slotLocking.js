const express = require("express");
const router = express.Router();
const { db } = require("../firebase/firebase");
const { v4: uuidv4 } = require("uuid");
const checkUserAuth = require("../middleware/checkUserAuth");

// Lock expiration time in minutes
const LOCK_EXPIRATION_MINUTES = 10;

// ============================================
// 1. LOCK A SLOT (when user selects it)
// ============================================
router.post("/slots/lock", checkUserAuth, async (req, res) => {
  try {
    const { vendorId, turfId, sport, date, timeSlot } = req.body;
    const userId = req.user.uid;

    if (!vendorId || !turfId || !sport || !date || !timeSlot) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const normalizedSport = sport.trim().toLowerCase();
    const normalizedSlot = timeSlot.trim();

    // Check if already booked
    const bookingSnapshot = await db
      .collection("bookings")
      .where("vendorId", "==", vendorId)
      .where("turfId", "==", turfId)
      .where("sports", "==", normalizedSport)
      .where("date", "==", date)
      .where("timeSlot", "==", normalizedSlot)
      .where("bookingStatus", "==", "confirmed")
      .limit(1)
      .get();

    if (!bookingSnapshot.empty) {
      return res.status(409).json({
        status: "booked",
        message: "Slot already booked",
      });
    }

    // Check if locked by someone else
    const now = new Date();
    const lockSnapshot = await db
      .collection("slot_locks")
      .where("vendorId", "==", vendorId)
      .where("turfId", "==", turfId)
      .where("sport", "==", normalizedSport)
      .where("date", "==", date)
      .where("timeSlot", "==", normalizedSlot)
      .where("status", "==", "locked")
      .get();

    // Filter active locks (not expired)
    const activeLocks = lockSnapshot.docs.filter((doc) => {
      const lockData = doc.data();
      const expiresAt = lockData.expiresAt?.toDate?.() || new Date(lockData.expiresAt);
      return expiresAt > now;
    });

    if (activeLocks.length > 0) {
      const existingLock = activeLocks[0].data();
      if (existingLock.userId !== userId) {
        const expiresAt = existingLock.expiresAt?.toDate?.() || new Date(existingLock.expiresAt);
        return res.status(409).json({
          status: "locked",
          message: "Slot is being booked by another user",
          expiresIn: Math.ceil((expiresAt - now) / 1000),
        });
      } else {
        // User already has a lock on this slot, extend it
        const lockId = activeLocks[0].id;
        const newExpiresAt = new Date(now.getTime() + LOCK_EXPIRATION_MINUTES * 60 * 1000);

        await db.collection("slot_locks").doc(lockId).update({
          expiresAt: newExpiresAt,
          lockedAt: now,
        });

        return res.status(200).json({
          status: "success",
          lockId,
          expiresAt: newExpiresAt,
          message: "Lock extended for 10 minutes",
        });
      }
    }

    // Create new lock
    const lockId = uuidv4();
    const expiresAt = new Date(now.getTime() + LOCK_EXPIRATION_MINUTES * 60 * 1000);

    await db.collection("slot_locks").doc(lockId).set({
      lockId,
      vendorId,
      turfId,
      sport: normalizedSport,
      date,
      timeSlot: normalizedSlot,
      userId,
      lockedAt: now,
      expiresAt,
      status: "locked",
    });

    res.status(200).json({
      status: "success",
      lockId,
      expiresAt,
      message: "Slot locked for 10 minutes",
    });
  } catch (err) {
    console.error("Error locking slot:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ============================================
// 2. RELEASE LOCK (when user deselects or times out)
// ============================================
router.delete("/slots/unlock/:lockId", checkUserAuth, async (req, res) => {
  try {
    const { lockId } = req.params;
    const userId = req.user.uid;

    const lockRef = db.collection("slot_locks").doc(lockId);
    const lockDoc = await lockRef.get();

    if (!lockDoc.exists) {
      return res.status(404).json({ message: "Lock not found" });
    }

    if (lockDoc.data().userId !== userId) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    await lockRef.delete();
    res.status(200).json({ message: "Lock released" });
  } catch (err) {
    console.error("Error releasing lock:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ============================================
// 3. GET REAL-TIME SLOT STATUS (for polling)
// ============================================
router.post("/slots/status", checkUserAuth, async (req, res) => {
  try {
    const { vendorId, turfId, sport, date, timeSlots } = req.body;
    const userId = req.user.uid;
    const now = new Date();

    if (!vendorId || !turfId || !sport || !date || !timeSlots) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const normalizedSport = sport.trim().toLowerCase();

    const slotStatuses = await Promise.all(
      timeSlots.map(async (slot) => {
        const normalizedSlot = slot.trim();

        // Check if booked
        const bookedSnapshot = await db
          .collection("bookings")
          .where("vendorId", "==", vendorId)
          .where("turfId", "==", turfId)
          .where("sports", "==", normalizedSport)
          .where("date", "==", date)
          .where("timeSlot", "==", normalizedSlot)
          .where("bookingStatus", "==", "confirmed")
          .limit(1)
          .get();

        if (!bookedSnapshot.empty) {
          return { slot, status: "booked" };
        }

        // Check if locked
        const lockSnapshot = await db
          .collection("slot_locks")
          .where("vendorId", "==", vendorId)
          .where("turfId", "==", turfId)
          .where("sport", "==", normalizedSport)
          .where("date", "==", date)
          .where("timeSlot", "==", normalizedSlot)
          .where("status", "==", "locked")
          .get();

        // Filter active locks
        const activeLocks = lockSnapshot.docs.filter((doc) => {
          const lockData = doc.data();
          const expiresAt = lockData.expiresAt?.toDate?.() || new Date(lockData.expiresAt);
          return expiresAt > now;
        });

        if (activeLocks.length > 0) {
          const lockData = activeLocks[0].data();
          const expiresAt = lockData.expiresAt?.toDate?.() || new Date(lockData.expiresAt);

          // If user owns the lock, mark as "selected" instead of "locked"
          if (lockData.userId === userId) {
            return {
              slot,
              status: "selected",
              lockId: lockData.lockId,
              expiresAt,
            };
          }

          return {
            slot,
            status: "locked",
            expiresAt,
          };
        }

        return { slot, status: "available" };
      })
    );

    res.status(200).json({ slotStatuses });
  } catch (err) {
    console.error("Error getting slot status:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ============================================
// 4. CONFIRM LOCK (after successful payment)
// ============================================
router.patch("/slots/confirm/:lockId", checkUserAuth, async (req, res) => {
  try {
    const { lockId } = req.params;
    const userId = req.user.uid;

    const lockRef = db.collection("slot_locks").doc(lockId);
    const lockDoc = await lockRef.get();

    if (!lockDoc.exists) {
      return res.status(404).json({ message: "Lock not found" });
    }

    if (lockDoc.data().userId !== userId) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    await lockRef.update({
      status: "confirmed",
      confirmedAt: new Date(),
    });

    res.status(200).json({ message: "Lock confirmed" });
  } catch (err) {
    console.error("Error confirming lock:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ============================================
// 5. CLEANUP EXPIRED LOCKS (can be called by cron/Cloud Function)
// ============================================
router.post("/slots/cleanup", async (req, res) => {
  try {
    const now = new Date();
    const expiredLocksSnapshot = await db
      .collection("slot_locks")
      .where("status", "==", "locked")
      .where("expiresAt", "<=", now)
      .get();

    if (expiredLocksSnapshot.empty) {
      return res.status(200).json({
        message: "No expired locks to clean up",
        cleaned: 0,
      });
    }

    const batch = db.batch();
    expiredLocksSnapshot.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    res.status(200).json({
      message: `Cleaned up ${expiredLocksSnapshot.size} expired locks`,
      cleaned: expiredLocksSnapshot.size,
    });
  } catch (err) {
    console.error("Error cleaning up locks:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ============================================
// 6. GET USER'S ACTIVE LOCKS
// ============================================
router.get("/slots/my-locks", checkUserAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const now = new Date();

    const locksSnapshot = await db
      .collection("slot_locks")
      .where("userId", "==", userId)
      .where("status", "==", "locked")
      .get();

    // Filter active (non-expired) locks
    const activeLocks = locksSnapshot.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((lock) => {
        const expiresAt = lock.expiresAt?.toDate?.() || new Date(lock.expiresAt);
        return expiresAt > now;
      });

    res.status(200).json({ locks: activeLocks });
  } catch (err) {
    console.error("Error fetching user locks:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ============================================
// 7. RELEASE ALL USER LOCKS (for cleanup on logout/app close)
// ============================================
router.delete("/slots/release-all", checkUserAuth, async (req, res) => {
  try {
    const userId = req.user.uid;

    const locksSnapshot = await db
      .collection("slot_locks")
      .where("userId", "==", userId)
      .where("status", "==", "locked")
      .get();

    if (locksSnapshot.empty) {
      return res.status(200).json({ message: "No locks to release", released: 0 });
    }

    const batch = db.batch();
    locksSnapshot.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();

    res.status(200).json({
      message: `Released ${locksSnapshot.size} locks`,
      released: locksSnapshot.size,
    });
  } catch (err) {
    console.error("Error releasing all locks:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
