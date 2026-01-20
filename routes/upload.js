const express = require('express');
const router = express.Router();
const cloudinary = require('../utils/cloudinary');
const multer = require('multer');
const checkUserAuth = require('../middleware/checkUserAuth');

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.post('/upload', async (req, res) => {
  try {
    const { image } = req.body; // Expecting base64 or URL
    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const uploadResult = await cloudinary.uploader.upload(image, {
      folder: 'turf_images',
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
