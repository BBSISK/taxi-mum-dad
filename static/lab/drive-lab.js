/* How's the Driving? Sensor Lab: records GPS + motion while the phone sits in a pocket or holder, then shows what
 * the analysis found. Everything stays on the phone (IndexedDB) apart from a simplified route sent to OpenStreetMap's
 * Overpass service for the speed-limit check. */
(function () {
  'use strict';
  const A = window.HTDAnalysis;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mmss = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const OVERPASS = 'https://overpass-api.de/api/interpreter';

  /* ------------------------------------------------------------------ storage (IndexedDB) */
  const DB = {
    open() {
      return this._p || (this._p = new Promise((res, rej) => {
        const r = indexedDB.open('htd-lab', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('drives', { keyPath: 'id' });
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }));
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('drives', mode), out = fn(t.objectStore('drives'));
        t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
      });
    },
    put(d) { return this.tx('readwrite', s => s.put(d)); },
    all() { return this.tx('readonly', s => s.getAll()); },
    get(id) { return this.tx('readonly', s => s.get(id)); },
    del(id) { return this.tx('readwrite', s => s.delete(id)); },
  };

  /* ------------------------------------------------------------------ sensors */
  const S = {
    t0: 0, trace: null, recording: false, live: false, watchId: null, wake: null,
    g: null, bucket: null, lastMotionWall: 0, motionCount: 0, lastFix: null, hNow: 0, src: 'none',
  };
  const now = () => Date.now() - S.t0;

  function onMotion(e) {
    const aig = e.accelerationIncludingGravity, lin = e.acceleration;
    const haveAig = aig && aig.x != null, haveLin = lin && lin.x != null;
    if (!haveAig && !haveLin) return;
    const wall = Date.now(), dt = S.lastMotionWall ? Math.min(200, Math.max(1, wall - S.lastMotionWall)) : 16;  // real gap between events
    if (haveAig) {
      if (!S.g) S.g = [aig.x, aig.y, aig.z];
      const k = dt / (1000 + dt);  // ~1 s low-pass = gravity
      S.g = [S.g[0] + k * (aig.x - S.g[0]), S.g[1] + k * (aig.y - S.g[1]), S.g[2] + k * (aig.z - S.g[2])];
    }
    let a;
    if (haveLin) { a = [lin.x, lin.y, lin.z]; S.src = haveAig ? 'acceleration' : 'acceleration-no-gravity'; }
    else { a = [aig.x - S.g[0], aig.y - S.g[1], aig.z - S.g[2]]; S.src = 'gravity-filtered'; }
    const g = S.g || [0, 0, 9.81];
    const rr = e.rotationRate, rot = rr ? Math.hypot(rr.alpha || 0, rr.beta || 0, rr.gamma || 0) : 0;
    S.motionCount++; S.lastMotionWall = wall;
    // live horizontal magnitude for the sensor check
    const gm = Math.hypot(...g) || 1, along = (a[0] * g[0] + a[1] * g[1] + a[2] * g[2]) / gm;
    S.hNow = Math.sqrt(Math.max(0, a[0] ** 2 + a[1] ** 2 + a[2] ** 2 - along ** 2));
    if (!S.recording) return;
    // average into 50 ms buckets (20 Hz) to keep traces small
    const t = now(), slot = Math.floor(t / 50);
    if (S.bucket && S.bucket.slot !== slot) flushBucket();
    if (!S.bucket) S.bucket = { slot, n: 0, a: [0, 0, 0], g: [0, 0, 0], rot: 0 };
    const b = S.bucket; b.n++;
    for (let i = 0; i < 3; i++) { b.a[i] += a[i]; b.g[i] += g[i]; }
    b.rot = Math.max(b.rot, rot);
  }
  function flushBucket() {
    const b = S.bucket; S.bucket = null;
    if (!b || !b.n || !S.trace) return;
    const r = x => Math.round(x * 1000) / 1000;
    S.trace.motion.push([b.slot * 50 + 25, r(b.a[0] / b.n), r(b.a[1] / b.n), r(b.a[2] / b.n), r(b.g[0] / b.n), r(b.g[1] / b.n), r(b.g[2] / b.n), Math.round(b.rot)]);
  }

  function onFix(p) {
    const c = p.coords;
    S.lastFix = { at: Date.now(), acc: c.accuracy, speed: c.speed, heading: c.heading };
    if (S.recording && S.trace) {
      S.trace.gps.push([now(), +c.latitude.toFixed(6), +c.longitude.toFixed(6),
        c.speed == null || isNaN(c.speed) ? null : Math.round(c.speed * 100) / 100,
        c.heading == null || isNaN(c.heading) ? null : Math.round(c.heading),
        Math.round(c.accuracy)]);
    }
  }
  function onFixError(err) {
    S.lastFixError = err.message || String(err.code);
    if (S.recording && S.trace) S.trace.errors.push([now(), 'gps', S.lastFixError]);
  }

  async function askMotionPermission() {  // iPhone needs a tap-triggered permission; Android just works
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      try { return (await DeviceMotionEvent.requestPermission()) === 'granted'; } catch { return false; }
    }
    return typeof DeviceMotionEvent !== 'undefined';
  }
  function startSensors() {
    if (!S.motionOn) { window.addEventListener('devicemotion', onMotion); S.motionOn = true; }
    if (S.watchId == null && navigator.geolocation) {
      S.watchId = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    }
  }
  function stopSensors() {
    if (S.motionOn) { window.removeEventListener('devicemotion', onMotion); S.motionOn = false; }
    if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  }

  async function lockScreenOn() {
    if (!('wakeLock' in navigator)) return false;
    try {
      S.wake = await navigator.wakeLock.request('screen');
      S.wake.addEventListener('release', () => { S.wake = null; });
      return true;
    } catch (e) { if (S.trace) S.trace.errors.push([now(), 'wakelock', e.message]); return false; }
  }

  /* ------------------------------------------------------------------ setup screen */
  function renderChecks() {
    const items = [
      [window.isSecureContext && !!navigator.geolocation, 'GPS available', 'GPS not available in this browser'],
      [typeof DeviceMotionEvent !== 'undefined', 'Motion sensors available', 'No motion sensors in this browser'],
      ['wakeLock' in navigator, 'Can keep the screen awake', "Can't keep the screen awake: set the screen timeout to 10 min before driving"],
      [!!window.indexedDB, 'Can save drives on this phone', "Can't save drives: download the trace straight after"],
    ];
    $('checks').innerHTML = items.map(([ok, yes, no]) => `<li><span class="${ok ? 'ok' : 'bad'}">${ok ? '✔' : '✖'}</span><span>${esc(ok ? yes : no)}</span></li>`).join('');
  }

  let liveTimer = null;
  function renderLive() {
    const f = S.lastFix, age = f ? Math.round((Date.now() - f.at) / 1000) : null;
    const hz = S._hzPrev != null ? (S.motionCount - S._hzPrev) : 0; S._hzPrev = S.motionCount;
    const rows = [
      ['GPS fix', f ? `±${Math.round(f.acc)} m, ${age}s ago` : (S.lastFixError ? `error: ${S.lastFixError}` : 'waiting…'), f && f.acc <= 20 ? 'ok' : f ? 'meh' : 'bad'],
      ['GPS speed', f && f.speed != null ? `${Math.round(f.speed * 3.6)} km/h` : 'not reported yet', f && f.speed != null ? 'ok' : 'meh'],
      ['Motion events', `${hz}/s`, hz >= 20 ? 'ok' : hz > 0 ? 'meh' : 'bad'],
      ['Motion source', S.src, S.src === 'acceleration' ? 'ok' : S.src === 'none' ? 'bad' : 'meh'],
      ['Sideways shake now', `${S.hNow.toFixed(1)} m/s² (${(S.hNow / 9.81).toFixed(2)} g)`, 'ok'],
    ];
    $('live').innerHTML = rows.map(([k, v, c]) => `<tr><th>${esc(k)}</th><td class="${c}">${esc(v)}</td></tr>`).join('');
  }
  async function toggleLive() {
    if (S.live) {
      S.live = false; clearInterval(liveTimer); if (!S.recording) stopSensors();
      $('liveBtn').textContent = 'Start sensor check'; return;
    }
    await askMotionPermission();
    S.live = true; S._hzPrev = S.motionCount; startSensors();
    liveTimer = setInterval(renderLive, 1000); renderLive();
    $('liveBtn').textContent = 'Stop sensor check';
  }

  async function renderPast() {
    let list = [];
    try { list = (await DB.all()).sort((a, b) => b.id.localeCompare(a.id)); } catch { /* no IndexedDB */ }
    if (!list.length) { $('past').innerHTML = '<p class="small">None yet.</p>'; return; }
    $('past').innerHTML = list.map(d => {
      const when = new Date(d.started).toLocaleString('en-IE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const mins = Math.round((d.endedMs || (d.gps.length ? d.gps[d.gps.length - 1][0] : 0)) / 60000);
      return `<div class="row"><span>${esc(when)} · ${mins} min${d.ended ? '' : ' · <b class="bad">unfinished</b>'}</span>
        <button class="slim" type="button" data-open="${esc(d.id)}">Open</button>
        <button class="slim" type="button" data-del="${esc(d.id)}" aria-label="Delete drive">✕</button></div>`;
    }).join('');
  }

  /* ------------------------------------------------------------------ recording */
  let clockTimer = null, saveTimer = null;
  async function startDrive() {
    await askMotionPermission();
    if (S.live) { S.live = false; clearInterval(liveTimer); $('liveBtn').textContent = 'Start sensor check'; }
    S.t0 = Date.now();
    const id = new Date(S.t0).toISOString();
    S.trace = { v: 1, id, started: id, ended: null, endedMs: null, ua: navigator.userAgent, gps: [], motion: [], touches: [], vis: [], errors: [], motionSource: 'none', overpass: null };
    S.recording = true; S.g = null; S.bucket = null;
    startSensors();
    const awake = await lockScreenOn();
    $('pocket').classList.add('on');
    $('pstatus').textContent = awake ? '' : "Screen may time out: keep it from locking";
    clockTimer = setInterval(() => {
      $('clock').textContent = `RECORDING · ${mmss(now())}`;
      const gpsOk = S.lastFix && Date.now() - S.lastFix.at < 5000, motOk = Date.now() - S.lastMotionWall < 2000;
      $('pstatus').textContent = `GPS ${gpsOk ? 'OK' : 'waiting'} · Motion ${motOk ? 'OK' : 'missing'}`;
    }, 1000);
    saveTimer = setInterval(() => { flushBucket(); S.trace.motionSource = S.src; DB.put(S.trace).catch(() => {}); }, 20000);
  }

  async function stopDrive() {
    if (!S.recording) return;
    S.recording = false;
    clearInterval(clockTimer); clearInterval(saveTimer);
    flushBucket(); stopSensors();
    if (S.wake) { try { await S.wake.release(); } catch { /* already gone */ } }
    S.trace.endedMs = now(); S.trace.ended = new Date().toISOString(); S.trace.motionSource = S.src;
    $('pocket').classList.remove('on');
    try { await DB.put(S.trace); } catch { /* no storage: the download button still works */ }
    showReport(S.trace);
  }

  document.addEventListener('visibilitychange', () => {
    if (!S.recording) return;
    S.trace.vis.push([now(), document.visibilityState]);
    if (document.visibilityState === 'visible') lockScreenOn();
    else { flushBucket(); DB.put(S.trace).catch(() => {}); }
  });

  // any touch on the black screen (other than the stop button) is noted as "phone handled"
  $('pocket').addEventListener('pointerdown', e => {
    if (S.recording && !e.target.closest('#hold')) S.trace.touches.push(now());
  });
  (function holdToStop() {
    const btn = $('hold'), bar = btn.querySelector('i');
    let timer = null, startAt = 0, raf = null;
    const reset = () => { clearTimeout(timer); cancelAnimationFrame(raf); timer = null; bar.style.width = '0'; };
    const tick = () => { bar.style.width = Math.min(100, (Date.now() - startAt) / 20) + '%'; raf = requestAnimationFrame(tick); };
    btn.addEventListener('pointerdown', e => { e.preventDefault(); startAt = Date.now(); tick(); timer = setTimeout(() => { reset(); stopDrive(); }, 2000); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, () => { if (timer) reset(); }));
    btn.addEventListener('contextmenu', e => e.preventDefault());
  })();

  /* ------------------------------------------------------------------ report */
  let current = null;
  async function fetchLimits(trace) {
    const pts = trace.gps.filter(p => p[5] != null && p[5] <= 30);
    if (pts.length < 10) throw new Error('not enough GPS to check limits');
    const q = A.overpassQuery(A.routeSample(pts));
    const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) });
    if (!res.ok) throw new Error(`Overpass said ${res.status}`);
    const j = await res.json();
    // keep only what matching needs, so saved drives stay small
    return { elements: (j.elements || []).filter(e => e.type === 'way').map(w => ({ type: 'way', tags: { highway: w.tags && w.tags.highway, maxspeed: w.tags && w.tags.maxspeed, name: w.tags && w.tags.name, ref: w.tags && w.tags.ref, oneway: w.tags && w.tags.oneway }, geometry: w.geometry })) };
  }

  async function showReport(trace, opts) {
    current = trace;
    $('setup').classList.add('hidden'); $('report').classList.remove('hidden');
    window.scrollTo(0, 0);
    let limitsNote = '';
    if (!trace.overpass && !(opts && opts.noFetch)) {
      render(trace, A.analyse(trace, null), 'Checking speed limits with OpenStreetMap…');
      try { trace.overpass = await fetchLimits(trace); DB.put(trace).catch(() => {}); }
      catch (e) { limitsNote = `Speed-limit check failed: ${e.message}. Try "Re-check limits" when you have signal.`; }
    }
    render(trace, A.analyse(trace, trace.overpass), limitsNote);
  }

  function render(trace, sum, note) {
    const f = sum.fun, h = sum.health;
    const label = t => A.LABELS[t] || t;
    const evRows = [...sum.events, ...sum.handling].sort((a, b) => a.t - b.t).map(e =>
      `<tr><td>${mmss(e.t)}</td><td>${esc(label(e.type))}${e.how ? `<br><span class="small">${esc(e.how)}</span>` : ''}</td>
       <td>${e.mps2 != null ? (Math.abs(e.mps2) / 9.81).toFixed(2) + ' g' : ''}</td><td>${e.kmh != null ? Math.round(e.kmh) : ''}</td><td>${esc(e.src)}</td></tr>`).join('');
    const spRows = sum.speeding.map(s => `<tr><td>${mmss(s.t)}</td><td>${Math.round(s.kmh)} in a ${s.limit}</td><td>${esc(s.road || '')}</td><td>${Math.round(s.seconds)} s</td></tr>`).join('');
    const healthRows = [
      ['GPS fixes (used)', `${h.gpsFixes} (${h.gpsUsed})`, h.gpsUsed > 30 ? 'ok' : 'bad'],
      ['GPS every', h.gpsMedianGapS != null ? `${h.gpsMedianGapS} s` : '–', h.gpsMedianGapS != null && h.gpsMedianGapS <= 1.5 ? 'ok' : 'meh'],
      ['GPS accuracy (median)', h.gpsMedianAccM != null ? `±${h.gpsMedianAccM} m` : '–', h.gpsMedianAccM != null && h.gpsMedianAccM <= 15 ? 'ok' : 'meh'],
      ['Motion samples', `${h.motionSamples} at ${h.motionHz} Hz`, h.motionHz >= 15 ? 'ok' : h.motionSamples ? 'meh' : 'bad'],
      ['Motion gaps > 2 s', h.motionGaps, h.motionGaps ? 'meh' : 'ok'],
      ['Motion source', h.motionSource, h.motionSource === 'acceleration' ? 'ok' : 'meh'],
      ['Screen touches / app left', `${h.touches} / ${h.hidden}`, h.touches + h.hidden ? 'meh' : 'ok'],
      ['Speed limit known', trace.overpass ? `${sum.limitKnownPct}% of moving time` : 'not checked', trace.overpass && sum.limitKnownPct >= 70 ? 'ok' : 'meh'],
    ].map(([k, v, c]) => `<tr><th>${esc(k)}</th><td class="${c}">${esc(v)}</td></tr>`).join('');

    $('report').innerHTML = `
      <div class="card">
        <div class="rc-top"><div class="stamp">${esc(f.grade)}</div>
          <div><span class="small">TEACHER'S COMMENT</span><p class="comment">"${esc(f.comment)}"</p></div></div>
        ${f.fines.map(x => `<div class="fine"><span>${esc(x.label)}${x.n > 1 ? ' ×' + x.n : ''}${x.note ? `<br><span class="small">${esc(x.note)}</span>` : ''}</span><b>−${x.pts}</b></div>`).join('') || '<p>No fines. Not one.</p>'}
        <div style="margin-top:8px">${f.badges.map(b => `<span class="pill">${esc(b)}</span>`).join('')}</div>
        <p class="small" style="margin-top:8px">Just for craic. Your phone's GPS is guessing, the speed-limit map has gaps, and this report won't get you out of a ticket.</p>
      </div>

      <div class="card">
        <h2>The drive</h2>
        <p>${sum.minutes} min · ${sum.km} km · ${sum.movingMin} min moving · average ${sum.avgKmh} km/h</p>
        ${note ? `<p class="small">${esc(note)}</p>` : ''}
        <canvas id="chart" width="600" height="200" role="img" aria-label="Speed and speed limit over the drive"></canvas>
        <div class="legend"><span style="--c:#141414">Speed</span><span style="--c:#d7262e">Limit</span><span style="--c:#ff7a1a">Brake / start</span><span style="--c:#2f6fde">Corner</span><span style="--c:#8a3ffc">Phone</span></div>
      </div>

      <div class="card">
        <h2>Lab: what the sensors caught</h2>
        <table><thead><tr><th>When</th><th>What</th><th>Peak</th><th>km/h</th><th>Seen by</th></tr></thead><tbody>${evRows || '<tr><td colspan="5">Nothing over the thresholds.</td></tr>'}</tbody></table>
        <h2 style="margin-top:16px">Over the limit</h2>
        <table><tbody>${spRows || `<tr><td>${trace.overpass ? 'Never over (by 4+ km/h for 4+ s).' : 'Not checked yet.'}</td></tr>`}</tbody></table>
        <h2 style="margin-top:16px">Sensor health</h2>
        <table><tbody>${healthRows}</tbody></table>
        <p class="small" style="margin-top:8px">"Seen by": gps = from speed changes, motion = from the accelerometer, both = they agree. Bumps are listed but never scored.</p>
      </div>

      <div class="grid2">
        <button type="button" id="dl">Download trace</button>
        <button type="button" id="copy">Copy summary for Claude</button>
        <button type="button" id="relimit">Re-check limits</button>
        <button type="button" id="back">Back</button>
      </div>`;
    drawChart(sum);
    $('dl').onclick = () => download(trace);
    $('copy').onclick = () => copySummary(trace, sum);
    $('relimit').onclick = () => { trace.overpass = null; showReport(trace); };
    $('back').onclick = () => { $('report').classList.add('hidden'); $('setup').classList.remove('hidden'); renderPast(); };
  }

  function drawChart(sum) {
    const c = $('chart'); if (!c) return;
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr; c.height = H * dpr;
    const x = c.getContext('2d'); x.scale(dpr, dpr);
    const { t, kmh, limit } = sum.series;
    if (t.length < 2) { x.font = '800 14px Nunito, sans-serif'; x.fillText('Not enough GPS to draw.', 12, 24); return; }
    const t0 = t[0], t1 = t[t.length - 1], maxY = Math.max(60, ...kmh, ...(limit || []).filter(Boolean)) + 10;
    const px = tt => 30 + (W - 40) * (tt - t0) / (t1 - t0), py = v => H - 18 - (H - 30) * v / maxY;
    x.strokeStyle = '#e4e0d4'; x.lineWidth = 1; x.fillStyle = '#5c5648'; x.font = '800 11px Nunito, sans-serif';
    for (let v = 0; v <= maxY; v += 20) { x.beginPath(); x.moveTo(30, py(v)); x.lineTo(W - 10, py(v)); x.stroke(); x.fillText(v, 4, py(v) + 4); }
    if (limit) {
      x.strokeStyle = '#d7262e'; x.lineWidth = 2; x.beginPath(); let on = false;
      t.forEach((tt, i) => { if (limit[i]) { if (!on) x.moveTo(px(tt), py(limit[i])); else x.lineTo(px(tt), py(limit[i])); on = true; } else on = false; });
      x.stroke();
    }
    x.strokeStyle = '#141414'; x.lineWidth = 2; x.beginPath();
    t.forEach((tt, i) => (i ? x.lineTo(px(tt), py(kmh[i])) : x.moveTo(px(tt), py(kmh[i])))); x.stroke();
    const col = { brake: '#ff7a1a', accel: '#ff7a1a', corner: '#2f6fde', handling: '#8a3ffc', bump: '#aaa' };
    for (const e of [...sum.events, ...sum.handling]) {
      x.fillStyle = col[e.type] || '#000'; x.beginPath(); x.arc(px(e.t), py(e.kmh != null ? e.kmh : 5), 5, 0, Math.PI * 2); x.fill();
    }
  }

  function download(trace) {
    const blob = new Blob([JSON.stringify(trace)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `htd-drive-${trace.started.slice(0, 16).replace(/[:T]/g, '-')}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function copySummary(trace, sum) {
    const { series, ...rest } = sum;
    const text = JSON.stringify({ lab: 'htd-sensor-lab v1', started: trace.started, ua: trace.ua, errors: trace.errors.slice(0, 10), ...rest }, null, 1);
    try { await navigator.clipboard.writeText(text); $('copy').textContent = 'Copied ✔'; }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); $('copy').textContent = 'Copied ✔'; } catch { $('copy').textContent = 'Copy failed'; }
      ta.remove();
    }
  }

  /* ------------------------------------------------------------------ wire up */
  $('start').onclick = startDrive;
  $('liveBtn').onclick = toggleLive;
  $('past').addEventListener('click', async e => {
    const open = e.target.closest('[data-open]'), del = e.target.closest('[data-del]');
    if (open) {
      const d = await DB.get(open.dataset.open);
      if (d && !d.ended) { d.endedMs = Math.max(d.gps.length ? d.gps[d.gps.length - 1][0] : 0, d.motion.length ? d.motion[d.motion.length - 1][0] : 0); d.ended = '(recovered)'; DB.put(d).catch(() => {}); }
      if (d) showReport(d);
    }
    if (del && confirm('Delete this drive from the phone?')) { await DB.del(del.dataset.del); renderPast(); }
  });
  renderChecks(); renderPast();
})();
