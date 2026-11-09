/* Shared voice helpers for the in-car games (County Collector now; Car Bingo will move onto it later).
 * Speech is turned into words by the phone's own speech service; everything is matched here on the phone.
 * Name aliases ("teach my name") are shared with Car Bingo, so a name taught once works in every game.
 */
(function () {
  'use strict';
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  const synth = window.speechSynthesis;
  const ALIAS_KEY = 'taxi.bingo.alias';
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

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

  /* Announcer: never gets stuck if a phone forgets to fire onend. */
  function say(text, { muted = false, before, after } = {}) {
    if (!synth || muted) { after && after(); return; }
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
  }

  /* Continuous listener that restarts after silence and gives up (tap mode) after repeated errors. */
  function createListener({ onPhrases, onFatal, onState }) {
    let rec = null, wanted = false, paused = false, errors = 0;
    const state = () => onState && onState(!!rec && !paused);
    function start() {
      if (!Rec || rec || !wanted || paused) return;
      rec = new Rec();
      rec.lang = 'en-IE';
      rec.continuous = true;
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      rec.onresult = e => {
        errors = 0;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) onPhrases(Array.from(e.results[i]).map(a => a.transcript));
        }
      };
      rec.onerror = e => {
        const fatal = ['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error);
        if (!fatal && (e.error === 'no-speech' || e.error === 'aborted')) return;
        errors += 1;
        if (fatal || errors >= 3) { wanted = false; stopNow(); onFatal && onFatal(e.error); }
      };
      rec.onend = () => { rec = null; state(); if (wanted && !paused) setTimeout(start, 250); };
      try { rec.start(); } catch { rec = null; }
      state();
    }
    function stopNow() { if (rec) { try { rec.abort(); } catch { /* ignore */ } rec = null; } state(); }
    return {
      start() { wanted = true; paused = false; start(); },
      stop() { wanted = false; stopNow(); },
      pause() { paused = true; stopNow(); },
      resume() { paused = false; setTimeout(start, 150); },
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

  window.TaxiVoice = { supported: !!Rec, norm, words, near, phraseAt, matchPlayer, saveAlias, say, createListener, listenOnce };
})();
