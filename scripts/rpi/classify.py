import numpy as np, sounddevice as sd, queue, time
import tflite_runtime.interpreter as tflite

# ── Load models ──────────────────────────────────────────
yam = tflite.Interpreter('scripts/kaggle_models/yamnet/tfLite/tflite/1/1.tflite',
                         num_threads=4)
yam.resize_tensor_input(yam.get_input_details()[0]['index'],
                        [15600], strict=True)
yam.allocate_tensors()

head = tflite.Interpreter('scripts/models/sonyc/sonyc_head_v3_int8.tflite',
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
SR = 16_000
HOP = SR                  # 1-second hops
FRAME = 15600             # 0.975 s (YAMNet window)

q_in = queue.Queue(maxsize=10)

def callback(indata, frames, time_info, status):
    if status: print(status, flush=True)
    q_in.put(indata.copy())

stream = sd.InputStream(device=None,  # default mic
                        channels=1, samplerate=SR,
                        blocksize=HOP, callback=callback)
stream.start()

ring = np.zeros(FRAME, dtype=np.float32)

print("Listening … Ctrl-C to stop")
try:
    while True:
        block = q_in.get()
        ring = np.concatenate((ring[len(block):], block[:,0]))  # keep last 0.975 s

        # --- run backbone ---
        yam.set_tensor(yam.get_input_details()[0]['index'], ring)
        yam.invoke()
        emb = yam.get_tensor(e_idx)[0]            # float32, (1024,)

        # --- quantise & run head ---
        emb_i8 = np.clip(np.round(emb / h_scale + h_zero),
                         -128, 127).astype(np.int8)[np.newaxis, :]
        head.set_tensor(h_in, emb_i8)
        head.invoke()
        p_i8  = head.get_tensor(h_out)[0]
        probs = (p_i8.astype(np.float32) - h_zero) * h_scale

        active = np.where(probs > 0.333)[0]        # threshold
        if active.size:
            ts = time.strftime('%H:%M:%S')
            print(f"{ts}  ➜ tags {active}  max {probs[active].max():.2f}")

except KeyboardInterrupt:
    stream.stop()
