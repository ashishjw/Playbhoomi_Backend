const express = require("express");
const router = express.Router();
const { db } = require("../firebase/firebase");
const { v4: uuidv4 } = require("uuid");
const checkUserAuth = require("../middleware/checkUserAuth");
const { rejectGuest } = require("../middleware/checkUserAuth");
const { getCourtsForSport, pickAvailableCourt } = require("../utils/courtHelper");

// Lock expiration time in minutes
const LOCK_EXPIRATION_MINUTES = 10;


// ============================================
// 1. LOCK A SLOT (when user selects it)
// ============================================
router.post("/slots/lock", checkUserAuth, rejectGuest, async (req, res) => {
  try {
    const { vendorId, turfId, sport, date, timeSlot } = req.body;
    const userId = req.user.uid;

    if (!vendorId || !turfId || !sport || !date || !timeSlot) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const normalizedSport = sport.trim().toLowerCase();
    const normalizedSlot = timeSlot.trim();
    const now = new Date();

    // Fetch courts configured for this sport
    const allCourts = await getCourtsForSport(vendorId, turfId, normalizedSport);

    // Fetch existing bookings and locks for this slot
    const [bookingSnapshot, lockSnapshot] = await Promise.all([
      db.collection("bookings")
        .where("vendorId", "==", vendorId)
        .where("turfId", "==", turfId)
        .where("sports", "==", normalizedSport)
        .where("date", "==", date)
        .where("timeSlot", "==", normalizedSlot)
        .where("bookingStatus", "==", "confirmed")
        .get(),
      db.collection("slot_locks")
        .where("vendorId", "==", vendorId)
        .where("turfId", "==", turfId)
        .where("sport", "==", normalizedSport)
        .where("date", "==", date)
        .where("timeSlot", "==", normalizedSlot)
        .where("status", "==", "locked")
        .get(),
    ]);

    // Active (non-expired) locks
    const activeLocks = lockSnapshot.docs.filter((doc) => {
      const lockData = doc.data();
      const expiresAt = lockData.expiresAt?.toDate?.() || new Date(lockData.expiresAt);
      return expiresAt > now;
    });

    // If user already has a lock on this slot, extend it
    const existingUserLock = activeLocks.find((d) => d.data().userId === userId);
    if (existingUserLock) {
      const lockId = existingUserLock.id;
      const newExpiresAt = new Date(now.getTime() + LOCK_EXPIRATION_MINUTES * 60 * 1000);
      await db.collection("slot_locks").doc(lockId).update({
        expiresAt: newExpiresAt,
        lockedAt: now,
      });
      return res.status(200).json({
        status: "success",
        lockId,
        expiresAt: newExpiresAt,
        court: existingUserLock.data().court || null,
        message: "Lock extended for 10 minutes",
      });
    }

    // Legacy path: no courts configured → treat as single capacity
    if (allCourts.length === 0) {
      if (bookingSnapshot.size > 0) {
        return res.status(409).json({ status: "booked", message: "Slot already booked" });
      }
      if (activeLocks.length > 0) {
        const existingLock = activeLocks[0].data();
        const expiresAt = existingLock.expiresAt?.toDate?.() || new Date(existingLock.expiresAt);
        return res.status(409).json({
          status: "locked",
          message: "Slot is being booked by another user",
          expiresIn: Math.ceil((expiresAt - now) / 1000),
        });
      }
    } else {
      // Court-aware path: figure out which courts are taken
      const takenCourts = [
        ...bookingSnapshot.docs.map((d) => d.data().court).filter(Boolean),
        ...activeLocks.map((d) => d.data().court).filter(Boolean),
      ];
      const { court: availableCourt, availableCount } = pickAvailableCourt(allCourts, takenCourts);

      if (availableCount === 0 || !availableCourt) {
        return res.status(409).json({
          status: "booked",
          message: "All courts are booked for this slot",
        });
      }

      // Create new lock with the assigned court
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
        court: availableCourt,
        lockedAt: now,
        expiresAt,
        status: "locked",
      });

      return res.status(200).json({
        status: "success",
        lockId,
        expiresAt,
        court: availableCourt,
        message: "Slot locked for 10 minutes",
      });
    }

    // Fallback (no courts, no bookings, no locks) — create a plain lock
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
      court: null,
      lockedAt: now,
      expiresAt,
      status: "locked",
    });

    res.status(200).json({
      status: "success",
      lockId,
      expiresAt,
      court: null,
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
router.delete("/slots/unlock/:lockId", checkUserAuth, rejectGuest, async (req, res) => {
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

    if (lockDoc.data().status !== "locked") {
      return res.status(409).json({ message: "Only active locks can be released" });
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

    // Fetch courts configured for this sport (capacity)
    const allCourts = await getCourtsForSport(vendorId, turfId, normalizedSport);
    // If no courts configured, treat each slot as capacity 1 (legacy behavior)
    const totalCapacity = allCourts.length > 0 ? allCourts.length : 1;

    // Batch queries: bookings + locks for the day
    const [bookedSnapshot, lockSnapshot] = await Promise.all([
      db.collection("bookings")
        .where("vendorId", "==", vendorId)
        .where("turfId", "==", turfId)
        .where("sports", "==", normalizedSport)
        .where("date", "==", date)
        .where("bookingStatus", "==", "confirmed")
        .get(),
      db.collection("slot_locks")
        .where("vendorId", "==", vendorId)
        .where("turfId", "==", turfId)
        .where("sport", "==", normalizedSport)
        .where("date", "==", date)
        .where("status", "==", "locked")
        .get(),
    ]);

    // Count bookings per slot (count of confirmed reservations)
    const bookingsPerSlot = {};
    bookedSnapshot.docs.forEach((doc) => {
      const slot = doc.data().timeSlot;
      bookingsPerSlot[slot] = (bookingsPerSlot[slot] || 0) + 1;
    });

    // Index active locks per slot (and which user holds them)
    const locksPerSlot = {};
    lockSnapshot.docs.forEach((doc) => {
      const lockData = doc.data();
      const expiresAt = lockData.expiresAt?.toDate?.() || new Date(lockData.expiresAt);
      if (expiresAt <= now) return;
      if (!locksPerSlot[lockData.timeSlot]) locksPerSlot[lockData.timeSlot] = [];
      locksPerSlot[lockData.timeSlot].push({
        userId: lockData.userId,
        lockId: lockData.lockId,
        expiresAt,
      });
    });

    // Build response: slot is "booked" only when all courts are taken
    const slotStatuses = timeSlots.map((slot) => {
      const normalizedSlot = slot.trim();
      const bookedCount = bookingsPerSlot[normalizedSlot] || 0;
      const activeLocks = locksPerSlot[normalizedSlot] || [];
      const takenCount = bookedCount + activeLocks.length;

      // Full capacity taken → booked
      if (takenCount >= totalCapacity) {
        // Prefer showing "selected" if one of the locks is the current user's
        const myLock = activeLocks.find((l) => l.userId === userId);
        if (myLock) {
          return { slot, status: "selected", lockId: myLock.lockId, expiresAt: myLock.expiresAt };
        }
        return { slot, status: "booked" };
      }

      // Not full — if current user has a lock here, show selected
      const myLock = activeLocks.find((l) => l.userId === userId);
      if (myLock) {
        return { slot, status: "selected", lockId: myLock.lockId, expiresAt: myLock.expiresAt };
      }

      // Capacity still available
      return { slot, status: "available" };
    });

    res.status(200).json({ slotStatuses });
  } catch (err) {
    console.error("Error getting slot status:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ============================================
// 4. CONFIRM LOCK (after successful payment)
// ============================================
router.patch("/slots/confirm/:lockId", checkUserAuth, rejectGuest, async (req, res) => {
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
router.post("/slots/cleanup", checkUserAuth, async (req, res) => {
  // Only allow admin role
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
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
router.delete("/slots/release-all", checkUserAuth, rejectGuest, async (req, res) => {
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
