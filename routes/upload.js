const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const cloudinary = require('../utils/cloudinary');
const multer = require('multer');
const checkUserAuth = require('../middleware/checkUserAuth');

// Accepts any valid JWT role (user, guest, vendor, admin) — for shared endpoints
const checkAnyAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authorization token missing' });
  }
  try {
    const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_BASE64_MB = 10;

router.post('/upload', checkAnyAuth, async (req, res) => {
  try {
    const { image } = req.body; // Expecting base64 data URI or https URL
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Validate: must be a base64 data URI or an https URL
    const isDataUri = image.startsWith('data:');
    const isHttpsUrl = image.startsWith('https://');
    if (!isDataUri && !isHttpsUrl) {
      return res.status(400).json({ error: 'Image must be a base64 data URI or https URL' });
    }

    // For base64: validate MIME type and size
    if (isDataUri) {
      const mimeMatch = image.match(/^data:([^;]+);base64,/);
      if (!mimeMatch || !ALLOWED_IMAGE_TYPES.includes(mimeMatch[1])) {
        return res.status(400).json({ error: 'Only JPEG, PNG, WebP, or GIF images are allowed' });
      }
      const base64Data = image.split(',')[1] || '';
      const sizeBytes = (base64Data.length * 3) / 4;
      if (sizeBytes > MAX_BASE64_MB * 1024 * 1024) {
        return res.status(400).json({ error: `Image must be under ${MAX_BASE64_MB}MB` });
      }
    }

    const uploadResult = await cloudinary.uploader.upload(image, {
      folder: 'turf_images',
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
      resource_type: 'image',
    });

    res.status(200).json(uploadResult);
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Profile photo upload endpoint
router.post('/upload/profile-photo', checkUserAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    // Convert buffer to base64
    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;

    // Upload to Cloudinary
    const uploadResult = await cloudinary.uploader.upload(base64Image, {
      folder: 'profile_photos',
      transformation: [
        { width: 400, height: 400, crop: 'fill' },
        { quality: 'auto' }
      ]
    });

    res.status(200).json({ 
      url: uploadResult.secure_url,
      publicId: uploadResult.public_id 
    });
  } catch (error) {
    console.error('Profile photo upload error:', error);
    res.status(500).json({ message: error.message || 'Failed to upload profile photo' });
  }
});

module.exports = router;
