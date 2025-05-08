#!/usr/bin/env bash
# ─ activate micromamba env ─────────────────────────────────────────
eval "$(micromamba shell hook --shell bash)"
micromamba activate yamnet

# ─ exec classify daemon ─────────────────────────────────────────────
exec python scripts/rpi/classify.py
