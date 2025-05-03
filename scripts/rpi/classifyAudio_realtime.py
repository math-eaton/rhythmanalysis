#!/usr/bin/env python3
import os
import csv
import json
import time
import asyncio
from pathlib import Path
from collections import deque

import numpy as np
from scipy.signal import resample_poly
import sounddevice as sd
import tflite_runtime.interpreter as tflite

# ——— USER SETTINGS ————————————————————————————————————————————————
INPUT_DEVICE_NAME = "USB PnP Sound Device: Audio (hw:2,0)"  # adjust to match an item in sd.query_devices()
HOP_SEC           = 0.5       # hop length in seconds (50% overlap)
THRESHOLD         = 0.333     # min average confidence to log (0–1)
NUM_THREADS       = 4         # TFLite interpreter threads
OUTPUT_JSON       = "output/classifications.json"
MODEL_FILE        = "yamnet_waveform.tflite"
CLASS_CSV         = "yamnet_class_map.csv"

FLUSH_SEC         = 5         # write results to disk every N seconds
ACCUM_SEC         = 3         # time window over which dominant label is decided
TOP_K             = 1         # how many labels to report each window
HP_FC             = 100       # one-pole high-pass corner frequency (Hz)

DEBUG            = True      # print top-5 scores even if below threshold
QUEUE_SIZE       = 8         # queue to ease callback pressure

# ————————————————————————————————————————————————————————————————

# Make sure the output directory exists (avoids SD-card seek penalty)
Path(OUTPUT_JSON).parent.mkdir(parents=True, exist_ok=True)

# 1. Select input device & get samplerate
devices = sd.query_devices()
INPUT_DEVICE = None
for idx, dev in enumerate(devices):
    if INPUT_DEVICE_NAME.lower() in dev['name'].lower() and dev['max_input_channels'] > 0:
        INPUT_DEVICE = idx
        break

if INPUT_DEVICE is None:
    print(f"Audio device '{INPUT_DEVICE_NAME}' not found. Falling back to device index 0.")
    INPUT_DEVICE = 0
    if devices[INPUT_DEVICE]['max_input_channels'] <= 0:
        raise RuntimeError(f"Fallback device index 0 ('{devices[INPUT_DEVICE]['name']}') is not valid for input.")

fs_native = int(sd.query_devices(INPUT_DEVICE, 'input')['default_samplerate'])
fs = 16_000  # ← YAMNet’s native rate; we will resample if mic cannot deliver 16 kHz
print(f"→ Using device #{INPUT_DEVICE}: '{devices[INPUT_DEVICE]['name']}' @ {fs_native} Hz → model @ 16 kHz")

# 2. Load class names
with open(CLASS_CSV) as f:
    reader = csv.DictReader(f)
    class_names = [row['display_name'] for row in reader]

# 3. Set up the TFLite interpreter
try:
    xnn_delegate = tflite.load_delegate("libtensorflowlite_delegate_xnnpack.so")
    interpreter = tflite.Interpreter(model_path=MODEL_FILE,
                                     num_threads=NUM_THREADS,
                                     experimental_delegates=[xnn_delegate])
    print("XNNPACK delegate loaded")
except (OSError, ValueError) as e:
    print("XNNPACK delegate not available – "
          "falling back to default CPU kernel:", e)
    interpreter = tflite.Interpreter(model_path=MODEL_FILE,
                                     num_threads=NUM_THREADS)
interpreter.allocate_tensors()
inp_detail = interpreter.get_input_details()[0]
out_detail = interpreter.get_output_details()[0]

# 4. Derive model input length + dynamic shape
inp_shape = inp_detail['shape']  # could be [15600] or [1,15600]
if len(inp_shape) == 2:
    _, MODEL_INPUT_LEN = inp_shape
    reshape_shape = (1, MODEL_INPUT_LEN)
elif len(inp_shape) == 1:
    MODEL_INPUT_LEN = inp_shape[0]
    reshape_shape = (MODEL_INPUT_LEN,)
else:
    MODEL_INPUT_LEN = int(inp_shape[-1])  # fallback to last dim
    reshape_shape = tuple(inp_shape)

WINDOW_SEC = MODEL_INPUT_LEN / 16000.0
FRAME_LEN  = int(fs_native * WINDOW_SEC)
HOP_LEN    = int(HOP_SEC * fs_native)

print(f"Buffering {FRAME_LEN} samples (~{WINDOW_SEC:.3f}s) with {HOP_LEN}-sample hop")

# ——— helper utils ————————————————————————————————————————
def compressor(audio, thr=0.1, ratio=4.0):
    """Very cheap soft-knee compressor to reduce mic clipping artefacts."""
    a = np.copy(audio)
    mask = np.abs(a) > thr
    a[mask] = np.sign(a[mask]) * (thr + (np.abs(a[mask]) - thr) / ratio)
    return a

def hipass(x, fs_in, fc=HP_FC):
    """Single-pole high-pass primarily to rm traffic rumble < 100 Hz."""
    if fc <= 0:
        return x
    alpha = np.exp(-2.0 * np.pi * fc / fs_in)
    y = np.empty_like(x)
    y[0] = x[0]
    for n in range(1, len(x)):
        y[n] = alpha * y[n-1] + x[n] - x[n-1]
    return y

def rms_db(x):
    """Return RMS level in dBFS (0 dBFS = full-scale)."""
    rms = np.sqrt(np.mean(np.square(x), dtype=np.float64))
    return 20.0 * np.log10(rms + 1e-12)

# ————————————————————————————————————————————————————————————————

async def producer(q):
    loop = asyncio.get_event_loop()
    def callback(indata, frames, t0, status):
        if status:
            print("Audio status:", status)
        loop.call_soon_threadsafe(q.put_nowait, indata[:, 0].copy())

    with sd.InputStream(device=INPUT_DEVICE,
                        channels=1,
                        samplerate=fs_native,
                        dtype='float32',
                        blocksize=HOP_LEN,
                        callback=callback):
        await asyncio.Event().wait()  # keep stream alive forever

async def consumer(q):
    buf = np.zeros(FRAME_LEN, dtype='float32')
    accum = deque()
    ram_buffer = []
    last_flush = time.time()

    while True:
        chunk = await q.get()
        buf = np.roll(buf, -len(chunk))
        buf[-len(chunk):] = chunk

        # ===  meter before comp =========
        db_now = rms_db(chunk) 

        # light front-end conditioning
        cmp = compressor(buf)
        cmp = hipass(cmp, fs_native)

        # Resample/trim/pad to exactly MODEL_INPUT_LEN @ 16 kHz
        if fs_native != 16000:
            # Fast rational resampler (e.g. 48 kHz → 16 kHz uses 1/3)
            wf = resample_poly(cmp, 16000, fs_native).astype('float32')
        else:
            wf = cmp.astype('float32')

        if wf.size > MODEL_INPUT_LEN:
            wf = wf[-MODEL_INPUT_LEN:]
        elif wf.size < MODEL_INPUT_LEN:
            wf = np.pad(wf, (MODEL_INPUT_LEN - wf.size, 0))

        # Inference
        interpreter.set_tensor(inp_detail['index'], wf.reshape(reshape_shape))
        interpreter.invoke()
        out = interpreter.get_tensor(out_detail['index'])
        scores = out[0] if out.ndim == 3 else out
        avg_scores = np.mean(scores, axis=0)

        # Accumulate logits for ACCUM_SEC seconds
        accum.append(avg_scores)
        if len(accum) * HOP_SEC < ACCUM_SEC:
            if DEBUG:
                # show quick debug line every hop
                top5 = avg_scores.argsort()[-5:][::-1]
                dbg = ", ".join(f"{class_names[i]} {avg_scores[i]*100:.1f}%"
                                for i in top5)
                print(f"buggy {time.time():.2f}  {db_now:5.1f} dB  {dbg}")
            continue

        mean_scores = np.mean(accum, axis=0)
        top_idx = mean_scores.argsort()[-TOP_K:][::-1]
        accum.clear()

        printed = False
        for idx in top_idx:
            conf = float(mean_scores[idx])
            if conf < THRESHOLD:
                continue
            printed = True
            ts = time.time()
            entry = {
                "ts": ts,
                "cl": class_names[idx],
                "db": round(db_now, 1),
                "cf": round(conf * 100, 1)
            }
            print(f"{ts:.2f} → {entry['cl']} "
                  f"({entry['cf']}%)  {entry['db']} dBFS")
            ram_buffer.append(entry)

        # if nothing crossed the threshold but DEBUG is on, still print one line
        if DEBUG and not printed:
            i = top_idx[0]
            print(f"DBG {time.time():.2f}  {db_now:5.1f} dB  "
                f"{class_names[i]} {mean_scores[i]*100:.1f}%")


        # Periodic, append-only disk write (newline-delimited JSON)
        now = time.time()
        if now - last_flush >= FLUSH_SEC and ram_buffer:
            with open(OUTPUT_JSON, "a") as f:
                for e in ram_buffer:
                    f.write(json.dumps(e) + "\n")
                f.flush()            # push to kernel
                os.fsync(f.fileno()) # push to SD card
            ram_buffer.clear()
            last_flush = now

async def main():
    q = asyncio.Queue(maxsize=QUEUE_SIZE)  # back-pressure if consumer stalls
    print("+++++ LOOPING +++++")
    await asyncio.gather(producer(q), consumer(q))

if __name__ == "__main__":
    asyncio.run(main())
