const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { auth, db } = require("../firebase/firebase");
const { v4: uuidv4 } = require("uuid");
const haversine = require("haversine-distance");
const checkUserAuth = require("../middleware/checkUserAuth");
const PDFDocument = require("pdfkit");
const stream = require("stream-buffers");

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

// ✅ POST /users/refresh-token → Refresh JWT token using Firebase ID token
router.post("/users/refresh-token", async (req, res) => {
  try {
    const { idToken } = req.body;
    
    if (!idToken) {
      return res.status(400).json({ message: "idToken is required" });
    }

    // Verify the Firebase ID token
    const decoded = await auth.verifyIdToken(idToken);
    const { uid } = decoded;

    // Generate a new JWT token
    const token = generateToken(uid);
    
    return res.status(200).json({ 
      message: "Token refreshed successfully", 
      token 
    });
  } catch (err) {
    console.error("Token refresh error:", err);
    return res.status(401).json({ 
      message: "Invalid or expired Firebase token" 
    });
  }
});

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

    let nearbyTurfs = [];

    for (const vendorDoc of vendorsSnapshot.docs) {
      const vendorData = vendorDoc.data();
      const vendorId = vendorDoc.id;

      const turfsSnapshot = await db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .get();

      turfsSnapshot.forEach((turfDoc) => {
        const turfData = turfDoc.data();
        console.log('🔎 [DEBUG] Turf data:', turfDoc.id, {
          title: turfData.title,
          hasCoordinates: !!turfData.coordinates,
          hasVendorCoordinates: !!turfData.vendorCoordinates,
          vendorCoordinates: turfData.vendorCoordinates,
          allFields: Object.keys(turfData)
        });

        // Check for vendorCoordinates field (Admin Panel saves as vendorCoordinates)
        if (turfData.vendorCoordinates) {
          console.log('✅ [DEBUG] Turf has vendorCoordinates:', turfData.vendorCoordinates);
          const dist = getDistance(
            userLocation.latitude,
            userLocation.longitude,
            turfData.vendorCoordinates.lat,
            turfData.vendorCoordinates.lng
          );
          console.log('📏 [DEBUG] Distance:', dist, 'km');

          // Temporarily increased to 5000km for testing - change back to 50 later
          if (dist <= 5000) {
            nearbyTurfs.push({
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
            console.log('✅ [DEBUG] Added turf to results');
          } else {
            console.log('❌ [DEBUG] Turf too far:', dist, 'km');
          }
        } else {
          console.log('❌ [DEBUG] Turf has no vendorCoordinates field');
        }
      });
    }

    return res.status(200).json(nearbyTurfs);
  } catch (err) {
    console.error("Error fetching nearby turfs:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

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
    let results = [];

    for (const vendorDoc of vendorsSnapshot.docs) {
      const vendorData = vendorDoc.data();
      const turfsSnapshot = await db
        .collection("vendors")
        .doc(vendorDoc.id)
        .collection("turfs")
        .get();

      turfsSnapshot.forEach((turfDoc) => {
        const turf = turfDoc.data();

        // Match by turf title or sports name
        const matchesTitle = turf.title.toLowerCase().includes(lowerKeyword);
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

          // Temporarily increased to 5000km for testing - change back to 50 later
          if (dist <= 5000) {
            const minPrice = Math.min(...turf.sports.map((s) => s.slotPrice));
            const maxPrice = Math.max(...turf.sports.map((s) => s.slotPrice));

            results.push({
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
    }

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
    let filteredTurfs = [];

    for (const vendorDoc of vendorsSnapshot.docs) {
      const vendorData = vendorDoc.data();
      const turfsSnapshot = await db
        .collection("vendors")
        .doc(vendorDoc.id)
        .collection("turfs")
        .get();

      turfsSnapshot.forEach((turfDoc) => {
        const turf = turfDoc.data();

        if (!turf.location) return;

        const dist = getDistanceFromLatLonInKm(
          latitude,
          longitude,
          turf.location.latitude,
          turf.location.longitude
        );

        if (dist > maxDistanceKm) return;

        // 🎯 Sports Type Match
        if (
          sportsType &&
          !turf.sports.some(
            (s) => s.name.toLowerCase() === sportsType.toLowerCase()
          )
        )
          return;

        // 💰 Price Range Match
        const allPrices = turf.sports.map((s) => s.slotPrice);
        const minPrice = Math.min(...allPrices);
        const maxPrice = Math.max(...allPrices);

        if (
          (priceMin && maxPrice < priceMin) ||
          (priceMax && minPrice > priceMax)
        )
          return;

        // ⏱️ Time Slot Match
        if (startSlot && endSlot) {
          const matchesTimeSlot = turf.timeSlots.some((slot) => {
            return slot.open < endSlot && slot.close > startSlot;
          });
          if (!matchesTimeSlot) return;
        }

        // ✅ Add Turf
        filteredTurfs.push({
          turfId: turfDoc.id,
          title: turf.title,
          distance: parseFloat(dist.toFixed(2)),
          vendorName: vendorData.name,
          phone: vendorData.phone,
          address: turf.address,
          images: turf.images,
          sports: turf.sports,
          priceRange: { min: minPrice, max: maxPrice },
          timeSlots: turf.timeSlots,
          courts: turf.courts,
          amenities: turf.amenities,
        });
      });
    }

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

    // ✅ Step 3: Fetch bookings for the given date & sports
    const bookingsSnapshot = await db
      .collection("bookings")
      .where("vendorId", "==", vendorId)
      .where("turfId", "==", turfId)
      .where("date", "==", date)
      .where("sports", "==", sports)
      .get();

    const bookedSlots = new Set();
    bookingsSnapshot.forEach((doc) => {
      bookedSlots.add(doc.data().timeSlot);
    });

    // ✅ Step 4: Filter available slots
    const availableSlots = allSlots.filter((slot) => !bookedSlots.has(slot));

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
    // 3️⃣ FETCH SLOT STATUS FOR THIS DATE
    // =====================================================
    const slotStatusRef = turfRef.collection("slotStatus").doc(date);
    const slotStatusDoc = await slotStatusRef.get();

    const slotData = slotStatusDoc.exists ? slotStatusDoc.data() : {};

    const isBooked = slotData?.[sportName]?.[slot]?.booked === true;

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
    const index = allSlots.indexOf(slot);
    const suggestions = [];

    // previous slot
    if (index > 0) {
      const prev = allSlots[index - 1];
      if (!slotData?.[sportName]?.[prev]?.booked) suggestions.push(prev);
    }

    // next slot
    if (index < allSlots.length - 1) {
      const next = allSlots[index + 1];
      if (!slotData?.[sportName]?.[next]?.booked) suggestions.push(next);
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

    // Get turf data
    const turfRef = db
      .collection("vendors")
      .doc(vendorId)
      .collection("turfs")
      .doc(turfId);
    const turfSnap = await turfRef.get();

    if (!turfSnap.exists) {
      return res.status(404).json({ message: "Turf not found" });
    }

    const turfData = turfSnap.data();

    // Get sport slot price
    const selectedSport = turfData.sports.find(
      (s) => s.name.toLowerCase() === sports.toLowerCase()
    );

    if (!selectedSport) {
      return res
        .status(400)
        .json({ message: "Sport not available for this turf" });
    }

    let pricePerSlot = selectedSport.slotPrice;

    // If discounted
    if (selectedSport.discountedPrice > 0) {
      pricePerSlot = selectedSport.discountedPrice;
    }

    // If weekend
    const bookingDate = date || new Date().toISOString();
    const day = new Date(bookingDate).getDay();
    const isWeekend = day === 0 || day === 6;

    if (isWeekend && selectedSport.weekendPrice > 0) {
      pricePerSlot = selectedSport.weekendPrice;
    }
    const totalSlots = selectedSlots.length;
    const baseAmount = pricePerSlot * totalSlots;

    // Fetch current tax percentage
    const taxSnap = await db.collection("tax").doc("global").get();
    const taxRate = taxSnap.exists ? taxSnap.data().percentage : 0;

    const taxAmount = Math.round((baseAmount * taxRate) / 100);
    const convenienceFee = 35; // Standard fee
    const subtotal = baseAmount + taxAmount + convenienceFee;
    
    const discountRate = 10; // 10% Promotional discount
    const discountAmount = Math.round((subtotal * discountRate) / 100);
    const finalAmount = subtotal - discountAmount;

    res.status(200).json({
      turfId,
      turfTitle: turfData.title,
      location: turfData.address,
      selectedSport: sports,
      selectedSlots,
      pricePerSlot,
      totalSlots,
      baseAmount,
      taxRate,
      taxAmount,
      convenienceFee,
      discountRate,
      discountAmount,
      finalAmount,
      message: "Booking summary with tax and fees calculated",
    });
  } catch (err) {
    console.error("Error generating summary:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/bookings/summary", checkUserAuth, async (req, res) => {
  try {
    const { vendorId, turfId, sports, selectedSlots } = req.query;

    if (!vendorId || !turfId || !sports || !selectedSlots) {
      return res.status(400).json({ message: "Missing required query params" });
    }

    const slotArray = selectedSlots.split(",");

    if (!slotArray.length) {
      return res.status(400).json({ message: "Selected slots are empty" });
    }

    // Fetch turf info
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

    // Find price for selected sport
    const selectedSportData = turfData.sports.find(
      (s) => s.name.toLowerCase() === sports.toLowerCase()
    );

    if (!selectedSportData) {
      return res
        .status(400)
        .json({ message: "Selected sport not available on this turf" });
    }

    const pricePerSlot = selectedSportData.slotPrice;
    const totalSlots = slotArray.length;
    const totalAmount = pricePerSlot * totalSlots;

    res.status(200).json({
      turfId,
      turfTitle: turfData.title,
      turfLocation: turfData.address,
      turfImages: turfData.images || [],
      selectedSport: sports,
      selectedSlots: slotArray,
      pricePerSlot,
      totalSlots,
      totalAmount,
      message: "Booking summary generated",
    });
  } catch (err) {
    console.error("GET Booking summary error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/bookings/create-order", checkUserAuth, async (req, res) => {
  try {
    const { amount, currency = "INR", turfId } = req.body;
    const userId = req.user.uid;

    if (!amount || !turfId) {
      return res.status(400).json({ message: "Amount and turfId required" });
    }

    // ✅ Auto-generate receipt ID
    const receipt = `${turfId}_${userId}_${Date.now()}`;

    if (process.env.RAZORPAY_TEST_MODE === "true") {
      return res.status(201).json({
        message: "Mock order created",
        orderId: "order_test_12345",
        amount: amount * 100,
        currency,
        receipt,
      });
    }

    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency,
      receipt,
    });

    res.status(201).json({
      message: "Order created",
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt,
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
  async (req, res) => {
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

      const notificationRef = db
        .collection("users")
        .doc(userId)
        .collection("notifications")
        .doc();

      await notificationRef.set({
        title: "Booking Confirmed ✅",
        message: `Your booking is confirmed at ${turfData.title}, ${turfData.address} on ${date} at ${timeSlot}.`,
        read: false,
        createdAt: new Date().toISOString(),
      });

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

// routes/users.js or routes/bookings.js

router.get("/bookings/:id/summary-pdf", async (req, res) => {
  const bookingId = req.params.id;

  try {
    // 1. Fetch booking by ID
    const bookingDoc = await db.collection("bookings").doc(bookingId).get();
    if (!bookingDoc.exists) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingDoc.data();

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

router.post("/cancel-booking", checkUserAuth, async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ message: "Booking ID not provided" });
    }

    const bookingSnap = await db.collection("bookings").doc(bookingId).get();

    if (!bookingSnap.exists) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingSnap.data();

    if (
      !booking?.date ||
      !booking?.timeSlot ||
      !booking?.sports ||
      !booking?.vendorId ||
      !booking?.turfId
    ) {
      return res.status(400).json({ message: "Incomplete booking data" });
    }

    // Parse slot time (e.g., "09:00 - 10:00" -> 09)
    const slotStartHour = parseInt(booking.timeSlot.split(":")[0]);
    const bookingDate = new Date(booking.date);
    const now = new Date();

    const slotDateTime = new Date(bookingDate);
    slotDateTime.setHours(slotStartHour);
    slotDateTime.setMinutes(0);
    slotDateTime.setSeconds(0);

    const timeDiffMinutes =
      (slotDateTime.getTime() - now.getTime()) / (1000 * 60);
    const refundEligible = timeDiffMinutes > 60;

    // ✅ Step 1: Mark booking as cancelled
    await db.collection("bookings").doc(bookingId).update({
      bookingStatus: "cancelled",
    });

    // ✅ Step 2: Update slotStatus structure (with merge)
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

    return res.status(200).json({
      message: "Booking cancelled successfully",
      refundEligible,
      refundInfo: refundEligible
        ? "Refund will be processed (cancellation >1hr before slot)"
        : "Refund not eligible (within 1hr of slot)",
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

router.get("/users/notifications", checkUserAuth, async (req, res) => {
  const userId = req.user.uid;

  try {
    const snapshot = await db
      .collection("users")
      .doc(userId)
      .collection("notifications")
      .orderBy("createdAt", "desc")
      .get();

    const notifications = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ notifications });
  } catch (err) {
    console.error("Fetch notifications error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/notifications/reminders", async (req, res) => {
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
      const notificationRef = db
        .collection("users")
        .doc(booking.userId)
        .collection("notifications")
        .doc();

      await notificationRef.set({
        title: "⏰ Booking Reminder",
        message: `Reminder: Your booking at ${booking.turfName} (${booking.turfLocation}) is today at ${booking.timeSlot}.`,
        read: false,
        createdAt: new Date().toISOString(),
      });
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

function parseHour(timeStr) {
  return parseInt(timeStr.split(":")[0], 10); // "23:00" → 23
}

router.post("/bookings/cancel-booking", checkUserAuth, async (req, res) => {
  const { bookingId, currentTime } = req.body;
  const userId = req.user.uid;

  if (!bookingId || !currentTime) {
    return res
      .status(400)
      .json({ message: "Missing bookingId or currentTime" });
  }

  try {
    // 1. Fetch booking
    const bookingRef = db.collection("bookings").doc(bookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = bookingSnap.data();
    console.log("Fetched Booking:", booking);
    if (booking.userId !== userId) {
      return res
        .status(403)
        .json({ message: "Unauthorized cancellation attempt" });
    }

    if (!booking.timeSlot || !booking.turfId || !booking.date) {
      return res.status(400).json({
        message: "Incomplete booking data",
        missingFields: {
          timeSlot: booking.timeSlot,
          turfId: booking.turfId,
          slotDate: booking.date,
        },
      });
    }

    // 2. Fetch cancellation hours from turf
    const turfSnap = await db.collection("turfs").doc(booking.turfId).get();
    const cancellationHours = turfSnap.exists
      ? turfSnap.data().cancellationHours || 0
      : 0;

    // 3. Time diff calculation
    const [slotStartTime] = booking.timeSlot.split(" - ");
    const slotHour = parseHour(slotStartTime);
    const currentHour = parseHour(currentTime);

    let hourDiff = slotHour - currentHour;
    if (hourDiff < 0) hourDiff += 24;

    const refundEligible = hourDiff >= cancellationHours;

    // 4. Update booking
    await bookingRef.update({
      bookingStatus: "cancelled",
      refundStatus: refundEligible ? "eligible" : "not eligible",
    });

    // 5. Update slotStatus document
    const slotStatusRef = db
      .collection("turfs")
      .doc(booking.turfId)
      .collection("slotStatus")
      .doc(booking.date);

    const slotStatusSnap = await slotStatusRef.get();

    if (slotStatusSnap.exists) {
      const timeSlotMap = slotStatusSnap.data().football || {};

      if (timeSlotMap[booking.timeSlot]) {
        timeSlotMap[booking.timeSlot] = {
          ...timeSlotMap[booking.timeSlot],
          booked: false,
          bookingId: null,
          userId: null,
        };

        await slotStatusRef.update({ football: timeSlotMap });
      }
    }

    return res.status(200).json({
      message: "Booking cancelled successfully",
      refundEligible,
      refundInfo: refundEligible
        ? `Refund will be processed as cancellation is ${hourDiff} hrs before the slot.`
        : cancellationHours === 0
        ? "No refund policy applies for this turf."
        : `No refund. Cancellation happened only ${hourDiff} hrs before the slot (requires ${cancellationHours}+ hrs).`,
    });
  } catch (error) {
    console.error("Cancel booking error:", error);
    return res
      .status(500)
      .json({ message: "Internal Server Error", error: error.message });
  }
});

module.exports = router;
