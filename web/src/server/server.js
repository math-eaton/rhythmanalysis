import express from "express";
import cors from "cors";
import { Pool } from "pg";

const app = express();
app.use(cors());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.get("/api/audio_logs", async (req, res) => {
  try {
    const { rows } = await pool.query(`
        SELECT EXTRACT(EPOCH FROM ts) AS ts, c1_name AS class
        FROM audio_logs
        ORDER BY ts DESC
    `);
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
