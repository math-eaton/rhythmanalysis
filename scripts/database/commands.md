### cheat sheet for sql/postgresql/psql commands

- enter render cli: render psql
- print ten lines from "audio_logs" db, sorted by timestamp: SELECT * FROM audio_logs ORDER BY ts DESC LIMIT 10;
- clear database: TRUNCATE TABLE audio_logs
  RESTART IDENTITY
  CASCADE;

- 

### other

- concurrency:
- pm2 start ecosystem.config.js
- pm2 kill