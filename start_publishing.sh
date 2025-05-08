#!/usr/bin/env bash
# wait so classify can warm up
sleep 10

# ─ activate micromamba env ─────────────────────────────────────────
eval "$(micromamba shell hook --shell bash)"
micromamba activate yamnet

# ─ exec publish daemon ─────────────────────────────────────────────
exec python scripts/database/publish.py
