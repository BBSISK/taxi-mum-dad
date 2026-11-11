/* Car Bingo: I-spy + bingo for the back seat. A self-contained module.
 *
 *   TaxiBingo.open({ players: [{type:'kid'|'parent', id, name, emoji}], onClose })
 *
 * Voice-first and hands-free: players shout "<name>, <thing>!" ("Jack, red door!").
 * The phone's own speech recognition turns speech into words; matching happens here on the
 * phone, and only "who spotted which item" is sent to the server. No audio is stored.
 * If voice isn't available (or the mic is refused), it falls back to big tap buttons.
 */
(function () {
  'use strict';
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;
  const V = window.TaxiVoice;  // shared voice core (static/games-core.js)
  let listener = null;
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const ALIAS_KEY = 'taxi.bingo.alias';
  const PENDING_KEY = 'taxi.bingo.pending';
  const SETTINGS_KEY = 'taxi.bingo.settings';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mmss = s => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  let st = null;       // current game
  let rec = null;      // SpeechRecognition instance
  let timer = null;

  /* ------------------------------------------------------------ text matching (pure, testable) */
  function norm(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function words(s) {
    return norm(s).split(' ').filter(Boolean).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  }
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const near = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1);
  // index of the first word of `phrase` found as a run inside the heard words, or -1
  function phraseAt(heard, phrase) {
    const pw = words(phrase);
    for (let i = 0; i + pw.length <= heard.length; i++) {
      if (pw.every((w, k) => near(heard[i + k], w))) return i;
    }
    return -1;
  }
  function matchItem(heard, items) {
    let best = null;
    for (const it of items) {
      for (const kw of it.keywords) {
        const at = phraseAt(heard, kw);
        const len = words(kw).length;
        if (at >= 0 && (!best || len > best.len)) best = { item: it, len, at };
      }
    }
    return best ? best.item : null;
  }
  function playerNames(p) {
    return [p.name, ...(LS.get(ALIAS_KEY, {})[p.type + '-' + p.id] || [])].filter(Boolean);
  }
  function matchPlayer(heard, players) {
    let best = null;
    for (const p of players) {
      for (const n of playerNames(p)) {
        const at = phraseAt(heard, n);
        if (at >= 0 && (!best || at < best.at)) best = { p, at };
      }
    }
    return best ? best.p : null;
  }

  /* ------------------------------------------------------------ speech */
  function voiceOn() { return !!Rec && st && st.voice; }
  /* kind: 'info' (silent unless "announce every spot"), 'question' or 'alert' (always spoken unless silent). */
  function say(text, then, kind = 'info') {
    V.say(text, { kind, before: () => listener && listener.pause(),
      after: () => { then && then(); if (listener) listener.resume(); } });
  }
  function startListening() {
    if (!voiceOn()) return;
    if (!listener) listener = V.createListener({
      onPhrases: hear,
      onState: s => { if (st) { st.mic = s; setMic(); } },
      onFatal: () => { if (!st) return; st.voice = false; st.voiceProblem = true; stopListening(); render(); },
      onPause: () => { if (st && st.phase === 'play' && !st.pausedAt) { st.pausedAt = Date.now(); render(); } },  // phone call: stop the clock
      onResume: () => { if (st && st.pausedAt) { st.roundEnd += Date.now() - st.pausedAt; st.pausedAt = 0; render(); } },
      onModeChange: () => { if (st) { st.fellBack = true; render(); } },
    });
    listener.start();
    if (st.phase === 'play') render();  // shows the push-to-talk button when that mode is in use
  }
  function stopListening() { if (listener) { listener.stop(); listener = null; } st && (st.mic = null); setMic(); }
  function pauseListening() { stopListening(); }
  function setMic() {
    const m = document.getElementById('bg-mic');
    if (!m || !st) return;
    const on = st.voice && st.mic && (st.mic.listening || st.mic.pttActive);
    m.className = 'bg-mic' + (on ? ' on' : '');
    m.textContent = st.voice ? V.micChip(st.mic) : '✋ Tap mode';
    const b = document.getElementById('bg-ptt');
    if (b) { b.classList.toggle('on', !!(st.mic && st.mic.pttActive)); b.textContent = st.mic && st.mic.pttActive ? '🎤 Listening… shout it!' : '🎤 Tap, then shout "Jack, red door!"'; }
  }

  /* ------------------------------------------------------------ game logic */
  function remaining() { return st.items.filter(i => !st.found.some(f => f.item.id === i.id)); }

  function hear(alternatives) {
    if (!st || st.phase !== 'play') return;
    const alts = Array.isArray(alternatives) ? alternatives : [alternatives];
    st.lastHeard = alts[0];
    for (const t of alts) {
      const heard = words(t);
      if (heard.includes('peek')) { peek(); return; }
      if (heard.includes('undo')) { undo(); return; }
      const item = matchItem(heard, remaining());
      let player = matchPlayer(heard, st.players);
      if (!item && player && st.waitingFor) { award(st.waitingFor, player); return; }  // "…who spotted it?" "Jack!"
      if (!item) continue;
      if (!player && st.players.length === 1) player = st.players[0];
      if (!player) {
        st.waitingFor = item;
        render();
        say(`${item.label}! Who spotted it?`, () => listener && listener.mode === 'ptt' && listener.push(), 'question');
        return;
      }
      award(item, player);
      return;
    }
    const already = st.found.find(f => alts.some(t => matchItem(words(t), [f.item])));
    if (already) say(`${already.player.name} already got the ${already.item.label.toLowerCase()}`);
    render();
  }

  function award(item, player, viaTap = false) {
    if (st.found.some(f => f.item.id === item.id)) return;
    const recalled = !st.peeked && !viaTap;
    const pts = item.points + (recalled ? st.recallBonus : 0);
    st.found.push({ item, player, recalled, points: pts, at: Date.now() });
    st.waitingFor = null;
    if (navigator.vibrate) try { navigator.vibrate(60); } catch { /* ignore */ }
    render();
    const done = remaining().length === 0;
    say(`${item.label}! ${pts} point${pts === 1 ? '' : 's'} for ${player.name}${recalled ? ', from memory' : ''}.${done ? ' Card cleared!' : ''}`,
      done ? () => end('cleared') : null, done ? 'alert' : 'info');
  }

  function undo() {
    const last = st.found[st.found.length - 1];
    if (!last || Date.now() - last.at > 20000) { say('Nothing to undo'); return; }
    st.found.pop();
    render();
    say(`Undone. ${last.item.label} is back on the card.`);
  }

  function peek() {
    if (st.phase !== 'play' || st.peekUntil > Date.now()) return;
    st.peeked = true;
    st.peekUntil = Date.now() + 5000;
    render();
    setTimeout(render, 5100);
  }

  function tick() {
    if (!st) return;
    const now = Date.now();
    if (st.phase === 'memorise') {
      const left = (st.memoriseEnd - now) / 1000;
      const el = document.getElementById('bg-count');
      if (el) el.textContent = Math.max(0, Math.ceil(left));
      const bar = document.getElementById('bg-bar');
      if (bar) bar.style.width = Math.max(0, 100 * left / st.cfg.memorise_seconds) + '%';
      if (left <= 0) startPlay();
    } else if (st.phase === 'play') {
      if (st.pausedAt) return;  // clock stopped during a phone call
      const left = (st.roundEnd - now) / 1000;
      const el = document.getElementById('bg-time');
      if (el) { el.textContent = mmss(left); el.classList.toggle('low', left < 60); }
      if (left <= 0) end('timeout');
      else if (left < 60 && !st.warned) { st.warned = true; say('One minute left!', null, 'alert'); }
    }
  }

  async function newCard() {
    st.phase = 'loading';
    render();
    try {
      const res = await fetch('/api/bingo/card', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('no card');
      const data = await res.json();
      Object.assign(st, { cfg: data.config, items: data.items, recallBonus: data.recall_bonus, bestLevel: data.best_level,
        found: [], peeked: false, peekUntil: 0, waitingFor: null, tapPlayer: null, result: null, lastHeard: '', warned: false });
      st.phase = 'ready';
    } catch {
      st.phase = 'error';
    }
    render();
  }

  function startMemorise() {
    st.phase = 'memorise';
    st.memoriseEnd = Date.now() + st.cfg.memorise_seconds * 1000;
    render();
    say(`Level ${st.cfg.level}. Remember these: ${st.items.map(i => i.label).join(', ')}.`);
  }

  function startPlay() {
    st.phase = 'play';
    st.roundEnd = Date.now() + st.cfg.round_seconds * 1000;
    render();
    say(st.voice ? 'List hidden! Shout your name and what you see.' : 'List hidden! Tap a name when you spot something.', () => startListening(), 'alert');
  }

  async function end(outcome) {
    if (!st || st.phase === 'end') return;
    st.phase = 'end';
    pauseListening();
    const payload = {
      outcome, items_total: st.items.length,
      found: st.found.map(f => ({ item_id: f.item.id, player: { type: f.player.type, id: f.player.id }, recalled: f.recalled })),
    };
    st.result = { outcome, pending: true };
    render();
    try {
      const res = await fetch('/api/bingo/round', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error('save failed');
      st.result = { outcome, ...(await res.json()) };
    } catch {
      LS.set(PENDING_KEY, [...LS.get(PENDING_KEY, []), payload]);  // no signal: send it next time
      st.result = { outcome, offline: true };
    }
    render();
    const lv = st.result.level;
    if (outcome === 'cleared') say(`Bingo! Card cleared.${lv ? ` Next time: level ${lv}.` : ''}`);
    else if (outcome === 'timeout') say(`Time's up! ${st.found.length} out of ${st.items.length}.${lv ? ` Next time: level ${lv}.` : ''}`);
  }

  async function flushPending() {
    const pending = LS.get(PENDING_KEY, []);
    if (!pending.length) return;
    const left = [];
    for (const p of pending) {
      try {
        const res = await fetch('/api/bingo/round', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
        if (!res.ok) left.push(p);
      } catch { left.push(p); }
    }
    if (left.length) LS.set(PENDING_KEY, left); else LS.del(PENDING_KEY);
  }

  function teachName(p) {
    if (!Rec) return;
    const r = new Rec();
    r.lang = 'en-IE';
    r.maxAlternatives = 3;
    st.teaching = p.type + '-' + p.id;
    render();
    r.onresult = e => {
      const heardAs = Array.from(e.results[0]).map(a => norm(a.transcript)).filter(Boolean);
      const all = LS.get(ALIAS_KEY, {});
      const key = p.type + '-' + p.id;
      all[key] = [...new Set([...heardAs, ...(all[key] || [])])].slice(0, 6);
      LS.set(ALIAS_KEY, all);
      st.teaching = null;
      st.taught = { ...(st.taught || {}), [key]: heardAs[0] };
      render();
      say(`Got it, ${p.name}.`);
    };
    r.onerror = r.onend = () => { if (st && st.teaching) { st.teaching = null; render(); } };
    say(`${p.name}, say your name now.`, () => { try { r.start(); } catch { /* ignore */ } });
  }

  /* ------------------------------------------------------------ view */
  const tierClass = t => 't' + t;
  function playersStrip(withTeach) {
    return `<div class="bg-players">${st.players.map(p => {
      const key = p.type + '-' + p.id, pts = st.found.filter(f => f.player.type === p.type && f.player.id === p.id).reduce((a, f) => a + f.points, 0);
      return `<div class="bg-player">
        <span class="bg-face">${esc(p.emoji)}</span><b>${esc(p.name)}</b>
        ${withTeach ? (Rec ? `<button class="bg-teach" data-b="teach" data-key="${key}">${st.teaching === key ? '👂 listening…' : st.taught?.[key] ? `✅ heard “${esc(st.taught[key])}”` : '🎤 teach my name'}</button>` : '')
          : `<span class="bg-pts">${pts}</span>`}
      </div>`;
    }).join('')}</div>`;
  }
  function render() {
    const root = document.getElementById('bingo-root');
    if (!root || !st) return;
    let body = '';
    const head = `<div class="bg-head"><span class="bg-title">🎯 Car Bingo</span>
      ${st.cfg ? `<span class="bg-level">Level ${st.cfg.level}</span>` : ''}
      ${st.phase === 'play' ? `<span class="bg-time" id="bg-time">${mmss((st.roundEnd - Date.now()) / 1000)}</span>` : ''}
      ${Rec && (st.phase === 'play' || st.phase === 'ready') ? `<button class="bg-x" data-b="gear" aria-label="Voice settings">⚙️</button>` : ''}
      <button class="bg-x" data-b="close" aria-label="Close Car Bingo">✕</button></div>`;

    if (st.phase === 'loading') body = `<div class="bg-center"><div class="bg-big">🎲</div><p>Dealing a card…</p></div>`;
    else if (st.phase === 'error') body = `<div class="bg-center"><div class="bg-big">📵</div><p>Couldn't get a card. Check the signal and try again.</p>
      <button class="bg-btn" data-b="again">Try again</button></div>`;
    else if (st.phase === 'ready') body = `
      <p class="bg-lead">Spot <b>${st.cfg.n_items} things</b> in <b>${st.cfg.round_seconds / 60} minutes</b>. You get <b>${st.cfg.memorise_seconds} seconds</b> to remember the list, then it hides!</p>
      <div class="bg-how">
        ${Rec && st.voice ? `<b>🗣️ Hands-free:</b> shout your name and the thing: <i>“Jack, red door!”</i>. Say <i>“peek”</i> to see the list (no memory bonus) or <i>“undo”</i> to fix a mistake.`
          : `<b>✋ Tap mode:</b> tap the spotter's name, then the thing they saw.`}
      </div>
      ${playersStrip(true)}
      ${Rec ? `<p class="bg-small">Tricky name? Tap “teach my name” and say it once, so the phone learns how it hears you.</p>
        <label class="bg-toggle"><input type="checkbox" data-b="voice" ${st.voice ? 'checked' : ''}> Voice spotting (uses your phone's speech recognition; we only keep who spotted what)</label>`
        : `<p class="bg-small">Voice spotting isn't available in this browser, so it's tap mode. (Chrome on Android and Safari on iPhone usually support it.)</p>`}
      ${st.voiceProblem ? `<p class="bg-warn">🎤 Voice isn't working right now (no microphone access or no signal), so it's tap mode.</p>` : ''}
      ${Rec && st.voice ? settingsBlock() + `<p class="bg-small">“Always on (radio-friendly)” keeps the phone's mic open the whole time so the car radio shouldn't keep cutting out. If it still does in your car, pick push to talk.</p>` : ''}
      <div class="bg-points">Points: everyday 1 · common 2 · lucky 3 · rare 5 · <b>+${st.recallBonus} from memory</b></div>
      <button class="bg-btn big" data-b="go">👀 Show me the list</button>`;
    else if (st.phase === 'memorise') body = `
      <p class="bg-lead">Remember these! Hiding in <b id="bg-count">${st.cfg.memorise_seconds}</b>s</p>
      <div class="bg-barwrap"><div class="bg-bar" id="bg-bar"></div></div>
      <div class="bg-grid">${st.items.map(i => `<div class="bg-card show ${tierClass(i.tier)}"><span class="e">${esc(i.emoji)}</span><span class="l">${esc(i.label)}</span><span class="p">${i.points}</span></div>`).join('')}</div>
      <button class="bg-btn" data-b="ready">Got it, hide the list!</button>`;
    else if (st.phase === 'play') {
      const peeking = st.peekUntil > Date.now();
      body = `
      ${st.pausedAt ? `<p class="bg-warn">⏸️ Paused for a call: the clock has stopped and starts again when the call ends.</p>` : ''}
      <div class="bg-status"><span id="bg-mic" class="bg-mic"></span>
        <span class="bg-heard">${st.voiceProblem && !st.voice ? 'Voice unavailable: tap a name below' : st.waitingFor ? `<b>${esc(st.waitingFor.label)}!</b> Who spotted it?` : st.lastHeard ? `Heard: “${esc(st.lastHeard)}”` : st.voice ? 'Shout: <i>“name, thing!”</i>' : ''}</span></div>
      ${st.waitingFor || st.tapPlayer || !st.voice ? `<div class="bg-whobtns">${st.players.map(p =>
        `<button class="bg-who ${st.tapPlayer && st.tapPlayer.id === p.id && st.tapPlayer.type === p.type ? 'on' : ''}" data-b="who" data-key="${p.type}-${p.id}">${esc(p.emoji)} ${esc(p.name)}</button>`).join('')}</div>` : ''}
      ${st.tapPlayer ? `<p class="bg-small">${esc(st.tapPlayer.name)} spotted… (tap it)</p>
        <div class="bg-grid">${remaining().map(i => `<button class="bg-card show pick ${tierClass(i.tier)}" data-b="pick" data-id="${i.id}"><span class="e">${esc(i.emoji)}</span><span class="l">${esc(i.label)}</span></button>`).join('')}</div>`
      : `<div class="bg-grid">${st.items.map(i => {
          const f = st.found.find(x => x.item.id === i.id);
          if (f) return `<div class="bg-card found ${tierClass(i.tier)}"><span class="e">${esc(i.emoji)}</span><span class="l">${esc(i.label)}</span><span class="by">${esc(f.player.emoji)} ${esc(f.player.name)} +${f.points}${f.recalled ? ' 🧠' : ''}</span></div>`;
          if (peeking) return `<div class="bg-card show ${tierClass(i.tier)}"><span class="e">${esc(i.emoji)}</span><span class="l">${esc(i.label)}</span><span class="p">${i.points}</span></div>`;
          return `<div class="bg-card hidden ${tierClass(i.tier)}"><span class="q">?</span><span class="p">${i.points}</span></div>`;
        }).join('')}</div>`}
      ${st.fellBack ? `<p class="bg-warn">Radio-friendly listening didn't work on this phone, so it's push to talk: tap the big button, then shout.</p>` : ''}
      ${st.voice && listener && listener.mode === 'ptt' ? `<button id="bg-ptt" class="bg-btn big gv-ptt" data-b="ptt">🎤 Tap, then shout "Jack, red door!"</button>` : ''}
      ${playersStrip(false)}
      <div class="bg-actions">
        <button class="bg-btn ghost" data-b="peek" ${peeking ? 'disabled' : ''}>👀 Peek${st.peeked ? '' : ' (lose memory bonus)'}</button>
        ${st.voice ? `<button class="bg-btn ghost" data-b="tapmode">✋ Tap instead</button>` : ''}
        <button class="bg-btn ghost" data-b="undo">↩️ Undo</button>
      </div>
      ${Rec ? `<details class="gv-more" ${st.settingsOpen ? 'open' : ''}><summary>⚙️ Voice settings</summary>${settingsBlock()}</details>` : ''}`;
    } else if (st.phase === 'end') {
      const r = st.result || {};
      const totals = st.players.map(p => ({ p, pts: st.found.filter(f => f.player.type === p.type && f.player.id === p.id).reduce((a, f) => a + f.points, 0) }))
        .sort((a, b) => b.pts - a.pts);
      const up = r.level && r.old_level && r.level > r.old_level, down = r.level && r.old_level && r.level < r.old_level;
      body = `<div class="bg-center">
        <div class="bg-big">${r.outcome === 'cleared' ? '🏆' : r.outcome === 'timeout' ? '⏰' : '🅿️'}</div>
        <h2>${r.outcome === 'cleared' ? 'Bingo! Card cleared' : r.outcome === 'timeout' ? "Time's up!" : 'Round ended'}</h2>
        <p>${st.found.length} of ${st.items.length} spotted</p>
        <ol class="bg-podium">${totals.map((t, i) => `<li>${i === 0 && t.pts ? '👑 ' : ''}${esc(t.p.emoji)} ${esc(t.p.name)} <b>${t.pts}</b></li>`).join('')}</ol>
        <p class="bg-lvl">${r.pending ? 'Saving…' : r.offline ? 'No signal: your points will be saved next time.' :
          up ? `⬆️ Up to <b>level ${r.level}</b> next time!` : down ? `Back to <b>level ${r.level}</b> next time. You'll get it!` : r.level ? `Staying on <b>level ${r.level}</b>.` : ''}</p>
        <button class="bg-btn big" data-b="again">🎲 Play again</button>
        <button class="bg-btn ghost" data-b="close">Back to the meter</button></div>`;
    }
    root.innerHTML = `<div class="bg-sheet">${head}${body}</div>`;
    setMic();
  }

  function onClick(e) {
    const vb = e.target.closest('button[data-bs]');
    if (vb && st) { V.handleSetting(vb.dataset.bs); if (vb.dataset.bs === 'vretry') restartVoice(); render(); return; }
    const el = e.target.closest('[data-b]');
    if (!el || !st) return;
    const a = el.dataset.b;
    const byKey = k => st.players.find(p => p.type + '-' + p.id === k);
    if (a === 'close') {
      if (st.phase === 'play' && st.found.length && !confirm('End this round? Points so far are kept and your level stays the same.')) return;
      if (st.phase === 'play' && st.found.length) { end('quit').then(() => close()); return; }
      close();
    } else if (a === 'go') startMemorise();
    else if (a === 'ready') startPlay();
    else if (a === 'again') newCard();
    else if (a === 'peek') peek();
    else if (a === 'undo') undo();
    else if (a === 'teach') teachName(byKey(el.dataset.key));
    else if (a === 'tapmode') { st.voice = false; pauseListening(); render(); }
    else if (a === 'ptt') listener && listener.push();
    else if (a === 'gear') { st.settingsOpen = true; render(); document.querySelector('#bingo-root .gv-more, #bingo-root .gv-settings')?.scrollIntoView({ behavior: 'smooth' }); }
    else if (a === 'who') {
      const p = byKey(el.dataset.key);
      if (st.waitingFor) { award(st.waitingFor, p); return; }
      st.tapPlayer = st.tapPlayer && st.tapPlayer === p ? null : p;
      render();
    } else if (a === 'pick') {
      const item = st.items.find(i => i.id === el.dataset.id);
      const p = st.tapPlayer;
      st.tapPlayer = null;
      if (item && p) award(item, p, true);
    }
  }
  function settingsBlock() {
    return V.settingsHtml('data-bs').replace('<details class="gv-check">', `<details class="gv-check" ${st.checkOpen ? 'open' : ''}>`);
  }
  function restartVoice() { if (st && st.phase === 'play' && st.voice) { st.fellBack = false; stopListening(); startListening(); } }
  function onChange(e) {
    const vs = e.target.dataset?.bs;
    if (st && vs) { V.handleSetting(vs, e.target.value); if (vs === 'vmode') restartVoice(); render(); return; }
    const a = e.target.dataset?.b;
    if (!st || !a) return;
    if (a === 'voice') st.voice = e.target.checked;
    if (a === 'mute') { st.muted = e.target.checked; if (st.muted && synth) synth.cancel(); }
    LS.set(SETTINGS_KEY, { voice: st.voice, muted: st.muted });
    render();
  }

  function close() {
    pauseListening();
    if (synth) try { synth.cancel(); } catch { /* ignore */ }
    clearInterval(timer);
    timer = null;
    const root = document.getElementById('bingo-root');
    if (root) root.remove();
    const cb = st && st.onClose;
    st = null;
    if (cb) cb();
  }

  function open(opts) {
    if (st) return;
    const saved = LS.get(SETTINGS_KEY, {});
    st = { players: opts.players || [], onClose: opts.onClose, voice: !!Rec && saved.voice !== false, muted: !!saved.muted,
      phase: 'loading', found: [] };
    const root = document.createElement('div');
    root.id = 'bingo-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Car Bingo');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('toggle', e => {
      if (!st) return;
      if (e.target.classList.contains('gv-more')) st.settingsOpen = e.target.open;
      if (e.target.classList.contains('gv-check')) st.checkOpen = e.target.open;
    }, true);
    document.body.appendChild(root);
    timer = setInterval(tick, 120);
    flushPending();
    newCard();
  }

  window.TaxiBingo = { open, close, isOpen: () => !!st,
    // exposed for tests
    _hear: hear, _state: () => st, _match: { words, matchItem, matchPlayer } };
})();
