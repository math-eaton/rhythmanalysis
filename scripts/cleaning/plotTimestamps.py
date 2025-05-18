#!/usr/bin/env python3
"""
Fetch all row IDs and timestamps from the audio_logs table (ordered by ID),
detect any non-linear timestamps, log them, and plot:
 1) Timestamp vs. row ID
 2) Δ seconds between consecutive timestamps vs. row ID

Dependencies: psycopg2, pandas, matplotlib
"""

import argparse
import json
from pathlib import Path

import psycopg2
import pandas as pd
import matplotlib.pyplot as plt


def get_db_url(args):
    # 1) From --db-url
    if args.db_url:
        return args.db_url

    # 2) Else try reading dbconfig.json
    cfg_path = Path(args.dbconfig)
    if cfg_path.exists():
        cfg = json.loads(cfg_path.read_text())
        url = cfg.get("postgres_url")
        if url:
            return url

    raise RuntimeError(
        "No database URL provided. "
        "Give --db-url or place your postgres_url in dbconfig.json."
    )


def fetch_data(db_url):
    # Connect and pull id, ts ordered by id
    conn = psycopg2.connect(dsn=db_url)
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, ts
                  FROM audio_logs
                 ORDER BY id ASC
            """)
            rows = cur.fetchall()
    finally:
        conn.close()

    # Build DataFrame
    df = pd.DataFrame(rows, columns=["id", "ts"])
    df["ts"] = pd.to_datetime(df["ts"])
    return df


def log_non_linear(df, logfile="non_linear_log.txt"):
    # Find places where ts decreases
    df["prev_ts"] = df["ts"].shift(1)
    df["prev_id"] = df["id"].shift(1)
    mask = df["ts"] < df["prev_ts"]

    if mask.any():
        with open(logfile, "w") as f:
            f.write("Non-linear timestamps detected:\n")
            f.write("id, ts, prev_id, prev_ts\n")
            for _, row in df[mask].iterrows():
                f.write(f"{row['id']}, {row['ts']}, "
                        f"{int(row['prev_id'])}, {row['prev_ts']}\n")
        print(f"Wrote {mask.sum()} non-linear entries to {logfile}")
    else:
        # If desired, clear previous log
        Path(logfile).unlink(missing_ok=True)
        print("No non-linear timestamps found.")


def plot_timestamps(df):
    # Compute inter‐record gaps in seconds
    df["delta_s"] = df["ts"].diff().dt.total_seconds()

    # Prepare figure with two stacked plots
    fig, (ax1, ax2) = plt.subplots(
        nrows=2,
        sharex=True,
        figsize=(10, 6),
        gridspec_kw={"height_ratios": (3, 1)}
    )

    # Top: timestamp vs. id
    ax1.plot(df["id"], df["ts"], marker=".", linestyle="none")
    ax1.set_ylabel("Timestamp")
    ax1.set_title("audio_logs: ts vs. id (chronological by id)")

    # Bottom: gap vs. id
    ax2.plot(df["id"], df["delta_s"], marker=".", linestyle="none")
    ax2.set_ylabel("Δ seconds")
    ax2.set_xlabel("Row ID")
    ax2.set_title("Inter-record time differences")

    plt.tight_layout()
    plt.show()


def main():
    p = argparse.ArgumentParser(
        description="Plot audio_log timestamps (by id) and detect non-linear entries."
    )
    p.add_argument(
        "--db-url",
        help="Postgres connection string, e.g. postgresql://user:pass@host:port/db"
    )
    p.add_argument(
        "--dbconfig",
        default="dbconfig.json",
        help="Path to JSON config containing your postgres_url key"
    )
    args = p.parse_args()

    db_url = get_db_url(args)
    df = fetch_data(db_url)

    if df.empty:
        print("No records found in audio_logs.")
        return

    # Log any non-linear timestamps
    log_non_linear(df)

    # Plot the ID vs ts and Δs
    plot_timestamps(df)


if __name__ == "__main__":
    main()