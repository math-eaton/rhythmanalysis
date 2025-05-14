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
from psycopg2.extras import execute_values


# paths
SCRIPT_DIR   = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]
config_path = PROJECT_ROOT / "dbconfig.json"
# csv_path    = PROJECT_ROOT / "output" / "classifications.csv"

# load config
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
try:
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
    print("[DEBUG] PostgreSQL connected OK")
except Exception as e:
    print("[ERROR] Could not connect to Postgres:", e)
    raise


# Ensure table exists
cur.execute("""
CREATE TABLE IF NOT EXISTS audio_logs (
  id          SERIAL PRIMARY KEY,
  ts          TIMESTAMPTZ    NOT NULL,
  db          DOUBLE PRECISION,
  c1_idx      DOUBLE PRECISION,
  c1_cf       DOUBLE PRECISION,
  c2_idx      DOUBLE PRECISION,
  c2_cf       DOUBLE PRECISION,
  c3_idx      DOUBLE PRECISION,
  c3_cf       DOUBLE PRECISION,
  raw_json    JSONB          NOT NULL,
  created_at  TIMESTAMPTZ    DEFAULT NOW()
);
""")

# Prepare INSERT
insert_sql = """
INSERT INTO audio_logs 
  (ts, db, c1_idx, c1_cf, c2_idx, c2_cf, c3_idx, c3_cf, raw_json)
VALUES %s;
"""

buffer = []
last_flush = time.time()

def on_message(client, userdata, msg):
    global buffer, last_flush
    print(f"[DEBUG] Got MQTT → topic={msg.topic}, payload={msg.payload[:80]}…")
    obj = json.loads(msg.payload.decode("utf-8")) 
    buffer.append(obj)

    # flush on size or timeout
    if len(buffer) >= 20 or time.time() - last_flush >= 5.0:
        args = [(
            datetime.fromtimestamp(o["ts"]),
            o["db"], o["c1_idx"], o["c1_cf"],
            o["c2_idx"], o["c2_cf"],
            o["c3_idx"], o["c3_cf"],
            json.dumps(o)
        ) for o in buffer]
        psycopg2.extras.execute_values(cur, insert_sql, args)
        execute_values(cur, insert_sql, args, template=None, page_size=20)
        conn.commit()
        buffer.clear()
        last_flush = time.time()

def on_connect(client, userdata, flags, rc):
    if rc == 0:
        print("[DEBUG] MQTT connected, subscribing…")
        client.subscribe(topic, qos=1)
    else:
        print("[ERROR] MQTT failed to connect, rc=", rc)

def on_disconnect(client, userdata, rc):
    if rc != 0:
        print("[ERROR] Unexpected disconnection. Reconnecting...")
        client.reconnect()

# Initialize MQTT client
client = mqtt.Client()
client.username_pw_set(username, password)
client.tls_set(tls_version=ssl.PROTOCOL_TLSv1_2)
client.enable_logger()
client.on_connect = on_connect
client.on_message = on_message
client.on_disconnect = on_disconnect 
client.connect(broker, port)

try:
    client.loop_forever()
except Exception as e:
    print(f"[ERROR] MQTT loop failed: {e}")