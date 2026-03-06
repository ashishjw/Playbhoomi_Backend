const axios = require("axios");

const FAST2SMS_URL = "https://www.fast2sms.com/dev/bulkV2";

function cleanPhone(phone) {
  const digits = String(phone).replace(/\D/g, "").replace(/^91/, "");
  return digits.length === 10 ? digits : null;
}

async function sendSMS(phone, message) {
  const number = cleanPhone(phone);
  if (!number) {
    console.warn("[SMS] Invalid phone number:", phone);
    return;
  }
  const response = await axios.post(
    FAST2SMS_URL,
    { route: "q", message, language: "english", flash: 0, numbers: number },
    { headers: { authorization: process.env.FAST2SMS_API_KEY } }
  );
  if (!response.data.return) {
    throw new Error(`Fast2SMS error: ${JSON.stringify(response.data)}`);
  }
}

async function sendBookingConfirmationSMS(phone, { bookingId, turfName, date, timeSlot, amount }) {
  const message =
    `Booking Confirmed! Krida\n` +
    `Venue: ${turfName}\n` +
    `Date: ${date} at ${timeSlot}\n` +
    `Amount: Rs.${amount}\n` +
    `Booking ID: ${bookingId}`;
  try {
    await sendSMS(phone, message);
  } catch (err) {
    console.error("[SMS] Booking confirmation failed:", err.message);
  }
}

async function sendBookingReminderSMS(phone, { turfName, date, timeSlot }) {
  const message =
    `Reminder: Your Krida booking is in ~2 hours!\n` +
    `Venue: ${turfName}\n` +
    `Date: ${date} at ${timeSlot}`;
  try {
    await sendSMS(phone, message);
  } catch (err) {
    console.error("[SMS] Booking reminder failed:", err.message);
  }
}

module.exports = { sendBookingConfirmationSMS, sendBookingReminderSMS };
