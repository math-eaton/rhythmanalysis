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
      WHERE ts >= NOW() - INTERVAL '1 hour'
      ORDER BY ts ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "db error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
