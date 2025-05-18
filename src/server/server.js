import express from "express";
import cors from "cors";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { parse as csvParse } from "csv-parse";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load dbconfig.json for database URL
const dbConfigPath = path.resolve(__dirname, '../../dbconfig.json');
const dbConfig = JSON.parse(fs.readFileSync(dbConfigPath, 'utf8'));
const pool = new Pool({
  connectionString: dbConfig.postgres_url,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());

app.get("/api/audio_logs", async (req, res) => {
  try {
    // Support start/end (UNIX seconds) or fallback to hours
    const start = req.query.start ? parseFloat(req.query.start) : null;
    const end = req.query.end ? parseFloat(req.query.end) : null;
    let text, params, windowStart, windowEnd;

    if (start && end) {
      text = `
        SELECT
          EXTRACT(EPOCH FROM ts)     AS ts,
          c1_idx                     AS cl,
          c1_cf                      AS cf,
          db                         AS dB
        FROM audio_logs
        WHERE ts > to_timestamp($1) AND ts < to_timestamp($2)
        ORDER BY ts ASC
      `;
      params = [start, end];
      windowStart = start;
      windowEnd = end;
      console.log("/api/audio_logs SQL (start/end):", { start, end, sql: text });
    } else {
      // Support fractional hours (float)
      const hours = req.query.hours ? parseFloat(req.query.hours) : 12;
      // Always use current time as windowEnd (real time)
      const nowSec = Date.now() / 1000;
      windowEnd = nowSec - (0 * 3600); // N hours ago
      windowStart = windowEnd - hours * 3600;
      text = `
        SELECT
          EXTRACT(EPOCH FROM ts)     AS ts,
          c1_idx                     AS cl,
          c1_cf                      AS cf,
          db                         AS dB
        FROM audio_logs
        WHERE ts >= to_timestamp($1) AND ts <= to_timestamp($2)
        ORDER BY ts ASC
      `;
      params = [windowStart, windowEnd];
      console.log("/api/audio_logs SQL:", { windowStart, windowEnd, sql: text });
    }

    const { rows } = await pool.query(text, params);
    console.log("/api/audio_logs returned rows:", rows.length);
    if (rows.length > 0) {
      const minTs = Math.min(...rows.map(r => +r.ts));
      const maxTs = Math.max(...rows.map(r => +r.ts));
      console.log("Earliest ts:", minTs, new Date(minTs * 1000).toISOString());
      console.log("Latest ts:", maxTs, new Date(maxTs * 1000).toISOString());
    }
    res.json({
      windowStart,
      windowEnd,
      data: rows
    });

  } catch (err) {
    console.error("/api/audio_logs ERROR:", err.stack || err);
    res.status(500).json({ error: "db error", details: err.message });
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
