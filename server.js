const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const pool = require("./database");
const { updateChessComLeaderboards } = require("./helpers/chesscom");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = [
  "https://chess45.com",
  "https://www.chess45.com",
  "http://127.0.0.1:5500",
];

app.use(
  cors({
    origin: allowedOrigins,
  }),
);

app.use((req, res, next) => {
  const origin = req.get("origin");

  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).send("Forbidden");
  }

  next();
});

app.use(express.json());

// --- Per-route rate limiters ---

// Puzzles: core gameplay, users may need several batches per session
const puzzlesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again in a minute." },
});

// Leaderboard: mostly static data, moderate limit
const chesscomLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again in a minute." },
});

// Feedback: strict — one submission every 5 minutes is plenty
const feedbackLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Please wait a few minutes before sending another message.",
  },
});

// --- Gmail transporter ---

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// --- Routes ---

app.get("/", (req, res) => {
  res.send("Chess API is running");
});

app.post("/puzzles", puzzlesLimiter, async (req, res) => {
  try {
    const ratingIds = Array.isArray(req.body?.ratingIds)
      ? req.body.ratingIds
      : [];

    if (ratingIds.length === 0) {
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT * FROM puzzles WHERE ratingId = ANY($1::text[])`,
      [ratingIds],
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send("Database error");
  }
});

app.get("/chesscom", chesscomLimiter, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM chesscom_players
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send("Database error");
  }
});

app.post("/feedback", feedbackLimiter, async (req, res) => {
  const { name, email, message } = req.body || {};

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "Message is required." });
  }
  if (message.trim().length > 2000) {
    return res
      .status(400)
      .json({ error: "Message must be under 2000 characters." });
  }

  const senderName = (name || "Anonymous").slice(0, 100);
  const senderEmail = (email || "Not provided").slice(0, 200);

  try {
    await transporter.sendMail({
      from: `"SOLVEchess Feedback" <${process.env.GMAIL_USER}>`,
      to: process.env.FEEDBACK_RECIPIENT,
      subject: `[SOLVEchess Feedback] from ${senderName}`,
      text: [
        `Name:    ${senderName}`,
        `Email:   ${senderEmail}`,
        ``,
        `Message:`,
        message.trim(),
      ].join("\n"),
      html: `
        <div style="font-family:sans-serif;max-width:600px">
          <h2 style="color:#333">New Feedback – SOLVEchess</h2>
          <table style="border-collapse:collapse;width:100%">
            <tr>
              <td style="padding:6px 12px;font-weight:bold;background:#f5f5f5;border:1px solid #ddd">Name</td>
              <td style="padding:6px 12px;border:1px solid #ddd">${senderName}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;font-weight:bold;background:#f5f5f5;border:1px solid #ddd">Email</td>
              <td style="padding:6px 12px;border:1px solid #ddd">${senderEmail}</td>
            </tr>
          </table>
          <h3 style="margin-top:20px;color:#333">Message</h3>
          <p style="white-space:pre-wrap;background:#f9f9f9;padding:12px;border-left:4px solid #ccc">${message.trim()}</p>
        </div>
      `,
    });

    res.json({ success: true, message: "Feedback sent. Thank you!" });
  } catch (err) {
    console.error("Feedback email error:", err);
    res
      .status(500)
      .json({ error: "Failed to send feedback. Please try again later." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Run once on startup
updateChessComLeaderboards(pool);

// Then refresh every hour
cron.schedule("0 */1 * * *", () => {
  console.log("Running scheduled leaderboard update...");
  updateChessComLeaderboards(pool);
});
