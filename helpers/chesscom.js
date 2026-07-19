const axios = require("axios");

const HEADERS = { "User-Agent": "SOLVEchess/1.0" };

async function updateChessComLeaderboards(pool) {
  try {
    console.log("Downloading Chess.com leaderboards...");

    const { data } = await axios.get("https://api.chess.com/pub/leaderboards", {
      headers: HEADERS,
    });

    const players = mergePlayers(
      data.live_blitz,
      data.live_rapid,
      data.live_bullet,
    );

    const values = Object.values(players);

    const placeholders = values
      .map((_, i) => {
        const o = i * 8;
        return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, NOW())`;
      })
      .join(", ");

    const params = values.flatMap((p) => [
      p.username,
      p.avatar ?? null,
      p.title ?? null,
      p.name ?? null,
      p.country ?? null,
      p.blitz_rating ?? null,
      p.rapid_rating ?? null,
      p.bullet_rating ?? null,
    ]);

    await pool.query(
      `INSERT INTO chesscom_players
        (username, avatar, title, name, country, blitz_rating, rapid_rating, bullet_rating, updated_at)
       VALUES ${placeholders}
       ON CONFLICT (username)
       DO UPDATE SET
        avatar        = EXCLUDED.avatar,
        title         = EXCLUDED.title,
        name          = EXCLUDED.name,
        country       = EXCLUDED.country,
        blitz_rating  = COALESCE(EXCLUDED.blitz_rating,  chesscom_players.blitz_rating),
        rapid_rating  = COALESCE(EXCLUDED.rapid_rating,  chesscom_players.rapid_rating),
        bullet_rating = COALESCE(EXCLUDED.bullet_rating, chesscom_players.bullet_rating),
        updated_at    = NOW()`,
      params,
    );

    console.log(`Leaderboards updated. (${values.length} players)`);
  } catch (err) {
    console.error("Failed to update leaderboards:", err);
  }
}

function mergePlayers(blitz = [], rapid = [], bullet = []) {
  const players = {};

  const merge = (list, ratingKey) => {
    for (const p of list.slice(0, 50)) {
      if (!players[p.username]) {
        players[p.username] = {
          username: p.username,
          avatar: p.avatar ?? null,
          title: p.title ?? null,
          name: p.name ?? null,
          country: p.country ? p.country.split("/").pop() : null,
          blitz_rating: null,
          rapid_rating: null,
          bullet_rating: null,
        };
      }
      players[p.username][ratingKey] = p.score;
    }
  };

  merge(blitz, "blitz_rating");
  merge(rapid, "rapid_rating");
  merge(bullet, "bullet_rating");

  return players;
}

module.exports = { updateChessComLeaderboards };
