import asyncio, time
import numpy as np
import time
import sounddevice as sd
import tensorflow as tf
import tensorflow_hub as hub
import csv

# — audio in —
INPUT_DEVICE = 3
dev_info = sd.query_devices(INPUT_DEVICE, 'input')
NATIVE_FS = int(dev_info['default_samplerate'])
print(f"Using device {INPUT_DEVICE} at {NATIVE_FS} Hz")

# — load YAMNet —
yamnet = hub.load('https://tfhub.dev/google/yamnet/1')
class_map = yamnet.class_map_path().numpy().decode()
with tf.io.gfile.GFile(class_map) as f:
    class_names = [r['display_name'] for r in csv.DictReader(f)]

# — buff params —
FRAME_SEC = 1.0
FRAME_LEN = int(NATIVE_FS * FRAME_SEC)
HOP_SEC = 0.5
HOP_LEN = int(NATIVE_FS * HOP_SEC)
buffer = np.zeros(FRAME_LEN, dtype='float32')

async def producer(q):
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
    from scipy.signal import resample

    # realtime buffer
    buffer = np.zeros(FRAME_LEN, dtype='float32')

    while True:
        chunk = await q.get()
        # shift old samples left, append new ones
        buffer = np.roll(buffer, -len(chunk))
        buffer[-len(chunk):] = chunk

        # resample for yamnet
        if NATIVE_FS != 16000:
            wf = resample(buffer, 16000).astype(np.float32)
        else:
            wf = buffer

        # run YAMNet
        scores, _, _ = yamnet(tf.constant(wf))
        avg = tf.reduce_mean(scores, axis=0).numpy()
        idx = np.argmax(avg)
        if avg[idx] > 0.3:
            print(f"{time.time():.2f}s → {class_names[idx]} ({avg[idx]:.2f})")

async def main():
    q = asyncio.Queue()
    await asyncio.gather(producer(q), consumer(q))

if __name__ == "__main__":
    asyncio.run(main())
