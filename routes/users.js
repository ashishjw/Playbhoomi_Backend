const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { auth, db, admin } = require("../firebase/firebase");
const { v4: uuidv4 } = require("uuid");
const haversine = require("haversine-distance");
const checkUserAuth = require("../middleware/checkUserAuth");
const { rejectGuest } = require("../middleware/checkUserAuth");
const { checkAdminAuth } = require("../middleware/auth");
const PDFDocument = require("pdfkit");
const stream = require("stream-buffers");
const { createNotification, sendBookingConfirmedNotification, sendPaymentSuccessNotification } = require("../utils/notificationHelper");
const { sendBookingConfirmationSMS, sendBookingReminderSMS } = require("../utils/smsHelper");
const { sendBookingConfirmationEmail, sendBookingReminderEmail } = require("../utils/emailHelper");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "",
});

const isRazorpayConfigured = () =>
  !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;

// JWT Generator (Your Own Token)
const generateToken = (uid) => {
  return jwt.sign({ uid, role: "user" }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

// 🔄 Shared Function: Register or Login
async function handleFirebaseUser(idToken, res, additionalData = {}) {
  try {
    const decoded = await auth.verifyIdToken(idToken);
    const { uid, email, name, phone_number } = decoded;

    const userRef = db.collection("users").doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      // Save to Firestore on first login
      const userData = {
        authType: decoded.firebase.sign_in_provider, // e.g., "google.com", "password", or "phone"
        createdAt: new Date().toISOString(),
      };

      // Handle phone authentication
      if (decoded.firebase.sign_in_provider === 'phone') {
        userData.phone = phone_number || additionalData.mobile || null;
        userData.name = additionalData.name || 'User';
        // Email might not exist for phone users
        if (email) userData.email = email;
      } else {
        // Handle email/google authentication
        userData.email = email;
        userData.name = name || additionalData.name || "New User";
        userData.phone = phone_number || additionalData.mobile || null;
      }

      await userRef.set(userData);
    }

    const token = generateToken(uid);
    return res.status(200).json({ message: "Success", token });
  } catch (err) {
    console.error("Firebase Token Verification Error:", err);
    return res
      .status(401)
      .json({ message: "Invalid or expired Firebase token" });
  }
}

// ✅ POST /users/register (Handled same as login)
router.post("/users/register", async (req, res) => {
  const { idToken, mobile, name } = req.body;
  if (!idToken) return res.status(400).json({ message: "idToken is required" });

  return handleFirebaseUser(idToken, res, { mobile, name });
});

// ✅ POST /users/login
router.post("/users/login", async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ message: "idToken is required" });

  return handleFirebaseUser(idToken, res);
});

// ✅ POST /users/refresh-token — reissue JWT from a valid Firebase idToken
router.post("/users/refresh-token", async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ message: "idToken is required" });

  return handleFirebaseUser(idToken, res);
});

// ✅ POST /users/google (Same logic)
router.post("/users/google", async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ message: "idToken is required" });

  return handleFirebaseUser(idToken, res);
});

// 🔐 Guest Token Generator
const generateGuestToken = (guestId) => {
  return jwt.sign(
    { guestId, role: "guest" },
    process.env.JWT_SECRET,
    { expiresIn: "2h" } // Guest token valid for 2 hours
  );
};

// ✅ POST /users/guest → Generate temporary guest session
router.post("/users/guest", (req, res) => {
  const guestId = `guest_${uuidv4().slice(0, 8)}`;

  const token = generateGuestToken(guestId);
  return res.status(200).json({
    message: "Guest session started",
    token,
    guestId,
    expiresIn: "2h",
  });
});

const computeBookingSummary = async ({
  vendorId,
  turfId,
  sports,
  selectedSlots,
  date,
}) => {
  const turfRef = db
    .collection("vendors")
    .doc(vendorId)
    .collection("turfs")
    .doc(turfId);
  const turfSnap = await turfRef.get();

  if (!turfSnap.exists) {
    const err = new Error("Turf not found");
    err.status = 404;
    throw err;
  }

  const turfData = turfSnap.data();
  const normalizedSport = sports.trim().toLowerCase();

  const selectedSportData = (turfData.sports || []).find(
    (s) => s.name.toLowerCase() === normalizedSport
  );

  if (!selectedSportData) {
    const err = new Error("Sport not available for this turf");
    err.status = 400;
    throw err;
  }

  let pricePerSlot = selectedSportData.slotPrice || 0;
  if ((selectedSportData.discountedPrice || 0) > 0) {
    pricePerSlot = selectedSportData.discountedPrice;
  }

  const bookingDate = date || new Date().toISOString();
  const day = new Date(bookingDate).getDay();
  const isWeekend = day === 0 || day === 6;

  if (isWeekend && (selectedSportData.weekendPrice || 0) > 0) {
    pricePerSlot = selectedSportData.weekendPrice;
  }

  const totalSlots = selectedSlots.length;
  const baseAmount = pricePerSlot * totalSlots;

  const [taxSnap, settingsSnap] = await Promise.all([
    db.collection("tax").doc("global").get(),
    db.collection("settings").doc("global").get(),
  ]);
  const taxRate = Number(taxSnap.exists ? taxSnap.data().percentage : 0) || 0;
  const taxAmount = Math.round((baseAmount * taxRate) / 100);
  const settingsData = settingsSnap.exists ? settingsSnap.data() : {};
  const convenienceFee = (Number(settingsData.convenienceFee) || 35) * totalSlots;
  const discountRate = Number(settingsData.discountRate) || 10;
  const subtotal = baseAmount + taxAmount + convenienceFee;
  const discountAmount = Math.round((subtotal * discountRate) / 100);
  const finalAmount = subtotal - discountAmount;

  return {
    vendorId,
    turfId,
    turfTitle: turfData.title,
    location: turfData.address,
    selectedSport: normalizedSport,
    selectedSlots,
    date,
    pricePerSlot,
    totalSlots,
    baseAmount,
    taxRate,
    taxAmount,
    convenienceFee,
    discountRate,
    discountAmount,
    finalAmount,
  };
};

// Duplicate /users/refresh-token removed — handled by the route defined at L92 above

// ✅ GET /users/profile → Get user profile
router.get("/users/profile", checkUserAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ message: "User not found" });
    }

    const userData = userDoc.data();
    res.status(200).json({ 
      user: {
        uid: userId,
        email: userData.email,
        name: userData.name,
        phone: userData.phone,
        photoURL: userData.photoURL,
        authType: userData.authType,
        createdAt: userData.createdAt,
      }
    });
  } catch (error) {
    console.error("Error fetching profile:", error);
    res.status(500).json({ message: "Failed to fetch profile" });
  }
});

// ✅ PUT /users/profile → Update user profile
router.put("/users/profile", checkUserAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { name, phone, photoURL } = req.body;

    const userRef = db.collection("users").doc(userId);
    const updateData = {};

    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (photoURL) updateData.photoURL = photoURL;

    await userRef.update(updateData);

    res.status(200).json({ 
      message: "Profile updated successfully",
      user: updateData 
    });
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// ✅ GET /users/notifications → Get user notifications
router.get("/users/notifications", checkUserAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    
    const notificationsSnapshot = await db
      .collection("notifications")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    const notifications = notificationsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ notifications });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
});

// ✅ PUT /users/notifications/:id/read → Mark notification as read
router.put("/users/notifications/:id/read", checkUserAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const notificationId = req.params.id;

    const notificationRef = db.collection("notifications").doc(notificationId);
    const notificationDoc = await notificationRef.get();

    if (!notificationDoc.exists) {
      return res.status(404).json({ message: "Notification not found" });
    }

    // Verify notification belongs to user
    if (notificationDoc.data().userId !== userId) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    await notificationRef.update({ read: true });
    res.status(200).json({ message: "Notification marked as read" });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({ message: "Failed to update notification" });
  }
});

// ✅ DELETE /users/notifications/:id → Delete notification
router.delete("/users/notifications/:id", checkUserAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const notificationId = req.params.id;

    const notificationRef = db.collection("notifications").doc(notificationId);
    const notificationDoc = await notificationRef.get();

    if (!notificationDoc.exists) {
      return res.status(404).json({ message: "Notification not found" });
    }

    // Verify notification belongs to user
    if (notificationDoc.data().userId !== userId) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    await notificationRef.delete();
    res.status(200).json({ message: "Notification deleted" });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({ message: "Failed to delete notification" });
  }
});

// 🌍 Haversine Formula (in km)
function getDistance(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

router.post("/users/nearby-venues", async (req, res) => {
  let userLocation = null;

  // Step 1: Try to extract from token
  if (req.headers.authorization) {
    try {
      const token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      const userDoc = await db.collection("users").doc(decoded.uid).get();
      if (userDoc.exists && userDoc.data().location) {
        userLocation = userDoc.data().location;
      }
    } catch (err) {
      console.warn("Invalid token or user not found");
    }
  }

  // Step 2: Fallback to request body
  if (!userLocation && req.body.latitude && req.body.longitude) {
    userLocation = {
      latitude: parseFloat(req.body.latitude),
      longitude: parseFloat(req.body.longitude),
    };
  }

  // Step 3: Final check
  if (!userLocation) {
    return res.status(400).json({ message: "User location is required" });
  }

  try {
    const vendorsSnapshot = await db.collection("vendors").get();

    const vendorTurfArrays = await Promise.all(
      vendorsSnapshot.docs.map(async (vendorDoc) => {
        const vendorData = vendorDoc.data();
        const turfsSnapshot = await db
          .collection("vendors")
          .doc(vendorDoc.id)
          .collection("turfs")
          .get();

        const turfs = [];
        turfsSnapshot.forEach((turfDoc) => {
          const turfData = turfDoc.data();
          if (turfData.deleted) return;
          if (!turfData.vendorCoordinates) return;

          const dist = getDistance(
            userLocation.latitude,
            userLocation.longitude,
            turfData.vendorCoordinates.lat,
            turfData.vendorCoordinates.lng
          );

          if (dist <= 50) {
            turfs.push({
              turfId: turfDoc.id,
              title: turfData.title,
              address: turfData.address,
              description: turfData.description,
              vendorName: vendorData.name,
              vendorPhone: vendorData.phone,
              location: { latitude: turfData.vendorCoordinates.lat, longitude: turfData.vendorCoordinates.lng },
              sports: turfData.sports,
              courts: turfData.courts,
              amenities: turfData.amenities,
              rules: turfData.rules,
              timeSlots: turfData.timeSlots,
              images: turfData.images,
              createdAt: turfData.createdAt,
              distance: parseFloat(dist.toFixed(2)),
            });
          }
        });
        return turfs;
      })
    );

    const nearbyTurfs = vendorTurfArrays.flat();
    return res.status(200).json(nearbyTurfs);
  } catch (err) {
    console.error("Error fetching nearby turfs:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Alias removed — use getDistance() defined above
const getDistanceFromLatLonInKm = getDistance;

router.post("/users/search-turfs", async (req, res) => {
  const { keyword, latitude, longitude } = req.body;

  if (!keyword || !latitude || !longitude) {
    return res
      .status(400)
      .json({ message: "keyword, latitude and longitude are required" });
  }

  const lowerKeyword = keyword.toLowerCase();

  try {
    const vendorsSnapshot = await db.collection("vendors").get();

    const vendorTurfArrays = await Promise.all(
      vendorsSnapshot.docs.map(async (vendorDoc) => {
        const vendorData = vendorDoc.data();
        const turfsSnapshot = await db
          .collection("vendors")
          .doc(vendorDoc.id)
          .collection("turfs")
          .get();

        const turfs = [];
        turfsSnapshot.forEach((turfDoc) => {
          const turf = turfDoc.data();
          if (turf.deleted) return;

          const matchesTitle = turf.title?.toLowerCase().includes(lowerKeyword);
          const matchesSport =
            Array.isArray(turf.sports) &&
            turf.sports.some((s) => s.name.toLowerCase().includes(lowerKeyword));

          if ((matchesTitle || matchesSport) && turf.vendorCoordinates) {
            const dist = getDistanceFromLatLonInKm(
              latitude,
              longitude,
              turf.vendorCoordinates.lat,
              turf.vendorCoordinates.lng
            );

            if (dist <= 50) {
              const minPrice = Math.min(...turf.sports.map((s) => s.slotPrice));
              const maxPrice = Math.max(...turf.sports.map((s) => s.slotPrice));

              turfs.push({
                turfId: turfDoc.id,
                title: turf.title,
                address: turf.address,
                vendorName: vendorData.name,
                phone: vendorData.phone,
                location: { latitude: turf.vendorCoordinates.lat, longitude: turf.vendorCoordinates.lng },
                sports: turf.sports,
                priceRange: { min: minPrice, max: maxPrice },
                amenities: turf.amenities,
                courts: turf.courts,
                images: turf.images,
                description: turf.description,
                distance: parseFloat(dist.toFixed(2)),
                createdAt: turf.createdAt,
              });
            }
          }
        });
        return turfs;
      })
    );

    const results = vendorTurfArrays.flat();
    return res.status(200).json(results);
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// ✅ POST /users/filter-turfs
router.post("/users/filter-turfs", async (req, res) => {
  const {
    latitude,
    longitude,
    maxDistanceKm,
    timeSlotCategory, // morning / afternoon / evening
    sportsType, // e.g., football
    priceMin,
    priceMax,
  } = req.body;

  if (!latitude || !longitude || !maxDistanceKm) {
    return res
      .status(400)
      .json({ message: "Latitude, longitude, and distance are required" });
  }

  // 🕒 Time slot mapping (client sends: morning, afternoon, evening)
  const timeSlotMap = {
    morning: ["05:00", "11:59"],
    afternoon: ["12:00", "16:59"],
    evening: ["17:00", "22:00"],
  };

  const [startSlot, endSlot] =
    (timeSlotCategory && timeSlotMap[timeSlotCategory.toLowerCase()]) || [];

  try {
    const vendorsSnapshot = await db.collection("vendors").get();

    const vendorTurfArrays = await Promise.all(
      vendorsSnapshot.docs.map(async (vendorDoc) => {
        const vendorData = vendorDoc.data();
        const turfsSnapshot = await db
          .collection("vendors")
          .doc(vendorDoc.id)
          .collection("turfs")
          .get();

        const turfs = [];
        turfsSnapshot.forEach((turfDoc) => {
          const turf = turfDoc.data();

          if (!turf.vendorCoordinates) return;

          const dist = getDistanceFromLatLonInKm(
            latitude,
            longitude,
            turf.vendorCoordinates.lat,
            turf.vendorCoordinates.lng
          );

          if (dist > maxDistanceKm) return;

          if (turf.deleted) return;

          if (sportsType && !turf.sports.some((s) => s.name.toLowerCase() === sportsType.toLowerCase())) return;

          const allPrices = turf.sports.map((s) => s.slotPrice);
          const minPrice = Math.min(...allPrices);
          const maxPrice = Math.max(...allPrices);

          if ((priceMin && maxPrice < priceMin) || (priceMax && minPrice > priceMax)) return;

          if (startSlot && endSlot) {
            // Check time slots from sports (weekday/weekend) or top-level timeSlots
            const allTimeSlots = turf.sports.flatMap((s) => [
              ...(s.weekdayTimeSlots || []),
              ...(s.weekendTimeSlots || []),
              ...(s.timeSlots || []),
            ]);
            const slotsToCheck = allTimeSlots.length > 0 ? allTimeSlots : (turf.timeSlots || []);
            const matchesTimeSlot = slotsToCheck.some((slot) => slot.open < endSlot && slot.close > startSlot);
            if (!matchesTimeSlot) return;
          }

          turfs.push({
            turfId: turfDoc.id,
            title: turf.title,
            distance: parseFloat(dist.toFixed(2)),
            vendorName: vendorData.name,
            phone: vendorData.phone,
            address: turf.address,
            description: turf.description,
            images: turf.images,
            sports: turf.sports,
            priceRange: { min: minPrice, max: maxPrice },
            timeSlots: turf.timeSlots,
            courts: turf.courts,
            amenities: turf.amenities,
            rules: turf.rules,
            vendorCoordinates: turf.vendorCoordinates,
          });
        });
        return turfs;
      })
    );

    const filteredTurfs = vendorTurfArrays.flat();
    return res.status(200).json(filteredTurfs);
  } catch (err) {
    console.error("Filter error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/users/turfs/:turfId", async (req, res) => {
  const { turfId } = req.params;

  try {
    const vendorSnapshot = await db.collection("vendors").get();

    for (const vendorDoc of vendorSnapshot.docs) {
      const turfRef = db
        .collection("vendors")
        .doc(vendorDoc.id)
        .collection("turfs")
        .doc(turfId);

      const turfDoc = await turfRef.get();

      if (turfDoc.exists) {
        const turfData = turfDoc.data();
        if (turfData.deleted) continue;
        const vendorData = vendorDoc.data();

        return res.status(200).json({
          turfId: turfDoc.id,
          vendorId: vendorDoc.id,
          vendorName: vendorData.name,
          vendorPhone: vendorData.phone,
          vendorLocation: vendorData.location,
          ...turfData,
        });
      }
    }

    res.status(404).json({ message: "Turf not found" });
  } catch (err) {
    console.error("Error fetching turf:", err.message);
    res.status(500).json({ message: "Internal server error" });
  }
});

// router.post("/bookings/available-slots", checkUserAuth, async (req, res) => {
//   try {
//     const { vendorId, turfId, date, sports } = req.body;

//     if (!vendorId || !turfId || !date || !sports) {
//       return res.status(400).json({ message: "Missing required fields" });
//     }

//     // 🔍 Step 1: Fetch all bookings matching criteria from top-level bookings
//     const bookingsSnapshot = await db
//       .collection("bookings")
//       .where("vendorId", "==", vendorId)
//       .where("turfId", "==", turfId)
//       .where("date", "==", date)
//       .where("sports", "==", sports)
//       .get();

//     const bookedSlots = new Set();
//     bookingsSnapshot.forEach((doc) => {
//       bookedSlots.add(doc.data().timeSlot);
//     });

//     // 🏟️ Step 2: Fetch turf's all time slots
//     const turfRef = db
//       .collection("vendors")
//       .doc(vendorId)
//       .collection("turfs")
//       .doc(turfId);
//     const turfDoc = await turfRef.get();

//     if (!turfDoc.exists) {
//       return res.status(404).json({ message: "Turf not found" });
//     }

//     const allSlots = turfDoc.data().timeSlots || [];

//     // ✅ Step 3: Filter out already booked slots
//     const availableSlots = allSlots.filter((slot) => !bookedSlots.has(slot));

//     res.status(200).json({
//       turfId,
//       sports,
//       date,
//       availableSlots,
//       totalAvailable: availableSlots.length,
//     });
//   } catch (err) {
//     console.error("Error fetching available slots:", err);
//     res.status(500).json({ message: "Internal server error" });
//   }
// });

router.post("/bookings/available-slots", checkUserAuth, async (req, res) => {
  try {
    const { vendorId, turfId, date, sports } = req.body;

    if (!vendorId || !turfId || !date || !sports) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // ✅ Step 1: Fetch turf details first
    const turfRef = db
      .collection("vendors")
      .doc(vendorId)
      .collection("turfs")
      .doc(turfId);
    const turfDoc = await turfRef.get();

    if (!turfDoc.exists) {
      return res.status(404).json({ message: "Turf not found" });
    }

    const turfData = turfDoc.data();

    // ✅ Step 2: Check if turf is suspended
    if (turfData.isSuspended === 1) {
      return res.status(200).json({
        message: "This turf is currently suspended and cannot accept bookings.",
        turfId,
        availableSlots: [],
        totalAvailable: 0,
      });
    }

    const allSlots = turfData.timeSlots || [];

    // Determine court capacity (if configured)
    const { getCourtsForSport } = require("../utils/courtHelper");
    const allCourts = await getCourtsForSport(vendorId, turfId, sports);
    const capacity = allCourts.length > 0 ? allCourts.length : 1;

    // ✅ Step 3: Fetch bookings for the given date & sports
    const bookingsSnapshot = await db
      .collection("bookings")
      .where("vendorId", "==", vendorId)
      .where("turfId", "==", turfId)
      .where("date", "==", date)
      .where("sports", "==", sports)
      .get();

    // Count confirmed bookings per slot; slot is fully booked only when count >= capacity
    const bookingsPerSlot = {};
    bookingsSnapshot.forEach((doc) => {
      const b = doc.data();
      if (b.bookingStatus === "confirmed") {
        bookingsPerSlot[b.timeSlot] = (bookingsPerSlot[b.timeSlot] || 0) + 1;
      }
    });

    // ✅ Step 4: Filter out only fully-booked slots
    const availableSlots = allSlots.filter(
      (slot) => (bookingsPerSlot[slot] || 0) < capacity
    );

    res.status(200).json({
      turfId,
      sports,
      date,
      availableSlots,
      totalAvailable: availableSlots.length,
    });
  } catch (err) {
    console.error("Error fetching available slots:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// router.post("/bookings/check-availability", checkUserAuth, async (req, res) => {
//   try {
//     const { vendorId, turfId, date, timeSlot, sports } = req.body;

//     if (!vendorId || !turfId || !date || !timeSlot || !sports) {
//       return res.status(400).json({ message: "Missing required fields" });
//     }

//     // Get slotStatus for the given turf and date
//     const slotStatusRef = db
//       .collection("vendors")
//       .doc(vendorId)
//       .collection("turfs")
//       .doc(turfId)
//       .collection("slotStatus")
//       .doc(date);

//     const slotDoc = await slotStatusRef.get();
//     const slotData = slotDoc.exists ? slotDoc.data() : {};
//     console.log("🔍 slotData keys:", Object.keys(slotData));
//     console.log("⚽ sports:", sports);
//     console.log("⏰ timeSlot:", timeSlot);
//     console.log(
//       "🧩 Inside data:",
//       JSON.stringify(slotData[sports]?.[timeSlot], null, 2)
//     );

//     const normalizedSport = sports.trim().toLowerCase();
//     const normalizedSlot = timeSlot.trim();

//     const isBooked =
//       slotData?.[normalizedSport]?.[normalizedSlot]?.booked === true;

//     // Get all available time slots from turf metadata
//     const turfRef = db
//       .collection("vendors")
//       .doc(vendorId)
//       .collection("turfs")
//       .doc(turfId);

//     const turfDoc = await turfRef.get();
//     if (!turfDoc.exists) {
//       return res.status(404).json({ message: "Turf not found" });
//     }

//     const allSlots = turfDoc.data().timeSlots?.map((s) => s["slot"]) || [];

//     if (!isBooked) {
//       return res.status(200).json({
//         available: true,
//         message: "Slot is available",
//       });
//     }

//     // Suggest nearby slots
//     const index = allSlots.indexOf(timeSlot);
//     const suggestions = [];

//     // Check previous slot
//     if (index > 0) {
//       const prev = allSlots[index - 1];
//       if (!slotData?.[sports]?.[prev]?.booked) suggestions.push(prev);
//     }

//     // Check next slot
//     if (index < allSlots.length - 1) {
//       const next = allSlots[index + 1];
//       if (!slotData?.[sports]?.[next]?.booked) suggestions.push(next);
//     }

//     return res.status(200).json({
//       available: false,
//       message: "Slot already booked",
//       suggestedSlots: suggestions,
//     });
//   } catch (err) {
//     console.error("Error checking availability:", err);
//     res.status(500).json({ message: "Internal server error" });
//   }
// });

// router.post("/bookings/check-availability", checkUserAuth, async (req, res) => {
//   try {
//     const { vendorId, turfId, date, timeSlot, sports } = req.body;

//     if (!vendorId || !turfId || !date || !timeSlot || !sports) {
//       return res.status(400).json({ message: "Missing required fields" });
//     }

//     // ✅ Normalize sport and slot names
//     const normalizedSport = sports.trim().toLowerCase();
//     const normalizedSlot = timeSlot.trim();

//     // ✅ Step 1: Get turf details (check suspension)
//     const turfRef = db
//       .collection("vendors")
//       .doc(vendorId)
//       .collection("turfs")
//       .doc(turfId);
//     const turfDoc = await turfRef.get();

//     if (!turfDoc.exists) {
//       return res.status(404).json({ message: "Turf not found" });
//     }

//     const turfData = turfDoc.data();

//     // ✅ If turf is suspended → return not available
//     if (turfData.isSuspended === 1) {
//       return res.status(200).json({
//         available: false,
//         message: "This turf is currently suspended and cannot accept bookings.",
//         suggestedSlots: [],
//       });
//     }

//     // ✅ Step 2: Fetch slotStatus for the given date
//     const slotStatusRef = turfRef.collection("slotStatus").doc(date);
//     const slotDoc = await slotStatusRef.get();
//     const slotData = slotDoc.exists ? slotDoc.data() : {};

//     console.log("🔍 slotData keys:", Object.keys(slotData));
//     console.log("⚽ normalizedSport:", normalizedSport);
//     console.log("⏰ normalizedSlot:", normalizedSlot);

//     const isBooked =
//       slotData?.[normalizedSport]?.[normalizedSlot]?.booked === true;

//     // ✅ Get all slots from turf metadata
//     const allSlots = (turfData.timeSlots || []).map((s) => s["slot"]);

//     if (!isBooked) {
//       return res.status(200).json({
//         available: true,
//         message: "Slot is available",
//       });
//     }

//     // ✅ Suggest nearby slots
//     const index = allSlots.indexOf(normalizedSlot);
//     const suggestions = [];

//     // Previous slot
//     if (index > 0) {
//       const prev = allSlots[index - 1];
//       if (!slotData?.[normalizedSport]?.[prev]?.booked) suggestions.push(prev);
//     }

//     // Next slot
//     if (index < allSlots.length - 1) {
//       const next = allSlots[index + 1];
//       if (!slotData?.[normalizedSport]?.[next]?.booked) suggestions.push(next);
//     }

//     return res.status(200).json({
//       available: false,
//       message: "Slot already booked",
//       suggestedSlots: suggestions,
//     });
//   } catch (err) {
//     console.error("Error checking availability:", err);
//     res.status(500).json({ message: "Internal server error" });
//   }
// });
router.post("/bookings/check-availability", checkUserAuth, async (req, res) => {
  try {
    const { vendorId, turfId, date, timeSlot, sports } = req.body;

    if (!vendorId || !turfId || !date || !timeSlot || !sports) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Normalize
    const sportName = sports.trim().toLowerCase();
    const slot = timeSlot.trim();

    // =====================================================
    // 1️⃣ FETCH TURF DATA (Check suspension + sports structure)
    // =====================================================
    const turfRef = db
      .collection("vendors")
      .doc(vendorId)
      .collection("turfs")
      .doc(turfId);

    const turfDoc = await turfRef.get();
    if (!turfDoc.exists) {
      return res.status(404).json({ message: "Turf not found" });
    }

    const turfData = turfDoc.data();

    if (turfData.isSuspended === 1) {
      return res.status(200).json({
        available: false,
        message: "This turf is suspended and cannot accept bookings.",
        suggestedSlots: [],
      });
    }

    // =====================================================
    // 2️⃣ GET SPORT DETAILS
    // =====================================================
    const sportObj = (turfData.sports || []).find(
      (s) => s.name.toLowerCase() === sportName
    );

    if (!sportObj) {
      return res.status(400).json({
        message: `Sport '${sports}' is not available on this turf.`,
      });
    }

    // Each timeSlot looks like: { open: "06:00", close: "07:00" }
    const allSlots = sportObj.timeSlots.map((ts) => `${ts.open}-${ts.close}`);

    if (!allSlots.includes(slot)) {
      return res.status(400).json({
        message: "Selected time slot does not exist for this sport.",
      });
    }

    // =====================================================
    // 3️⃣ CHECK BOOKINGS COLLECTION (canonical source of truth)
    // =====================================================
    const bookingSnapshot = await db
      .collection("bookings")
      .where("vendorId", "==", vendorId)
      .where("turfId", "==", turfId)
      .where("sports", "==", sportName)
      .where("date", "==", date)
      .where("timeSlot", "==", slot)
      .where("bookingStatus", "==", "confirmed")
      .limit(1)
      .get();

    const isBooked = !bookingSnapshot.empty;

    // =====================================================
    // 4️⃣ IF NOT BOOKED → AVAILABLE
    // =====================================================
    if (!isBooked) {
      return res.status(200).json({
        available: true,
        message: "Slot is available",
      });
    }

    // =====================================================
    // 5️⃣ SLOT IS BOOKED → SUGGEST NEARBY SLOTS
    // =====================================================
    // Fetch all booked slots for this date/sport to check neighbors
    const allBookingsSnapshot = await db
      .collection("bookings")
      .where("vendorId", "==", vendorId)
      .where("turfId", "==", turfId)
      .where("sports", "==", sportName)
      .where("date", "==", date)
      .where("bookingStatus", "==", "confirmed")
      .get();

    const bookedSlots = new Set();
    allBookingsSnapshot.forEach((doc) => bookedSlots.add(doc.data().timeSlot));

    const index = allSlots.indexOf(slot);
    const suggestions = [];

    // previous slot
    if (index > 0) {
      const prev = allSlots[index - 1];
      if (!bookedSlots.has(prev)) suggestions.push(prev);
    }

    // next slot
    if (index < allSlots.length - 1) {
      const next = allSlots[index + 1];
      if (!bookedSlots.has(next)) suggestions.push(next);
    }

    return res.status(200).json({
      available: false,
      message: "Slot already booked",
      suggestedSlots: suggestions,
    });
  } catch (err) {
    console.error("❌ Error checking availability:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// router.post("/bookings/summary", checkUserAuth, async (req, res) => {
//   try {
//     const { vendorId, turfId, sports, selectedSlots } = req.body;

//     if (
//       !vendorId ||
//       !turfId ||
//       !sports ||
//       !selectedSlots ||
//       !selectedSlots.length
//     ) {
//       return res
//         .status(400)
//         .json({ message: "Missing required booking fields" });
//     }

//     // Step 1: Fetch turf data
//     const turfRef = db
//       .collection("vendors")
//       .doc(vendorId)
//       .collection("turfs")
//       .doc(turfId);
//     const turfDoc = await turfRef.get();

//     if (!turfDoc.exists) {
//       return res.status(404).json({ message: "Turf not found" });
//     }

//     const turfData = turfDoc.data();

//     // Step 2: Find slot price for selected sport
//     const selectedSportData = turfData.sports.find(
//       (s) => s.name.toLowerCase() === sports.toLowerCase()
//     );

//     if (!selectedSportData) {
//       return res
//         .status(400)
//         .json({ message: "Selected sport not available on this turf" });
//     }

//     const pricePerSlot = selectedSportData.slotPrice;
//     const totalSlots = selectedSlots.length;
//     const totalAmount = pricePerSlot * totalSlots;

//     res.status(200).json({
//       turfId,
//       turfTitle: turfData.title,
//       location: turfData.address,
//       selectedSport: sports,
//       selectedSlots,
//       pricePerSlot,
//       totalSlots,
//       totalAmount,
//       message: "Booking summary generated",
//     });
//   } catch (err) {
//     console.error("Error generating booking summary:", err);
//     res.status(500).json({ message: "Internal server error" });
//   }
// });
router.post("/bookings/summary", checkUserAuth, async (req, res) => {
  try {
    const { vendorId, turfId, sports, selectedSlots, date } = req.body;

    if (!vendorId || !turfId || !sports || !selectedSlots?.length) {
      return res
        .status(400)
        .json({ message: "Missing required booking fields" });
    }

    const summary = await computeBookingSummary({
      vendorId,
      turfId,
      sports,
      selectedSlots,
      date,
    });

    res.status(200).json({
      ...summary,
      message: "Booking summary with tax and fees calculated",
    });
  } catch (err) {
    console.error("Error generating summary:", err);
    const status = err.status || 500;
    res.status(status).json({ message: err.message || "Internal server error" });
  }
});

router.get("/bookings/summary", checkUserAuth, async (req, res) => {
  try {
    const { vendorId, turfId, sports, selectedSlots, date } = req.query;

    if (!vendorId || !turfId || !sports || !selectedSlots) {
      return res.status(400).json({ message: "Missing required query params" });
    }

    const slotArray = selectedSlots.split(",");

    if (!slotArray.length) {
      return res.status(400).json({ message: "Selected slots are empty" });
    }

    const summary = await computeBookingSummary({
      vendorId,
      turfId,
      sports,
      selectedSlots: slotArray,
      date,
    });

    // Fetch turfImages separately since computeBookingSummary doesn't return them
    const turfDoc = await db
      .collection("vendors")
      .doc(vendorId)
      .collection("turfs")
      .doc(turfId)
      .get();

    res.status(200).json({
      ...summary,
      turfLocation: summary.location,
      turfImages: turfDoc.exists ? (turfDoc.data().images || []) : [],
      message: "Booking summary generated",
    });
  } catch (err) {
    console.error("GET Booking summary error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/bookings/create-order", checkUserAuth, rejectGuest, async (req, res) => {
  try {
    const { currency = "INR", bookingDetails } = req.body;
    const userId = req.user.uid;

    if (!bookingDetails) {
      return res.status(400).json({ message: "bookingDetails is required" });
    }

    const { vendorId, turfId, sports, selectedSlots, date } = bookingDetails;
    if (
      !vendorId ||
      !turfId ||
      !sports ||
      !Array.isArray(selectedSlots) ||
      selectedSlots.length === 0 ||
      !date
    ) {
      return res.status(400).json({
        message:
          "bookingDetails must include vendorId, turfId, sports, selectedSlots, and date",
      });
    }

    if (process.env.RAZORPAY_TEST_MODE !== "true" && !isRazorpayConfigured()) {
      return res.status(500).json({
        message: "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET",
      });
    }

    const summary = await computeBookingSummary({
      vendorId,
      turfId,
      sports,
      selectedSlots,
      date,
    });
    const finalAmount = summary.finalAmount;
    const amountInPaise = Math.round(Number(finalAmount) * 100);
    if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) {
      return res.status(400).json({ message: "Invalid computed amount" });
    }

    // Deterministic receipt for idempotency — same booking details produce same receipt
    const normalizedSlotsForReceipt = selectedSlots.map((s) => s.trim()).sort().join(",");
    const receiptData = `${turfId}_${userId}_${date}_${sports.trim().toLowerCase()}_${normalizedSlotsForReceipt}`;
    const receipt = crypto.createHash("md5").update(receiptData).digest("hex").slice(0, 40);

    if (process.env.RAZORPAY_TEST_MODE === "true") {
      return res.status(201).json({
        message: "Mock order created",
        orderId: "order_test_12345",
        amount: amountInPaise,
        currency,
        receipt,
        finalAmount,
      });
    }

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency,
      receipt,
      notes: {
        userId,
        vendorId,
        turfId,
        sports: sports.trim().toLowerCase(),
        date,
        slotCount: String(selectedSlots.length),
        finalAmount: String(finalAmount),
        amountInPaise: String(amountInPaise),
      },
    });

    res.status(201).json({
      message: "Order created",
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt,
      finalAmount,
    });
  } catch (err) {
    console.error("Order creation failed:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// router.post(
//   "/bookings/mock-payment-success",
//   checkUserAuth,
//   async (req, res) => {
//     try {
//       const { orderId, amount, turfId, vendorId, timeSlot, date, sports } =
//         req.body;
//       const userId = req.user.uid;

//       if (
//         !orderId ||
//         !amount ||
//         !turfId ||
//         !vendorId ||
//         !timeSlot ||
//         !date ||
//         !sports
//       ) {
//         return res
//           .status(400)
//           .json({ message: "Missing required booking fields" });
//       }

//       // 📌 Fetch turf details
//       const turfRef = db
//         .collection("vendors")
//         .doc(vendorId)
//         .collection("turfs")
//         .doc(turfId);
//       const turfDoc = await turfRef.get();
//       if (!turfDoc.exists)
//         return res.status(404).json({ message: "Turf not found" });

//       const turfData = turfDoc.data();

//       // 📌 Fetch vendor name
//       const vendorDoc = await db.collection("vendors").doc(vendorId).get();
//       const vendorData = vendorDoc.exists
//         ? vendorDoc.data()
//         : { name: "Unknown Vendor" };

//       const bookingData = {
//         orderId,
//         userId,
//         createdAt: new Date().toISOString(),
//         vendorId,
//         vendorName: vendorData.name,
//         turfId,
//         turfName: turfData.title,
//         turfLocation: turfData.address,
//         locationCoordinates: turfData.location || null,
//         date,
//         timeSlot,
//         sports,
//         amount,
//         paymentStatus: "confirmed",
//         bookingStatus: "confirmed",
//       };

//       // 🔥 Save to Firestore (could be global or under user)
//       await db.collection("bookings").add(bookingData);

//       res.status(200).json({
//         message: "Mock payment verified and booking saved",
//         booking: bookingData,
//       });
//     } catch (err) {
//       console.error("Mock payment error:", err);
//       res.status(500).json({ message: "Internal server error" });
//     }
//   }
// );
router.post(
  "/bookings/mock-payment-success",
  checkUserAuth,
  rejectGuest,
  async (req, res) => {
    // Block mock payments in production
    if (process.env.RAZORPAY_TEST_MODE !== "true") {
      return res.status(403).json({
        message: "Mock payments are disabled in production",
      });
    }

    try {
      const { orderId, amount, turfId, vendorId, timeSlot, date, sports } =
        req.body;
      const userId = req.user.uid;

      if (
        !orderId ||
        !amount ||
        !turfId ||
        !vendorId ||
        !timeSlot ||
        !date ||
        !sports
      ) {
        return res
          .status(400)
          .json({ message: "Missing required booking fields" });
      }

      // 📌 Fetch turf details
      const turfRef = db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .doc(turfId);
      const turfDoc = await turfRef.get();
      if (!turfDoc.exists)
        return res.status(404).json({ message: "Turf not found" });

      const turfData = turfDoc.data();

      // 📌 Fetch vendor name
      const vendorDoc = await db.collection("vendors").doc(vendorId).get();
      const vendorData = vendorDoc.exists
        ? vendorDoc.data()
        : { name: "Unknown Vendor" };

      // Assign a court if configured (court-aware mode)
      const { getCourtsForSport: _getCourts, pickAvailableCourt: _pickCourt } = require("../utils/courtHelper");
      const _sportsNorm = (sports || "").trim().toLowerCase();
      const _slotNorm = (timeSlot || "").trim();
      const _allCourts = await _getCourts(vendorId, turfId, _sportsNorm);
      let _assignedCourt = null;
      if (_allCourts.length > 0) {
        const [_bookingsForSlot, _locksForSlot] = await Promise.all([
          db.collection("bookings")
            .where("vendorId", "==", vendorId)
            .where("turfId", "==", turfId)
            .where("sports", "==", _sportsNorm)
            .where("date", "==", date)
            .where("timeSlot", "==", _slotNorm)
            .where("bookingStatus", "==", "confirmed")
            .get(),
          db.collection("slot_locks")
            .where("vendorId", "==", vendorId)
            .where("turfId", "==", turfId)
            .where("sport", "==", _sportsNorm)
            .where("date", "==", date)
            .where("timeSlot", "==", _slotNorm)
            .where("status", "==", "locked")
            .get(),
        ]);
        const _now = new Date();
        const _taken = [
          ..._bookingsForSlot.docs.map((d) => d.data().court).filter(Boolean),
          ..._locksForSlot.docs
            .filter((d) => {
              const exp = d.data().expiresAt?.toDate?.() || new Date(d.data().expiresAt);
              return exp > _now && d.data().userId !== userId;
            })
            .map((d) => d.data().court).filter(Boolean),
        ];
        _assignedCourt = _pickCourt(_allCourts, _taken).court;
      }

      // ✅ 1. Save to Firestore `bookings`
      const bookingData = {
        orderId,
        userId,
        createdAt: new Date().toISOString(),
        vendorId,
        vendorName: vendorData.name,
        turfId,
        turfName: turfData.title,
        turfLocation: turfData.address,
        locationCoordinates: turfData.location || null,
        date,
        timeSlot,
        sports,
        court: _assignedCourt,
        amount,
        paymentStatus: "confirmed",
        bookingStatus: "confirmed",
      };

      const bookingRef = await db.collection("bookings").add(bookingData);

      // ✅ 2. Update slotStatus under turf
      const slotStatusRef = db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .doc(turfId)
        .collection("slotStatus")
        .doc(date); // one doc per date

      const slotFieldPath = `${sports}.${timeSlot}`; // e.g. "football.06:00 - 07:00"
      const updateData = {
        [`${slotFieldPath}`]: {
          booked: true,
          userId,
          bookingId: bookingRef.id,
        },
      };

      // merge true so we don’t overwrite other slots
      const normalizedSport = sports.trim().toLowerCase();
      const normalizedSlot = timeSlot.trim();

      const bookingId = bookingRef.id;
      // 🔄 FIX: Separate nested keys
      await slotStatusRef.set(
        {
          [normalizedSport]: {
            [normalizedSlot]: {
              booked: true,
              bookingId,
              userId,
            },
          },
        },
        { merge: true }
      );

      try {
        await sendBookingConfirmedNotification(userId, {
          bookingId,
          turfName: turfData.title,
          date,
          timeSlot,
        });
        await sendPaymentSuccessNotification(userId, {
          bookingId,
          amount,
          paymentId: orderId,
        });
        const userDoc = await db.collection("users").doc(userId).get();
        const userData = userDoc.exists ? userDoc.data() : {};
        const msgData = { bookingId, turfName: turfData.title, date, timeSlot, amount };
        await Promise.allSettled([
          userData.phone ? sendBookingConfirmationSMS(userData.phone, msgData) : Promise.resolve(),
          userData.email ? sendBookingConfirmationEmail(userData.email, msgData) : Promise.resolve(),
        ]);
      } catch (notifErr) {
        console.error("[Notification] Failed to send mock booking notifications:", notifErr.message);
      }

      res.status(200).json({
        message: "Mock payment verified and booking saved",
        bookingId: bookingRef.id,
        booking: bookingData,
      });
    } catch (err) {
      console.error("Mock payment error:", err);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.post("/bookings/verify-payment", checkUserAuth, rejectGuest, async (req, res) => {
  let paymentVerified = false;
  let expectedAmountPaise = 0;
  let razorpayPaymentStatus = null; // track so catch block can capture before refunding

  try {
    const userId = req.user.uid;
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      bookingDetails,
      userLocks = [],
    } = req.body;

    if (process.env.RAZORPAY_TEST_MODE === "true") {
      return res.status(400).json({
        message:
          "RAZORPAY_TEST_MODE is enabled. Disable it to verify real Razorpay payments.",
      });
    }

    if (!isRazorpayConfigured()) {
      return res.status(500).json({
        message: "Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET",
      });
    }

    if (
      !razorpay_payment_id ||
      !razorpay_order_id ||
      !razorpay_signature ||
      !bookingDetails
    ) {
      return res.status(400).json({
        message:
          "razorpay_payment_id, razorpay_order_id, razorpay_signature, and bookingDetails are required",
      });
    }

    const { vendorId, turfId, sports, selectedSlots, date } = bookingDetails;
    if (
      !vendorId ||
      !turfId ||
      !sports ||
      !Array.isArray(selectedSlots) ||
      selectedSlots.length === 0 ||
      !date
    ) {
      return res.status(400).json({
        message:
          "bookingDetails must include vendorId, turfId, sports, selectedSlots, and date",
      });
    }

    if (!Array.isArray(userLocks) || userLocks.length === 0) {
      return res.status(400).json({
        message: "Active userLocks are required to confirm booking",
      });
    }

    const normalizedSport = sports.trim().toLowerCase();
    const normalizedSlots = selectedSlots.map((slot) => slot.trim());

    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const isSignatureValid =
      generatedSignature.length === razorpay_signature.length &&
      crypto.timingSafeEqual(
        Buffer.from(generatedSignature),
        Buffer.from(razorpay_signature)
      );

    if (!isSignatureValid) {
      return res.status(400).json({ message: "Invalid Razorpay signature" });
    }

    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (!payment) {
      return res.status(400).json({ message: "Payment not found on Razorpay" });
    }
    razorpayPaymentStatus = payment.status;

    if (!["authorized", "captured"].includes(payment.status)) {
      return res.status(400).json({
        message: `Payment is not successful (status: ${payment.status})`,
      });
    }

    if (payment.order_id !== razorpay_order_id) {
      return res.status(400).json({ message: "Order mismatch for payment" });
    }

    // Read amount from order notes (locked at creation time) instead of recomputing
    const razorpayOrder = await razorpay.orders.fetch(razorpay_order_id);
    expectedAmountPaise = Number(razorpayOrder.notes?.amountInPaise || razorpayOrder.amount);

    if (payment.amount !== expectedAmountPaise) {
      return res.status(400).json({
        message: "Paid amount does not match booking amount",
      });
    }

    // Payment is verified — from this point, if anything fails, we must refund
    paymentVerified = true;

    const existingPaymentBookings = await db
      .collection("bookings")
      .where("paymentId", "==", razorpay_payment_id)
      .where("userId", "==", userId)
      .where("bookingStatus", "==", "confirmed")
      .get();

    if (!existingPaymentBookings.empty) {
      const bookingIds = existingPaymentBookings.docs.map((doc) => doc.id);
      return res.status(200).json({
        message: "Payment already verified",
        bookingId: bookingIds[0],
        bookingIds,
      });
    }

    const turfRef = db
      .collection("vendors")
      .doc(vendorId)
      .collection("turfs")
      .doc(turfId);
    const turfDoc = await turfRef.get();
    if (!turfDoc.exists) {
      return res.status(404).json({ message: "Turf not found" });
    }
    const turfData = turfDoc.data();

    // Derive booking metadata from turfData and order notes
    const sportData = (turfData.sports || []).find(
      (s) => s.name.toLowerCase() === normalizedSport
    );
    const bookingDay = new Date(date).getDay();
    const isWeekendBooking = bookingDay === 0 || bookingDay === 6;
    let pricePerSlot = sportData?.slotPrice || 0;
    if ((sportData?.discountedPrice || 0) > 0) pricePerSlot = sportData.discountedPrice;
    if (isWeekendBooking && (sportData?.weekendPrice || 0) > 0) pricePerSlot = sportData.weekendPrice;
    const verifiedFinalAmount = Number(razorpayOrder.notes?.finalAmount || 0);
    const turfTitle = turfData.title || "Turf";
    const expectedSummary = {
      pricePerSlot,
      finalAmount: verifiedFinalAmount,
      turfTitle,
    };

    const vendorDoc = await db.collection("vendors").doc(vendorId).get();
    const vendorData = vendorDoc.exists ? vendorDoc.data() : { name: "Unknown Vendor" };

    const userLockIds = userLocks
      .map((lock) => lock?.lockId)
      .filter((id) => typeof id === "string" && id.trim());

    // Pre-transaction: check for duplicate bookings (queries not allowed inside transactions)
    for (const slot of normalizedSlots) {
      const existingBookingSnapshot = await db
        .collection("bookings")
        .where("vendorId", "==", vendorId)
        .where("turfId", "==", turfId)
        .where("sports", "==", normalizedSport)
        .where("date", "==", date)
        .where("timeSlot", "==", slot)
        .where("bookingStatus", "==", "confirmed")
        .limit(1)
        .get();
      if (!existingBookingSnapshot.empty) {
        throw new Error(`Slot already booked: ${slot}`);
      }
    }

    // Pre-transaction: validate locks and re-acquire expired ones
    const now = new Date();
    const selectedSlotSet = new Set(normalizedSlots);
    const lockToSlotMap = new Map();
    const slotToCourtMap = new Map(); // tracks assigned court per slot (from lock)

    for (const lockId of userLockIds) {
      const lockRef = db.collection("slot_locks").doc(lockId);
      const lockDoc = await lockRef.get();
      if (!lockDoc.exists) {
        // Lock was cleaned up after expiry. Payment is already verified and
        // duplicate booking was checked above — log and skip this lock.
        console.warn(`Lock ${lockId} not found (likely expired after payment). Continuing with verified payment.`);
        continue;
      }

      const lockData = lockDoc.data();
      const expiresAt = lockData.expiresAt?.toDate?.() || new Date(lockData.expiresAt);
      if (lockData.userId !== userId) {
        throw new Error("Unauthorized lock ownership");
      }
      if (
        lockData.vendorId !== vendorId ||
        lockData.turfId !== turfId ||
        (lockData.sport || "").trim().toLowerCase() !== normalizedSport ||
        lockData.date !== date
      ) {
        throw new Error("Lock details do not match selected booking details");
      }

      const slot = (lockData.timeSlot || "").trim();
      if (!selectedSlotSet.has(slot)) {
        throw new Error("Lock does not match selected slots");
      }

      // If lock is expired or no longer active, try to re-acquire
      if (lockData.status !== "locked" || expiresAt <= now) {
        // Check if slot is still available (not locked by someone else)
        const conflictSnapshot = await db
          .collection("slot_locks")
          .where("vendorId", "==", vendorId)
          .where("turfId", "==", turfId)
          .where("sport", "==", normalizedSport)
          .where("date", "==", date)
          .where("timeSlot", "==", slot)
          .where("status", "==", "locked")
          .get();

        const activeConflict = conflictSnapshot.docs.some((doc) => {
          if (doc.id === lockId) return false; // skip our own lock
          const d = doc.data();
          const exp = d.expiresAt?.toDate?.() || new Date(d.expiresAt);
          return exp > now && d.userId !== userId;
        });

        if (activeConflict) {
          throw new Error(`Slot ${slot} is now locked by another user. Refund will be issued.`);
        }

        // Re-acquire: extend the lock
        const newExpiresAt = new Date(now.getTime() + 10 * 60 * 1000);
        await lockRef.update({
          status: "locked",
          expiresAt: newExpiresAt,
          lockedAt: now,
        });
        console.log(`Lock ${lockId} re-acquired for slot ${slot}`);
      }

      lockToSlotMap.set(slot, lockRef);
      if (lockData.court) {
        slotToCourtMap.set(slot, lockData.court);
      }
    }

    // Fill in any slots whose locks were cleaned up (payment already verified above)
    for (const slot of normalizedSlots) {
      if (!lockToSlotMap.has(slot)) {
        lockToSlotMap.set(slot, null); // null = lock expired, slot booking proceeds via payment trust
      }
    }

    // For slots without assigned court (lock expired), assign one now if courts are configured
    const { getCourtsForSport, pickAvailableCourt } = require("../utils/courtHelper");
    const allCourts = await getCourtsForSport(vendorId, turfId, normalizedSport);
    if (allCourts.length > 0) {
      for (const slot of normalizedSlots) {
        if (slotToCourtMap.has(slot)) continue;
        // Fetch existing courts taken for this slot
        const [bookingsForSlot, locksForSlot] = await Promise.all([
          db.collection("bookings")
            .where("vendorId", "==", vendorId)
            .where("turfId", "==", turfId)
            .where("sports", "==", normalizedSport)
            .where("date", "==", date)
            .where("timeSlot", "==", slot)
            .where("bookingStatus", "==", "confirmed")
            .get(),
          db.collection("slot_locks")
            .where("vendorId", "==", vendorId)
            .where("turfId", "==", turfId)
            .where("sport", "==", normalizedSport)
            .where("date", "==", date)
            .where("timeSlot", "==", slot)
            .where("status", "==", "locked")
            .get(),
        ]);
        const takenCourts = [
          ...bookingsForSlot.docs.map((d) => d.data().court).filter(Boolean),
          ...locksForSlot.docs
            .filter((d) => {
              const exp = d.data().expiresAt?.toDate?.() || new Date(d.data().expiresAt);
              return exp > now && d.data().userId !== userId;
            })
            .map((d) => d.data().court).filter(Boolean),
        ];
        const { court } = pickAvailableCourt(allCourts, takenCourts);
        if (court) slotToCourtMap.set(slot, court);
      }
    }

    const bookingIds = await db.runTransaction(async (transaction) => {
      // Re-read locks inside transaction to ensure consistency
      for (const [slot, lockRef] of lockToSlotMap) {
        if (!lockRef) continue; // lock was cleaned up after expiry; payment already verified
        const lockDoc = await transaction.get(lockRef);
        if (!lockDoc.exists) {
          // Lock cleaned up between pre-check and transaction — safe to skip
          console.warn(`Lock disappeared inside transaction for slot ${slot}; payment was verified`);
          continue;
        }
        const lockData = lockDoc.data();
        if (lockData.status !== "locked" || lockData.userId !== userId) {
          throw new Error(`Lock for slot ${slot} is no longer valid`);
        }
      }

      const createdBookingIds = [];
      const slotStatusRef = db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .doc(turfId)
        .collection("slotStatus")
        .doc(date);
      const createdAt = new Date().toISOString();

      for (const slot of normalizedSlots) {

        const bookingRef = db.collection("bookings").doc();
        transaction.set(bookingRef, {
          orderId: razorpay_order_id,
          paymentId: razorpay_payment_id,
          userId,
          createdAt,
          vendorId,
          vendorName: vendorData.name || "Unknown Vendor",
          turfId,
          turfName: turfData.title || "Turf",
          turfLocation: turfData.address || "",
          locationCoordinates: turfData.location || null,
          date,
          timeSlot: slot,
          sports: normalizedSport,
          court: slotToCourtMap.get(slot) || null,
          amount: expectedSummary.pricePerSlot,
          finalAmount: expectedSummary.finalAmount,
          paymentStatus: "confirmed",
          bookingStatus: "confirmed",
          slotCount: normalizedSlots.length,
          currency: "INR",
        });
        createdBookingIds.push(bookingRef.id);

        transaction.set(
          slotStatusRef,
          {
            [normalizedSport]: {
              [slot]: {
                booked: true,
                bookingId: bookingRef.id,
                userId,
              },
            },
          },
          { merge: true }
        );

        const lockRef = lockToSlotMap.get(slot);
        if (lockRef) {
          transaction.update(lockRef, {
            status: "confirmed",
            confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
            bookingId: bookingRef.id,
            paymentId: razorpay_payment_id,
          });
        }
      }

      return createdBookingIds;
    });

    try {
      const turfTitle = expectedSummary.turfTitle || turfData.title;
      const timeSlotLabel = normalizedSlots.join(", ");
      await createNotification(
        userId,
        "Booking Confirmed! 🎉",
        `Your booking for ${turfTitle} on ${date} at ${timeSlotLabel} has been confirmed.`,
        "booking_confirmed",
        { bookingIds, turfName: turfTitle, date, timeSlot: timeSlotLabel }
      );
      await sendPaymentSuccessNotification(userId, {
        bookingId: bookingIds[0],
        amount: expectedSummary.finalAmount,
        paymentId: razorpay_payment_id,
      });
      const userDoc = await db.collection("users").doc(userId).get();
      const userData = userDoc.exists ? userDoc.data() : {};
      const msgData = { bookingId: bookingIds[0], turfName: turfTitle, date, timeSlot: timeSlotLabel, amount: expectedSummary.finalAmount };
      await Promise.allSettled([
        userData.phone ? sendBookingConfirmationSMS(userData.phone, msgData) : Promise.resolve(),
        userData.email ? sendBookingConfirmationEmail(userData.email, msgData) : Promise.resolve(),
      ]);
    } catch (notifErr) {
      console.error("[Notification] Failed to send booking notifications:", notifErr.message);
    }

    return res.status(200).json({
      message: "Payment verified and booking created successfully",
      bookingId: bookingIds[0],
      bookingIds,
      amount: expectedSummary.finalAmount,
    });
  } catch (err) {
    console.error("Payment verification error:", err);
    const message = err.message || "Internal server error";
    const isClientError =
      message.includes("Lock") ||
      message.includes("lock") ||
      message.includes("already booked") ||
      message.includes("Unauthorized") ||
      message.includes("expired") ||
      message.includes("selected slots");
    const status = message.includes("already booked")
      ? 409
      : isClientError
      ? 400
      : 500;

    // Auto-refund if payment was already verified but booking failed
    const { razorpay_payment_id, bookingDetails } = req.body;
    let refundStatus = null;
    if (paymentVerified && razorpay_payment_id) {
      try {
        // Razorpay can only refund captured payments — capture first if still authorized
        if (razorpayPaymentStatus === "authorized") {
          await razorpay.payments.capture(razorpay_payment_id, {
            amount: expectedAmountPaise,
            currency: "INR",
          });
          console.log(`Captured authorized payment ${razorpay_payment_id} before refunding`);
        }
        const refund = await razorpay.payments.refund(razorpay_payment_id, {
          amount: expectedAmountPaise,
          notes: {
            reason: "Booking failed after payment verification",
            error: message,
          },
        });
        refundStatus = { refunded: true, refundId: refund.id, amount: expectedAmountPaise };
        console.log(`Refund issued for payment ${razorpay_payment_id}: refund ${refund.id}`);
      } catch (refundErr) {
        refundStatus = { refunded: false, error: refundErr.message };
        console.error(`Refund FAILED for payment ${razorpay_payment_id}:`, refundErr);
      }

      // Write to failed_bookings collection for audit trail
      try {
        await db.collection("failed_bookings").add({
          razorpay_payment_id,
          razorpay_order_id: req.body.razorpay_order_id,
          userId: req.user.uid,
          bookingDetails: bookingDetails || null,
          failureReason: message,
          refundStatus,
          createdAt: new Date().toISOString(),
        });
      } catch (auditErr) {
        console.error("Failed to write audit log:", auditErr);
      }
    }

    return res.status(status).json({
      message,
      refundStatus,
    });
  }
});

// routes/users.js or routes/bookings.js

router.get("/bookings/:id/summary-pdf", checkUserAuth, async (req, res) => {
  const bookingId = req.params.id;

  try {
    // 1. Fetch booking by ID
    const bookingDoc = await db.collection("bookings").doc(bookingId).get();
    if (!bookingDoc.exists) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingDoc.data();

    // Ownership check — only the booking owner can download their PDF
    if (booking.userId !== req.user.uid) {
      return res.status(403).json({ message: "Access denied" });
    }

    // 2. Extract fields
    const {
      userId = "N/A",
      turfId = "N/A",
      turfName = "N/A",
      vendorId = "N/A",
      vendorName = "N/A",
      date = "N/A",
      timeSlot = "N/A",
      sports = "N/A",
      location = "N/A",
      totalAmount = 0,
      createdAt = new Date().toISOString(),
      bookingStatus = "Pending",
    } = booking;

    // 3. Initialize PDF document
    const doc = new PDFDocument({ margin: 50 });
    const bufferStream = new stream.WritableStreamBuffer();

    doc.pipe(bufferStream);

    // 4. Title
    doc.fontSize(20).text("📄 Booking Summary", { align: "center" });
    doc.moveDown();

    // 5. Table-style details
    doc.fontSize(12);
    const rows = [
      ["Booking ID", bookingId],
      ["User ID", userId],
      ["Vendor", vendorName],
      ["Turf", turfName],
      ["Location", location],
      ["Sports", sports],
      ["Date", date],
      ["Time Slot", timeSlot],
      ["Total Amount", `₹${totalAmount}`],
      ["Status", bookingStatus],
      ["Created At", new Date(createdAt).toLocaleString()],
    ];

    rows.forEach(([label, value]) => {
      doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
      doc.font("Helvetica").text(value);
    });

    // 6. End and send
    doc.end();

    bufferStream.on("finish", () => {
      const pdfData = bufferStream.getContents();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=booking_${bookingId}.pdf`
      );
      res.send(pdfData);
    });
  } catch (err) {
    console.error("Error generating booking PDF:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/users/my-bookings", checkUserAuth, async (req, res) => {
  try {
    const userId = req.user.uid;

    const bookingsSnapshot = await db
      .collection("bookings")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .get();

    if (bookingsSnapshot.empty) {
      return res.status(200).json({ bookings: [] });
    }

    const bookings = bookingsSnapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        bookingId: doc.id,
        amount: data.amount,
        sports: data.sports,
        turfId: data.turfId,
        turfName: data.turfName,
        turfLocation: data.turfLocation,
        timeSlot: data.timeSlot,
        date: data.date,
        bookingStatus: data.bookingStatus,
      };
    });

    res.status(200).json({ bookings });
  } catch (err) {
    console.error("Error fetching user bookings:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// router.delete(
//   "/users/my-bookings/:bookingId",
//   checkUserAuth,
//   async (req, res) => {
//     const userId = req.user.uid;
//     const bookingId = req.params.bookingId;

//     try {
//       // 1. Fetch booking
//       const bookingRef = db.collection("bookings").doc(bookingId);
//       const bookingDoc = await bookingRef.get();

//       if (!bookingDoc.exists) {
//         return res.status(404).json({ message: "Booking not found" });
//       }

//       const booking = bookingDoc.data();

//       // 2. Check ownership
//       if (booking.userId !== userId) {
//         return res.status(403).json({ message: "Unauthorized" });
//       }

//       // 3. Mark booking as cancelled
//       await bookingRef.update({ bookingStatus: "cancelled" });

//       // 4. Free the slot in slotStatus
//       const slotStatusRef = db
//         .collection("vendors")
//         .doc(booking.vendorId)
//         .collection("turfs")
//         .doc(booking.turfId)
//         .collection("slotStatus")
//         .doc(booking.date);

//       await slotStatusRef.set(
//         {
//           [booking.sports]: {
//             [booking.timeSlot]: {
//               booked: false,
//               userId: null,
//               bookingId: null,
//             },
//           },
//         },
//         { merge: true }
//       );

//       res.status(200).json({ message: "Booking cancelled successfully" });
//     } catch (err) {
//       console.error("Cancel booking error:", err);
//       res.status(500).json({ message: "Internal server error" });
//     }
//   }
// );

router.post("/cancel-booking", checkUserAuth, rejectGuest, async (req, res) => {
  try {
    const { bookingId } = req.body;
    const userId = req.user.uid;

    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID not provided" });
    }

    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingSnap.data();

    // Ownership check
    if (booking.userId !== userId) {
      return res.status(403).json({ message: "Unauthorized cancellation attempt" });
    }

    if (booking.bookingStatus === "cancelled") {
      return res.status(400).json({ message: "Booking is already cancelled" });
    }

    if (
      !booking?.date ||
      !booking?.timeSlot ||
      !booking?.sports ||
      !booking?.vendorId ||
      !booking?.turfId
    ) {
      return res.status(400).json({ message: "Incomplete booking data" });
    }

    // Use server time — never trust client time for refund eligibility
    const slotStartHour = parseInt(booking.timeSlot.split(":")[0]);
    const slotStartMin = parseInt(booking.timeSlot.split(":")[1]) || 0;
    const slotDateTime = new Date(booking.date);
    slotDateTime.setHours(slotStartHour, slotStartMin, 0, 0);
    const now = new Date();

    const timeDiffMinutes = (slotDateTime.getTime() - now.getTime()) / (1000 * 60);

    // Fetch cancellation policy from correct Firestore path
    const turfSnap = await db
      .collection("vendors")
      .doc(booking.vendorId)
      .collection("turfs")
      .doc(booking.turfId)
      .get();
    const cancellationHours = turfSnap.exists ? (turfSnap.data().cancellationHours ?? 1) : 1;
    const refundEligible = timeDiffMinutes > cancellationHours * 60;

    // Step 1: Mark booking as cancelled
    await bookingRef.update({
      bookingStatus: "cancelled",
      cancelledAt: new Date().toISOString(),
      refundStatus: refundEligible ? "pending" : "not_eligible",
    });

    // Step 2: Free the slot in correct Firestore path
    const slotStatusRef = db
      .collection("vendors")
      .doc(booking.vendorId)
      .collection("turfs")
      .doc(booking.turfId)
      .collection("slotStatus")
      .doc(booking.date);

    await slotStatusRef.set(
      {
        [booking.sports]: {
          [booking.timeSlot]: {
            booked: false,
            userId: null,
            bookingId: null,
          },
        },
      },
      { merge: true }
    );

    // Step 3: Process actual Razorpay refund if eligible
    let refundResult = null;
    if (refundEligible && booking.paymentId && isRazorpayConfigured()) {
      try {
        const refundAmountPaise = Math.round((booking.amount || booking.finalAmount || 0) * 100);
        if (refundAmountPaise > 0) {
          const refund = await razorpay.payments.refund(booking.paymentId, {
            amount: refundAmountPaise,
            notes: { reason: "User cancelled booking", bookingId },
          });
          refundResult = { refunded: true, refundId: refund.id };
          await bookingRef.update({ refundStatus: "refunded", refundId: refund.id });
        }
      } catch (refundErr) {
        console.error("Razorpay refund error:", refundErr.message);
        // Don't fail the cancellation if refund fails — log and retry manually
        await bookingRef.update({ refundStatus: "refund_failed", refundError: refundErr.message });
      }
    }

    return res.status(200).json({
      message: "Booking cancelled successfully",
      refundEligible,
      refundResult,
      refundInfo: refundEligible
        ? "Refund has been initiated and will appear in 5-7 business days"
        : `No refund — cancellation must be at least ${cancellationHours} hour(s) before slot`,
    });
  } catch (err) {
    console.error("Error cancelling booking:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/users/profile", checkUserAuth, async (req, res) => {
  const userId = req.user.uid;

  try {
    const userDoc = await db.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ message: "User not found" });
    }

    const userData = userDoc.data();

    res.status(200).json({
      message: "User profile fetched successfully",
      profile: {
        name: userData.name || null,
        email: userData.email || null,
        phone: userData.phone || null,
        role: userData.role || "user",
      },
    });
  } catch (err) {
    console.error("Fetch user profile error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.put("/users/profile", checkUserAuth, async (req, res) => {
  const userId = req.user.uid;
  const { email, phone, name } = req.body;

  if (!email && !phone && !name) {
    return res.status(400).json({ message: "No fields to update" });
  }

  try {
    const updates = {};
    if (email) updates.email = email;
    if (phone) updates.phone = phone;
    if (name) updates.name = name;

    // ✅ Update Firestore
    await db.collection("users").doc(userId).set(updates, { merge: true });

    res.status(200).json({
      message: "User profile updated successfully",
      updatedFields: updates,
    });
  } catch (err) {
    console.error("Update user profile error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


router.post("/notifications/reminders", checkAdminAuth, async (req, res) => {
  try {
    const now = new Date();
    const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const dateStr = twoHoursLater.toISOString().split("T")[0]; // e.g. 2025-07-15
    const timeStr = twoHoursLater.toTimeString().slice(0, 5); // e.g. 15:30

    // Fetch bookings on this date
    const bookingsSnapshot = await db
      .collection("bookings")
      .where("date", "==", dateStr)
      .get();

    const reminders = [];

    bookingsSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.timeSlot && isSlotWithin2Hours(data.timeSlot, twoHoursLater)) {
        reminders.push({ ...data, bookingId: doc.id });
      }
    });

    // Send reminders
    for (const booking of reminders) {
      await createNotification(
        booking.userId,
        "⏰ Booking Reminder",
        `Reminder: Your booking at ${booking.turfName} (${booking.turfLocation}) is today at ${booking.timeSlot}.`,
        "booking_reminder",
        { bookingId: booking.bookingId, turfName: booking.turfName, timeSlot: booking.timeSlot }
      );
    }

    res.status(200).json({
      message: `Reminders sent for ${reminders.length} upcoming bookings`,
    });
  } catch (err) {
    console.error("Reminder job error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});
function isSlotWithin2Hours(timeSlot, targetTime) {
  const [start, end] = timeSlot.split(" - ");
  const [slotHour, slotMin] = start.split(":").map(Number);

  const slotDateTime = new Date();
  slotDateTime.setHours(slotHour);
  slotDateTime.setMinutes(slotMin);
  slotDateTime.setSeconds(0);
  slotDateTime.setMilliseconds(0);

  const diff = slotDateTime.getTime() - targetTime.getTime();
  return diff > -60000 && diff < 15 * 60 * 1000; // Allow 15 min window for trigger
}


// Removed duplicate /bookings/cancel-booking route — use /cancel-booking above

module.exports = router;

