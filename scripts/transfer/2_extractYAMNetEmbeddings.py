import tensorflow_hub as hub, tensorflow as tf, numpy as np, pathlib, json, tqdm

yamnet = hub.load('/Users/matthewheaton/.cache/kagglehub/models/google/yamnet/tensorFlow2/yamnet/1')
labels  = json.load(open('/Users/matthewheaton/Documents/GitHub/rhythmanalysis/scripts/transfer/datasets/labels_fine.json'))
outdir  = pathlib.Path('/Users/matthewheaton/Documents/GitHub/rhythmanalysis/scripts/transfer/embeddings'); outdir.mkdir(exist_ok=True)

for wav in tqdm.tqdm(pathlib.Path('/Volumes/EXT_HEATON/GSAPP/rhythmanalysis/3966543/resampled').glob('*.wav')):
    audio = tf.io.read_file(str(wav))
    wav16k, _ = tf.audio.decode_wav(audio)          # (480000, 1)
    scores, embeds, _ = yamnet(wav16k[:, 0])        # embeds: (patches, 1024)

    # Each patch inherits the clip-level label vector
    y = np.array(labels[wav.name], dtype=np.int8)
    for i, e in enumerate(embeds.numpy()):
        np.savez_compressed(outdir / f'{wav.stem}_{i}.npz',
                            x=e.astype(np.float32), y=y)
