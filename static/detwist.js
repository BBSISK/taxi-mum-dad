/* DeTwist: one untangling puzzle a day for the passengers.
 *
 *   TaxiDetwist.open({ players: [{type, id, name, emoji}], onClose })
 *
 * The server hands out today's board (GET /api/detwist/today) and checks every finished game by replaying its
 * moves (POST /api/detwist/result). Drag one end of a band to an empty pin within reach. A band that is free
 * pops and gives its pins back. Clear them all in as few moves as you can. The rules below mirror
 * detwist/rules.py; the solver here only powers the Hint button.
 */
(function () {
  'use strict';
  const QUEUE_KEY = 'taxi.detwist.queue';
  const BOARD_KEY = 'taxi.detwist.board';
  const NS = 'http://www.w3.org/2000/svg';
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyOf = p => (p.type === 'kid' ? 'k' : 'p') + p.id;
  const colour = id => `var(--b${(id % 10) + 1})`;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  let st = null;
  let STEP = 0;   // how many pins an end may slide round the rim (0 = anywhere)
  let PTS = [];   // pin positions in the 400 x 400 board

  /* ------------------------------------------------------------ rules (same as detwist/rules.py) */
  const between = (x, a, b) => x > Math.min(a, b) && x < Math.max(a, b);
  const cross = (p, q) => between(q.a, p.a, p.b) !== between(q.b, p.a, p.b);
  const circ = (a, b, P) => { const d = Math.abs(a - b); return Math.min(d, P - d); };
  function decodeRel(n, bits) {
    if (!bits) return null;
    const rel = Array.from({ length: n }, () => Array(n).fill(false));
    let k = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const o = bits[k++] === '1'; rel[i][j] = o; rel[j][i] = !o; }
    return rel;
  }
  function tally(bands, rel) {
    const m = bands.length, cr = Array(m).fill(0), ov = Array(m).fill(0);
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) if (cross(bands[i], bands[j])) {
      cr[i]++; cr[j]++;
      if (rel) { if (rel[bands[i].id][bands[j].id]) ov[i]++; else ov[j]++; }
    }
    return { cr, ov };
  }
  function freeFlags(bands, rel) {
    const t = tally(bands, rel);
    return bands.map((_, i) => t.cr[i] === 0 || !!(rel && t.ov[i] === t.cr[i]));
  }
  function cascade(bands, rel) {
    let cur = bands;
    for (;;) {
      const f = freeFlags(cur, rel);
      if (!f.some(Boolean)) return cur;
      cur = cur.filter((_, i) => !f[i]);
      if (!cur.length) return cur;
    }
  }
  const crossTotal = bands => { let t = 0; for (let i = 0; i < bands.length; i++) for (let j = i + 1; j < bands.length; j++) if (cross(bands[i], bands[j])) t++; return t; };
  function weave(bands, rel) {
    const t = tally(bands, rel); let s = 0;
    for (let i = 0; i < bands.length; i++) s += Math.min(t.ov[i], t.cr[i] - t.ov[i]);
    return s;
  }
  const starsFor = (moves, par, hints) => {
    const slack = Math.max(2, Math.round(par * 0.3));
    const s = moves <= par ? 3 : moves <= par + slack ? 2 : 1;
    return hints ? Math.min(s, 2) : s;
  };

  /* Beam search for a short way to clear the board (powers the Hint button). */
  function solve(bands, P, rel, maxDepth = 16, width = 250) {
    const start = cascade(bands, rel);
    if (!start.length) return [];
    let level = [{ bands: start, path: [] }];
    for (let depth = 1; depth <= maxDepth; depth++) {
      const next = new Map();
      for (const s of level) {
        const occ = new Set();
        s.bands.forEach(b => { occ.add(b.a); occ.add(b.b); });
        const empties = [];
        for (let p = 0; p < P; p++) if (!occ.has(p)) empties.push(p);
        for (let bi = 0; bi < s.bands.length; bi++) for (const end of ['a', 'b']) for (const to of empties) {
          if (STEP && circ(to, s.bands[bi][end], P) > STEP) continue;
          const nb = s.bands.map((b, i) => (i === bi ? { ...b, [end]: to } : b));
          const alive = cascade(nb, rel);
          const move = { id: s.bands[bi].id, end, to };
          if (!alive.length) return [...s.path, move];
          const key = alive.map(b => `${rel ? b.id + ':' : ''}${Math.min(b.a, b.b)}-${Math.max(b.a, b.b)}`).sort().join('|');
          if (!next.has(key)) next.set(key, { bands: alive, path: [...s.path, move], score: alive.length * 100 + (rel ? weave(alive, rel) : crossTotal(alive)) });
        }
      }
      level = [...next.values()].sort((x, y) => x.score - y.score).slice(0, width);
      if (!level.length) return null;
    }
    return null;
  }

  /* ------------------------------------------------------------ server */
  async function postResult(body) {
    const res = await fetch('/api/detwist/result', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    if ([400, 404, 410, 422, 503].includes(res.status)) { const e = new Error('rejected'); e.rejected = true; throw e; }
    throw new Error('save failed');
  }
  async function flushQueue() {
    const q = LS.get(QUEUE_KEY, []);
    if (!q.length) return;
    const left = [];
    for (const b of q) {
      try { await postResult(b); } catch (e) { if (!e.rejected) left.push(b); }
    }
    LS.set(QUEUE_KEY, left);
  }
  async function load() {
    try {
      await flushQueue();
      const res = await fetch('/api/detwist/today', { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      setToday(await res.json());
      LS.set(BOARD_KEY, st.data);
    } catch {
      const saved = LS.get(BOARD_KEY, null);   // no signal: today's board saved on this phone still works
      if (saved && Date.parse(saved.ends_at) > Date.now()) { saved.offline = true; setToday(saved); } else st.error = true;
    }
    if (st) render();
  }
  function setToday(d) {
    st.data = d;
    st.board = d.board;
    st.rel = decodeRel(d.board.n, d.board.rel);
    st.ends = Date.parse(d.ends_at);
    STEP = d.board.step || 0;
    PTS = Array.from({ length: d.board.P }, (_, i) => {
      const ang = -Math.PI / 2 + (i * 2 * Math.PI) / d.board.P;
      return { x: 200 + 160 * Math.cos(ang), y: 200 + 160 * Math.sin(ang) };
    });
  }

  /* ------------------------------------------------------------ game */
  const alive = () => st.game.bands.filter(b => b.alive);
  function newGame(player, counted) {
    STEP = st.board.step || 0;
    st.player = player;
    st.game = { counted, bands: st.board.pins.map(([a, b], i) => ({ id: i, a, b, alive: true })), log: [], undo: [], hints: 0,
      drag: null, hint: null, started: 0, won: false, busy: false, result: null, reply: null, saving: false };
    st.screen = 'play';
    render();
  }
  function endPos(b, end) {
    const d = st.game.drag;
    return d && d.id === b.id && d.end === end ? d.pos : PTS[b[end]];
  }
  const reach = (q, origin) => !STEP || circ(q, origin, st.board.P) <= STEP;
  function occupiedExcept(skipId, skipEnd) {
    const occ = {};
    alive().forEach(b => {
      if (b.id === skipId && skipEnd === 'a') { occ[b.b] = 1; return; }
      if (b.id === skipId && skipEnd === 'b') { occ[b.a] = 1; return; }
      occ[b.a] = 1; occ[b.b] = 1;
    });
    return occ;
  }
  function segInt(p1, p2, p3, p4) {
    const rx = p2.x - p1.x, ry = p2.y - p1.y, sx = p4.x - p3.x, sy = p4.y - p3.y, d = rx * sy - ry * sx;
    if (Math.abs(d) < 1e-9) return null;
    const t = ((p3.x - p1.x) * sy - (p3.y - p1.y) * sx) / d, u = ((p3.x - p1.x) * ry - (p3.y - p1.y) * rx) / d;
    if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) return { x: p1.x + t * rx, y: p1.y + t * ry, t, u, sin: Math.abs(d) / (Math.hypot(rx, ry) * Math.hypot(sx, sy)) };
    return null;
  }
  function pieces(g) {   // the visible parts of a band once the gaps where it passes under others are cut out
    const len = dist(g.p1, g.p2) || 1;
    const iv = g.gaps.map(x => [x.t - x.half / len, x.t + x.half / len]).sort((a, b) => a[0] - b[0]);
    const out = []; let cur = 0;
    for (const v of iv) { if (v[0] > cur) out.push([cur, v[0]]); cur = Math.max(cur, v[1]); }
    if (cur < 1) out.push([cur, 1]);
    return out.filter(s => (s[1] - s[0]) * len > 1.5);
  }
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const grp = id => document.getElementById('dt-' + id);

  function paint() {
    const G = st.game;
    if (!G || !grp('bands')) return;
    ['shadow', 'bands', 'dots', 'handles', 'targets'].forEach(g => { grp(g).textContent = ''; });
    const rel = st.rel, bands = alive(), dragId = G.drag ? G.drag.id : -1;
    const ordered = [...bands.filter(b => b.id !== dragId), ...bands.filter(b => b.id === dragId)];

    const freeIds = new Set();   // bands that would pop if the dragged end were dropped on its current target
    if (G.drag && G.drag.target != null) {
      const tmp = bands.map(b => (b.id === G.drag.id ? { ...b, [G.drag.end]: G.drag.target } : b));
      const ff = freeFlags(tmp, rel);
      tmp.forEach((b, i) => { if (ff[i]) freeIds.add(b.id); });
    }

    const geo = ordered.map(b => ({ b, p1: endPos(b, 'a'), p2: endPos(b, 'b'), gaps: [] }));
    for (let i = 0; i < geo.length; i++) for (let j = i + 1; j < geo.length; j++) {
      const gi = geo[i], gj = geo[j], hit = segInt(gi.p1, gi.p2, gj.p1, gj.p2);
      if (!hit) continue;
      if (rel) {
        const half = Math.min(34, 6 / Math.max(hit.sin, 0.3) + 2.2);
        if (rel[gi.b.id][gj.b.id]) gj.gaps.push({ t: hit.u, half }); else gi.gaps.push({ t: hit.t, half });
      } else el('circle', { cx: hit.x, cy: hit.y, r: 3.4, fill: 'var(--dot)', style: 'stroke:var(--felt)', 'stroke-width': 1.2 }, grp('dots'));
    }
    geo.forEach(g => {
      const dx = g.p2.x - g.p1.x, dy = g.p2.y - g.p1.y, isDrag = g.b.id === dragId;
      for (const s of pieces(g)) {
        const x1 = g.p1.x + dx * s[0], y1 = g.p1.y + dy * s[0], x2 = g.p1.x + dx * s[1], y2 = g.p1.y + dy * s[1];
        el('line', { x1: x1 + 2, y1: y1 + 3, x2: x2 + 2, y2: y2 + 3, style: 'stroke:var(--shadow)', 'stroke-width': 8, opacity: 0.5 }, grp('shadow'));
        el('line', { x1, y1, x2, y2, class: 'dt-band' + (freeIds.has(g.b.id) ? ' free' : ''), style: 'stroke:' + colour(g.b.id), 'stroke-width': isDrag ? 6 : 5 }, grp('bands'));
      }
    });
    ordered.forEach(b => ['a', 'b'].forEach(end => {
      const p = endPos(b, end), isDrag = G.drag && G.drag.id === b.id && G.drag.end === end;
      el('circle', { cx: p.x, cy: p.y, r: isDrag ? 12 : 9.5, style: `fill:${colour(b.id)};stroke:var(--dot)`, 'stroke-width': 1.6 }, grp('handles'));
      el('circle', { cx: p.x, cy: p.y, r: 3.4, fill: 'var(--pin)', style: 'stroke:var(--shadow)', 'stroke-width': 0.8 }, grp('handles'));
    }));

    if (G.drag) {
      const occ = occupiedExcept(G.drag.id, G.drag.end);
      PTS.forEach((p, q) => {
        if (occ[q] || !reach(q, G.drag.origin)) return;
        const on = G.drag.target === q;
        el('circle', { cx: p.x, cy: p.y, r: on ? 15 : 9, fill: 'none', style: 'stroke:var(--pin-hi)', 'stroke-width': on ? 3 : 1.5, opacity: on ? 1 : 0.45, 'stroke-dasharray': on ? '' : '2 3' }, grp('targets'));
      });
    } else if (G.hint) {
      const hb = G.bands.find(b => b.id === G.hint.id);
      if (hb && hb.alive) {
        const hp = PTS[hb[G.hint.end]], tp = PTS[G.hint.to];
        el('circle', { cx: hp.x, cy: hp.y, r: 17, class: 'dt-pulse' }, grp('targets'));
        el('circle', { cx: tp.x, cy: tp.y, r: 15, class: 'dt-pulse' }, grp('targets'));
        el('line', { x1: hp.x, y1: hp.y, x2: tp.x, y2: tp.y, style: 'stroke:var(--pin-hi)', 'stroke-width': 2, 'stroke-dasharray': '3 6', opacity: 0.6 }, grp('targets'));
      }
    }
  }

  function hud() {
    const G = st.game;
    if (!G || !document.getElementById('dt-moves')) return;
    const left = alive().length, mv = document.getElementById('dt-moves');
    mv.textContent = G.log.length;
    mv.className = G.log.length > st.board.par ? 'over' : '';
    document.getElementById('dt-left').innerHTML = `${left} <small>/ ${st.board.n}</small>`;
    document.getElementById('dt-undo').disabled = !G.undo.length || G.busy;
    document.getElementById('dt-hint').disabled = G.won || G.busy;
    document.getElementById('dt-hint').textContent = G.hints ? `💡 Hint (${G.hints})` : '💡 Hint';
  }

  /* ------------------------------------------------------------ input */
  function toSvg(e) {
    const r = document.getElementById('dt-svg').getBoundingClientRect(), s = 400 / r.width;
    return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s };
  }
  function onDown(e) {
    const G = st && st.game;
    if (!G || G.drag || G.busy || G.won) return;
    const pos = toSvg(e);
    let best = null, bd = 30;
    alive().forEach(b => ['a', 'b'].forEach(end => { const d = dist(pos, PTS[b[end]]); if (d < bd) { bd = d; best = { id: b.id, end }; } }));
    if (!best) return;
    e.preventDefault();
    try { document.getElementById('dt-svg').setPointerCapture(e.pointerId); } catch { /* ignore */ }
    clearHint();
    if (!G.started) G.started = Date.now();
    const origin = G.bands.find(b => b.id === best.id)[best.end];
    G.drag = { id: best.id, end: best.end, pos: PTS[origin], origin, target: origin };
    paint();
  }
  function onMove(e) {
    const G = st && st.game;
    if (!G || !G.drag) return;
    G.drag.pos = toSvg(e);
    const occ = occupiedExcept(G.drag.id, G.drag.end);
    let bt = null, bd = 36;
    PTS.forEach((p, q) => { if (occ[q] || !reach(q, G.drag.origin)) return; const d = dist(G.drag.pos, p); if (d < bd) { bd = d; bt = q; } });
    G.drag.target = bt;
    if (!st.raf) st.raf = requestAnimationFrame(() => { st.raf = 0; if (st && st.game && st.game.drag) paint(); });
  }
  function onUp() {
    const G = st && st.game;
    if (!G || !G.drag) return;
    const d = G.drag;
    G.drag = null;
    if (d.target != null && d.target !== d.origin) applyMove(d.id, d.end, d.target);
    paint(); hud();
  }
  function onCancel() { if (st && st.game) { st.game.drag = null; paint(); } }

  function applyMove(id, end, to) {
    const G = st.game;
    G.undo.push({ bands: G.bands.map(b => ({ ...b })), log: G.log.slice() });
    G.bands.find(b => b.id === id)[end] = to;
    G.log.push({ id, end, to });
    let wave = 0, total = 0;   // freed bands pop in waves: removing one can free the next
    for (;;) {
      const live = alive(), ff = freeFlags(live, st.rel);
      let any = false;
      live.forEach((b, i) => { if (ff[i]) { b.alive = false; any = true; total++; ghost(b, wave * 0.28); } });
      if (!any) break;
      wave++;
    }
    if (total && navigator.vibrate) { try { navigator.vibrate(total > 1 ? [18, 40, 18] : 18); } catch { /* ignore */ } }
    const span = Math.max(0, wave - 1) * 280;
    clearTimeout(st.ghostTimer);
    st.ghostTimer = setTimeout(() => { const g = grp('ghosts'); if (g) g.textContent = ''; }, span + 700);
    if (!alive().length) {
      G.won = true; G.busy = true;
      setTimeout(() => { if (st && st.game === G) { G.busy = false; finish(); } }, span + 750);
    }
  }
  function ghost(b, delay) {
    const g = grp('ghosts');
    if (!g) return;
    const p1 = PTS[b.a], p2 = PTS[b.b], d = `animation-delay:${delay}s;`;
    el('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, pathLength: 1, class: 'dt-ghost', style: d + 'stroke:' + colour(b.id), 'stroke-width': 5 }, g);
    el('circle', { cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2, r: 16, class: 'dt-burst', style: d + 'stroke:' + colour(b.id) }, g);
  }
  function clearHint() { const G = st.game; if (G && G.hint) G.hint = null; clearTimeout(st.hintTimer); }

  function undo() {
    const G = st.game;
    if (!G || !G.undo.length || G.busy) return;
    const s = G.undo.pop();
    G.bands = s.bands; G.log = s.log; G.won = false;
    clearHint(); paint(); hud();
  }
  function reset() { newGame(st.player, st.game ? st.game.counted : false); }
  function hint() {
    const G = st.game;
    if (!G || G.won || G.drag) return;
    const sol = solve(alive().map(b => ({ id: b.id, a: b.a, b: b.b })), st.board.P, st.rel);
    if (!sol || !sol.length) return;
    G.hints++; G.hint = sol[0];
    paint(); hud();
    clearTimeout(st.hintTimer);
    st.hintTimer = setTimeout(() => { if (st && st.game === G) { G.hint = null; if (!G.drag) paint(); } }, 3500);
  }

  async function finish() {
    const G = st.game, moves = G.log.length;
    const secs = G.started ? Math.min(86400, Math.round((Date.now() - G.started) / 1000)) : 0;
    G.result = { moves, par: st.board.par, hints: G.hints, secs, stars: starsFor(moves, st.board.par, G.hints) };
    st.screen = 'done';
    if (G.counted) {
      G.saving = true;
      render();
      const body = { day: st.data.day, player: { type: st.player.type, id: st.player.id }, moves: G.log, secs, hints: G.hints };
      try {
        const r = await postResult(body);
        if (st && st.game === G) {
          G.reply = r; G.result = r.result; G.saving = false;
          st.data.played[r.key] = r.result; st.data.family = r.family; st.data.everyone = r.everyone; st.data.streaks = r.streaks;
          LS.set(BOARD_KEY, st.data);
        }
      } catch (e) {
        if (!e.rejected) { LS.set(QUEUE_KEY, [...LS.get(QUEUE_KEY, []), body]); G.queued = true; } else G.notSaved = true;
        if (st && st.game === G) G.saving = false;
        if (G.queued && st) { st.data.played[keyOf(st.player)] = G.result; }
      }
    }
    if (st && st.game === G) render();
  }

  /* ------------------------------------------------------------ view */
  const fmtSecs = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const starsHtml = n => `<span class="dt-stars" aria-label="${n} of 3 stars">${[1, 2, 3].map(i => `<span class="${i <= n ? 'on' : ''}">★</span>`).join('')}</span>`;
  const countdown = () => {
    const s = Math.max(0, Math.floor((st.ends - Date.now()) / 1000));
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(x => String(x).padStart(2, '0')).join(':');
  };
  function howText() {
    const b = st.board, reachTxt = `Each band end can slide up to ${b.step} pins along the rim, to an empty pin.`;
    return b.layers
      ? `Drag one end of a band. ${reachTxt} A band breaks where it passes under another, and it pops free only when it lies over everything it crosses.`
      : `Drag one end of a band. ${reachTxt} A band that crosses nothing pops free and gives its pins back.`;
  }
  const familyBoard = () => (st.data.family || []).length
    ? `<h3 class="dt-h">Today in the family</h3><ol class="dt-board-list">${st.data.family.map((r, i) => `<li><span>${i === 0 ? '👑 ' : ''}${esc(r.emoji)} ${esc(r.name)}</span>
        ${starsHtml(r.stars)}<b>${r.moves} moves</b><span class="dt-time">${fmtSecs(r.secs)}${r.hints ? ` · ${r.hints}💡` : ''}</span></li>`).join('')}</ol>` : '';
  const everyoneLine = (e, mine) => {
    if (!e || !e.total) return '';
    if (mine && mine.rank) return `<p class="dt-rank">Rank <b>${mine.rank}</b> of ${e.total} player${e.total === 1 ? '' : 's'} today${mine.beat_pct != null ? ` · beat ${mine.beat_pct}% of them` : ''}</p>`;
    return `<p class="dt-rank">${e.total} player${e.total === 1 ? '' : 's'} have finished today's board${e.top && e.top[0] ? ` · best so far ${e.top[0].moves} moves` : ''}</p>`;
  };

  function renderPick() {
    const d = st.data, played = d.played || {};
    return `<p class="bg-lead">One puzzle a day, the same board for everyone. <b>Passengers only</b>: drivers, eyes on the road.</p>
      <div class="bg-whobtns">${st.players.map(p => {
        const r = played[keyOf(p)];
        return `<button class="bg-who" data-d="who" data-key="${keyOf(p)}">${esc(p.emoji)} ${esc(p.name)}${r ? `<small class="dt-done">${starsHtml(r.stars)} ${r.moves} moves</small>` : '<small class="dt-done">Not played yet</small>'}</button>`;
      }).join('')}</div>
      ${d.streaks && Object.values(d.streaks).some(n => n > 1) ? `<p class="bg-small">🔥 ${st.players.filter(p => (d.streaks[keyOf(p)] || 0) > 1).map(p => `${esc(p.name)} ${d.streaks[keyOf(p)]} days`).join(' · ')}</p>` : ''}
      ${familyBoard()}${everyoneLine(d.everyone)}
      ${d.offline ? '<p class="bg-warn">No signal. Playing the board saved on this phone. Scores are sent when you are back online.</p>' : ''}
      <p class="bg-small">Next board in <b id="dt-count">${countdown()}</b></p>`;
  }

  function renderPlay() {
    const G = st.game, b = st.board;
    return `<div class="dt-stats"><div><label>Moves</label><output id="dt-moves">${G.log.length}</output></div>
        <div><label>Par</label><output>${b.par}</output></div>
        <div><label>Bands left</label><output id="dt-left"></output></div></div>
      <div class="dt-boardwrap"><svg id="dt-svg" viewBox="0 0 400 400" role="img" aria-label="Circular pin board with coloured elastic bands. Drag a band end to an empty pin.">
        <defs><radialGradient id="dt-felt" cx="50%" cy="42%" r="62%"><stop offset="0%" style="stop-color:var(--felt-hi)"/><stop offset="100%" style="stop-color:var(--felt)"/></radialGradient></defs>
        <circle cx="200" cy="200" r="194" fill="url(#dt-felt)" style="stroke:var(--felt-rim)" stroke-width="6"/>
        <circle cx="200" cy="200" r="178" fill="none" style="stroke:var(--felt-rim)" stroke-width="1" stroke-dasharray="2 6" stroke-linecap="round" opacity=".7"/>
        <g id="dt-pins">${PTS.map(p => `<circle cx="${p.x}" cy="${p.y}" r="5.5" fill="var(--pin)" style="stroke:var(--shadow)" stroke-width="1"/><circle cx="${p.x - 1.3}" cy="${p.y - 1.5}" r="1.8" fill="var(--pin-hi)" opacity=".9"/>`).join('')}</g>
        <g id="dt-shadow"></g><g id="dt-bands"></g><g id="dt-dots"></g><g id="dt-handles"></g><g id="dt-targets"></g><g id="dt-ghosts"></g></svg></div>
      <div class="bg-actions dt-play"><button class="bg-btn ghost" id="dt-undo" data-d="undo">↩️ Undo</button>
        <button class="bg-btn ghost" data-d="reset">🔄 Reset</button>
        <button class="bg-btn" id="dt-hint" data-d="hint">💡 Hint</button></div>
      <p class="bg-small">${G.counted ? "Your first finish today counts for the leaderboard." : "Practice: this one doesn't count."} Three stars means par or better; a hint caps it at two.</p>
      <p class="bg-small">${howText()}</p>
      ${b.layers ? `<div class="dt-rule"><figure><svg viewBox="0 0 120 72" aria-hidden="true"><rect width="120" height="72" rx="10" fill="var(--felt)"/>
        <g style="stroke:var(--b4)" stroke-width="5"><line x1="38" y1="8" x2="38" y2="28"/><line x1="38" y1="44" x2="38" y2="64"/></g>
        <g style="stroke:var(--b3)" stroke-width="5"><line x1="82" y1="8" x2="82" y2="28"/><line x1="82" y1="44" x2="82" y2="64"/></g>
        <line x1="12" y1="36" x2="108" y2="36" style="stroke:var(--b1)" stroke-width="5"/></svg><figcaption><b>Over both.</b> Nothing lies over the red band, so it pops free.</figcaption></figure>
        <figure><svg viewBox="0 0 120 72" aria-hidden="true"><rect width="120" height="72" rx="10" fill="var(--felt)"/>
        <g style="stroke:var(--b4)" stroke-width="5"><line x1="38" y1="8" x2="38" y2="28"/><line x1="38" y1="44" x2="38" y2="64"/></g>
        <line x1="82" y1="8" x2="82" y2="64" style="stroke:var(--b3)" stroke-width="5"/>
        <g style="stroke:var(--b1)" stroke-width="5"><line x1="12" y1="36" x2="73" y2="36"/><line x1="91" y1="36" x2="108" y2="36"/></g></svg><figcaption><b>Over one, under the other.</b> Something lies over the red band, so it waits.</figcaption></figure></div>` : ''}`;
  }

  function renderDone() {
    const G = st.game, r = G.result, reply = G.reply;
    const state = G.saving ? '<p class="bg-small">Saving your score…</p>'
      : G.queued ? '<p class="bg-warn">No signal. Your score is saved on this phone and will be sent later.</p>'
      : G.notSaved ? '<p class="bg-warn">That score could not be saved.</p>'
      : !G.counted ? '<p class="bg-small">Practice game: not counted.</p>' : '';
    return `<div class="bg-center"><div class="bg-big">🪢</div><h2>Untwisted!</h2>${starsHtml(r.stars)}
      <p class="dt-score"><b>${r.moves}</b> move${r.moves === 1 ? '' : 's'} · par ${r.par} · ${fmtSecs(r.secs)}${r.hints ? ` · ${r.hints} hint${r.hints === 1 ? '' : 's'}` : ''}</p>
      <p class="bg-small">${esc(st.player.emoji)} ${esc(st.player.name)}</p>
      ${state}${reply ? everyoneLine(reply.everyone, reply.everyone) : ''}
      ${reply && st.data.streaks && st.data.streaks[keyOf(st.player)] > 1 ? `<p class="dt-rank">🔥 ${st.data.streaks[keyOf(st.player)]} days in a row</p>` : ''}</div>
      ${familyBoard()}
      <p class="bg-small center">Next board in <b id="dt-count">${countdown()}</b></p>
      <div class="bg-actions"><button class="bg-btn ghost" data-d="practice">🔁 Practice again</button>
        <button class="bg-btn ghost" data-d="back">👥 Who's next?</button>
        <button class="bg-btn" data-d="close">Done</button></div>`;
  }

  function render() {
    const root = document.getElementById('detwist-root');
    if (!root || !st) return;
    let body, sub = '';
    if (st.error) body = `<div class="bg-center"><div class="bg-big">📵</div><p>Couldn't load today's board. Check the signal.</p><button class="bg-btn" data-d="retry">Try again</button></div>`;
    else if (!st.data) body = `<div class="bg-center"><div class="bg-big">🪢</div><p>Fetching today's board…</p></div>`;
    else {
      sub = `<span class="bg-level">No. ${st.board.number} · ${esc(st.board.name || '')}</span>`;
      body = st.screen === 'play' ? renderPlay() : st.screen === 'done' ? renderDone() : renderPick();
    }
    const showBack = st.data && st.screen !== 'pick';
    root.innerHTML = `<div class="bg-sheet"><div class="bg-head">${showBack ? '<button class="bg-x" data-d="back" aria-label="Back to players">‹</button>' : ''}
      <span class="bg-title">🪢 DeTwist</span>${sub}<button class="bg-x" data-d="close" aria-label="Close DeTwist">✕</button></div>${body}</div>`;
    if (st.screen === 'play' && st.data && st.game) {
      const svg = document.getElementById('dt-svg');
      svg.addEventListener('pointerdown', onDown);
      svg.addEventListener('pointermove', onMove);
      svg.addEventListener('pointerup', onUp);
      svg.addEventListener('pointercancel', onCancel);
      paint(); hud();
    }
  }

  function onClick(e) {
    const el = e.target.closest('[data-d]');
    if (!el || !st) return;
    const a = el.dataset.d;
    if (a === 'close') close();
    else if (a === 'retry') { st.error = false; render(); load(); }
    else if (a === 'back') { st.game = null; st.screen = 'pick'; render(); }
    else if (a === 'who') {
      const p = st.players.find(x => keyOf(x) === el.dataset.key);
      if (!p) return;
      const done = (st.data.played || {})[keyOf(p)];
      st.player = p;
      if (done) { st.game = { counted: false, result: done, reply: null, log: [], bands: [], undo: [], hints: 0 }; st.screen = 'done'; render(); } else newGame(p, true);
    } else if (a === 'practice') newGame(st.player, false);
    else if (a === 'undo') undo();
    else if (a === 'reset') reset();
    else if (a === 'hint') hint();
  }

  function close() {
    if (!st) return;
    clearInterval(st.timer); clearTimeout(st.hintTimer); clearTimeout(st.ghostTimer);
    document.getElementById('detwist-root')?.remove();
    const cb = st.onClose;
    st = null;
    cb && cb();
  }

  function open(opts) {
    if (st) return;
    st = { players: opts.players || [], onClose: opts.onClose, data: null, board: null, rel: null, screen: 'pick', game: null, player: null, error: false };
    const root = document.createElement('div');
    root.id = 'detwist-root';
    root.className = 'game-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'DeTwist');
    root.addEventListener('click', onClick);
    document.body.appendChild(root);
    st.timer = setInterval(() => { const c = document.getElementById('dt-count'); if (c && st) c.textContent = countdown(); }, 1000);
    render();
    load();
  }

  window.TaxiDetwist = { open, close, isOpen: () => !!st, _state: () => st, _solve: solve, _starsFor: starsFor };
})();
