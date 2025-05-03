import os
import csv
import json
import time
import asyncio

import numpy as np
from scipy.signal import resample
import sounddevice as sd
import tflite_runtime.interpreter as tflite

# ——— USER SETTINGS ————————————————————————————————————————————————
INPUT_DEVICE_NAME = "USB PnP Sound Device: Audio (hw:2,0)"  # adjust to match an item in sd.query_devices()
HOP_SEC           = 0.5    # hop length in seconds (50% overlap)
THRESHOLD         = 0.1    # min average confidence to log (0–1)
NUM_THREADS       = 4      # TFLite interpreter threads
OUTPUT_JSON       = "classifications.json"
MODEL_FILE        = "yamnet_waveform.tflite"
CLASS_CSV         = "yamnet_class_map.csv"
# ————————————————————————————————————————————————————————————————

# 1. Select input device & get samplerate
devices = sd.query_devices()
INPUT_DEVICE = None
for idx, dev in enumerate(devices):
    if INPUT_DEVICE_NAME.lower() in dev['name'].lower() and dev['max_input_channels'] > 0:
        INPUT_DEVICE = idx
        break

if INPUT_DEVICE is None:
    print(f"⚠️ Audio device '{INPUT_DEVICE_NAME}' not found. Falling back to device index 0.")
    INPUT_DEVICE = 0
    if devices[INPUT_DEVICE]['max_input_channels'] <= 0:
        raise RuntimeError(f"Fallback device index 0 ('{devices[INPUT_DEVICE]['name']}') is not valid for input.")

fs = int(sd.query_devices(INPUT_DEVICE, 'input')['default_samplerate'])
print(f"→ Using device #{INPUT_DEVICE}: '{devices[INPUT_DEVICE]['name']}' @ {fs} Hz")

# 2. Load class names
with open(CLASS_CSV) as f:
    reader = csv.DictReader(f)
    class_names = [row['display_name'] for row in reader]

# 3. Set up the TFLite interpreter
interpreter = tflite.Interpreter(model_path=MODEL_FILE, num_threads=NUM_THREADS)
interpreter.allocate_tensors()
inp_detail = interpreter.get_input_details()[0]
out_detail = interpreter.get_output_details()[0]

# 4. Derive buffer lengths from the model’s input shape
MODEL_INPUT_LEN = inp_detail['shape'][1]       # should be 15600
WINDOW_SEC      = MODEL_INPUT_LEN / 16000.0   # ~0.975 seconds
FRAME_LEN       = int(fs * WINDOW_SEC)        # buffer length @ device sample rate
HOP_LEN         = int(HOP_SEC * fs)           # hop length @ device sample rate

print(f"Buffering {FRAME_LEN} samples (~{WINDOW_SEC:.3f}s) with {HOP_LEN}-sample hop")

# 5. Audio producer & consumer
async def producer(q):
    loop = asyncio.get_event_loop()
    def callback(indata, frames, t0, status):
        if status:
            print("⚠️ Audio status:", status)
        # enqueue a copy of the newest chunk
        loop.call_soon_threadsafe(q.put_nowait, indata[:, 0].copy())

    with sd.InputStream(device=INPUT_DEVICE,
                        channels=1,
                        samplerate=fs,
                        dtype='float32',
                        blocksize=HOP_LEN,
                        callback=callback):
        await asyncio.Event().wait()

async def consumer(q):
    buf = np.zeros(FRAME_LEN, dtype='float32')

    def compressor(audio, thr=0.1, ratio=4.0):
        a = np.copy(audio)
        mask = np.abs(a) > thr
        a[mask] = np.sign(a[mask]) * (thr + (np.abs(a[mask]) - thr) / ratio)
        return a

    while True:
        chunk = await q.get()
        buf = np.roll(buf, -len(chunk))
        buf[-len(chunk):] = chunk

        # Apply compressor
        cmp = compressor(buf)

        # Resample to exactly MODEL_INPUT_LEN samples (16 kHz)
        if fs != 16000:
            wf = resample(cmp, MODEL_INPUT_LEN).astype('float32')
        else:
            # if the device is already 16kHz, just trim/pad to exact length
            if cmp.size > MODEL_INPUT_LEN:
                wf = cmp[-MODEL_INPUT_LEN:]
            elif cmp.size < MODEL_INPUT_LEN:
                pad = np.zeros(MODEL_INPUT_LEN - cmp.size, dtype='float32')
                wf = np.concatenate((pad, cmp))
            else:
                wf = cmp.astype('float32')

        # Run inference
        interpreter.set_tensor(inp_detail['index'], wf.reshape((1, MODEL_INPUT_LEN)))
        interpreter.invoke()
        out = interpreter.get_tensor(out_detail['index'])
        scores = out[0] if out.ndim == 3 else out
        avg_scores = np.mean(scores, axis=0)
        idx = int(np.argmax(avg_scores))
        conf = float(avg_scores[idx])

        # Log if above threshold
        if conf > THRESHOLD:
            ts = time.time()
            entry = {"ts": ts, "cl": class_names[idx], "cf": round(conf * 100, 1)}
            print(f"{ts:.2f} → {entry['cl']} ({entry['cf']}%)")

            # Append to JSON file
            if os.path.exists(OUTPUT_JSON):
                with open(OUTPUT_JSON, 'r+') as f:
                    data = json.load(f)
                    data.append(entry)
                    f.seek(0)
                    json.dump(data, f, indent=2)
            else:
                with open(OUTPUT_JSON, 'w') as f:
                    json.dump([entry], f, indent=2)

async def main():
    q = asyncio.Queue()
    print("▶️ Starting realtime YAMNet loop…")
    await asyncio.gather(producer(q), consumer(q))

if __name__ == "__main__":
    asyncio.run(main())
