#!/usr/bin/env python3
import argparse
import numpy as np
import sounddevice as sd
import queue
import time
import tflite_runtime.interpreter as tflite

# ── Optional resampling ─────────────────────────────────
try:
    from scipy.signal import resample_poly
except ImportError:
    resample_poly = None

# ── Argument parsing & device selection ─────────────────
parser = argparse.ArgumentParser(
    description="Real-time YAMNet + SONYC audio tagging (16 kHz mono)")
parser.add_argument(
    '--list-devices', dest='list_devices', action='store_true',
    help='List all available audio input devices and exit')
parser.add_argument(
    '-d', '--device', metavar='ID|NAME', default=None,
    help='Input device ID or substring of its name (default: auto-detect USB mic)')
args = parser.parse_args()

def list_input_devices():
    devices = sd.query_devices()
    print("Available input devices:")
    for idx, dev in enumerate(devices):
        if dev['max_input_channels'] > 0:
            print(f"[{idx}] {dev['name']}  (default SR: {dev['default_samplerate']})")

if args.list_devices:
    list_input_devices()
    exit(0)

# find a USB mic if no device specified
def find_usb_mic():
    devices = sd.query_devices()
    for idx, dev in enumerate(devices):
        if dev['max_input_channels'] > 0 and 'USB' in dev['name']:
            return idx
    return None  # fall back to default

# resolve args.device to an integer device ID (or None)
device_id = None
if args.device is not None:
    # try as integer first
    try:
        device_id = int(args.device)
    except ValueError:
        # substring match
        devices = sd.query_devices()
        matches = [i for i, d in enumerate(devices)
                   if args.device.lower() in d['name'].lower()
                   and d['max_input_channels'] > 0]
        if matches:
            device_id = matches[0]
        else:
            print(f"No input device matching '{args.device}' found, using default.")
            device_id = None
else:
    device_id = find_usb_mic()

device_info = sd.query_devices(device_id, 'input') if device_id is not None else sd.query_devices(None, 'input')
dev_sr = int(device_info['default_samplerate'])
SR = 16_000
need_resample = (dev_sr != SR)
if need_resample and resample_poly is None:
    raise RuntimeError(
        f"Device sample rate is {dev_sr} Hz but target is {SR} Hz, "
        "and scipy.signal.resample_poly is not available. "
        "Please install scipy.")

print(f"Using input device {device_id or 'default'}: '{device_info['name']}' at {dev_sr} Hz")
print(f"{'Resampling' if need_resample else 'Direct'} → target {SR} Hz mono")

# ── Load models ──────────────────────────────────────────
yam = tflite.Interpreter(
    'scripts/models/yamnet/tfLite/tflite/1/1.tflite',
    num_threads=4)
yam.resize_tensor_input(
    yam.get_input_details()[0]['index'],
    [15600], strict=True)
yam.allocate_tensors()

head = tflite.Interpreter(
    'scripts/models/sonyc/sonyc_head_v3_int8.tflite',
    num_threads=4)
head.allocate_tensors()

# locate embedding tensor (1 024-D)
embed_detail = next(d for d in yam.get_output_details()
                    if d['shape'][-1] == 1024)
e_idx, e_scale, e_zero = embed_detail['index'], *embed_detail['quantization']

h_in  = head.get_input_details()[0]['index']
h_out = head.get_output_details()[0]['index']
h_scale, h_zero = head.get_input_details()[0]['quantization']

# ── Audio capture ────────────────────────────────────────
HOP = SR                  # 1-second hops
FRAME = 15600             # 0.975 s (YAMNet window)

q_in = queue.Queue(maxsize=10)

def callback(indata, frames, time_info, status):
    if status:
        print(status, flush=True)
    q_in.put(indata.copy())

stream = sd.InputStream(
    device=device_id,
    samplerate=(dev_sr if need_resample else SR),
    channels=1, dtype='float32',
    blocksize=(dev_sr if need_resample else HOP),
    callback=callback)
stream.start()

ring = np.zeros(FRAME, dtype=np.float32)

print("Listening … Ctrl-C to stop")
try:
    while True:
        block = q_in.get()  # shape=(blocksize, 1)

        # ── ensure 16 kHz mono ───────────────────────────
        if need_resample:
            mono = resample_poly(block[:,0], SR, dev_sr)
        else:
            mono = block[:,0]

        # keep last 0.975 s of audio
        ring = np.concatenate((ring[len(mono):], mono.astype(np.float32)))

        # --- run backbone ---
        yam.set_tensor(
            yam.get_input_details()[0]['index'],
            ring)
        yam.invoke()
        emb = yam.get_tensor(e_idx)[0]  # float32, (1024,)

        # --- quantise & run head ---
        emb_i8 = np.clip(
            np.round(emb / h_scale + e_zero),
            -128, 127).astype(np.int8)[np.newaxis, :]
        head.set_tensor(h_in, emb_i8)
        head.invoke()
        p_i8   = head.get_tensor(h_out)[0]
        probs  = (p_i8.astype(np.float32) - h_zero) * h_scale

        active = np.where(probs > 0.333)[0]  # threshold
        if active.size:
            ts = time.strftime('%H:%M:%S')
            print(f"{ts}  ➜ tags {active}  max {probs[active].max():.2f}")

except KeyboardInterrupt:
    stream.stop()
    print("Stopped.")
