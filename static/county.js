/* County Collector: spot Irish number plates and fill the family's county passport.
 *
 *   TaxiCounty.open({ players: [{type, id, name, emoji}], tripKey, onClose })
 *
 * Hands-free: shout "<name>, <county>!" ("Jack, Kerry!") or the plate letters ("Jack, K Y!").
 * Uses the shared TaxiVoice helpers (static/games-core.js); taps work as a fallback.
 */
(function () {
  'use strict';
  const V = window.TaxiVoice;
  const QUEUE_KEY = 'taxi.county.queue';
  const SETTINGS_KEY = 'taxi.bingo.settings';  // same voice/mute settings as Car Bingo
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PROVINCES = ['Leinster', 'Munster', 'Connacht', 'Ulster'];
  const LETTERS = { k: 'k', kay: 'k', why: 'y', wye: 'y', y: 'y', c: 'c', see: 'c', sea: 'c', cee: 'c', d: 'd', dee: 'd',
    g: 'g', gee: 'g', jee: 'g', l: 'l', el: 'l', ell: 'l', m: 'm', em: 'm', n: 'n', en: 'n', o: 'o', oh: 'o', s: 's', ess: 's',
    t: 't', tee: 't', tea: 't', x: 'x', ex: 'x', h: 'h', aitch: 'h', haitch: 'h', e: 'e', ee: 'e', w: 'w', r: 'r', ar: 'r' };

  let st = null, listener = null;

  /* ------------------------------------------------------------ matching */
  function matchPlate(all, plates, span) {
    // Ignore the player's name, so a kid called Clare doesn't collect County Clare by saying her own name.
    const heard = all.filter((w, i) => !(span && i >= span.at && i < span.at + span.len));
    let best = null;
    for (const p of plates) {
      for (const kw of [p.name, ...p.keywords]) {
        const len = V.words(kw).length;
        if (V.phraseAt(heard, kw) >= 0 && (!best || len > best.len)) best = { p, len };
      }
    }
    if (best) return best.p;
    const byCode = Object.fromEntries(plates.map(p => [p.code.toLowerCase(), p]));
    const rest = heard;
    const toks = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === 'double' && (rest[i + 1] === 'u' || rest[i + 1] === 'you')) { toks.push('w'); i++; } else toks.push(rest[i]);
    }
    for (const t of toks) if (t.length === 2 && byCode[t]) return byCode[t];             // "ky"
    const L = toks.map(t => LETTERS[t] || null);
    for (let i = 0; i + 1 < L.length; i++) if (L[i] && L[i + 1] && byCode[L[i] + L[i + 1]]) return byCode[L[i] + L[i + 1]];  // "k y"
    if (toks.length <= 2) for (const l of L) if (l && byCode[l]) return byCode[l];         // "d" on its own
    return null;
  }

  /* ------------------------------------------------------------ voice */
  function speak(text, after) {
    V.say(text, { muted: st && st.muted, before: () => listener && listener.pause(), after: () => { after && after(); if (st && st.voice) listener && listener.resume(); } });
  }
  function hear(alts) {
    if (!st || !st.data) return;
    st.lastHeard = alts[0];
    for (const t of alts) {
      const heard = V.words(t);
      if (heard.includes('undo')) { undo(); return; }
      const who = V.matchPlayer(heard, st.players);
      const plate = matchPlate(heard, st.plates, who);
      if (!plate && who && st.waitingFor) { claim(st.waitingFor, who.p); return; }
      if (!plate) continue;
      const player = who ? who.p : st.players.length === 1 ? st.players[0] : null;
      if (!player) { st.waitingFor = plate; render(); speak(`${plate.name}! Who spotted it?`); return; }
      claim(plate, player);
      return;
    }
    render();
  }

  /* ------------------------------------------------------------ server */
  async function post(body) {
    const res = await fetch('/api/county/spot', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('save failed');
    return res.json();
  }
  async function claim(plate, player) {
    st.waitingFor = null;
    st.tapPlayer = null;
    const body = { code: plate.code, player: { type: player.type, id: player.id }, trip_key: st.tripKey };
    try {
      const r = await post(body);
      Object.assign(st.data, r);
      if (r.duplicate) {
        render();
        speak(`${plate.name} is already in this trip, spotted by ${r.by ? r.by.name : 'someone'}.`);
        return;
      }
      st.session.push({ id: r.spot_id, plate, player, points: r.points, isNew: r.is_new, at: Date.now() });
      if (navigator.vibrate) try { navigator.vibrate(r.is_new ? [60, 40, 60] : 60); } catch { /* ignore */ }
      render();
      const left = r.counties_total - r.counties_collected;
      if (r.complete) speak(`${plate.name}! That's all 26 counties! Passport complete! ${player.name} gets ${r.points} points.`);
      else if (r.is_new) speak(`New county! ${plate.name} for ${player.name}, ${r.points} points. ${left} to go.`);
      else speak(`${plate.name} again, ${r.points} point${r.points === 1 ? '' : 's'} for ${player.name}.`);
    } catch {
      LS.set(QUEUE_KEY, [...LS.get(QUEUE_KEY, []), body]);
      st.session.push({ id: null, plate, player, points: '…', isNew: false, at: Date.now(), queued: true });
      render();
      speak(`${plate.name} for ${player.name}. No signal, I'll save it later.`);
    }
  }
  async function flushQueue() {
    const q = LS.get(QUEUE_KEY, []);
    if (!q.length) return;
    const left = [];
    for (const b of q) { try { await post(b); } catch { left.push(b); } }
    LS.set(QUEUE_KEY, left);
  }
  async function undo() {
    const last = [...st.session].reverse().find(s => s.id && !s.undone);
    if (!last || Date.now() - last.at > 30000) { speak('Nothing to undo'); return; }
    try {
      const res = await fetch(`/api/county/spot/${last.id}`, { method: 'DELETE', credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      Object.assign(st.data, await res.json());
      last.undone = true;
      render();
      speak(`Undone. ${last.plate.name} taken back.`);
    } catch { speak("Couldn't undo, no signal"); }
  }
  async function load() {
    try {
      await flushQueue();
      const res = await fetch('/api/county/passport', { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      const d = await res.json();
      st.plates = d.plates;
      st.data = d;
      render();
      if (st.voice) {
        listener = V.createListener({ onPhrases: hear, onFatal: () => { st.voice = false; st.voiceProblem = true; render(); }, onState: setMic });
        speak(`County Collector. ${d.counties_collected} of 26 so far. Shout your name and the county.`, () => listener.start());
      }
    } catch {
      st.error = true;
      render();
    }
  }

  /* ------------------------------------------------------------ view */
  function setMic(on) {
    const m = document.getElementById('cc-mic');
    if (!m || !st) return;
    m.className = 'bg-mic' + (on ? ' on' : '');
    m.textContent = st.voice ? (on ? '🎤 Listening…' : '🎤 …') : '✋ Tap mode';
  }
  function render() {
    const root = document.getElementById('county-root');
    if (!root || !st) return;
    const d = st.data;
    let body;
    if (st.error) body = `<div class="bg-center"><div class="bg-big">📵</div><p>Couldn't load your passport. Check the signal.</p><button class="bg-btn" data-c="retry">Try again</button></div>`;
    else if (!d) body = `<div class="bg-center"><div class="bg-big">🗺️</div><p>Opening your passport…</p></div>`;
    else {
      const thisTrip = new Set(st.session.filter(s => !s.undone).map(s => s.plate.code));
      const pct = Math.round(100 * d.counties_collected / d.counties_total);
      body = `
      <div class="cc-progress"><div class="cc-bar"><span style="width:${pct}%"></span></div>
        <b>${d.counties_collected}/${d.counties_total}</b> counties${d.season > 1 ? ` · passport ${d.season}` : ''}</div>
      <div class="bg-status"><span id="cc-mic" class="bg-mic"></span>
        <span class="bg-heard">${st.hint && !st.tapPlayer ? '<b>Tap who spotted it first</b>, then the county' : st.voiceProblem && !st.voice ? 'Voice unavailable: tap a name, then a county' : st.waitingFor ? `<b>${esc(st.waitingFor.name)}!</b> Who spotted it?` :
          st.lastHeard ? `Heard: “${esc(st.lastHeard)}”` : st.voice ? 'Shout: <i>“Jack, Kerry!”</i> or <i>“Jack, K Y!”</i>' : 'Tap who spotted it, then the county'}</span></div>
      <div class="bg-whobtns">${st.players.map(p => `<button class="bg-who ${st.tapPlayer === p ? 'on' : ''}" data-c="who" data-key="${p.type}-${p.id}">${esc(p.emoji)} ${esc(p.name)}</button>`).join('')}</div>
      ${st.tapPlayer ? `<p class="bg-small">${esc(st.tapPlayer.name)} spotted… tap the county</p>` : ''}
      ${PROVINCES.map(pr => `<h3 class="cc-prov">${pr}</h3><div class="cc-grid">${st.plates.filter(p => p.province === pr).map(p => {
        const got = d.collected[p.code];
        return `<button class="cc-tile t${p.tier} ${got ? 'got' : ''} ${thisTrip.has(p.code) ? 'trip' : ''}" data-c="plate" data-code="${p.code}" aria-label="${esc(p.name)}${got ? ', collected' : ''}">
          <span class="code">${p.code}</span><span class="nm">${esc(p.name)}</span>
          ${got ? `<span class="by">${esc(got.by ? got.by.emoji : '✓')}</span>` : `<span class="pt">${p.points * 2}</span>`}</button>`;
      }).join('')}</div>`).join('')}
      ${st.session.length ? `<h3 class="cc-prov">This trip</h3><ul class="cc-log">${[...st.session].reverse().map(s =>
        `<li class="${s.undone ? 'undone' : ''}">${esc(s.player.emoji)} ${esc(s.player.name)} · <b>${esc(s.plate.code)}</b> ${esc(s.plate.name)} ${s.isNew ? '<span class="new">NEW</span>' : ''}<span class="pts">+${s.points}</span></li>`).join('')}</ul>` : ''}
      ${d.leaderboard.length ? `<h3 class="cc-prov">Top spotters</h3><div class="bg-players">${d.leaderboard.map((r, i) =>
        `<div class="bg-player">${i === 0 ? '👑' : ''}<span class="bg-face">${esc(r.emoji)}</span><b>${esc(r.name)}</b><span class="bg-pts">${r.points}</span></div>`).join('')}</div>` : ''}
      <p class="bg-small">New county = double points (shown on the tile). Rarer counties score more. Each county counts once per trip. Say <i>“undo”</i> to take back a mistake.</p>
      <div class="bg-actions">${st.voice ? `<button class="bg-btn ghost" data-c="tapmode">✋ Tap instead</button>` : V.supported && !st.voiceProblem ? `<button class="bg-btn ghost" data-c="voicemode">🎤 Use voice</button>` : ''}
        <button class="bg-btn ghost" data-c="undo">↩️ Undo</button></div>`;
    }
    root.innerHTML = `<div class="bg-sheet"><div class="bg-head"><span class="bg-title">🗺️ County Collector</span>
      <button class="bg-x" data-c="close" aria-label="Close County Collector">✕</button></div>${body}</div>`;
    setMic(false);
  }

  function onClick(e) {
    const el = e.target.closest('[data-c]');
    if (!el || !st) return;
    const a = el.dataset.c;
    const byKey = k => st.players.find(p => p.type + '-' + p.id === k);
    if (a === 'close') close();
    else if (a === 'retry') { st.error = false; render(); load(); }
    else if (a === 'undo') undo();
    else if (a === 'tapmode') { st.voice = false; listener && listener.stop(); render(); }
    else if (a === 'voicemode') { st.voice = true; render(); if (!listener) listener = V.createListener({ onPhrases: hear, onFatal: () => { st.voice = false; st.voiceProblem = true; render(); }, onState: setMic }); listener.start(); }
    else if (a === 'who') {
      const p = byKey(el.dataset.key);
      if (st.waitingFor) { claim(st.waitingFor, p); return; }
      st.tapPlayer = st.tapPlayer === p ? null : p;
      st.hint = false;
      render();
    } else if (a === 'plate') {
      if (!st.tapPlayer) { st.lastHeard = null; st.hint = true; render(); return; }
      claim(st.plates.find(p => p.code === el.dataset.code), st.tapPlayer);
    }
  }

  function close() {
    if (listener) listener.stop();
    listener = null;
    if (window.speechSynthesis) try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    document.getElementById('county-root')?.remove();
    const cb = st && st.onClose;
    st = null;
    cb && cb();
  }

  function open(opts) {
    if (st) return;
    const saved = LS.get(SETTINGS_KEY, {});
    st = { players: opts.players || [], tripKey: String(opts.tripKey || 'no-trip'), onClose: opts.onClose,
      voice: V.supported && saved.voice !== false, muted: !!saved.muted, session: [], data: null };
    const root = document.createElement('div');
    root.id = 'county-root';
    root.className = 'game-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'County Collector');
    root.addEventListener('click', onClick);
    document.body.appendChild(root);
    render();
    load();
  }

  window.TaxiCounty = { open, close, isOpen: () => !!st, _hear: hear, _state: () => st, _matchPlate: matchPlate };
})();
