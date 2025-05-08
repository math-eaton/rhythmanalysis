### cheat sheet for sql/postgresql/psql commands

- enter render cli: render psql
- print ten lines from "audio_logs" db, sorted by timestamp: SELECT * FROM audio_logs ORDER BY ts DESC LIMIT 10;
- clear database: TRUNCATE TABLE audio_logs
  RESTART IDENTITY
  CASCADE;

- count records / check date ranges: SELECT COUNT(*) AS total_rows,
       MIN(ts)       AS earliest,
       MAX(ts)       AS latest
FROM audio_logs;


### other

- concurrency:
- pm2 start ecosystem.config.js
- pm2 kill