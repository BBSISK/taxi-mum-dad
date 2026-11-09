/* Shared voice core for the in-car games (Car Bingo, County Collector, and future games).
 *
 * Speech is turned into words by the phone's own speech service; everything is matched here on the phone.
 * Name aliases ("teach my name") are shared by every game.
 *
 * Listening modes (chosen per phone, saved on the device):
 *   radio   "Radio-friendly": the app opens the phone's mic ONCE for the whole game and feeds that stream to
 *           speech recognition (SpeechRecognition.start(track), newer Chrome). The mic is never closed and
 *           reopened, which is what makes car radios and Android Auto drop out every few seconds.
 *   ptt     "Push to talk": nothing listens until someone taps the big mic button. Works everywhere.
 *   classic The original always-listening mode (the browser opens and closes the mic itself).
 * Talk levels: questions (only "who spotted it?" is spoken; everything else is a buzz + the screen),
 *              all (announce every spot), off.
 * Phone calls: Android hands the mic to the call. The listener pauses (onPause('call')) and resumes when the
 * call ends, instead of treating it as a broken mic.
 */
(function () {
  'use strict';
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;
  const ALIAS_KEY = 'taxi.bingo.alias';
  const PREFS_KEY = 'taxi.games.voice';
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  /* ------------------------------------------------------------ text matching */
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
  function phraseAt(heard, phrase) {
    const pw = words(phrase);
    for (let i = 0; i + pw.length <= heard.length; i++) if (pw.every((w, k) => near(heard[i + k], w))) return i;
    return -1;
  }
  const aliasesFor = p => LS.get(ALIAS_KEY, {})[p.type + '-' + p.id] || [];
  function matchPlayer(heard, players) {
    let best = null;
    for (const p of players) for (const n of [p.name, ...aliasesFor(p)]) {
      const at = phraseAt(heard, n);
      if (at >= 0 && (!best || at < best.at)) best = { p, at, len: words(n).length };
    }
    return best;
  }
  function saveAlias(p, heardAs) {
    const all = LS.get(ALIAS_KEY, {}), key = p.type + '-' + p.id;
    all[key] = [...new Set([...heardAs.map(norm).filter(Boolean), ...(all[key] || [])])].slice(0, 6);
    LS.set(ALIAS_KEY, all);
  }

  /* ------------------------------------------------------------ preferences */
  let trackSupport = null;  // null = not checked yet
  function detectTrackSupport() {
    if (trackSupport !== null) return trackSupport;
    trackSupport = false;
    if (!Rec || !navigator.mediaDevices?.getUserMedia) return false;
    // Chrome versions with the newer on-device API also take a MediaStreamTrack.
    if ('available' in Rec || 'processLocally' in Rec.prototype) return (trackSupport = true);
    // Otherwise: a browser that understands start(track) must reject an ended track with InvalidStateError.
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const t = ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
      t.stop();
      const r = new Rec();
      try { r.start(t); try { r.abort(); } catch { /* ignore */ } } catch (e) { trackSupport = e && e.name === 'InvalidStateError'; }
      try { ctx.close(); } catch { /* ignore */ }
    } catch { trackSupport = false; }
    return trackSupport;
  }
  function prefs() {
    const p = LS.get(PREFS_KEY, {});
    return { mode: p.mode || 'auto', talk: p.talk || 'questions' };
  }
  function setPrefs(change) { LS.set(PREFS_KEY, { ...prefs(), ...change }); }
  /* The mode actually used on this phone right now. */
  function resolveMode(mode = prefs().mode) {
    if (!Rec) return 'off';
    if (mode === 'auto') return detectTrackSupport() ? 'radio' : 'ptt';
    if (mode === 'radio' && !detectTrackSupport()) return 'ptt';
    return mode;
  }

  /* ------------------------------------------------------------ announcer */
  /* kind: 'question' (always spoken unless talk is off) or 'info' (spoken only when talk is 'all').
     Never gets stuck if a phone forgets to fire onend. */
  function say(text, { kind = 'info', muted = false, talk = prefs().talk, before, after } = {}) {
    const speak = synth && !muted && talk !== 'off' && (talk === 'all' || kind !== 'info');  // 'question' and 'alert' always speak
    if (!speak) {
      if (kind === 'info' && navigator.vibrate) try { navigator.vibrate(60); } catch { /* ignore */ }
      after && after();
      return false;
    }
    try {
      before && before();
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = synth.getVoices().find(x => /en-IE/i.test(x.lang)) || synth.getVoices().find(x => /en-GB/i.test(x.lang));
      if (v) u.voice = v;
      u.rate = 1.05;
      let done = false;
      const finish = () => { if (!done) { done = true; after && after(); } };
      u.onend = u.onerror = finish;
      setTimeout(finish, 1500 + text.length * 85);
      synth.speak(u);
    } catch { after && after(); }
    return true;
  }

  /* ------------------------------------------------------------ microphone */
  async function openPhoneMic() {
    const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    let stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    // Prefer the phone's own mic over a car or Bluetooth hands-free mic when the phone lets us choose.
    try {
      const mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.label);
      const current = stream.getAudioTracks()[0].getSettings().deviceId;
      const isCar = d => /bluetooth|car|headset|hands.?free|sco/i.test(d.label);
      const phone = mics.find(d => !isCar(d) && /speaker|built|phone|bottom|internal/i.test(d.label)) || mics.find(d => !isCar(d));
      const cur = mics.find(d => d.deviceId === current);
      if (phone && cur && isCar(cur) && phone.deviceId !== current) {
        stream.getTracks().forEach(t => t.stop());
        stream = await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: { exact: phone.deviceId } } });
      }
    } catch { /* keep the default mic */ }
    return stream;
  }

  /* createListener({ onPhrases(alts[]), onFatal(reason), onState({listening, mode, paused, pttActive}), onPause(why), onResume() })
     returns { start, stop, pause, resume, push, mode, deaf(bool) } */
  function createListener({ onPhrases, onFatal, onState, onPause, onResume } = {}) {
    const mode = resolveMode();
    let rec = null, wanted = false, paused = false, call = false, errors = 0, stream = null, deaf = false, ptt = false;
    const state = () => onState && onState({ listening: !!rec && !paused && !call, mode, paused: paused || call, call, pttActive: ptt });
    const live = () => stream && stream.getAudioTracks()[0] && stream.getAudioTracks()[0].readyState === 'live';

    function newRec(continuous) {
      const r = new Rec();
      r.lang = 'en-IE';
      r.continuous = continuous;
      r.interimResults = false;
      r.maxAlternatives = 3;
      r.onresult = e => {
        errors = 0;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal && !deaf) onPhrases(Array.from(e.results[i]).map(a => a.transcript));
        }
      };
      r.onerror = e => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        // A phone call (or the app going to the background) takes the mic: pause, don't give up.
        if (callLikely()) { enterCall(false); return; }
        const fatal = ['not-allowed', 'service-not-allowed'].includes(e.error);
        errors += 1;
        if (fatal || errors >= 3) { wanted = false; stopAll(); onFatal && onFatal(e.error); }
      };
      return r;
    }
    const callLikely = () => document.hidden || (stream && !live());

    /* radio + classic: keep a recogniser running; radio feeds it the one open mic stream */
    async function run() {
      if (!Rec || rec || !wanted || paused || call || mode === 'ptt') return;
      if (mode === 'radio') {
        if (!live()) {
          try { stream = await openPhoneMic(); } catch (e) {
            if (document.hidden) { enterCall(false); return; }
            wanted = false; state(); onFatal && onFatal('not-allowed'); return;
          }
          watchTrack(stream.getAudioTracks()[0]);
          if (!wanted || paused) { closeStream(); return; }
        }
      }
      rec = newRec(true);
      rec.onend = () => { rec = null; state(); if (wanted && !paused && !call) setTimeout(run, mode === 'radio' ? 50 : 250); };
      try { mode === 'radio' ? rec.start(stream.getAudioTracks()[0]) : rec.start(); } catch { rec = null; }
      state();
    }
    function stopRec() { ptt = false; if (rec) { const r = rec; rec = null; r.onend = null; try { r.abort(); } catch { /* ignore */ } } }
    function closeStream() { if (stream) { stream.getTracks().forEach(t => { t.onmute = t.onunmute = t.onended = null; t.stop(); }); stream = null; } }
    function stopAll() { stopRec(); closeStream(); ptt = false; state(); }

    let retry = null;
    function watchTrack(t) {
      t.onmute = () => enterCall(true);   // call started: keep the stream, wait for the mic to come back
      t.onunmute = () => leaveCall();
      t.onended = () => enterCall(false);
    }
    function enterCall(keepStream) {
      if (!wanted) return;
      if (!keepStream) closeStream();
      if (call) return;
      call = true;
      stopRec();
      state();
      onPause && onPause('call');
      clearInterval(retry);
      // If the browser stays on screen (e.g. the call shows on the car screen), check back every few seconds.
      retry = setInterval(async () => {
        if (!call || document.hidden) return;
        if (mode !== 'radio') { leaveCall(); return; }
        if (stream && live() && !stream.getAudioTracks()[0].muted) { leaveCall(); return; }
        if (!live()) {
          try { stream = await openPhoneMic(); watchTrack(stream.getAudioTracks()[0]); if (!stream.getAudioTracks()[0].muted) leaveCall(); }
          catch { /* still busy: try again later */ }
        }
      }, mode === 'radio' ? 6000 : 15000);
    }
    function leaveCall() {
      if (!call) return;
      call = false;
      clearInterval(retry);
      state();
      onResume && onResume();
      if (wanted && !paused) setTimeout(run, 400);
    }
    const onVis = () => { if (document.hidden) enterCall(false); else setTimeout(leaveCall, 600); };
    document.addEventListener('visibilitychange', onVis);

    return {
      mode,
      start() { wanted = true; paused = false; run(); state(); },
      stop() { wanted = false; clearInterval(retry); call = false; document.removeEventListener('visibilitychange', onVis); stopAll(); },
      /* Speaking: radio mode keeps the mic open and just ignores what it hears (no reopen, no dropout). */
      pause() { if (mode === 'radio') { deaf = true; return; } paused = true; stopRec(); state(); },
      resume() { if (mode === 'radio') { setTimeout(() => { deaf = false; }, 300); return; } paused = false; setTimeout(run, 150); },
      /* Push to talk: one utterance, then the mic closes again. */
      push() {
        if (!Rec || ptt || call) return;
        stopRec();
        ptt = true;
        state();
        const r = newRec(false);
        rec = r;
        r.onend = () => { if (rec === r) rec = null; ptt = false; state(); if (mode !== 'ptt' && wanted && !paused) setTimeout(run, 150); };
        try { r.start(); } catch { rec = null; ptt = false; state(); }
      },
      isCall: () => call,
    };
  }

  function listenOnce(onText, onDone) {
    if (!Rec) { onDone && onDone(); return; }
    const r = new Rec();
    r.lang = 'en-IE';
    r.maxAlternatives = 3;
    r.onresult = e => onText(Array.from(e.results[0]).map(a => a.transcript));
    r.onend = () => onDone && onDone();
    try { r.start(); } catch { onDone && onDone(); }
  }

  /* ------------------------------------------------------------ shared UI bits */
  const MODE_LABEL = { radio: '🎧 Always on (radio-friendly)', ptt: '👆 Push to talk', classic: '🎤 Always on (classic)' };
  function settingsHtml(attr) {
    const p = prefs(), actual = resolveMode(p.mode), track = detectTrackSupport();
    const opt = (v, label, dis) => `<option value="${v}" ${p.mode === v ? 'selected' : ''} ${dis ? 'disabled' : ''}>${label}</option>`;
    return `<div class="gv-settings">
      <label>Listening <select ${attr}="vmode">
        ${opt('auto', `Best for this phone (${actual === 'radio' ? 'always on' : 'push to talk'})`)}
        ${opt('radio', MODE_LABEL.radio + (track ? '' : ' – not on this phone'), !track)}
        ${opt('ptt', MODE_LABEL.ptt)}
        ${opt('classic', MODE_LABEL.classic + ' – may interrupt the radio')}
      </select></label>
      <label>Talking <select ${attr}="vtalk">
        <option value="questions" ${p.talk === 'questions' ? 'selected' : ''}>Only when it needs an answer</option>
        <option value="all" ${p.talk === 'all' ? 'selected' : ''}>Announce every spot</option>
        <option value="off" ${p.talk === 'off' ? 'selected' : ''}>Silent</option>
      </select></label></div>`;
  }
  function micChip(s) {
    if (!s) return '🎤 …';
    if (s.call) return '⏸️ Paused for a call';
    if (s.mode === 'ptt') return s.pttActive ? '🎤 Listening…' : '👆 Push to talk';
    return s.listening ? (s.mode === 'radio' ? '🎧 Listening' : '🎤 Listening…') : '🎤 …';
  }

  window.TaxiVoice = { supported: !!Rec, norm, words, near, phraseAt, matchPlayer, saveAlias, say, createListener, listenOnce,
    prefs, setPrefs, resolveMode, detectTrackSupport, settingsHtml, micChip, MODE_LABEL };
})();
