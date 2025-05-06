# test_head_mac_litert.py  –  works with ai_edge_litert
from ai_edge_litert.interpreter import Interpreter
import numpy as np

YAM = '/Users/matthewheaton/.cache/kagglehub/models/google/yamnet/tfLite/tflite/1/1.tflite'
HEAD = '/Users/matthewheaton/Documents/GitHub/rhythmanalysis/scripts/transfer/datasets/sonyc_head_v3_int8.tflite'


# ── Backbone ─────────────────────────────────────────────
yam = Interpreter(YAM)
# resize input from [1] -> [15600]  (vector, no batch dim)
yam.resize_tensor_input(yam.get_input_details()[0]['index'], [15600], strict=True)
yam.allocate_tensors()

# locate 1 024-D embedding tensor
embed = next(d for d in yam.get_output_details() if d['shape'][-1] == 1024)
e_idx, e_scale, e_zero = embed['index'], *embed['quantization']

# ── Head ─────────────────────────────────────────────────
head = Interpreter(HEAD)
head.allocate_tensors()
print(head.get_input_details()[0])
h_in  = head.get_input_details()[0]['index']
h_out = head.get_output_details()[0]['index']
h_scale, h_zero = head.get_input_details()[0]['quantization']

# ── Dummy 0.975 s audio frame ───────────────────────────
frame = np.random.randn(15600).astype(np.float32)  # shape (15600,)

yam.set_tensor(yam.get_input_details()[0]['index'], frame)
yam.invoke()
emb_f32 = yam.get_tensor(e_idx)[0]                 # (1024,) float32

# quantise to int8 for head
emb_i8 = np.clip(np.round(emb_f32 / h_scale + h_zero),
                 -128, 127).astype(np.int8)

# quantise to int8 for head
emb_i8 = np.clip(np.round(emb_f32 / h_scale + h_zero),
                 -128, 127).astype(np.int8)

# ←–– reshape to (1, 1024)
emb_i8 = emb_i8[np.newaxis, :]

head.set_tensor(h_in, emb_i8)
head.invoke()
p_i8  = head.get_tensor(h_out)[0]
probs = (p_i8.astype(np.float32) - h_zero) * h_scale
print("Top-5 tag IDs:", np.argsort(-probs)[:5], "max prob:", probs.max())
