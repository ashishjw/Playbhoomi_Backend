const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { db } = require("../firebase/firebase");
const checkVendorAuth = require("../middleware/checkVendorAuth");

const JWT_SECRET = process.env.JWT_SECRET || "your_vendor_secret"; // secure this in env

router.post("/vendors/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Email and password required" });
  }

  try {
    const vendorSnapshot = await db
      .collection("vendors")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (vendorSnapshot.empty) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const vendorDoc = vendorSnapshot.docs[0];
    const vendorData = vendorDoc.data();

    // 🔒 You can hash and compare passwords in production
    if (vendorData.password !== password) {
      return res.status(401).json({ message: "Invalid email or password" });
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
    const bookings = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      totalBookings += 1;
      totalEarnings += data.amount || 0;

      // 🔍 Fetch user info from Firestore
      const userDoc = await db.collection("users").doc(data.userId).get();
      const user = userDoc.exists
        ? userDoc.data()
        : { name: "Unknown", phone: "N/A" };

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