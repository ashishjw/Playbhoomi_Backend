const { db } = require('../firebase/firebase');

/**
 * Create a notification in Firestore
 * @param {string} userId - User ID to send notification to
 * @param {string} title - Notification title
 * @param {string} message - Notification message
 * @param {string} type - Notification type (booking_confirmed, booking_cancelled, etc.)
 * @param {object} metadata - Optional metadata (bookingId, amount, etc.)
 */
async function createNotification(userId, title, message, type, metadata = {}) {
  try {
    const notification = {
      userId,
      title,
      message,
      type,
      read: false,
      createdAt: new Date().toISOString(),
      metadata,
    };

    const notificationRef = await db.collection('notifications').add(notification);
    console.log(`✅ Notification created for user ${userId}:`, notificationRef.id);
    return notificationRef.id;
  } catch (error) {
    console.error('Error creating notification:', error);
    throw error;
  }
}

/**
 * Send booking confirmed notification
 */
async function sendBookingConfirmedNotification(userId, bookingData) {
  const title = 'Booking Confirmed! 🎉';
  const message = `Your booking for ${bookingData.turfName} on ${bookingData.date} at ${bookingData.timeSlot} has been confirmed.`;
  
  return createNotification(userId, title, message, 'booking_confirmed', {
    bookingId: bookingData.bookingId,
    turfName: bookingData.turfName,
    date: bookingData.date,
    timeSlot: bookingData.timeSlot,
  });
}

/**
 * Send booking cancelled notification
 */
async function sendBookingCancelledNotification(userId, bookingData) {
  const title = 'Booking Cancelled';
  const message = `Your booking for ${bookingData.turfName} on ${bookingData.date} has been cancelled. Refund will be processed within 5-7 business days.`;
  
  return createNotification(userId, title, message, 'booking_cancelled', {
    bookingId: bookingData.bookingId,
    turfName: bookingData.turfName,
    date: bookingData.date,
  });
}

/**
 * Send payment success notification
 */
async function sendPaymentSuccessNotification(userId, paymentData) {
  const title = 'Payment Successful ✅';
  const message = `Payment of ₹${paymentData.amount} received successfully. Your booking is confirmed!`;
  
  return createNotification(userId, title, message, 'payment_success', {
    bookingId: paymentData.bookingId,
    amount: paymentData.amount,
    paymentId: paymentData.paymentId,
  });
}

/**
 * Send admin announcement to all users
 */
async function sendAnnouncementToAllUsers(title, message) {
  try {
    const usersSnapshot = await db.collection('users').get();
    const promises = [];

    usersSnapshot.forEach((userDoc) => {
      promises.push(
        createNotification(userDoc.id, title, message, 'admin_announcement')
      );
    });

    await Promise.all(promises);
    console.log(`✅ Announcement sent to ${usersSnapshot.size} users`);
    return { success: true, count: usersSnapshot.size };
  } catch (error) {
    console.error('Error sending announcement:', error);
    throw error;
  }
}

/**
 * Send notification to specific user
 */
async function sendNotificationToUser(userId, title, message) {
  return createNotification(userId, title, message, 'admin_message');
}

module.exports = {
  createNotification,
  sendBookingConfirmedNotification,
  sendBookingCancelledNotification,
  sendPaymentSuccessNotification,
  sendAnnouncementToAllUsers,
  sendNotificationToUser,
};
