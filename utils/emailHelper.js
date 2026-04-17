const axios = require("axios");

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

async function sendEmail(to, subject, htmlContent) {
  if (!to || !to.includes("@")) {
    console.warn("[Email] Invalid email address:", to);
    return;
  }
  const response = await axios.post(
    BREVO_URL,
    {
      sender: {
        name: process.env.BREVO_SENDER_NAME || "Playbhoomi",
        email: process.env.BREVO_SENDER_EMAIL,
      },
      to: [{ email: to }],
      subject,
      htmlContent,
    },
    { headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" } }
  );
  if (response.status >= 400) {
    throw new Error(`Brevo error: ${JSON.stringify(response.data)}`);
  }
}

async function sendBookingConfirmationEmail(email, { bookingId, turfName, date, timeSlot, amount }) {
  const subject = "Booking Confirmed – Playbhoomi";
  const htmlContent = `
    <div style="font-family:sans-serif;max-width:500px;margin:auto;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
      <div style="background:#067B6A;padding:20px;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:22px">Booking Confirmed!</h1>
      </div>
      <div style="padding:24px">
        <p style="margin:0 0 16px">Hi there! Your turf booking has been confirmed.</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#555">Venue</td><td style="padding:8px 0;font-weight:600">${turfName}</td></tr>
          <tr><td style="padding:8px 0;color:#555">Date</td><td style="padding:8px 0;font-weight:600">${date}</td></tr>
          <tr><td style="padding:8px 0;color:#555">Time Slot</td><td style="padding:8px 0;font-weight:600">${timeSlot}</td></tr>
          <tr><td style="padding:8px 0;color:#555">Amount Paid</td><td style="padding:8px 0;font-weight:600">Rs. ${amount}</td></tr>
          <tr><td style="padding:8px 0;color:#555">Booking ID</td><td style="padding:8px 0;font-size:12px;color:#888">${bookingId}</td></tr>
        </table>
        <p style="margin:20px 0 0;color:#888;font-size:12px">See you on the field! – Team Playbhoomi</p>
      </div>
    </div>`;
  try {
    await sendEmail(email, subject, htmlContent);
  } catch (err) {
    console.error("[Email] Booking confirmation failed:", err.message);
  }
}

async function sendBookingReminderEmail(email, { turfName, date, timeSlot }) {
  const subject = "Reminder: Your Playbhoomi Booking is Coming Up!";
  const htmlContent = `
    <div style="font-family:sans-serif;max-width:500px;margin:auto;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
      <div style="background:#067B6A;padding:20px;text-align:center">
        <h1 style="color:#fff;margin:0;font-size:22px">Game Time Soon!</h1>
      </div>
      <div style="padding:24px">
        <p style="margin:0 0 16px">Your booking is coming up in about 2 hours. Get ready!</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#555">Venue</td><td style="padding:8px 0;font-weight:600">${turfName}</td></tr>
          <tr><td style="padding:8px 0;color:#555">Date</td><td style="padding:8px 0;font-weight:600">${date}</td></tr>
          <tr><td style="padding:8px 0;color:#555">Time Slot</td><td style="padding:8px 0;font-weight:600">${timeSlot}</td></tr>
        </table>
        <p style="margin:20px 0 0;color:#888;font-size:12px">See you on the field! – Team Playbhoomi</p>
      </div>
    </div>`;
  try {
    await sendEmail(email, subject, htmlContent);
  } catch (err) {
    console.error("[Email] Booking reminder failed:", err.message);
  }
}

module.exports = { sendBookingConfirmationEmail, sendBookingReminderEmail };
