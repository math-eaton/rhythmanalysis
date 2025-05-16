import express from "express";
import cors from "cors";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { parse as csvParse } from "csv-parse";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.get("/api/audio_logs", async (req, res) => {
  try {
    // Support start/end (UNIX seconds) or fallback to hours
    const start = req.query.start ? parseInt(req.query.start, 10) : null;
    const end = req.query.end ? parseInt(req.query.end, 10) : null;
    let text, params;

    if (start && end) {
      text = `
        SELECT
          EXTRACT(EPOCH FROM ts)     AS ts,
          c1_idx                     AS cl,
          c1_cf                      AS cf,
          db                         AS dB
        FROM audio_logs
        WHERE ts >= to_timestamp($1) AND ts < to_timestamp($2)
        ORDER BY ts ASC
      `;
      params = [start, end];
    } else {
      const hours = parseInt(req.query.hours, 10) || 24;
      text = `
        SELECT
          EXTRACT(EPOCH FROM ts)     AS ts,
          c1_idx                     AS cl,
          c1_cf                      AS cf,
          db                         AS dB
        FROM audio_logs
        WHERE ts >= NOW() - $1 * INTERVAL '1 hour'
        ORDER BY ts ASC
      `;
      params = [hours];
    }

    const { rows } = await pool.query(text, params);
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

// Serve yamnet_class_map.csv as JSON
app.get("/api/yamnet_class_map", async (req, res) => {
  const csvPath = path.join(__dirname, "yamnet_class_map.csv");
  try {
    const csvData = fs.readFileSync(csvPath, "utf8");
    csvParse(csvData, { columns: true }, (err, records) => {
      if (err) {
        res.status(500).json({ error: "Failed to parse CSV" });
      } else {
        res.json(records);
      }
    });
  } catch (e) {
    res.status(500).json({ error: "Failed to read CSV" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
