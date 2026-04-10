const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { db } = require("../firebase/firebase");
const checkVendorAuth = require("../middleware/checkVendorAuth");

const JWT_SECRET = process.env.JWT_SECRET;
const BCRYPT_ROUNDS = 10;

router.post("/vendors/login", async (req, res) => {
  const { email, phone, password } = req.body;
  const loginId = phone || email; // prefer phone, fallback to email

  if (!loginId || !password) {
    return res.status(400).json({ message: "Phone/email and password required" });
  }

  try {
    // Try phone first, then email
    let vendorSnapshot;
    if (phone) {
      vendorSnapshot = await db.collection("vendors").where("phone", "==", phone).limit(1).get();
    }
    if ((!vendorSnapshot || vendorSnapshot.empty) && email) {
      vendorSnapshot = await db.collection("vendors").where("email", "==", email).limit(1).get();
    }
    // Also try loginId as email if only one field sent
    if ((!vendorSnapshot || vendorSnapshot.empty) && !phone) {
      vendorSnapshot = await db.collection("vendors").where("phone", "==", loginId).limit(1).get();
    }

    if (!vendorSnapshot || vendorSnapshot.empty) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const vendorDoc = vendorSnapshot.docs[0];
    const vendorData = vendorDoc.data();

    // Compare password (supports both bcrypt hash and legacy plaintext)
    const isHashed = vendorData.password && vendorData.password.startsWith("$2");
    const passwordMatch = isHashed
      ? await bcrypt.compare(password, vendorData.password)
      : vendorData.password === password;

    if (!passwordMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Auto-migrate plaintext password to bcrypt hash
    if (!isHashed) {
      const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await vendorDoc.ref.update({ password: hashed });
    }

    // ✅ Generate JWT token
    const token = jwt.sign(
      {
        uid: vendorDoc.id,
        role: "vendor",
      },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(200).json({ message: "Login successful", token });
  } catch (err) {
    console.error("Vendor login error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/vendors/dashboard", checkVendorAuth, async (req, res) => {
  const vendorId = req.vendor.uid;

  try {
    const snapshot = await db
      .collection("bookings")
      .where("vendorId", "==", vendorId)
      .get();

    if (snapshot.empty) {
      return res.status(200).json({
        totalBookings: 0,
        totalEarnings: 0,
        bookings: [],
      });
    }

    let totalBookings = 0;
    let totalEarnings = 0;

    // Batch-fetch all unique users in one call instead of N+1 sequential reads
    const uniqueUserIds = [...new Set(snapshot.docs.map((doc) => doc.data().userId).filter(Boolean))];
    const userMap = {};
    if (uniqueUserIds.length > 0) {
      const userRefs = uniqueUserIds.map((uid) => db.collection("users").doc(uid));
      const userDocs = await db.getAll(...userRefs);
      userDocs.forEach((userDoc) => {
        if (userDoc.exists) {
          userMap[userDoc.id] = userDoc.data();
        }
      });
    }

    const bookings = [];
    for (const doc of snapshot.docs) {
      const data = doc.data();
      totalBookings += 1;
      totalEarnings += data.amount || 0;

      const user = userMap[data.userId] || { name: "Unknown", phone: "N/A" };

      bookings.push({
        bookingId: doc.id,
        turfId: data.turfId,
        turfName: data.turfName,
        date: data.date,
        timeSlot: data.timeSlot,
        sports: data.sports,
        bookingStatus: data.bookingStatus || "Pending",
        amount: data.amount,
        user: {
          name: user.name || "Unknown",
          phone: user.phone || "N/A",
        },
      });
    }

    res.status(200).json({
      totalBookings,
      totalEarnings,
      bookings,
    });
  } catch (err) {
    console.error("Vendor dashboard error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;