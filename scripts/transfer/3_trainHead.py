import tensorflow as tf
import numpy as np
import glob, os, pathlib, tqdm

# ───────────────────────────────────────────────  CONFIG  ──
EMBED_DIR = pathlib.Path(
    '/Users/matthewheaton/Documents/GitHub/rhythmanalysis/scripts/transfer/embeddings'
)
TFRECORD  = pathlib.Path(
    '/Users/matthewheaton/Documents/GitHub/rhythmanalysis/scripts/transfer/datasets/embeddings.tfrecord.gz'
)
MODEL_OUT = pathlib.Path(
    '/Users/matthewheaton/Documents/GitHub/rhythmanalysis/scripts/transfer/datasets/sonyc_head_v3'
)
NUM_TAGS  = 23
BATCH     = 128
EPOCHS    = 15
SHUFFLE_BUFFER = 10_000
# ───────────────────────────────────────────────────────────

MODEL_OUT.parent.mkdir(parents=True, exist_ok=True)
TFRECORD.parent.mkdir(parents=True, exist_ok=True)

# 1. ── Build TFRecord if it doesn't exist ─────────────────
if not TFRECORD.exists():
    print("Building TFRecord …")
    src_pattern = str(EMBED_DIR / '*.npz')
    num_records = 0
    with tf.io.TFRecordWriter(str(TFRECORD), options='GZIP') as w:
        for f in tqdm.tqdm(glob.glob(src_pattern), unit='file'):
            z = np.load(f)
            ex = tf.train.Example(features=tf.train.Features(feature={
                'x': tf.train.Feature(
                    float_list=tf.train.FloatList(value=z['x'])),
                'y': tf.train.Feature(
                    int64_list=tf.train.Int64List(value=z['y'].astype(np.int64)))
            }))
            w.write(ex.SerializeToString())
            num_records += 1
    size_mb = TFRECORD.stat().st_size / 1e6
    print(f"... wrote {num_records:,} records  ({size_mb:.1f} MB)")
else:
    print("TFRecord already exists, counting records …")
    # quick count via file size / single-record size isn’t safe ... iterate once
    num_records = sum(1 for _ in tf.data.TFRecordDataset(
        str(TFRECORD), compression_type='GZIP'))
    print(f"... found {num_records:,} records")


train_records = int(0.9 * num_records)
val_records   = num_records - train_records

STEPS      = (train_records + BATCH - 1) // BATCH   # ceil division ... 2603
VAL_STEPS  = (val_records   + BATCH - 1) // BATCH   # ...  289
print(f"Batches/epoch: {STEPS}  •  Val batches: {VAL_STEPS}")

# 2. ── Prepare tf.data pipeline ───────────────────────────
feature_spec = {
    'x': tf.io.FixedLenFeature([1024], tf.float32),
    'y': tf.io.FixedLenFeature([NUM_TAGS], tf.int64),
}
def parse(rec):
    feat = tf.io.parse_single_example(rec, feature_spec)
    return feat['x'], tf.cast(feat['y'], tf.int8)

full_ds = (tf.data.TFRecordDataset(str(TFRECORD), compression_type='GZIP')
             .map(parse, num_parallel_calls=tf.data.AUTOTUNE)
             .shuffle(SHUFFLE_BUFFER))

train_ds = (full_ds.take(int(0.9 * num_records))
                      .batch(BATCH)
                      .prefetch(tf.data.AUTOTUNE))
val_ds   = (full_ds.skip(int(0.9 * num_records))
                      .batch(BATCH)
                      .prefetch(tf.data.AUTOTUNE))

# 3. ── Build & train model ────────────────────────────────
model = tf.keras.Sequential([
    tf.keras.layers.Input((1024,)),
    tf.keras.layers.Dense(256, 'relu',
                          kernel_regularizer=tf.keras.regularizers.l2(1e-4)),
    tf.keras.layers.Dropout(0.3),
    tf.keras.layers.Dense(NUM_TAGS, 'sigmoid')
])
model.compile('adam', 'binary_crossentropy',
              metrics=[tf.keras.metrics.AUC(multi_label=True)])

model.fit(train_ds,
          validation_data=val_ds,
          epochs=EPOCHS,
          steps_per_epoch=STEPS,
          validation_steps=VAL_STEPS)

# 4. ── Save model (Keras + TFLite) ────────────────────────
h5_path = MODEL_OUT.with_suffix('.h5')
model.save(h5_path)
print("Saved:", h5_path)

def rep_data():
    for x, _ in train_ds.take(100):      # 100 random batches (~12 800 samples)
        yield [x]

converter = tf.lite.TFLiteConverter.from_keras_model(model)
converter.optimizations = [tf.lite.Optimize.DEFAULT]
converter.representative_dataset = rep_data
converter.inference_input_type  = tf.int8
converter.inference_output_type = tf.int8
tflite_model = converter.convert()
open('/Users/matthewheaton/Documents/GitHub/rhythmanalysis/scripts/transfer/datasets/sonyc_head_v3_int8.tflite', 'wb').write(tflite_model)