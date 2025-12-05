#!/usr/bin/env python3
"""
MQTT to PostgreSQL publisher with environment variable configuration.
Subscribes to MQTT topic, batches messages, and persists to database.
"""
import os
import time
import ssl
import json
from datetime import datetime
from urllib.parse import urlparse

import paho.mqtt.client as mqtt
import psycopg2
import psycopg2.extras
from psycopg2.extras import execute_values

# === Configuration from environment ===
broker   = os.getenv('MQTT_BROKER')
port     = int(os.getenv('MQTT_PORT', '8883'))
username = os.getenv('MQTT_USERNAME')
password = os.getenv('MQTT_PASSWORD')
topic    = os.getenv('MQTT_TOPIC')
db_url   = os.getenv('POSTGRES_URL')

if not all([broker, username, password, topic, db_url]):
    raise ValueError("Missing required environment variables: MQTT_BROKER, MQTT_USERNAME, MQTT_PASSWORD, MQTT_TOPIC, POSTGRES_URL")

# === Batch settings ===
BATCH_SIZE = 20
BATCH_TIMEOUT = 5  # seconds

# === PostgreSQL connection ===
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

# === Database schema ===
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
print("[DEBUG] Table 'audio_logs' ready")

# === Batching logic ===
batch = []
last_insert_time = time.time()

def flush_batch():
    global batch, last_insert_time
    if not batch:
        return
    
    try:
        rows = []
        for msg in batch:
            ts = datetime.fromtimestamp(msg["ts"], tz=None)
            rows.append((
                ts,
                msg.get("db"),
                msg.get("c1_idx"),
                msg.get("c1_cf"),
                msg.get("c2_idx"),
                msg.get("c2_cf"),
                msg.get("c3_idx"),
                msg.get("c3_cf"),
                json.dumps(msg)
            ))
        
        execute_values(
            cur,
            """
            INSERT INTO audio_logs (ts, db, c1_idx, c1_cf, c2_idx, c2_cf, c3_idx, c3_cf, raw_json)
            VALUES %s
            """,
            rows
        )
        print(f"[DB] Inserted {len(batch)} rows")
        batch = []
        last_insert_time = time.time()
    except Exception as e:
        print(f"[ERROR] Batch insert failed: {e}")
        batch = []

# === MQTT callbacks ===
def on_connect(client, userdata, flags, rc, properties):
    if rc == 0:
        print(f"[MQTT] Connected successfully, subscribing to '{topic}'")
        client.subscribe(topic, qos=1)
    else:
        print(f"[MQTT] Connection failed with code {rc}")

def on_message(client, userdata, msg):
    global batch, last_insert_time
    try:
        payload = json.loads(msg.payload.decode('utf-8'))
        batch.append(payload)
        
        # Flush if batch is full or timeout reached
        if len(batch) >= BATCH_SIZE or (time.time() - last_insert_time) >= BATCH_TIMEOUT:
            flush_batch()
    except Exception as e:
        print(f"[ERROR] Failed to process message: {e}")

def on_disconnect(client, userdata, disconnect_flags, rc, properties):
    print(f"[MQTT] Disconnected with code {rc}")
    if rc != 0:
        print("[MQTT] Unexpected disconnection, will auto-reconnect")

# === MQTT client setup ===
mqtt_client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
mqtt_client.on_connect = on_connect
mqtt_client.on_message = on_message
mqtt_client.on_disconnect = on_disconnect

mqtt_client.username_pw_set(username, password)
mqtt_client.tls_set(tls_version=ssl.PROTOCOL_TLSv1_2)

print(f"[MQTT] Connecting to {broker}:{port}...")
mqtt_client.connect(broker, port, keepalive=60)

# === Main loop ===
try:
    mqtt_client.loop_forever()
except KeyboardInterrupt:
    print("\n[INFO] Shutting down...")
    flush_batch()  # Flush any remaining messages
    mqtt_client.disconnect()
    cur.close()
    conn.close()
    print("[INFO] Cleanup complete")
