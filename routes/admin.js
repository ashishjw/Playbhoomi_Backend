const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { db } = require("../firebase/firebase");
const { checkAdminAuth } = require("../middleware/auth");
const axios = require("axios");
const { resolveShortUrl, extractLatLngFromUrl } = require("../utils/mapUtils");
const cloudinary = require("../utils/cloudinary");
router.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;

  // Only allow fixed email
  if (email !== "admin@gmail.com") {
    return res.status(403).json({ message: "Unauthorized email" });
  }

  // Fetch admin document
  const snapshot = await db
    .collection("admin")
    .where("email", "==", email)
    .get();
  if (snapshot.empty) {
    return res.status(404).json({ message: "Admin not found" });
  }

  const adminDoc = snapshot.docs[0];
  const adminData = adminDoc.data();

  // Compare plaintext password
  if (adminData.password !== password) {
    return res.status(401).json({ message: "Invalid password" });
  }

  // Generate JWT token
  const token = jwt.sign(
    { role: "admin", id: adminDoc.id },
    process.env.JWT_SECRET,
    { expiresIn: "2h" }
  );

  res.json({ message: "Login successful", token });
});

// Image upload endpoint
router.post("/admin/upload", checkAdminAuth, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "No image provided" });
    }

    const uploadResult = await cloudinary.uploader.upload(image, {
      folder: "turf_images",
    });

    res.status(200).json(uploadResult);
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    res.status(500).json({ error: error.message });
  }
});


const generateRandomId = () => Math.floor(1000 + Math.random() * 9000);
const generatePassword = () => Math.random().toString(36).slice(-8); // 8-char

router.post("/admin/vendors", checkAdminAuth, async (req, res) => {
  try {
    const { name, phone, location, gpsUrl } = req.body;

    if (!name || !phone || !location || !gpsUrl) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // 1) Resolve short URL (maps.app.goo.gl) if present; fall back to original on failure
    let finalUrl = gpsUrl;
    try {
      finalUrl = await resolveShortUrl(gpsUrl); // returns same URL if already full
    } catch (_) {
      // ignore resolution errors; we'll try parsing the original url
    }

    // 2) Extract lat/lng from the resolved URL; fallback to original if needed
    const coords =
      extractLatLngFromUrl(finalUrl) || extractLatLngFromUrl(gpsUrl);

    if (!coords) {
      return res.status(400).json({
        message:
          "Could not extract coordinates from the provided GPS URL. Please share a valid Google Maps link.",
      });
    }

    // 3) Generate random email + password
    const randomId = generateRandomId();
    const email = `vendor_${randomId}@venuemgmt.com`;
    const password = generatePassword();

    // 4) Save vendor document
    const newVendorRef = db.collection("vendors").doc(); // auto ID
    const vendorData = {
      name,
      email,
      phone,
      password, // plain for now (as you requested)
      location,
      gpsUrl, // store the URL the admin provided
      coordinates: {
        lat: coords.lat,
        lng: coords.lng,
      },
      createdAt: new Date().toISOString(),
    };

    await newVendorRef.set(vendorData);

    // 5) Return login credentials
    return res.status(201).json({
      message: "Vendor created successfully",
      vendorId: newVendorRef.id,
      login: { email, password },
      coordinates: vendorData.coordinates,
    });
  } catch (err) {
    console.error("Error creating vendor:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});
// GET all vendors
router.get("/admin/vendors", checkAdminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection("vendors").get();

    if (snapshot.empty) {
      return res.status(404).json({ message: "No vendors found" });
    }

    const vendors = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ vendors });
  } catch (err) {
    console.error("Error fetching vendors:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.put("/admin/vendors/:vendorId", checkAdminAuth, async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { name, phone, location, email, gpsUrl, password } = req.body;

    const vendorRef = db.collection("vendors").doc(vendorId);
    const doc = await vendorRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    const updateData = {};
    if (name) updateData.name = name;
    if (phone) updateData.phone = phone;
    if (location) updateData.location = location;
    if (email) {
      // Simple validation for email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ message: "Invalid email format" });
      }
      updateData.email = email;
    }
    if (password) updateData.password = password;
    if (gpsUrl) {
      updateData.gpsUrl = gpsUrl;

      // 1) Resolve short URL if needed
      let finalUrl = gpsUrl;
      try {
        finalUrl = await resolveShortUrl(gpsUrl);
      } catch (_) {
        console.log("Failed to resolve short URL, using original.");
      }

      // 2) Extract coordinates
      const coords =
        extractLatLngFromUrl(finalUrl) || extractLatLngFromUrl(gpsUrl);

      if (!coords) {
        return res.status(400).json({
          message:
            "Could not extract coordinates from the provided GPS URL. Please share a valid Google Maps link.",
        });
      }

      updateData.coordinates = {
        lat: coords.lat,
        lng: coords.lng,
      };
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        message: "No fields provided for update",
      });
    }
    await vendorRef.update(updateData);

    return res.status(200).json({
      message: "Vendor updated successfully",
      vendorId,
      updatedFields: updateData,
    });
  } catch (err) {
    console.error("Error updating vendor:", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});
router.post(
  "/admin/vendors/:vendorId/turfs",
  checkAdminAuth,
  async (req, res) => {
    try {
      const { vendorId } = req.params;

      let {
        title,
        address,
        description,
        sports,
        amenities,
        rules,
        images,
        cancellationHours = 0,
        featured = 0,
      } = req.body;

      // ✅ Step 1: Parse JSON fields if they come as strings
      try {
        if (typeof sports === "string") sports = JSON.parse(sports);
        if (typeof amenities === "string") amenities = JSON.parse(amenities);
        if (typeof rules === "string") rules = JSON.parse(rules);
        if (typeof images === "string") images = JSON.parse(images);
      } catch (parseError) {
        console.error("❌ JSON parse error:", parseError.message);
        return res
          .status(400)
          .json({ message: "Invalid JSON format in request body" });
      }

      // Validate required fields
      if (
        !title ||
        !address ||
        !description ||
        !sports ||
        !Array.isArray(amenities) ||
        !Array.isArray(rules) ||
        !Array.isArray(images)
      ) {
        return res
          .status(400)
          .json({ message: "Missing required turf fields or invalid array fields" });
      }

      // ✅ Step 2: Fetch vendor details with timeout
      const vendorRef = db.collection("vendors").doc(vendorId);
      const vendorDoc = await Promise.race([
        vendorRef.get(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Vendor fetch timeout")), 10000)
        )
      ]);

      if (!vendorDoc.exists) {
        return res.status(404).json({ message: "Vendor not found" });
      }

      const vendorData = vendorDoc.data();
      const vendorLocation = vendorData.location || "";
      const vendorGpsUrl = vendorData.gpsUrl || "";
      const vendorCoordinates = vendorData.coordinates || null;

      // ✅ Step 3: Process sports with timeSlots + courts + slotDuration + weekday/weekend slots
      const sportsData = (sports || []).map((sport) => ({
        name: sport.name,
        slotPrice: sport.slotPrice,
        discountedPrice: sport.discountedPrice ?? 0,
        weekendPrice: sport.weekendPrice ?? 0,
        slotDuration: sport.slotDuration || 60, // Default to 60 minutes (1 hour)
        weekdayTimeSlots: sport.weekdayTimeSlots || sport.timeSlots || sport.timings || [],
        weekendTimeSlots: sport.weekendTimeSlots || sport.timeSlots || sport.timings || [],
        // Keep timeSlots for backward compatibility (use weekday as default)
        timeSlots: sport.weekdayTimeSlots || sport.timeSlots || sport.timings || [],
        courts: sport.courts || [],
      }));

      // ✅ Step 4: Fetch amenities details in batches with timeout
      let amenitiesData = [];
      if (amenities && amenities.length > 0) {
        const amenitiesDocs = await Promise.race([
          Promise.all(
            amenities.map((id) => db.collection("amenities_master").doc(id).get())
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Amenities fetch timeout")), 10000)
          )
        ]);

        amenitiesData = amenitiesDocs
          .filter((doc) => doc.exists)
          .map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }));
      }

      // ✅ Step 5: Fetch rules details with timeout
      let rulesData = [];
      if (rules && rules.length > 0) {
        const rulesDocs = await Promise.race([
          Promise.all(
            rules.map((id) => db.collection("rules_master").doc(id).get())
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Rules fetch timeout")), 10000)
          )
        ]);

        rulesData = rulesDocs
          .filter((doc) => doc.exists)
          .map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }));
      }

      // ✅ Step 6: Prepare turf data
      const turfData = {
        title,
        address,
        description,
        sports: sportsData,
        amenities: amenitiesData,
        rules: rulesData,
        images: images || [],
        vendorId,
        vendorLocation,
        vendorGpsUrl,
        vendorCoordinates,
        createdAt: new Date().toISOString(),
        cancellationHours: Number(cancellationHours) || 0,
        featured: Number(featured) || 0,
        isSuspended: 0, // Active by default
      };

      console.log("✅ Prepared turf data, now saving to Firestore...");

      // ✅ Step 7: Save to Firestore with timeout
      const turfRef = await Promise.race([
        vendorRef.collection("turfs").add(turfData),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Firestore write timeout after 30s")), 30000)
        )
      ]);

      console.log("✅ Turf saved successfully with ID:", turfRef.id);

      // ✅ Step 8: Return response
      res.status(201).json({
        message: "Turf added successfully",
        vendorId,
        turfId: turfRef.id,
        turf: turfData,
      });
    } catch (err) {
      console.error("❌ Error adding turf:", err);

      // More specific error messages
      if (err.message.includes("timeout")) {
        return res.status(504).json({
          message: "Request timeout - please try again with smaller images or check your connection"
        });
      }

      res.status(500).json({
        message: err.message || "Internal server error"
      });
    }
  }
);

// ✅ PUT /admin/vendors/:vendorId/status → Update vendor status
router.put("/admin/vendors/:vendorId/status", checkAdminAuth, async (req, res) => {
  try {
    const { vendorId } = req.params;
    const { status } = req.body;

    if (!status || !['Active', 'Inactive'].includes(status)) {
      return res.status(400).json({ message: "Invalid status. Must be 'Active' or 'Inactive'" });
    }

    const vendorRef = db.collection("vendors").doc(vendorId);
    const doc = await vendorRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    await vendorRef.update({ status, updatedAt: new Date().toISOString() });

    res.status(200).json({
      message: `Vendor marked as ${status}`,
      vendor: { id: vendorId, status },
    });
  } catch (error) {
    console.error("Error updating vendor status:", error);
    res.status(500).json({ message: "Failed to update vendor status" });
  }
});

router.delete("/admin/vendors/:vendorId", checkAdminAuth, async (req, res) => {
  try {
    const { vendorId } = req.params;

    const vendorRef = db.collection("vendors").doc(vendorId);
    const doc = await vendorRef.get();

    if (!doc.exists) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    await vendorRef.delete();

    res.status(200).json({ message: "Vendor deleted successfully" });
  } catch (err) {
    console.error("Error deleting vendor:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// router.post(
//   "/admin/vendors/:vendorId/turfs",
//   checkAdminAuth,
//   async (req, res) => {
//     try {
//       const { vendorId } = req.params;
//       const {
//         title,
//         address,
//         description,
//         timeSlots,
//         sports,
//         courts,
//         amenities,
//         rules,
//         images,
//       } = req.body;

//       // Validate required fields
//       if (
//         !title ||
//         !address ||
//         !description ||
//         !timeSlots ||
//         !sports ||
//         !courts ||
//         !amenities ||
//         !rules ||
//         !images
//       ) {
//         return res
//           .status(400)
//           .json({ message: "Missing required turf fields" });
//       }

//       // Check if vendor exists
//       const vendorRef = db.collection("vendors").doc(vendorId);
//       const vendorDoc = await vendorRef.get();

//       if (!vendorDoc.exists) {
//         return res.status(404).json({ message: "Vendor not found" });
//       }

//       // Prepare turf data
//       const turfData = {
//         title,
//         address,
//         description,
//         timeSlots, // [{ open: "06:00", close: "10:00" }, ...]
//         sports, // [{ name: "football", slotPrice: 500 }]
//         courts, // ["Court A", "Court B"]
//         amenities, // ["wifi", "parking", ...]
//         rules, // ["No food", "No smoking", ...]
//         images, // [URLs]
//         createdAt: new Date().toISOString(),
//       };

//       // Save turf under vendor's subcollection
//       const turfRef = await vendorRef.collection("turfs").add(turfData);

//       res.status(201).json({
//         message: "Turf added successfully",
//         turfId: turfRef.id,
//       });
//     } catch (error) {
//       console.error("Error adding turf:", error);
//       res.status(500).json({ message: "Internal server error" });
//     }
//   }
// );

// router.post(
//   "/admin/vendors/:vendorId/turfs",
//   checkAdminAuth,
//   async (req, res) => {
//     try {
//       const { vendorId } = req.params;
//       const {
//         title,
//         address,
//         description,
//         timeSlots,
//         sports,
//         courts,
//         amenities,
//         rules,
//         images,
//       } = req.body;

//       if (
//         !title ||
//         !address ||
//         !description ||
//         !timeSlots ||
//         !sports ||
//         !courts ||
//         !amenities ||
//         !rules ||
//         !images
//       ) {
//         return res
//           .status(400)
//           .json({ message: "Missing required turf fields" });
//       }

//       // Check vendor exists
//       const vendorRef = db.collection("vendors").doc(vendorId);
//       const vendorDoc = await vendorRef.get();

//       if (!vendorDoc.exists) {
//         return res.status(404).json({ message: "Vendor not found" });
//       }

//       // 🌐 Geocode the address to get lat/lng
//       // 🌐 Geocode using maps.co (instead of Google)
// let location = null;

// try {
//   const encodedAddress = encodeURIComponent("Burdwan Railway Station,Burdwan");
//   console.log(encodedAddress); // 🔑 encode the full address
//   const geoUrl = `https://geocode.maps.co/search?q=${encodedAddress}&api_key=${process.env.MAPSCO_API_KEY}`;

//   const response = await axios.get(geoUrl);
//   const result = response.data && response.data.length > 0 ? response.data[0] : null;

//   if (result) {
//     location = {
//       latitude: parseFloat(result.lat),
//       longitude: parseFloat(result.lon),
//     };
//   }
// } catch (geoErr) {
//   console.warn("⚠️ maps.co geocoding failed:", geoErr.message);
// }

//       // Prepare turf data
//       const turfData = {
//         title,
//         address,
//         description,
//         timeSlots,
//         sports,
//         courts,
//         amenities,
//         rules,
//         images,
//         location: location || null,
//         createdAt: new Date().toISOString(),
//       };

//       // Save to Firestore
//       const turfRef = await vendorRef.collection("turfs").add(turfData);

//       res.status(201).json({
//         message: "Turf added successfully",
//         turfId: turfRef.id,
//       });
//     } catch (err) {
//       console.error("Error adding turf:", err);
//       res.status(500).json({ message: "Internal server error" });
//     }
//   }
// );

// router.post(
//   "/admin/vendors/:vendorId/turfs",
//   checkAdminAuth,
//   async (req, res) => {
//     try {
//       const { vendorId } = req.params;
//       const {
//         title,
//         address,
//         description,
//         timeSlots,
//         sports,
//         courts,
//         amenities,
//         rules,
//         images,
//         cancellationHours = 0,
//         featured = 0,
//       } = req.body;

//       if (
//         !title ||
//         !address ||
//         !description ||
//         !timeSlots ||
//         !sports ||
//         !courts ||
//         !amenities ||
//         !rules ||
//         !images
//       ) {
//         return res
//           .status(400)
//           .json({ message: "Missing required turf fields" });
//       }

//       // 🔍 Step 1: Check vendor exists
//       const vendorRef = db.collection("vendors").doc(vendorId);
//       const vendorDoc = await vendorRef.get();

//       if (!vendorDoc.exists) {
//         return res.status(404).json({ message: "Vendor not found" });
//       }

//       // 📍 Step 2: Geocode the actual `address` from req.body (not hardcoded)
//       let location = null;
//       try {
//         const encodedAddress = encodeURIComponent(address); // ✅ correct usage
//         const geoUrl = `https://geocode.maps.co/search?q=${encodedAddress}&api_key=${process.env.MAPSCO_API_KEY}`;

//         const response = await axios.get(geoUrl);
//         const result =
//           response.data && response.data.length > 0 ? response.data[0] : null;

//         if (result) {
//           location = {
//             latitude: parseFloat(result.lat),
//             longitude: parseFloat(result.lon),
//           };
//         } else {
//           console.warn("⚠️ No valid geocode result for:", address);
//         }
//       } catch (geoErr) {
//         console.warn("⚠️ maps.co geocoding failed:", geoErr.message);
//       }
//       const sportsWithDiscount = sports.map((sport) => ({
//         name: sport.name,
//         slotPrice: sport.slotPrice,
//         discountedPrice: sport.discountedPrice ?? 0, // default to 0 if missing
//       }));

//       let amenitiesData = [];
//       if (amenities && amenities.length > 0) {
//         const amenitiesPromises = amenities.map((id) =>
//           db.collection("amenities_master").doc(id).get()
//         );
//         const amenitiesDocs = await Promise.all(amenitiesPromises);
//         amenitiesData = amenitiesDocs
//           .filter((doc) => doc.exists)
//           .map((doc) => ({ id: doc.id, ...doc.data() }));
//       }

//       // Fetch rules details
//       let rulesData = [];
//       if (rules && rules.length > 0) {
//         const rulesPromises = rules.map((id) =>
//           db.collection("rules_master").doc(id).get()
//         );
//         const rulesDocs = await Promise.all(rulesPromises);
//         rulesData = rulesDocs
//           .filter((doc) => doc.exists)
//           .map((doc) => ({ id: doc.id, ...doc.data() }));
//       }
//       // 🧾 Step 3: Prepare turf data
//       const turfData = {
//         title,
//         address,
//         description,
//         timeSlots, // [{ open, close }]
//         sports: sportsWithDiscount, // [{ name: "football", slotPrice: 500 }]
//         courts, // ["Court A", "Court B"]
//         amenities: amenitiesData, // ["wifi", "parking", ...]
//         rules: rulesData, // ["No smoking", ...]
//         images, // [URLs]
//         location: location || null,
//         createdAt: new Date().toISOString(),
//         cancellationHours, // default 0 if not provided
//         featured,
//         vendorId, // store vendor ID for easy reference
//       };

//       // 💾 Step 4: Save to Firestore
//       const turfRef = await vendorRef.collection("turfs").add(turfData);

//       res.status(201).json({
//         message: "Turf added successfully",
//         vendorId: vendorId,
//         turfId: turfRef.id,
//         turf: turfData, // ✅ include full saved data in response
//       });
//     } catch (err) {
//       console.error("❌ Error adding turf:", err);
//       res.status(500).json({ message: "Internal server error" });
//     }
//   }
// );

router.get("/vendors/:id/turfs", checkAdminAuth, async (req, res) => {
  try {
    const vendorId = req.params.id;

    // 1. Get vendor details
    const vendorRef = db.collection("vendors").doc(vendorId);
    const vendorDoc = await vendorRef.get();

    if (!vendorDoc.exists) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    const vendorData = vendorDoc.data();

    // 2. Get turfs under this vendor
    const turfSnapshot = await vendorRef.collection("turfs").get();
    const turfs = [];

    turfSnapshot.forEach((doc) => {
      const turf = doc.data();

      // Calculate openTime, closeTime from all timeSlots
      const openTimes = turf.timeSlots.map((slot) => slot.open);
      const closeTimes = turf.timeSlots.map((slot) => slot.close);

      const openTime = openTimes.sort()[0];
      const closeTime = closeTimes.sort().reverse()[0];

      turfs.push({
        turfId: doc.id,
        title: turf.title,
        vendorName: vendorData.name,
        phone: vendorData.phone,
        location: vendorData.location,
        description: turf.description,
        courtsCount: turf.courts?.length || 0,
        openTime,
        closeTime,
        createdAt: turf.createdAt,
        thumbnail: turf.images?.[0] || null,
        cancellationHour: turf.cancellationHour || null, // ✅ New Field
        featured: turf.featured || false, // ✅ New Field
        isSuspended: turf.isSuspended || false, // ✅ New Field
      });
    });

    res.status(200).json(turfs);
  } catch (error) {
    console.error("Error fetching turfs:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/admin/turfs", checkAdminAuth, async (req, res) => {
  try {
    const vendorSnapshot = await db.collection("vendors").get();
    const allTurfs = [];

    for (const vendorDoc of vendorSnapshot.docs) {
      const vendorData = vendorDoc.data();
      const vendorId = vendorDoc.id;

      const turfSnapshot = await db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .get();

      turfSnapshot.forEach((turfDoc) => {
        const turf = turfDoc.data();

        // Get open/close time from timeSlots
        const openTimes = turf.timeSlots?.map((slot) => slot.open) || [];
        const closeTimes = turf.timeSlots?.map((slot) => slot.close) || [];

        const openTime = openTimes.length ? openTimes.sort()[0] : null;
        const closeTime = closeTimes.length
          ? closeTimes.sort().reverse()[0]
          : null;

        allTurfs.push({
          turfId: turfDoc.id,
          title: turf.title,
          vendorName: vendorData.name,
          phone: vendorData.phone,
          location: vendorData.location,
          description: turf.description,
          courtsCount: turf.courts?.length || 0,
          courts: turf.courts || [],
          openTime,
          closeTime,
          createdAt: turf.createdAt,
          thumbnail: turf.images?.[0] || null,
          isSuspended: turf.isSuspended || 0, // ✅ Include suspension status
        });
      });
    }

    res.status(200).json(allTurfs);
  } catch (err) {
    console.error("Error fetching all turfs:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.put(
  "/admin/vendors/:vendorId/turfs/:turfId",
  checkAdminAuth,
  async (req, res) => {
    try {
      const { vendorId, turfId } = req.params;
      const updateData = req.body;

      const turfRef = db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .doc(turfId);

      const turfDoc = await turfRef.get();

      if (!turfDoc.exists) {
        return res.status(404).json({ message: "Turf not found" });
      }

      await turfRef.update(updateData);

      res.status(200).json({ message: "Turf updated successfully" });
    } catch (error) {
      console.error("Error updating turf:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.patch(
  "/admin/turfs/:vendorId/:turfId/suspend",
  checkAdminAuth,
  async (req, res) => {
    try {
      const { vendorId, turfId } = req.params;
      const { isSuspended } = req.body; // 1 or 0

      if (typeof isSuspended === "undefined") {
        return res.status(400).json({ message: "isSuspended is required" });
      }

      // Turf reference
      const turfRef = db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .doc(turfId);
      const turfDoc = await turfRef.get();

      if (!turfDoc.exists) {
        return res.status(404).json({ message: "Turf not found" });
      }

      // Update the turf
      await turfRef.update({ isSuspended: Number(isSuspended) });

      // Fetch updated turf
      const updatedTurfDoc = await turfRef.get();
      const updatedTurf = updatedTurfDoc.data();

      // Add turfId to the response for clarity
      updatedTurf.turfId = turfId;

      res.status(200).json({
        message:
          isSuspended == 1
            ? "Turf suspended successfully"
            : "Turf unsuspended successfully",
        turf: updatedTurf,
      });
    } catch (error) {
      console.error("Error updating turf suspension:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.delete(
  "/admin/vendors/:vendorId/turfs/:turfId",
  checkAdminAuth,
  async (req, res) => {
    try {
      const { vendorId, turfId } = req.params;

      const turfRef = db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .doc(turfId);

      const turfDoc = await turfRef.get();

      if (!turfDoc.exists) {
        return res.status(404).json({ message: "Turf not found" });
      }

      // ✅ Soft delete (flag as deleted)
      await turfRef.update({ deleted: true });

      res.status(200).json({ message: "Turf marked as deleted" });

      // ❌ Hard delete (only use if you're sure):
      // await turfRef.delete();
      // res.status(200).json({ message: "Turf deleted permanently" });
    } catch (error) {
      console.error("Error deleting turf:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.get("/admin/turfs/rules", checkAdminAuth, async (req, res) => {
  try {
    const vendorSnapshot = await db.collection("vendors").get();
    const result = [];

    for (const vendorDoc of vendorSnapshot.docs) {
      const vendorId = vendorDoc.id;
      const turfSnapshot = await db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .get();

      turfSnapshot.forEach((turfDoc) => {
        const turf = turfDoc.data();
        if (turf.rules && Array.isArray(turf.rules)) {
          result.push({
            turfId: turfDoc.id,
            title: turf.title,
            rules: turf.rules,
          });
        }
      });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching rules:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.delete(
  "/admin/vendors/:vendorId/turfs/:turfId/rules",
  checkAdminAuth,
  async (req, res) => {
    try {
      const { vendorId, turfId } = req.params;
      const { rulesToDelete } = req.body;

      if (!rulesToDelete || !Array.isArray(rulesToDelete)) {
        return res
          .status(400)
          .json({ message: "rulesToDelete must be an array" });
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
      const updatedRules =
        turfData.rules?.filter((rule) => !rulesToDelete.includes(rule)) || [];

      await turfRef.update({ rules: updatedRules });

      res.status(200).json({
        message: "Rules deleted successfully",
        remainingRules: updatedRules,
      });
    } catch (error) {
      console.error("Error deleting rules:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.get("/admin/turfs/amenities", checkAdminAuth, async (req, res) => {
  try {
    const vendorSnapshot = await db.collection("vendors").get();
    const result = [];

    for (const vendorDoc of vendorSnapshot.docs) {
      const vendorId = vendorDoc.id;
      const turfSnapshot = await db
        .collection("vendors")
        .doc(vendorId)
        .collection("turfs")
        .get();

      turfSnapshot.forEach((turfDoc) => {
        const turf = turfDoc.data();
        if (turf.amenities && Array.isArray(turf.amenities)) {
          result.push({
            turfId: turfDoc.id,
            title: turf.title,
            amenities: turf.amenities,
          });
        }
      });
    }

    res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching amenities:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.delete(
  "/admin/vendors/:vendorId/turfs/:turfId/amenities",
  checkAdminAuth,
  async (req, res) => {
    try {
      const { vendorId, turfId } = req.params;
      const { amenitiesToDelete } = req.body;

      if (!amenitiesToDelete || !Array.isArray(amenitiesToDelete)) {
        return res
          .status(400)
          .json({ message: "amenitiesToDelete must be an array" });
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
      const updatedAmenities =
        turfData.amenities?.filter((a) => !amenitiesToDelete.includes(a)) || [];

      await turfRef.update({ amenities: updatedAmenities });

      res.status(200).json({
        message: "Amenities deleted successfully",
        remainingAmenities: updatedAmenities,
      });
    } catch (error) {
      console.error("Error deleting amenities:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  }
);

router.get("/admin/bookings/:bookingId", checkAdminAuth, async (req, res) => {
  try {
    const { bookingId } = req.params;

    const bookingDoc = await db.collection("bookings").doc(bookingId).get();
    if (!bookingDoc.exists) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const bookingData = bookingDoc.data();

    res.status(200).json({
      bookingId,
      ...bookingData,
    });
  } catch (error) {
    console.error("Error fetching booking:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/admin/bookings/summary", async (req, res) => {
  console.log("📥 Admin bookings summary route hit");

  try {
    const snapshot = await db.collection("bookings").get();
    console.log("📦 Total bookings found:", snapshot.size);

    if (snapshot.empty) {
      return res.status(404).json({ message: "No bookings found" });
    }

    let totalBookings = 0;
    let totalAmount = 0;

    snapshot.forEach((doc) => {
      const data = doc.data();
      totalBookings += 1;
      totalAmount += data.amount || 0;
    });

    res.status(200).json({ totalBookings, totalAmount });
  } catch (err) {
    console.error("🔥 Error fetching bookings:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/admin/all-bookings", checkAdminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection("bookings").get();

    if (snapshot.empty) {
      return res.status(200).json({ total: 0, bookings: [] });
    }

    const bookings = [];
    snapshot.forEach((doc) => {
      bookings.push({
        bookingId: doc.id,
        ...doc.data(),
      });
    });

    res.status(200).json({ total: bookings.length, bookings });
  } catch (err) {
    console.error("Error fetching all bookings:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/admin/users", checkAdminAuth, async (req, res) => {
  try {
    const usersSnap = await db.collection("users").get();

    if (usersSnap.empty) {
      return res.status(200).json({ users: [], message: "No users found." });
    }

    const users = usersSnap.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.status(200).json({ users });
  } catch (error) {
    console.error("Error fetching users:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/admin/tax", checkAdminAuth, async (req, res) => {
  try {
    const { percentage } = req.body;

    if (percentage === undefined || percentage < 0) {
      return res.status(400).json({ message: "Invalid tax percentage" });
    }

    await db.collection("tax").doc("global").set({ percentage });

    res.status(200).json({
      message: "Tax rate updated successfully",
      percentage,
    });
  } catch (err) {
    console.error("Failed to set tax:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// CREATE Amenity
router.post("/admin/amenities", checkAdminAuth, async (req, res) => {
  try {
    const { name, description = "", icon = "" } = req.body;

    // Validate only the name field
    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "Name field is required" });
    }

    const newAmenity = { name, description, icon };
    const docRef = await db.collection("amenities_master").add(newAmenity);

    res.status(201).json({ id: docRef.id, ...newAmenity });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/admin/amenities", checkAdminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection("amenities_master").get();
    const amenities = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json(amenities);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// UPDATE Amenity
router.put("/admin/amenities/:id", checkAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, icon } = req.body;

    const docRef = db.collection("amenities_master").doc(id);
    const docSnapshot = await docRef.get();

    if (!docSnapshot.exists) {
      return res.status(404).json({ error: "Amenity not found" });
    }

    await docRef.update({ name, description, icon });

    res.status(200).json({ message: "Amenity updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE Amenity
router.delete("/admin/amenities/:id", checkAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const docRef = db.collection("amenities_master").doc(id);

    const docSnapshot = await docRef.get();
    if (!docSnapshot.exists) {
      return res.status(404).json({ error: "Amenity not found" });
    }

    await docRef.delete();
    res.status(200).json({ message: "Amenity deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/admin/rules", checkAdminAuth, async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Rule name is required" });
    }

    const newRule = { name, description: description || "" };
    const docRef = await db.collection("rules_master").add(newRule);

    res.status(201).json({ id: docRef.id, ...newRule });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/admin/rules", checkAdminAuth, async (req, res) => {
  try {
    const snapshot = await db.collection("rules_master").get();
    const rules = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.status(200).json(rules);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put("/admin/rules/:id", checkAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Rule name is required" });
    }

    await db
      .collection("rules_master")
      .doc(id)
      .update({ name, description: description || "" });
    res.status(200).json({ message: "Rule updated successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/admin/rules/:id", checkAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    await db.collection("rules_master").doc(id).delete();
    res.status(200).json({ message: "Rule deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// NOTIFICATIONS MANAGEMENT
// ========================================

const {
  sendAnnouncementToAllUsers,
  sendNotificationToUser,
} = require('../utils/notificationHelper');

// ✅ POST /admin/notifications/send → Send notification to all users
router.post("/admin/notifications/send", checkAdminAuth, async (req, res) => {
  try {
    const { title, message } = req.body;

    if (!title || !message) {
      return res.status(400).json({ message: "Title and message are required" });
    }

    const result = await sendAnnouncementToAllUsers(title, message);
    
    res.status(200).json({
      message: "Notification sent successfully",
      usersCount: result.count,
    });
  } catch (error) {
    console.error("Error sending notification:", error);
    res.status(500).json({ message: "Failed to send notification" });
  }
});

// ✅ POST /admin/notifications/send-to-user → Send notification to specific user
router.post("/admin/notifications/send-to-user", checkAdminAuth, async (req, res) => {
  try {
    const { userId, title, message } = req.body;

    if (!userId || !title || !message) {
      return res.status(400).json({ message: "userId, title, and message are required" });
    }

    // Verify user exists
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({ message: "User not found" });
    }

    await sendNotificationToUser(userId, title, message);
    
    res.status(200).json({ message: "Notification sent successfully" });
  } catch (error) {
    console.error("Error sending notification to user:", error);
    res.status(500).json({ message: "Failed to send notification" });
  }
});

// ✅ GET /admin/notifications/history → Get notification history
router.get("/admin/notifications/history", checkAdminAuth, async (req, res) => {
  try {
    const notificationsSnapshot = await db
      .collection("notifications")
      .where("type", "in", ["admin_announcement", "admin_message"])
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();

    const notifications = notificationsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ notifications });
  } catch (error) {
    console.error("Error fetching notification history:", error);
    res.status(500).json({ message: "Failed to fetch notification history" });
  }
});

// ============================================
// CONTENT MANAGEMENT ENDPOINTS
// ============================================

// GET /api/admin/content/help-support - Fetch Help & Support content for admin
router.get("/admin/content/help-support", checkAdminAuth, async (req, res) => {
  try {
    const doc = await db.collection("app_content").doc("help_support").get();
    
    if (!doc.exists) {
      // Return default content if not found
      return res.status(200).json({
        greeting: "Hi, How can we help you?",
        contactOptions: [
          {
            id: 1,
            title: "Email Us",
            subtitle: "support@playbhoomi.com",
            icon: "mail",
            type: "email"
          },
          {
            id: 2,
            title: "Call Us",
            subtitle: "+91 1234567890",
            icon: "call",
            type: "phone"
          },
          {
            id: 3,
            title: "WhatsApp",
            subtitle: "Chat with us",
            icon: "logo-whatsapp",
            type: "whatsapp",
            whatsappNumber: "+911234567890"
          }
        ],
        faqs: [],
        supportHours: "Monday - Sunday: 9:00 AM - 9:00 PM"
      });
    }

    res.status(200).json(doc.data());
  } catch (error) {
    console.error("Error fetching help & support content:", error);
    res.status(500).json({ message: "Failed to fetch content" });
  }
});

// PUT /api/admin/content/help-support - Update Help & Support content
router.put("/admin/content/help-support", checkAdminAuth, async (req, res) => {
  try {
    const { greeting, contactOptions, faqs, supportHours } = req.body;

    if (!greeting || !contactOptions || !faqs || !supportHours) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const contentData = {
      greeting,
      contactOptions,
      faqs,
      supportHours,
      updatedAt: new Date().toISOString()
    };

    await db.collection("app_content").doc("help_support").set(contentData, { merge: true });

    res.status(200).json({ 
      message: "Help & Support content updated successfully",
      content: contentData
    });
  } catch (error) {
    console.error("Error updating help & support content:", error);
    res.status(500).json({ message: "Failed to update content" });
  }
});

// GET /api/admin/content/terms-conditions - Fetch Terms & Conditions for admin
router.get("/admin/content/terms-conditions", checkAdminAuth, async (req, res) => {
  try {
    const doc = await db.collection("app_content").doc("terms_conditions").get();
    
    if (!doc.exists) {
      // Return default content if not found
      return res.status(200).json({
        title: "Terms & Conditions",
        lastUpdated: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
        sections: [
          {
            id: 1,
            title: "1. Acceptance of Terms",
            content: "By accessing and using this turf booking application, you accept and agree to be bound by the terms and provision of this agreement."
          }
        ],
        contactEmail: "support@playbhoomi.com"
      });
    }

    res.status(200).json(doc.data());
  } catch (error) {
    console.error("Error fetching terms & conditions:", error);
    res.status(500).json({ message: "Failed to fetch content" });
  }
});

// PUT /api/admin/content/terms-conditions - Update Terms & Conditions
router.put("/admin/content/terms-conditions", checkAdminAuth, async (req, res) => {
  try {
    const { title, lastUpdated, sections, contactEmail } = req.body;

    if (!title || !sections || !contactEmail) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const contentData = {
      title,
      lastUpdated,
      sections,
      contactEmail,
      updatedAt: new Date().toISOString()
    };

    await db.collection("app_content").doc("terms_conditions").set(contentData, { merge: true });

    res.status(200).json({ 
      message: "Terms & Conditions updated successfully",
      content: contentData
    });
  } catch (error) {
    console.error("Error updating terms & conditions:", error);
    res.status(500).json({ message: "Failed to update content" });
  }
});

// ============================================
// PUBLIC CONTENT ENDPOINTS (No Auth Required)
// ============================================

// GET /api/content/help-support - Public endpoint for user app
router.get("/content/help-support", async (req, res) => {
  try {
    const doc = await db.collection("app_content").doc("help_support").get();
    
    if (!doc.exists) {
      // Return default content
      return res.status(200).json({
        greeting: "Hi, How can we help you?",
        contactOptions: [
          {
            id: 1,
            title: "Email Us",
            subtitle: "support@playbhoomi.com",
            icon: "mail",
            type: "email"
          },
          {
            id: 2,
            title: "Call Us",
            subtitle: "+91 1234567890",
            icon: "call",
            type: "phone"
          },
          {
            id: 3,
            title: "WhatsApp",
            subtitle: "Chat with us",
            icon: "logo-whatsapp",
            type: "whatsapp",
            whatsappNumber: "+911234567890"
          }
        ],
        faqs: [
          {
            id: 1,
            question: "How do I book a turf?",
            answer: "Browse available turfs on the home screen, select your preferred turf, choose date and time slots, and proceed to payment to confirm your booking."
          }
        ],
        supportHours: "Monday - Sunday: 9:00 AM - 9:00 PM"
      });
    }

    res.status(200).json(doc.data());
  } catch (error) {
    console.error("Error fetching help & support content:", error);
    res.status(500).json({ message: "Failed to fetch content" });
  }
});

// GET /api/content/terms-conditions - Public endpoint for user app
router.get("/content/terms-conditions", async (req, res) => {
  try {
    const doc = await db.collection("app_content").doc("terms_conditions").get();
    
    if (!doc.exists) {
      // Return default content
      return res.status(200).json({
        title: "Terms & Conditions",
        lastUpdated: "January 19, 2026",
        sections: [
          {
            id: 1,
            title: "1. Acceptance of Terms",
            content: "By accessing and using this turf booking application, you accept and agree to be bound by the terms and provision of this agreement."
          },
          {
            id: 2,
            title: "2. Booking Policy",
            content: "• All bookings are subject to availability\n• Booking confirmation will be sent via email/SMS\n• Payment must be completed to confirm booking\n• Booking slots are for the specified time duration only"
          }
        ],
        contactEmail: "support@playbhoomi.com"
      });
    }

    res.status(200).json(doc.data());
  } catch (error) {
    console.error("Error fetching terms & conditions:", error);
    res.status(500).json({ message: "Failed to fetch content" });
  }
});

module.exports = router;
