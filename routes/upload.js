const express = require('express');
const router = express.Router();
const cloudinary = require('../utils/cloudinary');

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

module.exports = router;
