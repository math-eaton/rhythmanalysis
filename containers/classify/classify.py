#!/usr/bin/env python3
"""
Audio classification script with environment variable configuration.
Reads from USB microphone, performs YAMNet inference, logs to CSV, and publishes via MQTT.
"""
import argparse
import time
import queue
import csv
import json
import os
import ssl
from pathlib import Path
from datetime import datetime
import pytz

import numpy as np
import pandas as pd
import sounddevice as sd
try:
    from ai_edge_litert.interpreter import Interpreter
    HAS_NUM_THREADS_ARG = True  # liteRT ie we are running on a raspberry pi
except ImportError:
    from tensorflow.lite.python.interpreter import Interpreter
    HAS_NUM_THREADS_ARG = False  # full TF ie we are running on a computer
from scipy.signal import resample_poly
import paho.mqtt.client as mqtt

# === config from environment ================================================─
YAMNET_MODEL      = os.getenv('YAMNET_MODEL', 'scripts/models/yamnet/tfLite/tflite/1/1.tflite')
CLASS_MAP_CSV     = os.getenv('CLASS_MAP_CSV', 'scripts/models/yamnet/yamnet_class_map.csv')
THRESHOLD         = float(os.getenv('CONFIDENCE_THRESHOLD', '0.33'))
NUM_THREADS       = int(os.getenv('NUM_THREADS', '2'))
TARGET_SR         = 16_000
FRAME_LEN         = 15_600    # 0.975 s

CHUNK_SEC         = 3.0
CHUNK_SAMPLES     = int(CHUNK_SEC * TARGET_SR)
HOP_SEC           = 0.5
HOP_SAMPLES       = int(HOP_SEC * TARGET_SR)

TOP_K             = 1
FLUSH_SEC         = 30
OUTPUT_CSV        = os.getenv('OUTPUT_CSV', "output/classifications.csv")

# === prep output csv ===================================================─
Path(OUTPUT_CSV).parent.mkdir(parents=True, exist_ok=True)
if not Path(OUTPUT_CSV).exists():
    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["ts", "db", "c1_idx", "c1_cf", "c1_name", "c2_idx", "c2_cf", "c2_name", "c3_idx", "c3_cf", "c3_name"])

# === mqtt config from environment ===================================================
broker   = os.getenv('MQTT_BROKER')
port     = int(os.getenv('MQTT_PORT', '8883'))
username = os.getenv('MQTT_USERNAME')
password = os.getenv('MQTT_PASSWORD')
topic    = os.getenv('MQTT_TOPIC')

if not all([broker, username, password, topic]):
    raise ValueError("Missing required MQTT environment variables: MQTT_BROKER, MQTT_USERNAME, MQTT_PASSWORD, MQTT_TOPIC")

# === init + connect mqtt ===================================================─
mqtt_client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2)

# Set up callbacks for connection, message, and log events
def on_connect(client, userdata, flags, rc, properties):
    if rc == 0:
        print("[MQTT] Connected successfully")
    else:
        print(f"[MQTT] Connection failed with code {rc}")

def on_disconnect(client, userdata, disconnect_flags, rc, properties):
    print(f"[MQTT] Disconnected with code {rc}")
    if rc != 0:
        print("[MQTT] Unexpected disconnection, will auto-reconnect")

mqtt_client.on_connect = on_connect
mqtt_client.on_disconnect = on_disconnect

mqtt_client.username_pw_set(username, password)
mqtt_client.tls_set(tls_version=ssl.PROTOCOL_TLSv1_2)

# Connect with non-blocking approach
try:
    mqtt_client.connect(broker, port, keepalive=60)
    mqtt_client.loop_start()
    print("[MQTT] Connection initiated...")
except Exception as e:
    print(f"[MQTT] Initial connection failed: {e}")
    print("[MQTT] Will continue anyway and retry in background...")
    mqtt_client.loop_start()  # Start loop anyway for auto-reconnect

# === load model + labels =============================================
print(f"[DEBUG] Loading labels from {CLASS_MAP_CSV}")
class_map = pd.read_csv(CLASS_MAP_CSV)
labels    = class_map['display_name'].to_numpy()
print(f"[DEBUG] {len(labels)} labels loaded")

print(f"[DEBUG] Loading TFLite model from {YAMNET_MODEL} with {NUM_THREADS} threads")
if HAS_NUM_THREADS_ARG:
    yam = Interpreter(model_path=YAMNET_MODEL, num_threads=NUM_THREADS)
else:
    yam = Interpreter(model_path=YAMNET_MODEL)
inp_detail = yam.get_input_details()[0]
print(f"[DEBUG] Original input shape: {inp_detail['shape']}")

yam.resize_tensor_input(0, [FRAME_LEN], strict=True)
yam.allocate_tensors()
inp_detail = yam.get_input_details()[0]
out_detail = yam.get_output_details()[0]
print(f"[DEBUG] Resized  input shape: {inp_detail['shape']}")

# === warm up model =====================================================================
print("[DEBUG] Warming up interpreter with a dummy frame…")
dummy = np.zeros((FRAME_LEN,), dtype=np.float32)
yam.set_tensor(inp_detail['index'], dummy)
t0 = time.monotonic()
yam.invoke()
t1 = time.monotonic()
print(f"[DEBUG]  → warm-up invoke: {t1-t0:.3f}s")

scores_idx = yam.get_output_details()[0]['index']
print(f"[DEBUG] Model ready with fixed input length {FRAME_LEN}")

# === parse args =========================================================
parser = argparse.ArgumentParser()
parser.add_argument('--list-devices', action='store_true')
parser.add_argument('-d','--device', default=None)
args = parser.parse_args()
if args.list_devices:
    for i, d in enumerate(sd.query_devices()):
        if d['max_input_channels']>0:
            print(f"[DEV] [{i}] {d['name']} @ {d['default_samplerate']}")
    exit(0)

# === set audio input device ======================================================
def find_device(name_or_id):
    try:
        return int(name_or_id)
    except:
        if name_or_id:
            for i, d in enumerate(sd.query_devices()):
                if name_or_id.lower() in d['name'].lower() and d['max_input_channels']>0:
                    return i
    for i, d in enumerate(sd.query_devices()):
        if d['max_input_channels']>0 and 'USB' in d['name']:
            return i
    return None

try:
    dev_id = find_device(args.device)
    info   = sd.query_devices(dev_id, 'input') if dev_id is not None else sd.query_devices(None,'input')
    dev_sr = int(info['default_samplerate'])
    print(f"[DEBUG] Using input '{info['name']}' @ {dev_sr} Hz → target {TARGET_SR} Hz")
    need_resample = (dev_sr != TARGET_SR)
except Exception as e:
    print(f"[ERROR] No audio device available: {e}")
    print("[INFO] This is expected on systems without audio hardware (development machines)")
    print("[INFO] Container will stay running for health check. On production RPi, ensure USB mic is connected.")
    # Keep container running for health check
    import signal
    signal.pause()

# === audio callback ==========================================─
blocksize = int(HOP_SAMPLES * dev_sr / TARGET_SR)
print(f"[DEBUG] Audio callback blocksize={blocksize} frames (~{blocksize/dev_sr:.3f}s)  queue size=100")
q = queue.Queue(maxsize=100)

def audio_callback(indata, frames, time_info, status):
    if status:
        print(f"[AUDIO STATUS] {status}")
    try:
        q.put_nowait(indata[:,0].copy())
    except queue.Full:
        print("[AUDIO DROPPED] queue full, dropping block")

stream = sd.InputStream(
    device=dev_id,
    channels=1,
    samplerate=dev_sr,
    dtype='float32',
    blocksize=blocksize,
    latency='high',
    callback=audio_callback
)
stream.start()
print("Listening… Ctrl-C to stop")

# === MAIN LOOP ============================================================
chunk_buffer = np.zeros((0,), dtype=np.float32)
ram_buffer   = []
last_flush   = time.time()

try:
    while True:
        # 1) pull a block
        block = q.get()
        mono = resample_poly(block, TARGET_SR, dev_sr) if need_resample else block

        # 2) accumulate until we have CHUNK_SAMPLES
        chunk_buffer = np.concatenate((chunk_buffer, mono))
        if len(chunk_buffer) < CHUNK_SAMPLES:
            continue

        # 3) slice out exactly CHUNK_SAMPLES and leave the rest
        chunk = chunk_buffer[:CHUNK_SAMPLES]
        chunk_buffer = chunk_buffer[CHUNK_SAMPLES:]

        # compute how many windows fit in the chunk
        num_windows = 1 + (CHUNK_SAMPLES - FRAME_LEN) // HOP_SAMPLES

        # 4) sliding‐window inference
        for w in range(num_windows):
            start = w * HOP_SAMPLES
            end   = start + FRAME_LEN
            window = chunk[start:end].astype(np.float32)

            # invoke the model
            yam.set_tensor(inp_detail['index'], window)
            yam.invoke()
            scores = yam.get_tensor(scores_idx)[0]

            # pick top‐K
            top_idx  = scores.argsort()[-TOP_K:][::-1]
            top_conf = scores[top_idx]

            # estimate loudness
            rms    = np.sqrt(np.mean(window**2))
            db_now = 20 * np.log10(rms + 1e-10)

            # if above threshold, record it
            if top_conf[0] >= THRESHOLD:
                ts = datetime.now(pytz.UTC).timestamp()
                names = labels[top_idx]
                confs = [f"{c*100:.1f}%" for c in top_conf]

                # Check if the top prediction is "Silence" - if so, skip logging
                if names[0] == "Silence":
                    print(f"{datetime.fromtimestamp(ts, pytz.UTC).strftime('%H:%M:%S')} -> Silence ({confs[0]}) - not logged")
                    continue

                # Skip logging for other excluded environmental labels
                excluded_classes = [
                    "Inside, small room",
                    "Inside, large room or hall", 
                    "Inside, public space",
                    "Outside, urban or manmade",
                    "Outside, rural or natural"
                ]
                if names[0] in excluded_classes:
                    continue

                # append highest cf labels
                msg = f"{names[0]} ({confs[0]})"

                # extras, if any
                if len(names) > 1:
                    extras = [f"{n} ({cf})" for n, cf in zip(names[1:], confs[1:])]
                    msg += " +[" + ", ".join(extras) + "]"

                # Format the timestamp using UTC
                print(f"{datetime.fromtimestamp(ts, pytz.UTC).strftime('%H:%M:%S')} -> {msg}  {db_now:.1f} dB")

                # build the row
                row = [ts, round(db_now, 1)]
                for idx, c in zip(top_idx, top_conf):
                    row.extend([int(idx), round(c*100, 1), labels[idx]])

                # pad out any missing columns to preserve schema
                pad_slots = 3 - len(top_idx)
                for _ in range(pad_slots):
                    row.extend([None, None, None])

                ram_buffer.append(row)

                # build the payload with padding if needed
                payload = {
                    "ts":        float(ts),
                    "db":        float(round(db_now, 1)),
                    "c1_idx":    int(top_idx[0]) if len(top_idx) > 0 else None,
                    "c1_cf":     float(round(top_conf[0] * 100, 1)) if len(top_conf) > 0 else None,
                    "c2_idx":    int(top_idx[1]) if len(top_idx) > 1 else None,
                    "c2_cf":     float(round(top_conf[1] * 100, 1)) if len(top_conf) > 1 else None,
                    "c3_idx":    int(top_idx[2]) if len(top_idx) > 2 else None,
                    "c3_cf":     float(round(top_conf[2] * 100, 1)) if len(top_conf) > 2 else None,
                }
                
                mqtt_client.publish(topic, json.dumps(payload), qos=1)

        # 5) flush buffer to disk every FLUSH_SEC
        if time.time() - last_flush >= FLUSH_SEC and ram_buffer:
            with open(OUTPUT_CSV, "a", newline="") as f:
                writer = csv.writer(f)
                writer.writerows(ram_buffer)
                f.flush(); os.fsync(f.fileno())
            ram_buffer.clear()
            last_flush = time.time()

except KeyboardInterrupt:
    stream.stop()
    print("Stopped.")
