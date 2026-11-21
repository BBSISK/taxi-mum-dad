/* Native extras for the iPhone/Android app shells (Capacitor). Does nothing in a normal browser.
 *
 * - Share: WhatsApp links without a phone number open the phone's own share sheet (WhatsApp, Messages, AirDrop…).
 * - Haptics: a small buzz on surcharges, starting/stopping the meter and printing a receipt.
 * - Job reminders: a local notification at 6pm on the day a promised job is due (opt-in, works with the app closed).
 *
 * The web app calls TaxiNative.onState(S) after every refresh and TaxiNative.settingsCard() in Settings.
 */
(function () {
  'use strict';
  const Cap = window.Capacitor;
  const native = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const PREF = 'taxi.native.reminders';   // 'on' | 'off' | absent (not asked yet)
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  function plugin(name) {
    if (!native) return null;
    return (Cap.Plugins && Cap.Plugins[name]) || (typeof Cap.registerPlugin === 'function' ? Cap.registerPlugin(name) : null);
  }
  const Share = plugin('Share'), Haptics = plugin('Haptics'), Notes = plugin('LocalNotifications');

  /* ---------------------------------------------------------------- share sheet */
  async function share(text, url) {
    if (!Share) return false;
    try { await Share.share({ text, url, dialogTitle: 'Share' }); return true; } catch { return true; }  // user cancelled: still handled
  }
  if (native) {
    document.addEventListener('click', e => {
      const a = e.target.closest && e.target.closest('a[href^="https://wa.me/?"], a[href^="https://wa.me?"]');
      if (!a || !Share) return;  // links with a phone number (wa.me/353…) go straight to that WhatsApp chat
      const text = new URL(a.href).searchParams.get('text') || '';
      e.preventDefault();
      share(text);
    }, true);
  }

  /* ---------------------------------------------------------------- haptics */
  const BUZZ = { liveCharge: 'MEDIUM', liveUndo: 'LIGHT', startMeter: 'HEAVY', stopMeter: 'HEAVY', issue: 'MEDIUM', rate: 'LIGHT' };
  if (native && Haptics) {
    document.addEventListener('click', e => {
      const el = e.target.closest && e.target.closest('[data-act]');
      const style = el && BUZZ[el.dataset.act];
      if (style) Haptics.impact({ style }).catch(() => {});
    }, true);
  }

  /* ---------------------------------------------------------------- job reminders */
  const remindersOn = () => LS.get(PREF) === 'on';
  function at6pm(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(y, m - 1, d, 18, 0, 0);
  }
  async function schedule(promises) {
    if (!Notes || !remindersOn()) return;
    try {
      const perm = await Notes.checkPermissions();
      if (perm.display !== 'granted') return;
      const now = Date.now();
      const wanted = (promises || []).filter(p => p.due_on && at6pm(p.due_on).getTime() > now + 60000);
      const pending = (await Notes.getPending()).notifications || [];
      const wantedIds = new Set(wanted.map(p => p.id));
      const stale = pending.filter(n => !wantedIds.has(n.id));
      if (stale.length) await Notes.cancel({ notifications: stale.map(n => ({ id: n.id })) });
      if (!wanted.length) return;
      await Notes.schedule({
        notifications: wanted.map(p => ({
          id: p.id,
          title: `${p.kid_emoji} ${p.kid}'s job is due today`,
          body: `${p.emoji} ${p.label} (−${p.credits}). Tick it off in the app when it's done.`,
          schedule: { at: at6pm(p.due_on), allowWhileIdle: true },
        })),
      });
    } catch { /* reminders are a nice-to-have: never break the app */ }
  }
  let lastPromises = [];
  async function turnOn() {
    if (!Notes) return false;
    try {
      let perm = await Notes.checkPermissions();
      if (perm.display !== 'granted') perm = await Notes.requestPermissions();
      if (perm.display !== 'granted') { LS.set(PREF, 'off'); return false; }
      LS.set(PREF, 'on');
      await schedule(lastPromises);
      return true;
    } catch { return false; }
  }
  async function turnOff() {
    LS.set(PREF, 'off');
    if (!Notes) return;
    try {
      const pending = (await Notes.getPending()).notifications || [];
      if (pending.length) await Notes.cancel({ notifications: pending.map(n => ({ id: n.id })) });
    } catch { /* ignore */ }
  }

  window.TaxiNative = {
    native,
    share,
    onState(S) { lastPromises = (S && S.promises) || []; schedule(lastPromises); },
    /* Shown on Home the first time a family has a promised job, so permission is asked in context. */
    reminderNudge(S) {
      if (!Notes || LS.get(PREF) || !(S && S.promises && S.promises.length)) return '';
      return `<div class="card" id="remind-nudge"><b>🔔 Remind you when jobs are due?</b>
        <p class="small muted" style="margin:6px 0 10px">We'll send a reminder at 6pm on the day a promised job is due, so nobody wriggles out of the dishes.</p>
        <div class="grid2"><button class="btn slim" data-act="nativeReminders" data-val="on">Yes please</button>
        <button class="btn white slim" data-act="nativeReminders" data-val="off">No thanks</button></div></div>`;
    },
    settingsCard() {
      if (!Notes) return '';
      return `<div class="card"><h2 style="margin-top:0">🔔 Job reminders</h2>
        <p class="small muted">A reminder at 6pm on the day a promised job is due. Set on this phone only.</p>
        <button class="btn ${remindersOn() ? 'white' : ''}" data-act="nativeReminders" data-val="${remindersOn() ? 'off' : 'on'}">
          ${remindersOn() ? 'Turn reminders off' : 'Turn reminders on'}</button></div>`;
    },
    async setReminders(on) { return on ? turnOn() : (await turnOff(), false); },
  };
})();
