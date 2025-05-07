import os
import time
import ssl
import json
from datetime import datetime
from urllib.parse import urlparse
from pathlib import Path

import paho.mqtt.client as mqtt
import pandas as pd
import psycopg2

# paths
SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]
config_path = PROJECT_ROOT / "config.json"
csv_path    = PROJECT_ROOT / "output" / "classifications.csv"


# load config
config_path = os.path.join(os.path.dirname(__file__), "config.json")
with open(config_path, "r") as cfg_file:
    cfg = json.load(cfg_file)

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

data = pd.read_csv(csv_path)

# ————— MQTT setup —————
client = mqtt.Client()
client.username_pw_set(username, password)
client.tls_set(tls_version=ssl.PROTOCOL_TLSv1_2)
client.connect(broker, port)

try:
    for _, row in data.iterrows():
        # 1) Publish to MQTT
        payload = row.to_json()
        client.publish(topic, payload)
        print(f"Published securely to HiveMQ: {payload}")

        # 2) Parse JSON and INSERT into Postgres
        obj = json.loads(payload)
        ts = datetime.fromtimestamp(obj["ts"])
        db     = obj.get("db")
        c1_idx = obj.get("c1_idx")
        c1_cf  = obj.get("c1_cf")
        c1_name = obj.get("c1_name")
        c2_idx = obj.get("c2_idx")
        c2_cf  = obj.get("c2_cf")
        c2_name = obj.get("c2_name")
        c3_idx = obj.get("c3_idx")
        c3_cf  = obj.get("c3_cf")
        c3_name = obj.get("c3_name")

        cur.execute(
            insert_sql,
            (ts, db, c1_idx, c1_cf, c1_name, c2_idx, c2_cf, c2_name, c3_idx, c3_cf, c3_name, json.dumps(obj))
        )
        print("  → Stored to Postgres")

        time.sleep(interval)

except KeyboardInterrupt:
    print("Terminated by user")

finally:
    client.disconnect()
    cur.close()
    conn.close()
