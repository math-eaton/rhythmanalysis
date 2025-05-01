import asyncio, time
import numpy as np
import time
import sounddevice as sd
import tensorflow as tf
import tensorflow_hub as hub
import csv
import json
import os

# print("Initializing script...")

# — audio in —
# print("Configuring audio input...")
devices = sd.query_devices()  # since inputs may vary, query all available devices
input_device_name = "MacBook Pro Microphone" # for testing - eventually usb / i2c device
INPUT_DEVICE = None

# find correct device
for i, device in enumerate(devices):
    if input_device_name.lower() in device['name'].lower() and device['max_input_channels'] > 0:
        INPUT_DEVICE = i
        break

if INPUT_DEVICE is None:
    raise ValueError(f"Input device '{input_device_name}' not found. Please check your audio devices.")

dev_info = sd.query_devices(INPUT_DEVICE, 'input')
NATIVE_FS = int(dev_info['default_samplerate'])
print(f"Using device '{input_device_name}' (ID: {INPUT_DEVICE}) at {NATIVE_FS} Hz")

# — load YAMNet —
print("Loading YAMNet model...")
start_time = time.time()
local_model_path = "/Users/matthewheaton/Documents/GitHub/natural-synthetic/models/mjh/model"
if os.path.exists(local_model_path):
    yamnet = tf.saved_model.load(local_model_path)  # Use tf.saved_model.load for SavedModel format
    print(f"YAMNet model loaded locally in {time.time() - start_time:.2f} seconds.")
else:
    print("Local model not found. Downloading from TensorFlow Hub...")
    yamnet = hub.load('https://tfhub.dev/google/yamnet/1')
    tf.saved_model.save(yamnet, local_model_path)  # Save in SavedModel format
    print(f"YAMNet model downloaded and saved locally in {time.time() - start_time:.2f} seconds.")

print("Loading class map...")
start_time = time.time()
class_map = yamnet.class_map_path().numpy().decode()
with tf.io.gfile.GFile(class_map) as f:
    class_names = [r['display_name'] for r in csv.DictReader(f)]
print(f"Class map loaded in {time.time() - start_time:.2f} seconds.")

# — buff params —
# print("Setting up audio buffering parameters...")
FRAME_SEC = 1.0
FRAME_LEN = int(NATIVE_FS * FRAME_SEC)
HOP_SEC = 0.5
HOP_LEN = int(NATIVE_FS * HOP_SEC)
buffer = np.zeros(FRAME_LEN, dtype='float32')
# print("Audio buffering parameters configured.")

OUTPUT_JSON = "scripts/output/classifications_yamnet.json" 
# print(f"Output JSON file: {OUTPUT_JSON}")

async def producer(q):
    # print("Starting audio producer...")
    loop = asyncio.get_event_loop()
    def cb(indata, frames, t, s):
        # indata is float32 in [-1,1]
        loop.call_soon_threadsafe(q.put_nowait, indata[:,0].copy())
    with sd.InputStream(device=INPUT_DEVICE,
                        channels=1,
                        samplerate=NATIVE_FS,
                        dtype='float32',
                        blocksize=HOP_LEN,
                        callback=cb):
        await asyncio.Event().wait()

async def consumer(q):
    # print("Starting audio consumer...")
    from scipy.signal import resample

    # realtime buffer
    buffer = np.zeros(FRAME_LEN, dtype='float32')

    def apply_compressor(audio, threshold=0.1, ratio=4.0):
        """
        Apply a simple dynamic range compressor to the audio signal.
        Args:
            audio (np.ndarray): Input audio signal.
            threshold (float): Threshold above which compression is applied.
            ratio (float): Compression ratio.
        Returns:
            np.ndarray: Compressed audio signal.
        """
        compressed = np.copy(audio)
        above_threshold = np.abs(audio) > threshold
        compressed[above_threshold] = (
            np.sign(audio[above_threshold]) *
            (threshold + (np.abs(audio[above_threshold]) - threshold) / ratio)
        )
        return compressed

    while True:
        chunk = await q.get()
        # shift old samples left, append new ones
        buffer = np.roll(buffer, -len(chunk))
        buffer[-len(chunk):] = chunk

        # Apply compressor to the buffer
        compressed_buffer = apply_compressor(buffer)

        # resample for yamnet
        if NATIVE_FS != 16000:
            wf = resample(compressed_buffer, 16000).astype(np.float32)
        else:
            wf = compressed_buffer

        # run YAMNet
        scores, _, _ = yamnet(tf.constant(wf))
        avg = tf.reduce_mean(scores, axis=0).numpy()
        idx = np.argmax(avg)
        if avg[idx] > 0.1:
            cl = {
                "ts": time.time(),  # Unix time w seconds res
                "cl": class_names[idx],
                "cf": round(avg[idx] * 100, 1)  # cf as a percentage
            }
            print(f"{cl['ts']:.2f}s → {cl['cl']} ({cl['cf']}%)")

            # Append cl to JSON file
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
    # print("Script started. Initializing asyncio...")
    asyncio.run(main())
