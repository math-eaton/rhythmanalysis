import json
import math
import numpy as np
import matplotlib.pyplot as plt
from datetime import datetime
import random

# import ext json
with open("scripts/output/classifications_yamnet.json") as f:
    data = json.load(f)

# sort by timestamp + choose window
WINDOW_MINUTES = 120
data = sorted(data, key=lambda e: e["ts"])
start_ts = data[0]["ts"]
end_ts = start_ts + WINDOW_MINUTES * 60

# filter by ts + cf
CONFIDENCE_THRESHOLD = 40
window = [e for e in data
          if start_ts <= e["ts"] < end_ts and e["cf"] > CONFIDENCE_THRESHOLD]
if not window:
    raise ValueError(f"No events in the {WINDOW_MINUTES}-minute window "
                     f"with confidence > {CONFIDENCE_THRESHOLD}!")

# assign colors + orbital ring to unique classes
classes = sorted({e["cl"] for e in window})
outer, inner = 1.0, 0.25
radii = np.linspace(outer, inner, len(classes), endpoint=False)
ring_radius = dict(zip(classes, radii))

# build a categorical colormap with as many entries as existing classes
cmap = plt.get_cmap("tab20")
colors = { cl: cmap(i) for i, cl in enumerate(classes) }

# clock angles
angles = [
    -((e["ts"] - start_ts) / (WINDOW_MINUTES * 60)) * 2 * math.pi
    for e in window
]

# high cf = larger point size
max_area = 50
sizes = [(e["cf"]/100) * max_area for e in window]

# add jitter for better visibility / interest
ring_width = (outer - inner) / len(classes)
jitter_amt = ring_width * 0.4
max_ang_jit = (0.5 / (WINDOW_MINUTES * 60)) * 2 * math.pi

# plot events
fig, ax = plt.subplots(subplot_kw={"projection": "polar"}, figsize=(10,10))
for e, θ, s in zip(window, angles, sizes):
    base_r = ring_radius[e["cl"]]
    # jit
    r = base_r + random.uniform(-jitter_amt, jitter_amt)
    θ = θ + random.uniform(-max_ang_jit, max_ang_jit)
    ax.scatter(
        θ, r, 
        s=s, 
        alpha=0.6,
        color=colors[e["cl"]], 
        edgecolor='k', 
        linewidth=0.3,
        label=e["cl"]
    )

# plot orbital ring guides
for r0 in radii:
    ax.plot(
        np.linspace(0, 2*math.pi, 360),
        [r0]*360,
        color='gray',
        lw=0.5,
        alpha=0.2
    )

# plot surrounds
handles, labels = ax.get_legend_handles_labels()
by_label = dict(zip(labels, handles))
ax.legend(
    by_label.values(), 
    by_label.keys(), 
    bbox_to_anchor=(1.1, 1),
    title="Event classes"
)

ax.set_ylim(0, 1.1)
ax.set_yticks([])

# rm final label (origin)
minutes = np.arange(0, WINDOW_MINUTES + 1, 5)  # Include all ticks
ax.set_xticks(-minutes / WINDOW_MINUTES * 2 * math.pi)
ax.set_xticklabels(
    [f"{m:02d} min" if m != WINDOW_MINUTES else "" for m in minutes]  # Remove label for the last tick
)

ax.set_title(
    f"Events from {datetime.fromtimestamp(start_ts)}\n"
    f"to {datetime.fromtimestamp(end_ts)}",
    va="bottom"
)

plt.tight_layout()
plt.show()
