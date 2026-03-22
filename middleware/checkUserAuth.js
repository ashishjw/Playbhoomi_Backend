const jwt = require("jsonwebtoken");

const checkUserAuth = function (req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authorization token missing" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!["user", "guest"].includes(decoded.role)) {
      return res.status(403).json({ message: "User access required" });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

const rejectGuest = function (req, res, next) {
  if (req.user && req.user.role === "guest") {
    return res.status(403).json({ message: "Please login to access this feature" });
  }
  next();
};

module.exports = checkUserAuth;
module.exports.rejectGuest = rejectGuest;
