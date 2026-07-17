const express = require("express");
const cors = require("cors");
const pool = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Chess API is running for testing only");
});

// Get Puzzles by ratingId
// Body: { ratingIds: string[] }  e.g. ["221B", "453B", "566B", "8874B"]
// The frontend pre-generates unique random ratingIds for the current band
// and excludes already-solved ones, so ORDER BY RANDOM() is not needed here.
app.post("/puzzles", async (req, res) => {
  try {
    const ratingIds = Array.isArray(req.body?.ratingIds)
      ? req.body.ratingIds
      : [];

    if (ratingIds.length === 0) {
      return res.json([]);
    }

    const result = await pool.query(
      `SELECT * FROM puzzles
       WHERE ratingId = ANY($1::text[])`,
      [ratingIds],
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).send("Database error");

    res.status(500).json({
      message: error.message,
    });
  }
});

/*pool
  .query("SELECT NOW()")
  .then((result) => {
    console.log("✅ Connected to PostgreSQL");
    console.log(result.rows[0]);
  })
  .catch((err) => {
    console.error("❌ PostgreSQL connection failed");
    console.error(err);
  });*/

app.listen(PORT, () => {
  console.log(`Server runing in ${PORT}`);
});
