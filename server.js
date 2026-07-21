const express = require("express");
const cors = require("cors");
const pool = require("./database");
const { updateChessComLeaderboards } = require("./helpers/chesscom");
const cron = require("node-cron");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Chess API is running for testing only");
});

app.post("/puzzles", async (req, res) => {
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

app.get("/chesscom", async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Run once on startup
updateChessComLeaderboards(pool);

// Then refresh every 6 hours
cron.schedule("0 */1 * * *", () => {
  console.log("Running scheduled leaderboard update...");
  updateChessComLeaderboards(pool);
});

/* SELECT DISTINCT *
      FROM (
        (SELECT * FROM chesscom_players
        ORDER BY rapid_rating DESC
        LIMIT 20)

        UNION

        (SELECT * FROM chesscom_players
        ORDER BY blitz_rating DESC
        LIMIT 20)

        UNION

        (SELECT * FROM chesscom_players
        ORDER BY bullet_rating DESC
        LIMIT 20)
      ) AS top_players;*/
