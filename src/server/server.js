import express from "express";
import cors from "cors";
import compression from "compression";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { parse as csvParse } from "csv-parse/sync";
import { fileURLToPath } from "url";
import { DateTime } from "luxon";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// env variable for remote web service, fallback to dbconfig.json for local dev
let dbUrl = process.env.POSTGRES_URL;
if (!dbUrl) {
  const dbConfigPath = path.resolve(__dirname, '../../dbconfig.json');
  const dbConfig = JSON.parse(fs.readFileSync(dbConfigPath, 'utf8'));
  dbUrl = dbConfig.postgres_url;
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false }
});

// Warm up the pool to avoid cold-start latency on first request
pool.connect()
  .then(client => client.release())
  .catch(err => console.error('Pool warmup failed', err));

const app = express();
app.use(cors());
app.use(compression());               // enable gzip

// Parse the CSV once at startup
const csvPath = path.join(__dirname, "yamnet_class_map.csv");
let classMap = [];
try {
  const csvData = fs.readFileSync(csvPath, "utf8");
  classMap = csvParse(csvData, { columns: true });
} catch (err) {
  console.error("Failed to load yamnet_class_map.csv:", err);
}

app.get("/api/audio_logs", async (req, res) => {
  try {
    // build time window
    let start, end;
    const offset = req.query.offsetHours ? parseFloat(req.query.offsetHours) : 0;
    const binSeconds = req.query.binSeconds ? parseInt(req.query.binSeconds) : null;
    const limit = req.query.limit
      ? parseInt(req.query.limit)
      : (binSeconds ? 100000 : 1000);
    const rowOffset = req.query.offset ? parseInt(req.query.offset) : 0;

    if (req.query.start && req.query.end) {
      start = parseFloat(req.query.start) - offset * 3600;
      end   = parseFloat(req.query.end)   - offset * 3600;
    } else {
      const now = DateTime.utc();
      end   = now.toSeconds() - offset * 3600;
      start = now
        .minus({ hours: req.query.hours ? parseFloat(req.query.hours) : 24 })
        .toSeconds() - offset * 3600;
    }

    // approximate total via pg_class.reltuples
    const estResult = await pool.query(
      `SELECT reltuples AS estimate
         FROM pg_class
        WHERE relname = 'audio_logs'`
    );
    const total = Math.floor(estResult.rows[0].estimate);

    // fetch your data (binned vs. raw)
    let text, params;
    if (binSeconds) {
      text = `
        SELECT * FROM (
          SELECT *,
            EXTRACT(EPOCH FROM ts) AS ts,
            FLOOR(EXTRACT(EPOCH FROM ts) / $3) AS bin,
            ROW_NUMBER()
              OVER (
                PARTITION BY c1_idx, FLOOR(EXTRACT(EPOCH FROM ts) / $3)
                ORDER BY c1_cf DESC, ts DESC
              ) AS rn
          FROM audio_logs
          WHERE ts BETWEEN to_timestamp($1) AND to_timestamp($2)
        ) sub
        WHERE rn = 1
        ORDER BY c1_idx, bin
        LIMIT $4 OFFSET $5
      `;
      params = [start, end, binSeconds, limit, rowOffset];
    } else {
      text = `
        SELECT
          id,
          raw_ts,
          EXTRACT(EPOCH FROM ts) AS ts,
          db,
          c1_idx,
          c1_cf
        FROM audio_logs
        WHERE ts BETWEEN to_timestamp($1) AND to_timestamp($2)
        ORDER BY ts DESC, id DESC
        LIMIT $3 OFFSET $4
      `;
      params = [start, end, limit, rowOffset];
    }

    const { rows } = await pool.query(text, params);

    res.json({
      windowStart: start,
      windowEnd: end,
      total,
      data: rows
    });

  } catch (err) {
    console.error("/api/audio_logs ERROR:", err.stack || err);
    res.status(500).json({ error: "db error", details: err.message });
  }
});

app.get("/api/audio_logs/count", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS total,
             MIN(ts)   AS earliest,
             MAX(ts)   AS latest
        FROM audio_logs;
    `);
    res.json(rows[0]);
  } catch (err) {
    console.error("/api/audio_logs/count ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/yamnet_class_map", (_, res) => {
  res.json(classMap);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
