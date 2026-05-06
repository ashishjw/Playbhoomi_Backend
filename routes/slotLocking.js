const express = require("express");
const router = express.Router();
const { db } = require("../firebase/firebase");
const { v4: uuidv4 } = require("uuid");
const checkUserAuth = require("../middleware/checkUserAuth");
const { rejectGuest } = require("../middleware/checkUserAuth");
const { pickAvailableCourt } = require("../utils/courtHelper");

// Lock expiration time in minutes
const LOCK_EXPIRATION_MINUTES = 10;

const isTruthyFlag = (value) =>
  value === true ||
  value === 1 ||
  (typeof value === "string" && ["1", "true", "yes"].includes(value.toLowerCase()));

const isFalseyFlag = (value) =>
  value === false ||
  value === 0 ||
  (typeof value === "string" && ["0", "false", "no"].includes(value.toLowerCase()));

const isTurfHiddenFromUsers = (turfData = {}) => {
  const status = String(turfData.status || turfData.turfStatus || "").toLowerCase();
  return (
    isTruthyFlag(turfData.deleted) ||
    isTruthyFlag(turfData.isSuspended) ||
    status === "suspended" ||
    status === "inactive" ||
    status === "disabled" ||
    (turfData.isActive !== undefined && isFalseyFlag(turfData.isActive)) ||
    (turfData.active !== undefined && isFalseyFlag(turfData.active))
  );
};

const isVendorHiddenFromUsers = (vendorData = {}) => {
  const status = String(vendorData.status || vendorData.vendorStatus || "").toLowerCase();
  return (
    isTruthyFlag(vendorData.deleted) ||
    isTruthyFlag(vendorData.isSuspended) ||
    status === "suspended" ||
    status === "inactive" ||
    status === "disabled" ||
    (vendorData.isActive !== undefined && isFalseyFlag(vendorData.isActive)) ||
    (vendorData.active !== undefined && isFalseyFlag(vendorData.active))
  );
};

const isVenueHiddenFromUsers = (turfData = {}, vendorData = {}) =>
  isTurfHiddenFromUsers(turfData) || isVendorHiddenFromUsers(vendorData);

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
    const vendorRef = db.collection("vendors").doc(vendorId);
    const turfRef = vendorRef.collection("turfs").doc(turfId);

    const result = await db.runTransaction(async (transaction) => {
      const now = new Date();
      const [vendorDoc, turfDoc, bookingSnapshot, lockSnapshot] = await Promise.all([
        transaction.get(vendorRef),
        transaction.get(turfRef),
        transaction.get(
          db.collection("bookings")
            .where("vendorId", "==", vendorId)
            .where("turfId", "==", turfId)
            .where("sports", "==", normalizedSport)
            .where("date", "==", date)
            .where("timeSlot", "==", normalizedSlot)
            .where("bookingStatus", "==", "confirmed")
        ),
        transaction.get(
          db.collection("slot_locks")
            .where("vendorId", "==", vendorId)
            .where("turfId", "==", turfId)
            .where("sport", "==", normalizedSport)
            .where("date", "==", date)
            .where("timeSlot", "==", normalizedSlot)
            .where("status", "==", "locked")
        ),
      ]);

      if (!vendorDoc.exists) {
        return { code: 404, body: { message: "Vendor not found" } };
      }

      if (!turfDoc.exists) {
        return { code: 404, body: { message: "Turf not found" } };
      }

      const vendorData = vendorDoc.data();
      const turfData = turfDoc.data();
      if (isVenueHiddenFromUsers(turfData, vendorData)) {
        return {
          code: 409,
          body: {
            status: "unavailable",
            message: "This turf is currently unavailable and cannot accept bookings",
          },
        };
      }

      const sportData = (turfData.sports || []).find(
        (s) => s.name?.toLowerCase() === normalizedSport
      );

      if (!sportData) {
        return { code: 400, body: { message: "Sport not available for this turf" } };
      }

      const allCourts = sportData?.courts || [];
      const activeLocks = lockSnapshot.docs.filter((doc) => {
        const lockData = doc.data();
        const expiresAt = lockData.expiresAt?.toDate?.() || new Date(lockData.expiresAt);
        return expiresAt > now;
      });

      const existingUserLock = activeLocks.find((d) => d.data().userId === userId);
      if (existingUserLock && allCourts.length === 0) {
        const lockData = existingUserLock.data();
        const lockId = lockData.lockId || existingUserLock.id;
        const expiresAt = new Date(now.getTime() + LOCK_EXPIRATION_MINUTES * 60 * 1000);
        transaction.update(existingUserLock.ref, { expiresAt, lockedAt: now });
        return {
          code: 200,
          body: {
            status: "success",
            lockId,
            expiresAt,
            message: "Lock extended for 10 minutes",
          },
        };
      }

      if (allCourts.length === 0) {
        if (bookingSnapshot.size > 0) {
          return { code: 409, body: { status: "booked", message: "Slot already booked" } };
        }
        if (activeLocks.length > 0) {
          const existingLock = activeLocks[0].data();
          const expiresAt = existingLock.expiresAt?.toDate?.() || new Date(existingLock.expiresAt);
          return {
            code: 409,
            body: {
              status: "locked",
              message: "Slot is being booked by another user",
              expiresIn: Math.ceil((expiresAt - now) / 1000),
            },
          };
        }
      } else {
        const takenCourts = [
          ...bookingSnapshot.docs.map((d) => d.data().court).filter(Boolean),
          ...activeLocks.map((d) => d.data().court).filter(Boolean),
        ];
        const { court: availableCourt, availableCount } = pickAvailableCourt(allCourts, takenCourts);

        if (availableCount === 0 || !availableCourt) {
          return {
            code: 409,
            body: {
              status: "booked",
              message: "All courts are booked for this slot",
            },
          };
        }

        const lockId = uuidv4();
        const expiresAt = new Date(now.getTime() + LOCK_EXPIRATION_MINUTES * 60 * 1000);
        const lockRef = db.collection("slot_locks").doc(lockId);
        transaction.set(lockRef, {
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

        return {
          code: 200,
          body: {
            status: "success",
            lockId,
            expiresAt,
            message: "Slot locked for 10 minutes",
          },
        };
      }

      const lockId = uuidv4();
      const expiresAt = new Date(now.getTime() + LOCK_EXPIRATION_MINUTES * 60 * 1000);
      const lockRef = db.collection("slot_locks").doc(lockId);
      transaction.set(lockRef, {
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

      return {
        code: 200,
        body: {
          status: "success",
          lockId,
          expiresAt,
          message: "Slot locked for 10 minutes",
        },
      };
    });

    return res.status(result.code).json(result.body);
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

    const vendorRef = db.collection("vendors").doc(vendorId);
    const turfRef = vendorRef.collection("turfs").doc(turfId);
    const [vendorDoc, turfDoc] = await Promise.all([vendorRef.get(), turfRef.get()]);

    if (!vendorDoc.exists) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    if (!turfDoc.exists) {
      return res.status(404).json({ message: "Turf not found" });
    }

    const vendorData = vendorDoc.data();
    const turfData = turfDoc.data();
    if (isVenueHiddenFromUsers(turfData, vendorData)) {
      return res.status(409).json({
        message: "This turf is currently unavailable and cannot accept bookings",
      });
    }

    const sportData = (turfData.sports || []).find(
      (s) => s.name?.toLowerCase() === normalizedSport
    );
    const allCourts = sportData?.courts || [];
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
      const myLocks = activeLocks.filter((l) => l.userId === userId);
      const availableCount = Math.max(totalCapacity - takenCount, 0);
      const baseStatus = {
        slot,
        capacity: totalCapacity,
        bookedCount,
        lockedCount: activeLocks.length,
        selectedCount: myLocks.length,
        availableCount,
      };

      // Full capacity taken → booked
      if (takenCount >= totalCapacity) {
        // Prefer showing "selected" if one of the locks is the current user's
        const myLock = activeLocks.find((l) => l.userId === userId);
        if (myLock) {
          return {
            ...baseStatus,
            status: "selected",
            lockId: myLock.lockId,
            lockIds: myLocks.map((l) => l.lockId),
            expiresAt: myLock.expiresAt,
          };
        }
        return { ...baseStatus, status: "booked" };
      }

      // Not full — if current user has a lock here, show selected
      const myLock = activeLocks.find((l) => l.userId === userId);
      if (myLock) {
        return {
          ...baseStatus,
          status: "selected",
          lockId: myLock.lockId,
          lockIds: myLocks.map((l) => l.lockId),
          expiresAt: myLock.expiresAt,
        };
      }

      // Capacity still available
      return { ...baseStatus, status: "available" };
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
