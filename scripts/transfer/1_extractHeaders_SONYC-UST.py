import pandas as pd, numpy as np, pathlib, json, re

CSV = '/Volumes/EXT_HEATON/GSAPP/rhythmanalysis/3966543/annotations.csv'
TAX = '/Volumes/EXT_HEATON/GSAPP/rhythmanalysis/3966543/dcase-ust-taxonomy.yaml'

df = pd.read_csv(CSV)

# Choose a target granularity  ---------

# fine = columns that …
#   – end with '_presence'
#   – contain '-'  (fine-level, not coarse)
#   – do NOT contain '-X_'  (drop the “other-unknown …” rows)

FINE_COLS = [
    c for c in df.columns
    if re.match(r'^\d+-\d+_', c)          #  digit-dash-digit-underscore
    and '-X_' not in c                    #  drop the 6 “other-unknown” tags
    and c.endswith('_presence')
]

print("Fine columns:", len(FINE_COLS))
print(FINE_COLS)

# coarse = 8 high-level classes
COARSE_COLS = [
    c for c in df.columns
    if re.match(r'^\d+_', c)              #  digit-underscore
    and not re.match(r'^\d+-\d+_', c)     #  exclude fine pattern
    and c.endswith('_presence')
]

print("Coarse columns:", len(COARSE_COLS)) 
print(COARSE_COLS)


COLS = COARSE_COLS                         # ← switch to COARSE_COLS for 8 tags


def agg(group):
    # 1) use verified row if present
    verified = group[group.annotator_id == 0]
    if len(verified):
        row = verified.iloc[0]
        return (row[COLS] == 1).astype(int).values
    # 2) majority vote across volunteers & staff
    votes = (group[COLS] == 1).sum(axis=0)
    return (votes >= (len(group) / 2)).astype(int).values

label_map = {}
for clip, g in df.groupby('audio_filename'):
    label_map[clip] = agg(g)

# Save to disk
json.dump({k: v.tolist() for k, v in label_map.items()},
          open('labels_coarse.json', 'w'))

