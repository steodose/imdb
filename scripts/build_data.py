#!/usr/bin/env python3
"""Build per-series episode-rating JSON from the official IMDb bulk datasets.

Reads the curated show list in data/series_urls.csv, downloads the three IMDb
TSV files (title.episode, title.ratings, title.basics), joins them, and writes
one JSON file per show into data/series/ plus an index.json for the UI.

Usage:
    python3 scripts/build_data.py            # download if missing, then build
    python3 scripts/build_data.py --refresh  # force re-download of the TSVs

Data is from https://datasets.imdbws.com/ and is for personal, non-commercial
use per IMDb's terms.
"""

import argparse
import csv
import gzip
import json
import os
import re
import sys
import urllib.request
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOWNLOADS = os.path.join(ROOT, "downloads")
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "series")
SERIES_URLS = os.path.join(DATA, "series_urls.csv")

BASE_URL = "https://datasets.imdbws.com/"
FILES = ("title.episode.tsv.gz", "title.ratings.tsv.gz", "title.basics.tsv.gz")

# A tt id in the CSV: "tt" + 7 or 8 digits.
TT_RE = re.compile(r"tt\d{7,8}")


def log(msg):
    print(msg, flush=True)


def download(refresh=False):
    os.makedirs(DOWNLOADS, exist_ok=True)
    for name in FILES:
        dest = os.path.join(DOWNLOADS, name)
        if os.path.exists(dest) and not refresh:
            log(f"  have {name} ({os.path.getsize(dest) / 1e6:.0f} MB), skipping")
            continue
        url = BASE_URL + name
        log(f"  downloading {url} ...")
        req = urllib.request.Request(url, headers={"User-Agent": "imdb-dashboard/1.0"})
        with urllib.request.urlopen(req) as resp, open(dest, "wb") as f:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        log(f"  saved {name} ({os.path.getsize(dest) / 1e6:.0f} MB)")


def load_series_list():
    """Return {imdb_id: display_name} from series_urls.csv.

    The file may be well-formed CSV *or* one long line with no row breaks, so
    parse defensively: pull every 'Name,ttXXXXXXX' pair via regex.
    """
    with open(SERIES_URLS, encoding="utf-8") as f:
        text = f.read()

    series = {}
    # Match "<name>,tt#######" where name is everything up to the comma that
    # precedes a tt id. Works whether or not rows are newline-separated.
    pair_re = re.compile(r"([^,\n]+?),\s*(tt\d{7,8})")
    for name, tid in pair_re.findall(text):
        name = name.strip()
        if name.lower() in ("series_name", ""):  # header / stray
            continue
        series[tid] = name
    return series


def path_for(name):
    return os.path.join(DOWNLOADS, name)


def open_tsv(name):
    return gzip.open(path_for(name), "rt", encoding="utf-8", newline="")


def build(series):
    parents = set(series)  # series tconsts we care about

    # 1) title.episode: episode -> (parent, season, episode)
    log("  scanning title.episode ...")
    episodes = {}  # episode_tconst -> (parent, season, episode)
    with open_tsv("title.episode.tsv.gz") as f:
        reader = csv.reader(f, delimiter="\t")
        next(reader, None)  # header
        for row in reader:
            # tconst, parentTconst, seasonNumber, episodeNumber
            if len(row) < 4:
                continue
            tconst, parent, season, ep = row[0], row[1], row[2], row[3]
            if parent not in parents:
                continue
            if season == "\\N" or ep == "\\N":
                continue
            try:
                episodes[tconst] = (parent, int(season), int(ep))
            except ValueError:
                continue
    log(f"  matched {len(episodes)} episodes across {len(parents)} series")

    wanted_ratings = set(episodes) | parents

    # 2) title.ratings: tconst -> (avgRating, numVotes)
    log("  scanning title.ratings ...")
    ratings = {}
    with open_tsv("title.ratings.tsv.gz") as f:
        reader = csv.reader(f, delimiter="\t")
        next(reader, None)
        for row in reader:
            if len(row) < 3:
                continue
            tconst, avg, votes = row[0], row[1], row[2]
            if tconst not in wanted_ratings:
                continue
            try:
                ratings[tconst] = (float(avg), int(votes))
            except ValueError:
                continue

    # 3) title.basics: tconst -> primaryTitle (episode names + series names)
    log("  scanning title.basics (large, streaming) ...")
    wanted_titles = set(episodes) | parents
    titles = {}
    with open_tsv("title.basics.tsv.gz") as f:
        reader = csv.reader(f, delimiter="\t")
        next(reader, None)
        for row in reader:
            if len(row) < 3:
                continue
            tconst = row[0]
            if tconst not in wanted_titles:
                continue
            titles[tconst] = row[2]  # primaryTitle
            if len(titles) == len(wanted_titles):
                break

    # 4) Assemble per-series payloads
    os.makedirs(OUT, exist_ok=True)
    today = date.today().isoformat()

    # group episodes by parent
    by_parent = {}
    for etid, (parent, season, ep) in episodes.items():
        by_parent.setdefault(parent, []).append((etid, season, ep))

    index = []
    empty = []
    for tid, name in sorted(series.items(), key=lambda kv: kv[1].lower()):
        eps = []
        for etid, season, ep in by_parent.get(tid, []):
            r = ratings.get(etid)
            if r is None:
                continue  # no rating -> skip (blank cell)
            eps.append({
                "season": season,
                "episode": ep,
                "title": titles.get(etid, f"Episode {ep}"),
                "rating": round(r[0], 1),
                "votes": r[1],
            })
        if not eps:
            empty.append(name)
            continue

        eps.sort(key=lambda e: (e["season"], e["episode"]))
        seasons = sorted({e["season"] for e in eps})

        # Headline figures are aggregated over episodes (matching the "Avg. Rating"
        # and "Total Votes" semantics of the original Tableau dashboard).
        avg_rating = round(sum(e["rating"] for e in eps) / len(eps), 1)
        total_votes = sum(e["votes"] for e in eps)
        # The series title's own IMDb rating (a distinct, user-facing number).
        imdb_series_rating = ratings.get(tid, (None,))[0]
        if imdb_series_rating is not None:
            imdb_series_rating = round(imdb_series_rating, 1)

        payload = {
            "name": name,
            "imdbId": tid,
            "lastRefreshed": today,
            "avgRating": avg_rating,
            "imdbSeriesRating": imdb_series_rating,
            "totalEpisodes": len(eps),
            "totalSeasons": len(seasons),
            "totalVotes": total_votes,
            "episodes": eps,
        }
        with open(os.path.join(OUT, f"{tid}.json"), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

        index.append({
            "name": name,
            "imdbId": tid,
            "avgRating": avg_rating,
            "totalSeasons": len(seasons),
            "totalEpisodes": len(eps),
            "totalVotes": total_votes,
        })

    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"lastRefreshed": today, "series": index}, f, ensure_ascii=False)

    log("")
    log(f"Wrote {len(index)} series to {OUT}")
    if empty:
        log(f"No episode data for {len(empty)} series: {', '.join(empty)}")


def main():
    ap = argparse.ArgumentParser(description="Build IMDb episode-rating JSON.")
    ap.add_argument("--refresh", action="store_true", help="force re-download of TSVs")
    args = ap.parse_args()

    log("Step 1/2: downloading IMDb datasets")
    download(refresh=args.refresh)

    log("Step 2/2: building series JSON")
    series = load_series_list()
    if not series:
        log("ERROR: no series parsed from data/series_urls.csv")
        sys.exit(1)
    log(f"  {len(series)} shows in curated list")
    build(series)


if __name__ == "__main__":
    main()
