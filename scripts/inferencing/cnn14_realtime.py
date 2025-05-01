import asyncio
import time
import os
import json

import numpy as np
import sounddevice as sd
from scipy.signal import resample
from panns_inference import AudioTagging

# — audio in —
devices = sd.query_devices()
input_device_name = "MacBook Pro Microphone"  # adjust as needed
INPUT_DEVICE = None

for i, device in enumerate(devices):
    if input_device_name.lower() in device['name'].lower() and device['max_input_channels'] > 0:
        INPUT_DEVICE = i
        break

if INPUT_DEVICE is None:
    raise ValueError(f"Input device '{input_device_name}' not found. Please check your audio devices.")

dev_info = sd.query_devices(INPUT_DEVICE, 'input')
NATIVE_FS = int(dev_info['default_samplerate'])
print(f"Using device '{input_device_name}' (ID: {INPUT_DEVICE}) at {NATIVE_FS} Hz")

# — load PANNs CNN14 —
print("Loading PANNs CNN14 model...")
tagger = AudioTagging(checkpoint_path='Cnn14', device='cpu')
class_names = tagger.labels
print("PANNs CNN14 model ready.")

# — buffering params —
FRAME_SEC = 1.0
FRAME_LEN = int(NATIVE_FS * FRAME_SEC)
HOP_SEC = 0.5
HOP_LEN = int(NATIVE_FS * HOP_SEC)
buffer = np.zeros(FRAME_LEN, dtype='float32')

OUTPUT_JSON = "scripts/output/classifications_cnn14.json"

async def producer(q):
    loop = asyncio.get_event_loop()
    def cb(indata, frames, t, s):
        # indata is shape (frames, channels)
        loop.call_soon_threadsafe(q.put_nowait, indata[:, 0].copy())
    with sd.InputStream(device=INPUT_DEVICE,
                        channels=1,
                        samplerate=NATIVE_FS,
                        dtype='float32',
                        blocksize=HOP_LEN,
                        callback=cb):
        await asyncio.Event().wait()

async def consumer(q):
    buffer = np.zeros(FRAME_LEN, dtype='float32')

    def apply_compressor(audio, threshold=0.1, ratio=4.0):
        compressed = np.copy(audio)
        above = np.abs(audio) > threshold
        compressed[above] = (
            np.sign(audio[above]) *
            (threshold + (np.abs(audio[above]) - threshold) / ratio)
        )
        return compressed

    while True:
        chunk = await q.get()
        buffer = np.roll(buffer, -len(chunk))
        buffer[-len(chunk):] = chunk

        compressed_buffer = apply_compressor(buffer)

        # resample down to 16 kHz for PANNs
        if NATIVE_FS != 16000:
            wf = resample(compressed_buffer, 16000).astype(np.float32)
        else:
            wf = compressed_buffer

        # run PANNs CNN14
        clipwise_output, _ = tagger.inference(wf)
        idx = np.argmax(clipwise_output)
        confidence = clipwise_output[idx]

        if confidence > 0.1:
            cl = {
                "ts": time.time(),
                "cl": class_names[idx],
                "cf": round(float(confidence) * 100, 1)
            }
            print(f"{cl['ts']:.2f}s → {cl['cl']} ({cl['cf']}%)")

            # append to JSON
            os.makedirs(os.path.dirname(OUTPUT_JSON), exist_ok=True)
            if os.path.exists(OUTPUT_JSON):
                with open(OUTPUT_JSON, "r+") as f:
                    data = json.load(f)
                    data.append(cl)
                    f.seek(0)
                    json.dump(data, f, indent=4)
            else:
                with open(OUTPUT_JSON, "w") as f:
                    json.dump([cl], f, indent=4)

async def main():
    print("Starting main event loop...")
    q = asyncio.Queue()
    await asyncio.gather(producer(q), consumer(q))

if __name__ == "__main__":
    asyncio.run(main())
