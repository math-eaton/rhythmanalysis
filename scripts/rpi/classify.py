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
import tflite_runtime.interpreter as tflite
from scipy.signal import resample_poly

# ── USER CONFIGURATION ─────────────────────────────────
YAMNET_MODEL      = 'scripts/models/yamnet/tfLite/tflite/1/1.tflite'
CLASS_MAP_CSV     = 'scripts/models/yamnet/yamnet_class_map.csv'
THRESHOLD         = 0.33
NUM_THREADS       = 2         
TARGET_SR         = 16_000
FRAME_LEN         = 15_600    # 0.975 s @16 kHz

# chunking parameters
CHUNK_SEC      = 3.0                         # process every 3 s
CHUNK_SAMPLES  = int(CHUNK_SEC * TARGET_SR)  # 48 000 samples
HOP_SEC        = 0.5                         # slide windows by 0.5 s
HOP_SAMPLES    = int(HOP_SEC * TARGET_SR)    #  8 000 samples

TOP_K       = 3                # how many classes to keep
FLUSH_SEC   = 5.0              # flush to CSV every 5 s
OUTPUT_CSV  = "output/classifications.csv"

# ── PREPARE OUTPUT ───────────────────────────────────
Path(OUTPUT_CSV).parent.mkdir(parents=True, exist_ok=True)
if not Path(OUTPUT_CSV).exists():
    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "ts",    # unix timestamp (end of chunk)
            "db",    # instantaneous dBFS of last window
            "c1_idx","c1_cf",
            "c2_idx","c2_cf",
            "c3_idx","c3_cf",
        ])

# ── LOAD LABELS & MODEL ──────────────────────────────
class_map = pd.read_csv(CLASS_MAP_CSV)
labels    = class_map['display_name'].to_numpy()

yam = tflite.Interpreter(
    model_path=YAMNET_MODEL,
    num_threads=NUM_THREADS
)
inp_detail = yam.get_input_details()[0]
yam.resize_tensor_input(inp_detail['index'], [FRAME_LEN], strict=True)
yam.allocate_tensors()
scores_idx = yam.get_output_details()[0]['index']

# ── ARG PARSING ──────────────────────────────────────
parser = argparse.ArgumentParser(
    description="Chunked YAMNet tagging on Raspberry Pi"
)
parser.add_argument('--list-devices', action='store_true')
parser.add_argument('-d','--device', default=None)
args = parser.parse_args()
if args.list_devices:
    for i, dev in enumerate(sd.query_devices()):
        if dev['max_input_channels']>0:
            print(f"[{i}] {dev['name']} @ {dev['default_samplerate']} Hz")
    exit(0)

# ── SELECT DEVICE & RESAMPLE SETUP ───────────────────
def find_device(name_or_id):
    try:
        return int(name_or_id)
    except (ValueError,TypeError):
        for i, d in enumerate(sd.query_devices()):
            if name_or_id and name_or_id.lower() in d['name'].lower() \
               and d['max_input_channels']>0:
                return i
    # fallback to first USB mic
    for i, d in enumerate(sd.query_devices()):
        if d['max_input_channels']>0 and 'USB' in d['name']:
            return i
    return None

device_id = find_device(args.device)
info   = sd.query_devices(device_id, 'input') if device_id is not None else sd.query_devices(None,'input')
dev_sr = int(info['default_samplerate'])
print(f"Using input '{info['name']}' @ {dev_sr} Hz → {TARGET_SR} Hz")

need_resample = (dev_sr != TARGET_SR)
if need_resample and resample_poly is None:
    raise RuntimeError("Need scipy.signal.resample_poly for resampling")

# ── AUDIO CAPTURE SETUP ─────────────────────────────
q = queue.Queue(maxsize=100)
def audio_callback(indata, frames, time_info, status):
    if status:
        print("Audio status:", status)
    try:
        # push raw float32 mono
        q.put_nowait(indata[:,0].copy())
    except queue.Full:
        # drop silently if we're backed up
        pass

stream = sd.InputStream(
    device=device_id,
    channels=1,
    samplerate=dev_sr,
    dtype='float32',
    blocksize = int(TARGET_SR * 0.5 * dev_sr / TARGET_SR),  # ~0.5 s blocks
    latency='high',  # bigger internal buffer
    callback=audio_callback
)
stream.start()

print("Listening… Ctrl-C to stop")

# ── MAIN LOOP: CHUNK + INFERENCE ────────────────────
chunk_buffer = np.zeros((0,), dtype=np.float32)
ram_buffer   = []
last_flush   = time.time()

try:
    while True:
        # 1) get next audio block
        block = q.get()  
        mono = resample_poly(block, TARGET_SR, dev_sr) if need_resample else block

        # 2) accumulate into our chunk
        chunk_buffer = np.concatenate((chunk_buffer, mono))
        if chunk_buffer.shape[0] < CHUNK_SAMPLES:
            continue

        # 3) we have at least CHUNK_SEC of audio → process it
        chunk = chunk_buffer[:CHUNK_SAMPLES]
        chunk_buffer = chunk_buffer[CHUNK_SAMPLES:]  # drop processed

        # slide FRAME_LEN windows through the chunk at HOP_SAMPLES
        scores_list = []
        for start in range(0, CHUNK_SAMPLES - FRAME_LEN + 1, HOP_SAMPLES):
            window = chunk[start : start + FRAME_LEN]
            yam.set_tensor(inp_detail['index'], window.astype(np.float32))
            yam.invoke()
            scores_list.append(yam.get_tensor(scores_idx)[0])

        # 4) aggregate & threshold
        mean_scores = np.mean(scores_list, axis=0)
        top_idx     = mean_scores.argsort()[-TOP_K:][::-1]
        top_conf    = [mean_scores[i] for i in top_idx]

        # compute last-window dBFS for logging
        rms    = np.sqrt(np.mean(window**2))
        db_now = 20 * np.log10(rms + 1e-10)

        if top_conf[0] >= THRESHOLD:
            ts = time.time()
            names = labels[top_idx]
            confs = [f"{c*100:.1f}%" for c in top_conf]
            print(
                f"{time.strftime('%H:%M:%S', time.localtime(ts))} → "
                f"{names[0]} ({confs[0]}) [+{names[1]} ({confs[1]}), "
                f"{names[2]} ({confs[2]})]  {db_now:.1f} dBFS"
            )

            # prepare CSV row
            row = [ts, round(db_now,1)]
            for idx, c in zip(top_idx, top_conf):
                row.extend([int(idx), round(c*100,1)])
            ram_buffer.append(row)

        # 5) flush to disk periodically
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
