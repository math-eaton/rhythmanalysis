import os
import json
import csv
import numpy as np
import tensorflow as tf
import tensorflow_hub as hub
from scipy.signal import resample
from scipy.io import wavfile
import time

# — USER CONFIG —
MODEL_PATH = "/Users/matthewheaton/Documents/GitHub/natural-synthetic/models/mjh/model"
if os.path.exists(MODEL_PATH):
    yamnet = tf.saved_model.load(MODEL_PATH)  # Use tf.saved_model.load for SavedModel format
    # print(f"YAMNet model loaded locally in {time.time() - start_time:.2f} seconds.")
else:
    print("Local model not found. Downloading from TensorFlow Hub...")
    yamnet = hub.load('https://tfhub.dev/google/yamnet/1')
    tf.saved_model.save(yamnet, MODEL_PATH)  # Save in SavedModel format
    # print(f"YAMNet model downloaded and saved locally in {time.time() - start_time:.2f} seconds.")
INPUT_DIR = "/Users/matthewheaton/Documents/GitHub/natural-synthetic/samples/zoom_20250430"
OUTPUT_DIR = "/Users/matthewheaton/Documents/GitHub/natural-synthetic/output/classifications_zoom_20250430.json"
THRESHOLD = 0.333
FRAME_SEC = 1.0
HOP_SEC   = 0.5

# — LOAD MODEL & CLASS MAP —
yamnet = tf.saved_model.load(MODEL_PATH)
class_map_path = yamnet.class_map_path().numpy().decode("utf-8")
with tf.io.gfile.GFile(class_map_path) as f:
    class_names = [r["display_name"] for r in csv.DictReader(f)]

def process_file(wav_path):
    """Classify one WAV file and return list of events."""
    sr, audio = wavfile.read(wav_path)  # audio may be int16 or float32
    # normalize to float32 in [-1,1]
    if audio.dtype.kind == "i":
        audio = audio.astype(np.float32) / np.iinfo(audio.dtype).max
    elif audio.dtype.kind == "u":  # unlikely for WAV
        audio = (audio.astype(np.float32) - 32768) / 32768
    audio = audio.flatten()

    frame_len = int(sr * FRAME_SEC)
    hop_len   = int(sr * HOP_SEC)
    # parse filename as UNIX time (seconds)
    basename = os.path.splitext(os.path.basename(wav_path))[0]
    try:
        start_time = float(basename)
    except ValueError:
        raise ValueError(f"Filename {basename} is not a valid Unix timestamp")

    events = []
    # slide over with hop
    for i in range(0, len(audio) - frame_len + 1, hop_len):
        frame = audio[i : i + frame_len]
        # compressor if desired (reuse your apply_compressor here)
        # ----- optional compressor -----
        # frame = apply_compressor(frame)

        # resample to 16 kHz
        if sr != 16000:
            wf = resample(frame, int(16000 * FRAME_SEC)).astype(np.float32)
        else:
            wf = frame.astype(np.float32)

        # run YAMNet
        scores, _, _ = yamnet(tf.constant(wf))
        avg = tf.reduce_mean(scores, axis=0).numpy()
        idx = np.argmax(avg)
        confidence = avg[idx]
        if confidence >= THRESHOLD:
            # center of this frame in seconds
            frame_center = (i / sr) + (FRAME_SEC / 2)
            ts = start_time + frame_center
            events.append({
                "ts": round(ts, 3),
                "cl": class_names[idx],
                "cf": round(float(confidence * 100), 1)
            })

    return events

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    all_events = []
    for fname in os.listdir(INPUT_DIR):
        if not fname.lower().endswith(".wav"):
            continue
        wav_path = os.path.join(INPUT_DIR, fname)
        print(f"Processing {fname} …")
        ev = process_file(wav_path)
        out_path = os.path.join(OUTPUT_DIR, fname.replace(".wav", ".json"))
        with open(out_path, "w") as out_f:
            json.dump(ev, out_f, indent=2)
        all_events.extend(ev)

    # Optionally write a merged file:
    merged_path = os.path.join(OUTPUT_DIR, "merged_classifications.json")
    with open(merged_path, "w") as m:
        json.dump(all_events, m, indent=2)
    print("Done!")

if __name__ == "__main__":
    main()
