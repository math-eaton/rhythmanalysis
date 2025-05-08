import os
import time
import ssl
import json
from datetime import datetime
from urllib.parse import urlparse
from pathlib import Path

import paho.mqtt.client as mqtt
import psycopg2
import psycopg2.extras

# paths
SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]
config_path = PROJECT_ROOT / "config.json"
csv_path    = PROJECT_ROOT / "output" / "classifications.csv"


# load config
config_path = Path(__file__).parent.parent / "config.json"
with open(config_path, "r") as f:
    cfg = json.load(f)

# MQTT settings
broker   = cfg["hiveMQ_broker"]
port     = cfg["hiveMQ_port"]
username = cfg["hiveMQ_username"]
password = cfg["hiveMQ_password"]
topic    = cfg["topic"]
interval = cfg["interval_seconds"]

# Postgres via render
db_url = cfg["postgres_url"]

# load postgres
result = urlparse(db_url)
conn = psycopg2.connect(
    dbname   = result.path.lstrip("/"),
    user     = result.username,
    password = result.password,
    host     = result.hostname,
    port     = result.port,
)
conn.autocommit = True
cur = conn.cursor()

# Ensure table exists
cur.execute("""
CREATE TABLE IF NOT EXISTS audio_logs (
  id          SERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ    NOT NULL,
  db          DOUBLE PRECISION,
  c1_idx      DOUBLE PRECISION,
  c1_cf       DOUBLE PRECISION,
  c1_name     TEXT,
  c2_idx      DOUBLE PRECISION,
  c2_cf       DOUBLE PRECISION,
  c2_name     TEXT,
  c3_idx      DOUBLE PRECISION,
  c3_cf       DOUBLE PRECISION,
  c3_name     TEXT,
  raw_json    JSONB          NOT NULL,
  created_at  TIMESTAMPTZ    DEFAULT NOW()
);
""")

# Prepare INSERT
insert_sql = """
INSERT INTO audio_logs 
  (ts, db, c1_idx, c1_cf, c1_name, c2_idx, c2_cf, c2_name, c3_idx, c3_cf, c3_name, raw_json)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s);
"""

buffer = []
last_flush = time.time()

def on_message(client, userdata, msg):
    global buffer, last_flush
    obj = json.loads(msg.payload)
    buffer.append(obj)

    # flush on size or timeout
    if len(buffer) >= 20 or time.time() - last_flush >= 5.0:
        args = [(
            datetime.fromtimestamp(o["ts"]),
            o["db"], o["c1_idx"], o["c1_cf"], o["c1_name"],
            o["c2_idx"], o["c2_cf"], o["c2_name"],
            o["c3_idx"], o["c3_cf"], o["c3_name"],
            json.dumps(o)
        ) for o in buffer]
        psycopg2.extras.execute_values(cur, insert_sql, args)
        conn.commit()
        buffer.clear()
        last_flush = time.time()

client = mqtt.Client()
client.username_pw_set(username, password)
client.tls_set(tls_version=ssl.PROTOCOL_TLSv1_2)
client.connect(broker, port)

client.on_message = on_message
client.connect(broker, port)

client.subscribe(topic)

client.loop_forever()