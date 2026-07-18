# TV Series Ratings Dashboard

An interactive dashboard of IMDb episode ratings for a curated set of TV shows —
a season × episode heatmap, headline stats, a top-episodes table, and an average
rating-by-season chart. A modern, buildless successor to an earlier Tableau
dashboard and R/Shiny tool.

![Concept: season × episode rating heatmap with KPI tiles](https://datasets.imdbws.com/)

## How it works

- **Data** comes from the official [IMDb datasets](https://datasets.imdbws.com/)
  (`title.episode`, `title.ratings`, `title.basics`). A Python script joins them
  into one small JSON file per show.
- **Frontend** is plain HTML + vanilla JS with Tailwind via CDN — no build step,
  no framework. It just fetches the prebuilt JSON.

```
index.html            dashboard shell
app.js                loads JSON, renders heatmap / tiles / table / chart
styles.css            theme tokens + heatmap/chart styles
data/
  series_urls.csv     curated show list (input) — "Name,ttXXXXXXX" per row
  series/             generated: index.json + one <imdbId>.json per show
scripts/build_data.py the data pipeline
downloads/            raw IMDb .tsv.gz (gitignored)
```

## 1. Build the data

Requires Python 3 (stdlib only — no pip installs).

```bash
python3 scripts/build_data.py            # downloads TSVs if missing, then builds
python3 scripts/build_data.py --refresh  # force re-download for fresh ratings
```

This writes `data/series/index.json` and `data/series/<imdbId>.json`. Re-run it
whenever you want fresh ratings; each file is stamped with `lastRefreshed`.

To add or remove shows, edit `data/series_urls.csv` (a `Series Name,ttXXXXXXX`
row per show — the `tt…` id is from the show's IMDb URL) and rebuild.

## 2. Run the site

The page fetches local JSON, so it must be served over HTTP — opening
`index.html` via `file://` will not load data.

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Pick a show from the search box; deep-link with `?show=tt0098904`.

## 3. Deploy

It is fully static — push the repo to any static host:

- **GitHub Pages:** enable Pages on the repo root (`/`).
- **Netlify / Vercel:** no build command; publish directory is the repo root.

Make sure `data/series/*.json` is committed (it is not gitignored; only
`downloads/` is).

## Data terms

IMDb data is provided for **personal and non-commercial use** per IMDb's
[dataset terms](https://www.imdb.com/interfaces/). This project is a personal tool.
