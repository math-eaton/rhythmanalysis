# test_head_mac.py
import tflite_runtime.interpreter as tflite
import numpy as np

yam = tflite.Interpreter('yamnet_int8.tflite')
yam.allocate_tensors()
embed_idx = yam.get_output_details()[1]['index']
e_scale, e_zero = yam.get_output_details()[1]['quantization']

head = tflite.Interpreter('sonyc_head_v2_int8.tflite')
head.allocate_tensors()
h_in  = head.get_input_details()[0]['index']
h_out = head.get_output_details()[0]['index']
h_scale, h_zero = head.get_input_details()[0]['quantization']

# 1 sec of pink-noise just to see a number
dummy = np.random.randn(16000).astype(np.float32)

yam.set_tensor(yam.get_input_details()[0]['index'], dummy)
yam.invoke()
emb_i8 = yam.get_tensor(embed_idx)[0]           # (1024,) int8

# (re-quant step needed only if scales differ)
if not np.isclose(e_scale, h_scale):
    emb_f32 = (emb_i8.astype(np.float32) - e_zero) * e_scale
    emb_i8  = np.clip(np.round(emb_f32 / h_scale + h_zero), -128, 127).astype(np.int8)

head.set_tensor(h_in, emb_i8)
head.invoke()
probs_i8 = head.get_tensor(h_out)[0]            # (23,) int8
probs = (probs_i8.astype(np.float32) - h_zero) * h_scale
print(np.argsort(-probs)[:5], probs.max())      # top-5 tags + confidence
