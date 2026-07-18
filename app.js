'use strict';

const DATA_DIR = 'data/series';
const state = { index: [], byName: new Map(), current: null };

/* ---------- utilities ---------- */

function fmtVotes(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'K';
  return String(n);
}

function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

// Parse "#rrggbb" -> [r,g,b]
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  return [Math.round(lerp(c1[0], c2[0], t)), Math.round(lerp(c1[1], c2[1], t)), Math.round(lerp(c1[2], c2[2], t))];
}
function rgbStr(c) { return `rgb(${c[0]},${c[1]},${c[2]})`; }

// Relative luminance -> choose readable text color for a cell background.
function textOn(rgb) {
  const [r, g, b] = rgb.map(v => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * r + 0.7152 * g + 0.4152 * b;
  return L > 0.5 ? '#0b0b0b' : '#ffffff';
}

/* Diverging color scale centered on the show's mean rating.
   below mean -> warm (div-low), at mean -> neutral, above -> cool (div-high). */
function makeColorScale(mean, spread) {
  const low = hexToRgb(cssVar('--div-low'));
  const mid = hexToRgb(cssVar('--div-mid'));
  const high = hexToRgb(cssVar('--div-high'));
  const half = Math.max(spread, 0.5); // avoid div-by-zero / flat shows
  return function (rating) {
    let t = (rating - mean) / half;         // -1..+1 (clamped)
    t = Math.max(-1, Math.min(1, t));
    return t < 0 ? mix(mid, low, -t) : mix(mid, high, t);
  };
}

/* ---------- data loading ---------- */

async function loadIndex() {
  const res = await fetch(`${DATA_DIR}/index.json`);
  const data = await res.json();
  state.index = data.series;
  const dl = document.getElementById('show-list');
  dl.innerHTML = '';
  for (const s of state.index) {
    state.byName.set(s.name.toLowerCase(), s);
    const opt = document.createElement('option');
    opt.value = s.name;
    dl.appendChild(opt);
  }
  document.getElementById('last-refreshed').textContent = `Last refreshed ${data.lastRefreshed}`;
}

async function loadShow(imdbId) {
  const res = await fetch(`${DATA_DIR}/${imdbId}.json`);
  const show = await res.json();
  state.current = show;
  document.getElementById('show-input').value = show.name;
  const url = new URL(location.href);
  url.searchParams.set('show', imdbId);
  history.replaceState(null, '', url);
  render(show);
}

/* ---------- rendering ---------- */

function render(show) {
  renderKPIs(show);
  renderHeatmap(show);
  renderTopEpisodes(show);
  renderSeasonChart(show);
}

function kpiTile(label, value, sub) {
  return `<div class="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm">
      <div class="text-2xl sm:text-3xl font-bold tracking-tight">${value}</div>
      <div class="text-xs text-[var(--text-secondary)] mt-1">${label}</div>
      ${sub ? `<div class="text-[11px] text-[var(--muted)] mt-0.5">${sub}</div>` : ''}
    </div>`;
}

function renderKPIs(show) {
  const el = document.getElementById('kpis');
  el.innerHTML = [
    kpiTile('Avg. Rating', show.avgRating.toFixed(1),
      show.imdbSeriesRating != null ? `IMDb series: ${show.imdbSeriesRating.toFixed(1)}` : ''),
    kpiTile('Total Episodes', show.totalEpisodes),
    kpiTile('Total Seasons', show.totalSeasons),
    kpiTile('Total Votes', fmtVotes(show.totalVotes)),
  ].join('');
}

function renderHeatmap(show) {
  const eps = show.episodes;
  const seasons = [...new Set(eps.map(e => e.season))].sort((a, b) => a - b);
  const maxEp = Math.max(...eps.map(e => e.episode));
  const grid = new Map(); // "s:e" -> episode
  for (const e of eps) grid.set(`${e.season}:${e.episode}`, e);

  const mean = show.avgRating;
  const spread = Math.max(...eps.map(e => Math.abs(e.rating - mean)));
  const color = makeColorScale(mean, spread);

  const hm = document.getElementById('heatmap');
  hm.style.gridTemplateColumns = `36px repeat(${seasons.length}, minmax(38px, 1fr))`;

  const parts = [];
  parts.push(`<div class="hm-corner"></div>`);
  for (const s of seasons) parts.push(`<div class="hm-col-head" title="Season ${s}">${s}</div>`);

  for (let ep = 1; ep <= maxEp; ep++) {
    parts.push(`<div class="hm-row-head">${ep}</div>`);
    for (const s of seasons) {
      const e = grid.get(`${s}:${ep}`);
      if (!e) { parts.push(`<div class="hm-cell hm-empty"></div>`); continue; }
      const bg = color(e.rating);
      const fg = textOn(bg);
      parts.push(
        `<div class="hm-cell" style="background:${rgbStr(bg)};color:${fg}"
           data-tip="S${e.season}E${e.episode} · ${escapeHtml(e.title)}||★ ${e.rating.toFixed(1)} · ${fmtVotes(e.votes)} votes">${e.rating.toFixed(1)}</div>`
      );
    }
  }
  hm.innerHTML = parts.join('');
  attachTooltips(hm);

  document.getElementById('legend').innerHTML =
    `<span>Below avg</span><span class="legend-bar"></span><span>Above avg</span>`;
}

function renderTopEpisodes(show) {
  const rows = [...show.episodes].sort((a, b) => b.rating - a.rating || b.votes - a.votes);
  const tb = document.getElementById('top-episodes');
  tb.innerHTML = rows.map(e => {
    const pct = (e.rating / 10) * 100;
    return `<tr class="border-b border-[var(--border)] last:border-0">
        <td class="py-1.5 pr-2 text-[var(--text-secondary)] tabular-nums whitespace-nowrap">S${e.season}·E${e.episode}</td>
        <td class="py-1.5 pr-2">${escapeHtml(e.title)}</td>
        <td class="py-1.5 pl-2 w-24">
          <div class="rating-bar-track"><div class="rating-bar-fill" style="width:${pct}%"></div>
            <div class="rating-bar-val">${e.rating.toFixed(1)}</div></div>
        </td>
      </tr>`;
  }).join('');
}

function renderSeasonChart(show) {
  const seasons = [...new Set(show.episodes.map(e => e.season))].sort((a, b) => a - b);
  const means = seasons.map(s => {
    const es = show.episodes.filter(e => e.season === s);
    return es.reduce((a, e) => a + e.rating, 0) / es.length;
  });

  const W = 460, H = 240, m = { t: 16, r: 14, b: 28, l: 30 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const lo = Math.floor(Math.min(...means) * 2) / 2 - 0.25;
  const hi = Math.ceil(Math.max(...means) * 2) / 2 + 0.25;
  const x = i => m.l + (seasons.length === 1 ? iw / 2 : (i / (seasons.length - 1)) * iw);
  const y = v => m.t + ih - ((v - lo) / (hi - lo)) * ih;

  const ticks = [];
  for (let v = Math.ceil(lo * 2) / 2; v <= hi; v += 0.5) ticks.push(v);

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="w-full h-auto" role="img" aria-label="Average rating by season">`;
  for (const t of ticks) {
    svg += `<line class="sc-grid" x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/>`;
    svg += `<text class="sc-axis-text" x="${m.l - 6}" y="${y(t) + 3}" text-anchor="end">${t.toFixed(1)}</text>`;
  }
  const pts = means.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  svg += `<polyline class="sc-line" points="${pts}"/>`;
  means.forEach((v, i) => {
    svg += `<circle class="sc-dot" cx="${x(i)}" cy="${y(v)}" r="4"
        data-tip="Season ${seasons[i]}||Avg ★ ${v.toFixed(2)}"/>`;
    svg += `<text class="sc-val-text" x="${x(i)}" y="${y(v) - 9}" text-anchor="middle">${v.toFixed(1)}</text>`;
    svg += `<text class="sc-axis-text" x="${x(i)}" y="${H - 8}" text-anchor="middle">${seasons[i]}</text>`;
  });
  svg += `</svg>`;
  const el = document.getElementById('season-chart');
  el.innerHTML = svg;
  attachTooltips(el);
}

/* ---------- tooltip ---------- */

function attachTooltips(root) {
  const tip = document.getElementById('tooltip');
  root.querySelectorAll('[data-tip]').forEach(node => {
    node.addEventListener('mouseenter', e => {
      const [title, sub] = node.getAttribute('data-tip').split('||');
      tip.innerHTML = `<div class="font-semibold">${title}</div>${sub ? `<div class="text-white/70 mt-0.5">${sub}</div>` : ''}`;
      tip.classList.remove('hidden');
      moveTip(e);
    });
    node.addEventListener('mousemove', moveTip);
    node.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  });
  function moveTip(e) {
    const pad = 14;
    let left = e.clientX + pad, top = e.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (left + r.width > window.innerWidth) left = e.clientX - r.width - pad;
    if (top + r.height > window.innerHeight) top = e.clientY - r.height - pad;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- theme toggle ---------- */

function initTheme() {
  const root = document.body; // .viz-root
  const saved = localStorage.getItem('theme');
  if (saved) root.setAttribute('data-theme', saved);
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const isDark = root.getAttribute('data-theme') === 'dark' ||
      (!root.hasAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    if (state.current) render(state.current); // recompute colors from new tokens
  });
}

/* ---------- init ---------- */

async function init() {
  initTheme();
  await loadIndex();

  const input = document.getElementById('show-input');
  // Native datalist filters its options against the field's current text, so a
  // pre-filled value hides every other show. Clear on focus to reveal the full
  // list; restore the current show if the user clicks away without picking one.
  input.addEventListener('focus', () => { input.value = ''; });
  input.addEventListener('blur', () => {
    if (!state.byName.get(input.value.trim().toLowerCase()) && state.current) {
      input.value = state.current.name;
    }
  });
  input.addEventListener('change', e => {
    const s = state.byName.get(e.target.value.trim().toLowerCase());
    if (s) { loadShow(s.imdbId); input.blur(); }
  });

  const wanted = new URL(location.href).searchParams.get('show');
  const start = state.index.find(s => s.imdbId === wanted)
    || state.byName.get('seinfeld')
    || state.index[0];
  if (start) await loadShow(start.imdbId);
}

init();
