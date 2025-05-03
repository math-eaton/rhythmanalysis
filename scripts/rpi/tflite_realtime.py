#!/usr/bin/env python3
import os, json, time, asyncio, csv
import numpy as np
from scipy.signal import resample
import sounddevice as sd
import tflite_runtime.interpreter as tflite

# ——— USER SETTINGS ————————————————————————————————————————————————
INPUT_DEVICE_NAME = "USB PnP Sound Device: Audio (hw:2,0)"  # adjust to match an item in sd.query_devices()
FRAME_LEN = int(44100 * (15600/16000)) # yamnet expects 0.975 sec
HOP_SEC    = 0.5 # hop length in seconds (50% overlap)
THRESHOLD  = 0.1 # min average confidence to log (0–1)
NUM_THREADS= 4  # TFLite interpreter threads
OUTPUT_JSON= "classifications.json"
MODEL_FILE = "yamnet_waveform.tflite"
CLASS_CSV  = "yamnet_class_map.csv"
# ————————————————————————————————————————————————————————————————

# 1. Select input device & get samplerate
devices = sd.query_devices()
INPUT_DEVICE = None
for idx, dev in enumerate(devices):
    if INPUT_DEVICE_NAME.lower() in dev['name'].lower() and dev['max_input_channels'] > 0:
        INPUT_DEVICE = idx
        break

# Fallback to device index 0 if INPUT_DEVICE_NAME is not found
if INPUT_DEVICE is None:
    print(f"⚠️ Audio device '{INPUT_DEVICE_NAME}' not found. Falling back to device index 0.")
    INPUT_DEVICE = 0
    if devices[INPUT_DEVICE]['max_input_channels'] <= 0:
        raise RuntimeError(f"Fallback device index 0 ('{devices[INPUT_DEVICE]['name']}') is not valid for input.")

fs = int(sd.query_devices(INPUT_DEVICE, 'input')['default_samplerate'])
print(f"→ Using device #{INPUT_DEVICE}: '{devices[INPUT_DEVICE]['name']}' @ {fs} Hz")

# 2. Load class names
class_names = []
with open(CLASS_CSV) as f:
    reader = csv.DictReader(f)
    for row in reader:
        class_names.append(row['display_name'])

# 3. Set up the TFLite interpreter
interpreter = tflite.Interpreter(model_path=MODEL_FILE, num_threads=NUM_THREADS)
interpreter.allocate_tensors()
inp_detail  = interpreter.get_input_details()[0]
out_detail  = interpreter.get_output_details()[0]

# 4. Compute buffer sizes
FRAME_LEN = int(FRAME_SEC * fs)
HOP_LEN   = int(HOP_SEC   * fs)

# 5. Audio producer & consumer
async def producer(q):
    loop = asyncio.get_event_loop()
    def callback(indata, frames, t0, status):
        if status:
            print("~!!!~", status)
        loop.call_soon_threadsafe(q.put_nowait, indata[:,0].copy())
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
        a[mask] = np.sign(a[mask]) * (thr + (np.abs(a[mask]) - thr)/ratio)
        return a

    while True:
        chunk = await q.get()
        buf = np.roll(buf, -len(chunk))
        buf[-len(chunk):] = chunk

        # apply compressor & resample
        cmp = compressor(buf)
        if fs != 16_000:
            wf = resample(cmp, 16_000).astype('float32')
        else:
            wf = cmp

        # run inference
        interpreter.set_tensor(inp_detail['index'], wf.reshape(inp_detail['shape']))
        interpreter.invoke()
        out = interpreter.get_tensor(out_detail['index'])
        # out shape may be [1, patches, classes]
        scores = out[0] if out.ndim==3 else out
        avg_scores = np.mean(scores, axis=0)
        idx = int(np.argmax(avg_scores))
        conf = float(avg_scores[idx])

        if conf > THRESHOLD:
            ts = time.time()
            entry = {"ts": ts, "cl": class_names[idx], "cf": round(conf*100,1)}
            print(f"{ts:.2f} → {entry['cl']} ({entry['cf']}%)")

            # append to JSON
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

if __name__=="__main__":
    asyncio.run(main())