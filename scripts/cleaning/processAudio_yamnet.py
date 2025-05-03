#!/usr/bin/env python3
"""
yamnet_prepare.py
Convert a directory of arbitrary audio files to 16 kHz mono WAV suitable for YAMNet.
Also renames the originals to their creation time in seconds since the Unix epoch.

Usage
-----
python yamnet_prepare.py   \
       --input  /path/to/raw_audio   \
       --output /path/to/converted   \
       --recursive                  # optional

Dependencies
------------
pip install soundfile librosa tqdm  # and ffmpeg installed on the system for non-WAV input
"""
from __future__ import annotations
import argparse, os, sys, shutil, stat, time
from pathlib import Path
import soundfile as sf
import librosa
from tqdm import tqdm

# ---------- helpers --------------------------------------------------------- #
AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aiff", ".aif", ".aifc"}

def file_timestamp(p: Path) -> int:
    """Return creation-time in seconds. Fallback to mtime on Unix where ctime≈mtime."""
    if hasattr(os, "stat"):
        st = p.stat()
        # On macOS/Linux st.st_birthtime is creation time when available
        if hasattr(st, "st_birthtime"):
            return int(st.st_birthtime)
        # On Windows st_ctime is creation time; on Unix it's last status change
        return int(st.st_ctime)
    return int(time.time())

def convert_to_yamnet(src: Path, dst: Path, sr: int = 16_000) -> None:
    """Load *src* with librosa, resample/mono-ize, write WAV 16 kHz PCM 16-bit to *dst*."""
    y, _ = librosa.load(src, sr=sr, mono=True)          # ensures 16 kHz + mono
    dst.parent.mkdir(parents=True, exist_ok=True)
    sf.write(dst, y, sr, subtype="PCM_16")              # WAV, 16-bit PCM

# ---------- main ------------------------------------------------------------ #
def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Prepare audio for YAMNet (16 kHz mono WAV).")
    parser.add_argument("--input",  "-i", type=Path, required=True, help="Directory containing raw audio.")
    parser.add_argument("--output", "-o", type=Path, required=True, help="Directory for converted WAVs.")
    parser.add_argument("--recursive", "-r", action="store_true", help="Recurse into sub-directories.")
    args = parser.parse_args(argv)

    if not args.input.is_dir():
        sys.exit(f"Input {args.input} is not a directory")

    paths = args.input.rglob("*") if args.recursive else args.input.glob("*")
    audio_files = [p for p in paths if p.suffix.lower() in AUDIO_EXTS and p.is_file()]

    if not audio_files:
        sys.exit("No audio files found!")

    for src in tqdm(audio_files, desc="Processing", unit="file"):
        ts = file_timestamp(src)
        new_name = f"{ts}{src.suffix.lower()}"
        new_path = src.with_name(new_name)

        # rename original if it hasn't already been renamed
        if src.name != new_name:
            try:
                src.rename(new_path)
                src = new_path  # update reference for conversion
            except OSError as e:
                tqdm.write(f"⚠️  Could not rename {src}: {e}")

        # destination file gets .wav regardless of original extension
        dst_path = args.output / f"{ts}.wav"
        try:
            convert_to_yamnet(src, dst_path)
        except Exception as e:
            tqdm.write(f"❌  Failed on {src}: {e}")

if __name__ == "__main__":
    main()
