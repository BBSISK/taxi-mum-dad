/* How's the Driving? Sensor Lab: trace analysis (pure functions, no DOM).
 *
 * Trace format (times are ms since the drive started):
 *   gps:     [[t, lat, lon, speed_mps|null, heading_deg|null, accuracy_m], ...]
 *   motion:  [[t, ax, ay, az, gx, gy, gz, rot_dps], ...]   20 Hz; a = acceleration without gravity, g = gravity estimate
 *   touches: [t, ...]          screen touches while recording (the hold-to-stop button excluded)
 *   vis:     [[t, 'hidden'|'visible'], ...]
 *
 * Every threshold lives in DEFAULTS so test drives can tune them.
 * Works in the browser (window.HTDAnalysis) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    gpsMaxAccuracy: 30,       // m: fixes worse than this are ignored
    movingMps: 3,             // ~11 km/h: below this we're "parked", nothing counts
    brakeMps2: -3.0,          // ~0.3 g, GPS-derived deceleration
    accelMps2: 2.5,           // ~0.25 g, GPS-derived acceleration
    cornerMps2: 3.5,          // ~0.35 g sideways, from speed x turn rate
    motionMps2: 2.8,          // horizontal phone acceleration (0.5 s average) that counts as an event
    motionMinMs: 400,         // ...held this long
    motionWildMps2: 12,       // above this the phone itself moved (dropped, grabbed), not the car
    tiltDeg: 35,              // phone orientation change in 2 s while moving = picked up / moved
    mergeMs: 3000,            // events closer than this are one event
    overKmh: 4,               // km/h over the limit before it counts (GPS slack)
    overMinMs: 4000,          // ...for at least this long
    matchMeters: 25,          // GPS point to road distance for a speed-limit match
  };

  /* ------------------------------------------------------------------ geometry */
  const R = 6371000, rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
  function dist(a, b) {  // haversine, metres; a, b = [lat, lon]
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function bearing(a, b) {
    const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
    const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;  // signed, -180..180

  /* ------------------------------------------------------------------ GPS */
  function cleanGps(gps, o) {
    const out = [];
    for (const p of gps || []) {
      if (!p || p[5] == null || p[5] > o.gpsMaxAccuracy) continue;
      const prev = out[out.length - 1];
      if (prev && p[0] - prev[0] < 200) continue;  // duplicate burst
      if (prev) {  // teleport filter: > 70 m/s between fixes is a bad fix
        const dt = (p[0] - prev[0]) / 1000;
        if (dist([prev[1], prev[2]], [p[1], p[2]]) / dt > 70) continue;
      }
      out.push(p);
    }
    return out;
  }

  /* Speed (m/s), longitudinal and lateral acceleration per GPS point. */
  function kinematics(pts) {
    const n = pts.length, v = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const s = pts[i][3];
      if (s != null && s >= 0) v[i] = s;
      else if (i > 0) v[i] = dist([pts[i - 1][1], pts[i - 1][2]], [pts[i][1], pts[i][2]]) / Math.max(0.2, (pts[i][0] - pts[i - 1][0]) / 1000);
    }
    const vs = v.map((_, i) => {  // 3-point median kills single-fix spikes
      const w = [v[i - 1], v[i], v[i + 1]].filter(x => x != null).sort((a, b) => a - b);
      return w[Math.floor(w.length / 2)];
    });
    const head = pts.map((p, i) => {
      if (p[4] != null && vs[i] > 3) return p[4];
      const a = pts[i - 1], b = pts[i + 1];
      if (a && b && dist([a[1], a[2]], [b[1], b[2]]) > 8) return bearing([a[1], a[2]], [b[1], b[2]]);
      return null;
    });
    const lon = new Array(n).fill(null), lat = new Array(n).fill(null);
    for (let i = 1; i < n - 1; i++) {
      const dt = (pts[i + 1][0] - pts[i - 1][0]) / 1000;
      if (dt < 0.8 || dt > 5) continue;
      lon[i] = (vs[i + 1] - vs[i - 1]) / dt;
      if (head[i - 1] != null && head[i + 1] != null && vs[i] > 5) {
        lat[i] = vs[i] * rad(angleDiff(head[i - 1], head[i + 1])) / dt;
      }
    }
    return { v: vs, head, lon, lat };
  }

  /* Value of a per-GPS-point series at time t (nearest point within 2.5 s). */
  function atTime(pts, series, t) {
    let lo = 0, hi = pts.length - 1;
    if (hi < 0) return null;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m][0] < t) lo = m + 1; else hi = m; }
    let best = lo;
    if (lo > 0 && Math.abs(pts[lo - 1][0] - t) < Math.abs(pts[lo][0] - t)) best = lo - 1;
    return Math.abs(pts[best][0] - t) <= 2500 ? series[best] : null;
  }

  /* Runs where test(i) is true -> one event at the peak. */
  function runs(n, test, score) {
    const out = []; let cur = null;
    for (let i = 0; i < n; i++) {
      if (test(i)) {
        if (!cur) cur = { start: i, peak: i };
        if (score(i) > score(cur.peak)) cur.peak = i;
        cur.end = i;
      } else if (cur) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  function gpsEvents(pts, k, o) {
    const ev = [];
    const moving = i => k.v[i] > o.movingMps || (k.v[i - 1] || 0) > o.movingMps;
    for (const r of runs(pts.length, i => k.lon[i] != null && k.lon[i] <= o.brakeMps2 && moving(i), i => -k.lon[i]))
      ev.push({ t: pts[r.peak][0], type: 'brake', mps2: k.lon[r.peak], kmh: k.v[r.start] * 3.6, src: 'gps' });
    for (const r of runs(pts.length, i => k.lon[i] != null && k.lon[i] >= o.accelMps2, i => k.lon[i]))
      ev.push({ t: pts[r.peak][0], type: 'accel', mps2: k.lon[r.peak], kmh: k.v[r.peak] * 3.6, src: 'gps' });
    for (const r of runs(pts.length, i => k.lat[i] != null && Math.abs(k.lat[i]) >= o.cornerMps2, i => Math.abs(k.lat[i])))
      ev.push({ t: pts[r.peak][0], type: 'corner', mps2: Math.abs(k.lat[r.peak]), kmh: k.v[r.peak] * 3.6, src: 'gps' });
    return ev;
  }

  /* ------------------------------------------------------------------ motion */
  function motionSeries(motion) {
    // horizontal acceleration = the part of the phone's acceleration at right angles to gravity, whichever way up it is
    const h = [], g = [];
    for (const m of motion || []) {
      const gm = Math.hypot(m[4], m[5], m[6]) || 1;
      const gx = m[4] / gm, gy = m[5] / gm, gz = m[6] / gm;
      const along = m[1] * gx + m[2] * gy + m[3] * gz;
      const tot2 = m[1] * m[1] + m[2] * m[2] + m[3] * m[3];
      h.push(Math.sqrt(Math.max(0, tot2 - along * along)));
      g.push([gx, gy, gz]);
    }
    const sm = h.map((_, i) => {  // 0.5 s moving average (10 samples at 20 Hz)
      let s = 0, c = 0;
      for (let j = Math.max(0, i - 9); j <= i; j++) { s += h[j]; c++; }
      return s / c;
    });
    return { h: sm, g };
  }

  function motionEvents(motion, ms, pts, k, o) {
    const ev = [], handling = [];
    const n = (motion || []).length;
    const rs = runs(n, i => ms.h[i] >= o.motionMps2, i => ms.h[i]);
    for (const r of rs) {
      const t0 = motion[r.start][0], t1 = motion[r.end][0], t = motion[r.peak][0];
      if (t1 - t0 < o.motionMinMs) continue;
      const v = atTime(pts, k.v, t);
      if (v == null || v < o.movingMps) continue;
      if (ms.h[r.peak] >= o.motionWildMps2) { handling.push({ t, type: 'handling', how: 'phone jolted', src: 'motion' }); continue; }
      const lon = atTime(pts, k.lon, t), lat = atTime(pts, k.lat, t);
      let type = 'bump';
      if (lon != null && lon <= -1) type = 'brake';
      else if (lon != null && lon >= 1) type = 'accel';
      else if (lat != null && Math.abs(lat) >= 1.5) type = 'corner';
      ev.push({ t, type, mps2: ms.h[r.peak], kmh: v * 3.6, src: 'motion' });
    }
    // phone picked up / turned over: gravity direction swings more than tiltDeg within 2 s while moving
    let lastT = -1e9;
    for (let i = 40; i < n; i++) {
      const a = ms.g[i - 40], b = ms.g[i];
      const ang = deg(Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))));
      const t = motion[i][0];
      if (ang >= o.tiltDeg && t - lastT > 10000) {
        const v = atTime(pts, k.v, t);
        if (v != null && v >= o.movingMps) { handling.push({ t, type: 'handling', how: `phone tilted ${Math.round(ang)}°`, src: 'motion' }); lastT = t; }
      }
    }
    return { ev, handling };
  }

  /* Same type within mergeMs from both sources -> one event marked 'both'. */
  function mergeEvents(list, o) {
    const sorted = list.slice().sort((a, b) => a.t - b.t), out = [];
    for (const e of sorted) {
      const prev = [...out].reverse().find(x => x.type === e.type && e.t - x.t <= o.mergeMs);
      if (prev) {
        if (prev.src !== e.src) prev.src = 'both';
        if ((e.mps2 || 0) > (prev.mps2 || 0) && e.type !== 'brake') prev.mps2 = e.mps2;
        if (e.type === 'brake' && e.src === 'gps') prev.mps2 = e.mps2;
      } else out.push({ ...e });
    }
    return out;
  }

  /* ------------------------------------------------------------------ speed limits (OpenStreetMap) */
  function parseMaxspeed(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d+(?:\.\d+)?)\s*(mph)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return m[2] ? Math.round(n * 1.609) : n;
  }

  /* A simplified route for the Overpass query: points at least `spacing` m apart, at most maxPts. */
  function routeSample(pts, maxPts) {
    maxPts = maxPts || 250;
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += dist([pts[i - 1][1], pts[i - 1][2]], [pts[i][1], pts[i][2]]);
    const spacing = Math.max(80, total / maxPts);
    const out = []; let last = null;
    for (const p of pts) {
      if (!last || dist(last, [p[1], p[2]]) >= spacing) { last = [p[1], p[2]]; out.push(last); }
    }
    const end = pts[pts.length - 1];
    if (end && (!out.length || dist(out[out.length - 1], [end[1], end[2]]) > 20)) out.push([end[1], end[2]]);
    return out.slice(0, maxPts + 1);
  }

  function overpassQuery(sample, around) {
    const line = sample.map(p => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(',');
    return `[out:json][timeout:25];way(around:${around || 30},${line})["highway"];out tags geom;`;
  }

  /* Match each GPS point to the nearest road from the Overpass result. */
  function matchLimits(pts, k, overpass, o) {
    const segs = [];
    const cell = 0.002, grid = new Map();
    for (const w of (overpass && overpass.elements) || []) {
      if (w.type !== 'way' || !w.geometry) continue;
      const tags = w.tags || {};
      const info = { limit: parseMaxspeed(tags.maxspeed), name: tags.name || tags.ref || tags.highway, ref: tags.ref || '', oneway: tags.oneway === 'yes' };
      for (let i = 1; i < w.geometry.length; i++) {
        const a = w.geometry[i - 1], b = w.geometry[i];
        const s = { a: [a.lat, a.lon], b: [b.lat, b.lon], info, brg: bearing([a.lat, a.lon], [b.lat, b.lon]) };
        const idx = segs.push(s) - 1;
        const cx0 = Math.floor(Math.min(a.lat, b.lat) / cell), cx1 = Math.floor(Math.max(a.lat, b.lat) / cell);
        const cy0 = Math.floor(Math.min(a.lon, b.lon) / cell), cy1 = Math.floor(Math.max(a.lon, b.lon) / cell);
        for (let x = cx0; x <= cx1; x++) for (let y = cy0; y <= cy1; y++) {
          const key = x + ':' + y; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(idx);
        }
      }
    }
    function segDist(p, s) {  // point to segment, metres, flat-earth locally
      const kx = Math.cos(rad(p[0])) * 111320, ky = 110540;
      const ax = (s.a[1] - p[1]) * kx, ay = (s.a[0] - p[0]) * ky, bx = (s.b[1] - p[1]) * kx, by = (s.b[0] - p[0]) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let u = L ? -(ax * dx + ay * dy) / L : 0; u = Math.max(0, Math.min(1, u));
      return Math.hypot(ax + u * dx, ay + u * dy);
    }
    return pts.map((p, i) => {
      const x = Math.floor(p[1] / cell), y = Math.floor(p[2] / cell), seen = new Set();
      let best = null, bestScore = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const idx of grid.get((x + dx) + ':' + (y + dy)) || []) {
          if (seen.has(idx)) continue; seen.add(idx);
          const s = segs[idx], d = segDist([p[1], p[2]], s);
          if (d > o.matchMeters) continue;
          let score = d;
          const h = k.head[i];
          if (h != null) {  // prefer roads running the way we're driving
            const diff = Math.abs(angleDiff(h, s.brg));
            const along = Math.min(diff, 180 - diff);
            score += along > 35 ? 30 : along / 5;
          }
          if (score < bestScore) { bestScore = score; best = s; }
        }
      }
      return best ? { limit: best.info.limit, name: best.info.name } : null;
    });
  }

  function speedingRuns(pts, k, matched, o) {
    const n = pts.length, over = i => matched[i] && matched[i].limit && k.v[i] * 3.6 - matched[i].limit >= o.overKmh;
    const out = [];
    for (const r of runs(n, over, i => k.v[i] * 3.6 - matched[i].limit)) {
      const ms = pts[r.end][0] - pts[r.start][0];
      if (ms < o.overMinMs) continue;
      const m = matched[r.peak];
      out.push({ t: pts[r.peak][0], type: 'speeding', kmh: k.v[r.peak] * 3.6, limit: m.limit, over: k.v[r.peak] * 3.6 - m.limit, road: m.name, seconds: ms / 1000 });
    }
    return out;
  }

  /* ------------------------------------------------------------------ fun report */
  const LABELS = {
    brake: 'Squirrel Stop', accel: 'Kangaroo Start', corner: 'Mondello Moment', speeding: 'Lead Foot Levy',
    handling: 'Fiddle Fine', bump: 'Bump (not scored)',
  };
  function grade(score) {
    return score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 84 ? 'B+' : score >= 78 ? 'B' : score >= 70 ? 'C+' : score >= 60 ? 'C' : score >= 50 ? 'D' : 'E';
  }
  function funReport(sum) {
    const c = t => sum.events.filter(e => e.type === t).length;
    const brakes = c('brake'), accels = c('accel'), corners = c('corner'), fiddles = sum.handling.length, speeding = sum.speeding;
    let score = 100 - brakes * 4 - accels * 2 - corners * 3 - fiddles * 8;
    for (const s of speeding) score -= 5 + Math.floor(Math.max(0, s.over - 10) / 5);
    score = Math.max(0, score);
    const fines = [];
    if (brakes) fines.push({ label: LABELS.brake, n: brakes, pts: brakes * 4 });
    if (accels) fines.push({ label: LABELS.accel, n: accels, pts: accels * 2 });
    if (corners) fines.push({ label: LABELS.corner, n: corners, pts: corners * 3 });
    if (fiddles) fines.push({ label: LABELS.handling, n: fiddles, pts: fiddles * 8 });
    for (const s of speeding) fines.push({ label: LABELS.speeding, n: 1, pts: 5 + Math.floor(Math.max(0, s.over - 10) / 5), note: `${Math.round(s.kmh)} in a ${s.limit}${s.road ? ', ' + s.road : ''}` });
    const badges = [];
    if (!fiddles && sum.movingMin >= 3) badges.push('Zero Fiddles');
    if (!brakes && !accels && !corners && sum.movingMin >= 3) badges.push('Butter Mode');
    if (!speeding.length && sum.limitKnownPct >= 60 && sum.movingMin >= 3) badges.push('Limit Legend');
    if (sum.maxKmh < 55 && sum.movingMin >= 5) badges.push('Driving Miss Daisy');
    let comment;
    if (score >= 95) comment = 'Smooth as a Sunday mass. Nothing to report, which is the best report of all.';
    else if (speeding.length && brakes) comment = 'Heavy on the right foot, then heavy on the brake. Pick one, ideally neither.';
    else if (speeding.length) comment = `Must stop treating ${speeding[0].limit}s as a suggestion.`;
    else if (brakes >= 2) comment = 'Shows great promise. Brakes like a squirrel crossed the road.';
    else if (fiddles) comment = 'The phone can wait. The road cannot.';
    else if (corners) comment = 'Took a corner like it owed you money. Ease it in.';
    else comment = 'Good effort. A bit more butter and less kangaroo next time.';
    return { score, grade: grade(score), fines, badges, comment };
  }

  /* ------------------------------------------------------------------ main */
  function analyse(trace, overpass, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const pts = cleanGps(trace.gps, o);
    const k = kinematics(pts);
    let distM = 0, movingMs = 0, maxV = 0;
    for (let i = 1; i < pts.length; i++) {
      distM += dist([pts[i - 1][1], pts[i - 1][2]], [pts[i][1], pts[i][2]]);
      if (k.v[i] > o.movingMps) movingMs += Math.min(5000, pts[i][0] - pts[i - 1][0]);
      maxV = Math.max(maxV, k.v[i]);
    }
    const ms = motionSeries(trace.motion);
    const g = gpsEvents(pts, k, o);
    const m = motionEvents(trace.motion, ms, pts, k, o);
    const events = mergeEvents([...g, ...m.ev], o);  // 'bump' events are listed for tuning but never scored

    // touches and screen-off while moving count as handling
    const endT = trace.endedMs || (pts.length ? pts[pts.length - 1][0] : 0);
    const handling = [...m.handling];
    for (const t of trace.touches || []) {
      const v = atTime(pts, k.v, t);
      if (v != null && v >= o.movingMps && endT - t > 5000) handling.push({ t, type: 'handling', how: 'screen touched', src: 'touch' });
    }
    for (const [t, s] of trace.vis || []) {
      const v = atTime(pts, k.v, t);
      if (s === 'hidden' && v != null && v >= o.movingMps) handling.push({ t, type: 'handling', how: 'left the app / screen off', src: 'screen' });
    }
    const handlingMerged = [];
    for (const h of handling.sort((a, b) => a.t - b.t)) {
      const prev = handlingMerged[handlingMerged.length - 1];
      if (prev && h.t - prev.t < 10000) { if (!prev.how.includes(h.how)) prev.how += ' + ' + h.how; } else handlingMerged.push({ ...h });
    }

    let matched = null, speeding = [], limitKnownPct = 0, overPct = 0;
    if (overpass) {
      matched = matchLimits(pts, k, overpass, o);
      speeding = speedingRuns(pts, k, matched, o);
      let known = 0, over = 0, movingN = 0;
      for (let i = 0; i < pts.length; i++) {
        if (k.v[i] <= o.movingMps) continue;
        movingN++;
        if (matched[i] && matched[i].limit) { known++; if (k.v[i] * 3.6 - matched[i].limit >= o.overKmh) over++; }
      }
      limitKnownPct = movingN ? Math.round(100 * known / movingN) : 0;
      overPct = known ? Math.round(100 * over / known) : 0;
    }

    // sampling health
    const gi = []; for (let i = 1; i < (trace.gps || []).length; i++) gi.push(trace.gps[i][0] - trace.gps[i - 1][0]);
    gi.sort((a, b) => a - b);
    const accs = (trace.gps || []).map(p => p[5]).filter(x => x != null).sort((a, b) => a - b);
    const mo = trace.motion || [];
    const motionHz = mo.length > 1 ? Math.round(10 * (mo.length - 1) / ((mo[mo.length - 1][0] - mo[0][0]) / 1000)) / 10 : 0;
    let gaps = 0; for (let i = 1; i < mo.length; i++) if (mo[i][0] - mo[i - 1][0] > 2000) gaps++;

    const sum = {
      minutes: Math.round(endT / 6000) / 10,
      movingMin: Math.round(movingMs / 6000) / 10,
      km: Math.round(distM / 100) / 10,
      avgKmh: movingMs ? Math.round(distM / (movingMs / 1000) * 3.6) : 0,
      maxKmh: Math.round(maxV * 3.6),
      events, handling: handlingMerged, speeding, limitKnownPct, overPct,
      health: {
        gpsFixes: (trace.gps || []).length, gpsUsed: pts.length,
        gpsMedianGapS: gi.length ? Math.round(gi[gi.length >> 1] / 100) / 10 : null,
        gpsMedianAccM: accs.length ? Math.round(accs[accs.length >> 1]) : null,
        motionSamples: mo.length, motionHz, motionGaps: gaps, motionSource: trace.motionSource || 'none',
        touches: (trace.touches || []).length, hidden: (trace.vis || []).filter(v => v[1] === 'hidden').length,
      },
      series: { t: pts.map(p => p[0]), kmh: k.v.map(v => v * 3.6), limit: matched ? matched.map(x => (x && x.limit) || null) : null },
    };
    sum.fun = funReport(sum);
    return sum;
  }

  const api = { DEFAULTS, LABELS, analyse, routeSample, overpassQuery, parseMaxspeed, matchLimits, dist, bearing, funReport };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HTDAnalysis = api;
})(typeof window !== 'undefined' ? window : this);
