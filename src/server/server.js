import express from "express";
import cors from "cors";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { parse as csvParse } from "csv-parse";
import { fileURLToPath } from "url";
import { DateTime } from "luxon";

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
    let start, end;
    let offset = req.query.offsetHours ? parseFloat(req.query.offsetHours) : 0;
    if (req.query.start && req.query.end) {
      start = parseFloat(req.query.start);
      end = parseFloat(req.query.end);
      if (offset) {
        start -= offset * 3600;
        end -= offset * 3600;
      }
    } else {
      // Always use current UTC time as windowEnd
      const now = DateTime.utc();
      end = now.toSeconds() - offset * 3600;
      start = now.minus({ hours: req.query.hours ? parseFloat(req.query.hours) : 24 }).toSeconds() - offset * 3600;
    }

    const text = `
      SELECT
        id,
        raw_ts,
        EXTRACT(EPOCH FROM ts) AS ts,  -- now a FLOAT in seconds
        db,
        c1_idx,
        c1_cf,
        c2_idx,
        c2_cf,
        c3_idx,
        c3_cf
      FROM audio_logs
      WHERE ts BETWEEN to_timestamp($1) AND to_timestamp($2)
      ORDER BY ts, id
    `;
    const params = [start, end];
    console.log("/api/audio_logs SQL:", { start, end, offset, sql: text });

    const { rows } = await pool.query(text, params);
    console.log("/api/audio_logs returned rows:", rows.length);
    if (rows.length > 0) {
      const minTs = Math.min(...rows.map(r => +r.ts));
      const maxTs = Math.max(...rows.map(r => +r.ts));
      console.log("Earliest ts:", minTs, new Date(minTs * 1000).toISOString());
      console.log("Latest ts:", maxTs, new Date(maxTs * 1000).toISOString());
    }
    res.json({
      windowStart: start,
      windowEnd: end,
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
