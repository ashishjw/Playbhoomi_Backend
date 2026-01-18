// server.js
const express = require("express");
const cors = require("cors");
require("dotenv").config();

const adminRoutes = require("./routes/admin");
const vendorRoutes = require("./routes/vendors");
const userRoutes = require("./routes/users");
const uploadRoutes = require("./routes/upload");

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for image uploads
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use("/api", adminRoutes);
app.use("/api", vendorRoutes);
app.use("/api", userRoutes);
app.use("/api", uploadRoutes);

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
