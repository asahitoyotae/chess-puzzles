const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");
const pool = require("./database");
const { updateChessComLeaderboards } = require("./helpers/chesscom");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

// Render (and most hosts) put a reverse proxy in front of the app. Without
// this, req.ip is the proxy's IP for EVERYONE, so every rate limiter below
// becomes one shared bucket (feedback = 1 message per 5 min for the whole site).
app.set("trust proxy", 1);

const allowedOrigins = ["https://chess45.com", "https://www.chess45.com"];

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
  skipFailedRequests: true, // a failed send shouldn't lock the user out
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Please wait a few minutes before sending another message.",
  },
});

// --- Gmail transporter ---

// NOTE: Render's free tier blocks outbound SMTP (ports 25/465/587) since
// Sept 2025, so Gmail/SMTP only works on a paid instance or locally. When
// RESEND_API_KEY is set we send over HTTPS instead, which always works.
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

const escapeHtml = (str) =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isEmail = (str) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);

async function deliverFeedback({ subject, text, html, replyTo }) {
  const to = process.env.FEEDBACK_RECIPIENT;
  if (!to) throw new Error("FEEDBACK_RECIPIENT is not set");

  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from:
          process.env.RESEND_FROM ||
          "chess45.com Feedback <onboarding@resend.dev>",
        to: [to],
        subject,
        text,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
    return;
  }

  await transporter.sendMail({
    from: `"chess45.com Feedback" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
}

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

app.post("/endgame_puzzles", puzzlesLimiter, async (req, res) => {
  try {
    const ratingIds = Array.isArray(req.body?.ratingIds)
      ? req.body.ratingIds
      : [];

    if (ratingIds.length === 0) {
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT * FROM endgames_puzzles WHERE ratingId = ANY($1::text[])`,
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

  const senderName =
    (typeof name === "string" && name.trim().slice(0, 100)) || "Anonymous";
  const senderEmail =
    (typeof email === "string" && email.trim().slice(0, 200)) || "Not provided";
  const cleanMessage = message.trim();

  try {
    await deliverFeedback({
      subject: `[chess45.com Feedback] from ${senderName}`.replace(
        /[\r\n]+/g,
        " ",
      ),
      replyTo: isEmail(senderEmail) ? senderEmail : undefined,
      text: [
        `Name:    ${senderName}`,
        `Email:   ${senderEmail}`,
        ``,
        `Message:`,
        cleanMessage,
      ].join("\n"),
      html: `
        <div style="font-family:sans-serif;max-width:600px">
          <h2 style="color:#333">New Feedback – chess45.com</h2>
          <table style="border-collapse:collapse;width:100%">
            <tr>
              <td style="padding:6px 12px;font-weight:bold;background:#f5f5f5;border:1px solid #ddd">Name</td>
              <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(senderName)}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;font-weight:bold;background:#f5f5f5;border:1px solid #ddd">Email</td>
              <td style="padding:6px 12px;border:1px solid #ddd">${escapeHtml(senderEmail)}</td>
            </tr>
          </table>
          <h3 style="margin-top:20px;color:#333">Message</h3>
          <p style="white-space:pre-wrap;background:#f9f9f9;padding:12px;border-left:4px solid #ccc">${escapeHtml(cleanMessage)}</p>
        </div>
      `,
    });

    res.json({ success: true, message: "Feedback sent. Thank you!" });
  } catch (err) {
    // err.code is ETIMEDOUT / ECONNECTION when SMTP is blocked, EAUTH for a bad app password
    console.error("Feedback email error:", err.code || "", err.message);
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
