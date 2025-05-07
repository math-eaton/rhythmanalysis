#!/usr/bin/env python3
import argparse
import time
import queue
import csv
import os
from pathlib import Path

import numpy as np
import pandas as pd
import sounddevice as sd
try:
    from tflite_runtime.interpreter import Interpreter
    HAS_NUM_THREADS_ARG = True
except ImportError:
    from tensorflow.lite.python.interpreter import Interpreter
    HAS_NUM_THREADS_ARG = False
from scipy.signal import resample_poly

# ── USER CONFIGURATION ─────────────────────────────────
YAMNET_MODEL      = 'scripts/models/yamnet/tfLite/tflite/1/1.tflite'
CLASS_MAP_CSV     = 'scripts/models/yamnet/yamnet_class_map.csv'
THRESHOLD         = 0.33
NUM_THREADS       = 2
TARGET_SR         = 16_000
FRAME_LEN         = 15_600    # 0.975 s

CHUNK_SEC         = 3.0
CHUNK_SAMPLES     = int(CHUNK_SEC * TARGET_SR)
HOP_SEC           = 0.5
HOP_SAMPLES       = int(HOP_SEC * TARGET_SR)

TOP_K             = 3
FLUSH_SEC         = 5.0
OUTPUT_CSV        = "output/classifications.csv"

# ── PREPARE OUTPUT ───────────────────────────────────
Path(OUTPUT_CSV).parent.mkdir(parents=True, exist_ok=True)
if not Path(OUTPUT_CSV).exists():
    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["ts","db","c1_idx","c1_cf","c2_idx","c2_cf","c3_idx","c3_cf"])

# ── LOAD MODEL & LABELS ──────────────────────────────
print(f"[DEBUG] Loading labels from {CLASS_MAP_CSV}")
class_map = pd.read_csv(CLASS_MAP_CSV)
labels    = class_map['display_name'].to_numpy()
print(f"[DEBUG] {len(labels)} labels loaded")

print(f"[DEBUG] Loading TFLite model from {YAMNET_MODEL} with {NUM_THREADS} threads")
if HAS_NUM_THREADS_ARG:
    yam = Interpreter(model_path=YAMNET_MODEL, num_threads=NUM_THREADS)
else:
    yam = Interpreter(model_path=YAMNET_MODEL)
    # yam.experimental_set_num_threads(NUM_THREADS)
inp_detail = yam.get_input_details()[0]
print(f"[DEBUG] Original input shape: {inp_detail['shape']}")
yam.resize_tensor_input(inp_detail['index'], [FRAME_LEN], strict=True)
yam.allocate_tensors()

# ── WARM-UP ──────────────────────────────────────────────
print("[DEBUG] Warming up interpreter with a dummy frame…")
dummy = np.zeros((FRAME_LEN,), dtype=np.float32)
yam.set_tensor(inp_detail['index'], dummy)
t0 = time.monotonic()
yam.invoke()
t1 = time.monotonic()
print(f"[DEBUG]  → warm-up invoke: {t1-t0:.3f}s")


scores_idx = yam.get_output_details()[0]['index']
print(f"[DEBUG] Model ready with fixed input length {FRAME_LEN}")

# ── ARG PARSING ──────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument('--list-devices', action='store_true')
parser.add_argument('-d','--device', default=None)
args = parser.parse_args()
if args.list_devices:
    for i, d in enumerate(sd.query_devices()):
        if d['max_input_channels']>0:
            print(f"[DEV] [{i}] {d['name']} @ {d['default_samplerate']}")
    exit(0)

# ── SELECT DEVICE ────────────────────────────────────
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

dev_id = find_device(args.device)
info   = sd.query_devices(dev_id, 'input') if dev_id is not None else sd.query_devices(None,'input')
dev_sr = int(info['default_samplerate'])
print(f"[DEBUG] Using input '{info['name']}' @ {dev_sr} Hz → target {TARGET_SR} Hz")
need_resample = (dev_sr != TARGET_SR)

# ── AUDIO CALLBACK SETUP ─────────────────────────────
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

# ── MAIN LOOP ────────────────────────────────────────
chunk_buffer = np.zeros((0,), dtype=np.float32)
ram_buffer   = []
last_flush   = time.time()

try:
    while True:
        # 1) pull a block
        block = q.get()
        # print(f"[DEBUG] Got block: {len(block)} samples; qsize={q.qsize()}")
        mono = resample_poly(block, TARGET_SR, dev_sr) if need_resample else block
        # print(f"[DEBUG] Resampled to {len(mono)} samples")

        # 2) accumulate
        chunk_buffer = np.concatenate((chunk_buffer, mono))
        # print(f"[DEBUG] Chunk buffer: {len(chunk_buffer)}/{CHUNK_SAMPLES} samples")
        if len(chunk_buffer) < CHUNK_SAMPLES:
            continue

        # 3) process chunk
        chunk = chunk_buffer[:CHUNK_SAMPLES]
        chunk_buffer = chunk_buffer[CHUNK_SAMPLES:]
        num_windows = 1 + (CHUNK_SAMPLES - FRAME_LEN) // HOP_SAMPLES
        # print(f"[DEBUG] Processing chunk: {CHUNK_SEC}s → {num_windows} windows "
        #       f"(frame={FRAME_LEN}, hop={HOP_SAMPLES})")

        # single inference per chunk (last 0.975 s slice)
        window = chunk[-FRAME_LEN:].astype(np.float32)
        t0 = time.monotonic()
        yam.set_tensor(inp_detail['index'], window)
        yam.invoke()
        scores = yam.get_tensor(scores_idx)[0]
        t1 = time.monotonic()
        print(f"[PERF] single invoke: {t1-t0:.3f}s")

        mean_scores = scores


        # 4) aggregate
        top_idx     = mean_scores.argsort()[-TOP_K:][::-1]
        top_conf    = [mean_scores[i] for i in top_idx]

        rms    = np.sqrt(np.mean(window**2))
        db_now = 20 * np.log10(rms + 1e-10)

        if top_conf[0] >= THRESHOLD:
            ts = time.time()
            names = labels[top_idx]
            confs = [f"{c*100:.1f}%" for c in top_conf]
            print(f"{time.strftime('%H:%M:%S',time.localtime(ts))} → "
                  f"{names[0]} ({confs[0]}) [+{names[1]} ({confs[1]}), "
                  f"{names[2]} ({confs[2]})]  {db_now:.1f} dBFS")
            row = [ts, round(db_now,1)]
            for idx, c in zip(top_idx, top_conf):
                row.extend([int(idx), round(c*100,1)])
            ram_buffer.append(row)

        # 5) flush
        if time.time() - last_flush >= FLUSH_SEC and ram_buffer:
            print(f"[DEBUG] Flushing {len(ram_buffer)} rows to CSV")
            with open(OUTPUT_CSV, "a", newline="") as f:
                writer = csv.writer(f)
                writer.writerows(ram_buffer)
                f.flush(); os.fsync(f.fileno())
            ram_buffer.clear()
            last_flush = time.time()

except KeyboardInterrupt:
    stream.stop()
    print("Stopped.")