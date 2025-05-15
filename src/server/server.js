import express from "express";
import cors from "cors";
import { Pool } from "pg";

const app = express();
app.use(cors());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.get("/api/audio_logs", async (req, res) => {
  try {
    // allow client to override, but default to 24 hours
    const hours = parseInt(req.query.hours, 10) || 24;

    const text = `
      SELECT
        EXTRACT(EPOCH FROM ts)     AS ts,
        c1_idx                     AS cl,
        c1_cf                      AS cf,
        db                         AS dB
      FROM audio_logs
      WHERE ts >= NOW() - $1 * INTERVAL '1 hour'
      ORDER BY ts ASC
    `;

    const { rows } = await pool.query(text, [hours]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "db error" });
  }
});

app.get("/api/audio_logs/count", async (req, res) => {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS total,
             MIN(ts)   AS earliest,
             MAX(ts)   AS latest
      FROM audio_logs;
    `);
    res.json(rows[0]);
  });
  
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
