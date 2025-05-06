#!/usr/bin/env python3
import argparse
import time
import queue
import warnings

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
THRESHOLD         = 0.05
NUM_THREADS       = 4
TARGET_SR         = 16_000
FRAME_LEN         = 15600   # YAMNet window size (0.975 s @16 kHz)

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
    # explicit ID
    if name_or_id is not None:
        try:
            idx = int(name_or_id)
            return idx
        except ValueError:
            # substring match
            for i, d in enumerate(devices):
                if (name_or_id.lower() in d['name'].lower()
                        and d['max_input_channels'] > 0):
                    return i
            return None
    # auto-detect USB mic
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
# model expects 1-D [FRAME_LEN]
yam.resize_tensor_input(
    inp_detail['index'], [FRAME_LEN], strict=True
)
yam.allocate_tensors()
scores_idx = yam.get_output_details()[0]['index']

# ── Placeholder for SONYC head (disabled) ──────────────
# head = tflite.Interpreter(
#     model_path=SONYC_HEAD_MODEL, num_threads=NUM_THREADS
# )\# head.allocate_tensors()
# h_in = head.get_input_details()[0]['index']
# h_out = head.get_output_details()[0]['index']
# h_scale, h_zero = head.get_input_details()[0]['quantization']

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
        yam.set_tensor(
            inp_detail['index'], ring.astype(np.float32)
        )
        yam.invoke()
        scores = yam.get_tensor(scores_idx)[0]

        # report active classes
        active = np.where(scores > THRESHOLD)[0]
        if active.size:
            ts = time.strftime('%H:%M:%S')
            names = labels[active]
            print(
                f"{ts} ➜ YAMNet [{active}] → "
                f"{list(names)}, max={scores[active].max():.2f}"
            )

        # SONYC head logic (to add later):
        # emb = yam.get_tensor(<embedding_idx>)[0]
        # quantize emb -> head input, head.invoke(), get probs, threshold & print

except KeyboardInterrupt:
    stream.stop()
    print("Stopped.")
