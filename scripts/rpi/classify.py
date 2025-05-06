#!/usr/bin/env python3
import argparse
import time
import queue
import warnings
import csv
import os
from pathlib import Path

import numpy as np
import pandas as pd
import sounddevice as sd
import tflite_runtime.interpreter as tflite
from scipy.signal import resample_poly

# suppress minor numpy warnings
warnings.filterwarnings("ignore", message="The value of the smallest subnormal")

# ── USER CONFIGURATION ─────────────────────────────────
YAMNET_MODEL      = 'scripts/models/yamnet/tfLite/tflite/1/1.tflite'
CLASS_MAP_CSV     = 'scripts/rpi/yamnet_class_map.csv'
SONYC_HEAD_MODEL  = 'scripts/models/sonyc/sonyc_head_v3_int8.tflite'  # placeholder
THRESHOLD         = 0.33
NUM_THREADS       = 4
TARGET_SR         = 16_000
FRAME_LEN         = 15600   # YAMNet window size (0.975 s @16 kHz)

# ── LOG CONFIG ──────────────────────────────────────────
OUTPUT_CSV = "output/classifications.csv"
Path(OUTPUT_CSV).parent.mkdir(parents=True, exist_ok=True)

# write a header row if the file doesn't exist yet
if not Path(OUTPUT_CSV).exists():
    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "ts",      # unix timestamp
            "db",      # instantaneous amplitude in dBFS
            "c1_idx",  # top-1 class index
            "c1_cf",   # top-1 confidence (%)
            "c2_idx",  # top-2 class index
            "c2_cf",   # top-2 confidence (%)
            "c3_idx",  # top-3 class index
            "c3_cf",   # top-3 confidence (%)
        ])

# aggregation & flush params
ACCUM_SEC   = 3.0              # seconds to accumulate before logging
HOP_SEC     = 1.0              # since we step 1 s per block
TOP_K       = 3                # how many class slots to record
FLUSH_SEC   = 5.0              # flush buffer every N seconds

accum       = []               # list of score arrays
ram_buffer  = []               # rows waiting to be written
last_flush  = time.time()

# ── Argument parsing ───────────────────────────────────
parser = argparse.ArgumentParser(
    description="Real-time YAMNet (+ SONYC) audio tagging @16 kHz mono"
)
parser.add_argument(
    '--list-devices', action='store_true', help='List audio input devices'
)
parser.add_argument(
    '-d', '--device', default=None, help='Device ID or substring'
)
args = parser.parse_args()

# ── Handle device listing ───────────────────────────────
if args.list_devices:
    for idx, dev in enumerate(sd.query_devices()):
        if dev['max_input_channels'] > 0:
            print(f"[{idx}] {dev['name']} @ {dev['default_samplerate']} Hz")
    exit(0)

# ── Device selection ────────────────────────────────────
def find_device(name_or_id=None):
    devices = sd.query_devices()
    if name_or_id is not None:
        try:
            return int(name_or_id)
        except ValueError:
            for i, d in enumerate(devices):
                if (name_or_id.lower() in d['name'].lower()
                        and d['max_input_channels'] > 0):
                    return i
            return None
    for i, d in enumerate(devices):
        if d['max_input_channels'] > 0 and 'USB' in d['name']:
            return i
    return None

device_id = find_device(args.device)
if device_id is None:
    info = sd.query_devices(None, 'input')
else:
    info = sd.query_devices(device_id, 'input')
dev_sr = int(info['default_samplerate'])
print(f"Using device {device_id or 'default'}: '{info['name']}' @ {dev_sr} Hz")

# ── Resampling check ────────────────────────────────────
need_resample = (dev_sr != TARGET_SR)
if need_resample and resample_poly is None:
    raise RuntimeError(
        f"Device SR={dev_sr}, target={TARGET_SR}, but scipy missing"
    )
print(
    f"{'Resampling' if need_resample else 'Direct'} → {TARGET_SR} Hz mono"
)

# ── Load class map ──────────────────────────────────────
class_map = pd.read_csv(CLASS_MAP_CSV)
labels    = class_map['display_name'].to_numpy()

# ── Load YAMNet ─────────────────────────────────────────
yam = tflite.Interpreter(
    model_path=YAMNET_MODEL,
    num_threads=NUM_THREADS
)
inp_detail = yam.get_input_details()[0]
print(
    "YAMNet input shape:", inp_detail['shape'],
    "rank:", len(inp_detail['shape'])
)
yam.resize_tensor_input(
    inp_detail['index'], [FRAME_LEN], strict=True
)
yam.allocate_tensors()
scores_idx = yam.get_output_details()[0]['index']

# ── Audio capture setup ─────────────────────────────────
HOP_SAMPLES = TARGET_SR       # 1 s hop at target rate
block_in    = int(HOP_SAMPLES * dev_sr / TARGET_SR)
q           = queue.Queue(maxsize=10)

def audio_callback(indata, frames, time_info, status):
    if status:
        print("Audio status:", status)
    q.put(indata[:, 0].copy())

stream = sd.InputStream(
    device=device_id,
    samplerate=dev_sr,
    channels=1,
    dtype='float32',
    blocksize=block_in,
    latency='low',
    callback=audio_callback
)
stream.start()

ring = np.zeros(FRAME_LEN, dtype=np.float32)
print("Listening… Ctrl-C to stop")

try:
    while True:
        block = q.get()
        # resample to TARGET_SR if needed
        mono = (
            resample_poly(block, TARGET_SR, dev_sr)
            if need_resample else block
        )

        # update ring buffer
        if len(mono) >= FRAME_LEN:
            ring = mono[-FRAME_LEN:]
        else:
            ring = np.concatenate((ring[len(mono):], mono))

        # run YAMNet
        yam.set_tensor(inp_detail['index'], ring.astype(np.float32))
        yam.invoke()
        scores = yam.get_tensor(scores_idx)[0]

        # ── compute instantaneous amplitude (dBFS)
        rms = np.sqrt(np.mean(ring**2))
        db_now = 20 * np.log10(rms + 1e-10)

        # ── accumulate & aggregate every ACCUM_SEC
        accum.append(scores)
        if len(accum) * HOP_SEC < ACCUM_SEC:
            continue

        mean_scores = np.mean(accum, axis=0)
        top_idx     = mean_scores.argsort()[-TOP_K:][::-1]
        top_conf    = [mean_scores[i] for i in top_idx]
        accum.clear()

        # ── only log/print if best-confidence crosses threshold
        if top_conf[0] >= THRESHOLD:
            ts = time.time()
            # human‐readable print
            names = labels[top_idx]
            confs = [f"{c*100:.1f}%" for c in top_conf]
            print(
                f"{time.strftime('%H:%M:%S')} → "
                f"{names[0]} ({confs[0]}) [+{names[1]} ({confs[1]}), "
                f"{names[2]} ({confs[2]})]  {db_now:.1f} dBFS"
            )

            # prepare CSV row: ts, db, idx1, cf1, idx2, cf2, idx3, cf3
            row = [ts, round(db_now,1)]
            for idx, c in zip(top_idx, top_conf):
                row.extend([int(idx), round(c*100,1)])
            ram_buffer.append(row)

        # ── flush to disk every FLUSH_SEC
        if time.time() - last_flush >= FLUSH_SEC and ram_buffer:
            with open(OUTPUT_CSV, "a", newline="") as f:
                writer = csv.writer(f)
                writer.writerows(ram_buffer)
                f.flush()
                os.fsync(f.fileno())   # ensure SD-card persistence
            ram_buffer.clear()
            last_flush = time.time()

except KeyboardInterrupt:
    stream.stop()
    print("Stopped.")
