'use strict';
/* Taxi of Mum & Dad - vanilla JS PWA. No build step, no framework. */

const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

const PARENT_EMOJI = ['👩', '👨', '🧔', '👱‍♀️', '👵', '👴', '🧑', '🦸'];
const KID_EMOJI = ['🧒', '👧', '👦', '🧑', '🦄', '🐯', '⚽', '🎮', '🎨', '🦖', '🐱', '🌟'];
const JOB_EMOJI = ['⭐', '🧹', '🍽️', '🛏️', '🌳', '👵', '📚', '🐕', '🚲', '🎹', '🧺', '💪'];
const PLACES = ['🏫 School', '⚽ Training', '🏠 Friend\'s house', '👵 Granny\'s', '🛒 Shops', '🎉 Party', '🎭 Drama', '🏊 Swimming'];

let S = LS.get('taxi.state');      // cached server state (instant start, works offline-ish)
let view = { name: 'boot' };
let picks = {};                    // emoji picker selections, keyed by group
let tickTimer = null, gpsWatch = null, wakeLock = null;
const app = $('#app');

/* ------------------------------------------------------------------ API */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* not json */ }
  if (res.status === 401) { S = null; LS.del('taxi.state'); go('welcome'); throw new Error('Please sign in first'); }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
}
async function refresh() { S = await api('/api/state'); LS.set('taxi.state', S); return S; }

/* ------------------------------------------------------------------ helpers */
const cur = () => S?.family?.currency || 'Taxi Tokens';
const kidById = id => S?.kids.find(k => k.id === id);
const stars = n => n ? '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n)) : '';
const mmss = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

function go(name, params = {}) {
  view = { name, ...params };
  render();
  window.scrollTo(0, 0);
}

function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>` + (undo ? '<button type="button">Undo</button>' : '');
  if (undo) t.querySelector('button').onclick = () => { t.classList.remove('show'); undo(); };
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), undo ? 6000 : 3000);
}
const oops = err => toast('😬 ' + (err.message || err));

function modal(html) {
  const m = $('#modal');
  m.innerHTML = `<div class="card">${html}<button class="btn white" style="margin-top:12px" data-act="closeModal">Close</button></div>`;
  m.hidden = false;
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

function confetti(chars = ['🚕', '⭐', '🎉', '🪙']) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let i = 0; i < 26; i++) {
    const c = document.createElement('span');
    c.className = 'confetti';
    c.textContent = chars[i % chars.length];
    c.style.left = Math.random() * 100 + 'vw';
    c.style.animationDuration = 1.6 + Math.random() * 1.6 + 's';
    c.style.animationDelay = Math.random() * .4 + 's';
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 4000);
  }
}

function emojiPicker(group, list, current) {
  if (!picks[group]) picks[group] = current || list[0];
  return `<div class="emoji-pick">${list.map(e =>
    `<button type="button" class="${picks[group] === e ? 'on' : ''}" data-act="pick" data-group="${group}" data-val="${esc(e)}" aria-label="${esc(e)}">${e}</button>`).join('')}</div>`;
}

function header(title, sub = '', back = null) {
  return `<header class="top"><h1>${back ? `<button class="back" data-act="go" data-to="${back}" aria-label="Back">←</button>` : ''}${title}</h1>
    ${sub ? `<div class="sub">${sub}</div>` : '<div style="height:8px"></div>'}<div class="checker"></div></header>`;
}

function nav(active) {
  const b = (to, icon, label, cls = '') => `<button class="${cls} ${active === to ? 'on' : ''}" data-act="${to === 'start' ? 'startOrResume' : 'go'}" data-to="${to}"><span class="i">${icon}</span>${label}</button>`;
  return `<nav class="bottom"><div class="wrap">${b('home', '🏠', 'Home')}${b('start', '🚕', 'Start trip', 'go')}${b('settings', '⚙️', 'Settings')}</div></nav>`;
}

const val = id => ($('#' + id)?.value || '').trim();

/* ------------------------------------------------------------------ fare maths (mirrors server) */
function fareNow(rates, km, minutes, extraKeys = []) {
  const extras = (S?.extras || []).filter(e => extraKeys.includes(e.key)).reduce((a, e) => a + e.credits, 0);
  return rates.flag_fall + km * rates.per_km + minutes * rates.per_min + extras;
}

/* ------------------------------------------------------------------ views */
const VIEWS = {
  boot: () => `<div class="boot">🚕</div>`,

  welcome() {
    const code = new URLSearchParams(location.search).get('join') || '';
    return `
    <section class="hero">
      <div class="sign">TAXI</div>
      <h1>Taxi of Mum &amp; Dad</h1>
      <p class="muted">Run the meter on every lift. Send a cheeky receipt.<br>Let them pay it off with jobs, granny visits and fresh air.</p>
    </section>
    ${code ? '' : `
    <div class="card">
      <h2 style="margin-top:0">🚖 Start your taxi firm</h2>
      <label class="f" for="w-fam">Firm name</label>
      <input id="w-fam" type="text" maxlength="80" placeholder="e.g. Murphy Cabs Ltd.">
      <label class="f" for="w-name">Your driver name</label>
      <input id="w-name" type="text" maxlength="40" placeholder="Mum, Dad, Da, Mam…">
      <label class="f">Your face</label>
      ${emojiPicker('new', PARENT_EMOJI)}
      <div style="height:14px"></div>
      <button class="btn" data-act="createFamily">Open for business 🚦</button>
    </div>`}
    <div class="card">
      <h2 style="margin-top:0">🤝 Join your co-driver</h2>
      <label class="f" for="j-code">Invite code</label>
      <input id="j-code" type="text" maxlength="16" placeholder="TAXI-XXXXXX" value="${esc(code)}" autocapitalize="characters">
      <label class="f" for="j-name">Your driver name</label>
      <input id="j-name" type="text" maxlength="40" placeholder="Dad">
      <label class="f">Your face</label>
      ${emojiPicker('join', PARENT_EMOJI, '👨')}
      <div style="height:14px"></div>
      <button class="btn white" data-act="joinFamily">Join the firm</button>
    </div>`;
  },

  home() {
    const meter = LS.get('taxi.meter');
    const draft = LS.get('taxi.end');
    const kids = S.kids;
    const drivers = [...S.drivers];
    const best = drivers.filter(d => d.driver_stars).sort((a, b) => b.driver_stars - a.driver_stars)[0];
    return header(`🚕 ${esc(S.family.name)}`, `On duty: ${esc(S.me.emoji)} ${esc(S.me.name)}`) + `
    ${meter ? `<button class="btn big-go resume" data-act="go" data-to="meter"><span class="lamp">⏱️</span> METER RUNNING - TAP</button>`
      : draft ? `<button class="btn big-go resume" data-act="go" data-to="end"><span class="lamp">🧾</span> FINISH RECEIPT</button>`
      : `<button class="btn big-go" data-act="go" data-to="start"><span class="lamp">🚦</span> START THE METER</button>`}

    <h2>Passengers &amp; their tabs</h2>
    ${kids.length ? `<div class="kids">${kids.map(k => `
      <button class="card kidcard" data-act="kid" data-id="${k.id}">
        <div class="face">${esc(k.emoji)}</div>
        <div class="name">${esc(k.name)}</div>
        <div class="bal ${k.balance > 0 ? 'owes' : 'clear'}">${k.balance > 0 ? k.balance : (k.balance < 0 ? '+' + (-k.balance) : '0')}</div>
        <div class="small muted">${k.balance > 0 ? 'owes ' + esc(cur()) : k.balance < 0 ? 'in credit 😇' : 'all square 🎉'}</div>
        ${k.passenger_stars ? `<div class="small">${stars(k.passenger_stars)}</div>` : ''}
      </button>`).join('')}</div>`
      : `<div class="empty"><p>No passengers yet. Who's always looking for a lift?</p><button class="btn slim" data-act="kidEdit">➕ Add a passenger</button></div>`}

    <h2>Driver of the month 🏆</h2>
    <div class="league">${drivers.map(d => `
      <div class="card">
        <div class="crown">${best && best.id === d.id ? '👑' : ''}</div>
        <div class="face">${esc(d.emoji)}</div>
        <div><b>${esc(d.name)}</b></div>
        <div class="stars">${d.driver_stars ? '★ ' + d.driver_stars : '-'}</div>
        <div class="small muted">${d.trips} trip${d.trips === 1 ? '' : 's'}</div>
      </div>`).join('')}
      ${drivers.length < 2 ? `<button class="card" style="cursor:pointer;font:inherit" data-act="go" data-to="settings"><div class="crown"></div><div class="face">➕</div><b>Invite your co-driver</b><div class="small muted">and settle Mum vs Dad</div></button>` : ''}
    </div>
    <p class="small muted center">Passengers rate drivers from their receipt link. Last 30 days.</p>

    <h2>Recent trips</h2>
    ${S.trips.length ? `<div class="card"><ul class="list">${S.trips.map(t => `
      <li data-act="trip" data-id="${t.id}" style="cursor:pointer">
        <span style="font-size:24px">${t.passengers.map(p => esc(p.emoji)).join('')}</span>
        <span class="grow"><b class="ellipsis" style="display:block">${esc(t.note || 'Ride with ' + t.driver)}</b>
          <span class="small muted">${esc(t.driver_emoji)} ${esc(t.when)} · ${t.distance_km} km${t.passengers.some(p => p.driver_stars) ? ' · rated ⭐' : ''}</span></span>
        <span class="amt plus">${t.total_fare}</span>
      </li>`).join('')}</ul></div>` : `<div class="empty">No trips yet - the meter's waiting 🚦</div>`}
    ` + nav('home');
  },

  start() {
    const sel = view.sel || (view.sel = S.kids.length === 1 ? [S.kids[0].id] : []);
    return header('🚦 New trip', 'Who\'s in the back?', 'home') + `
    ${S.kids.length ? `<div class="chips">${S.kids.map(k =>
      `<button class="chip kid ${sel.includes(k.id) ? 'on' : ''}" data-act="toggleKid" data-id="${k.id}">${esc(k.emoji)} ${esc(k.name)}</button>`).join('')}</div>`
      : `<div class="empty"><p>Add a passenger first.</p><button class="btn slim" data-act="kidEdit">➕ Add a passenger</button></div>`}
    <h2>Where to? <span class="small muted">(optional)</span></h2>
    <input id="s-note" type="text" maxlength="80" placeholder="Football training" value="${esc(view.note || '')}">
    <div class="chips" style="margin-top:10px">${PLACES.map(p => `<button class="chip" data-act="place" data-val="${esc(p)}">${esc(p)}</button>`).join('')}</div>
    <div style="height:20px"></div>
    <button class="btn big-go" data-act="startMeter" ${sel.length ? '' : 'disabled'}><span class="lamp">🚕</span> GO!</button>
    <p class="center"><button class="link" data-act="manualTrip" ${sel.length ? '' : 'disabled'}>Already there? Enter the trip by hand</button></p>
    ` + nav('start');
  },

  meter() {
    const m = LS.get('taxi.meter');
    if (!m) { setTimeout(() => go('home')); return ''; }
    return `
    <div style="height:calc(14px + env(safe-area-inset-top))"></div>
    <div class="roofsign"><span>HIRED</span></div>
    <div class="meter">
      <div class="label">FARE</div>
      <div class="fare" id="m-fare">0.0</div>
      <div class="cur">${esc(m.rates.currency)}</div>
      <div class="stats">
        <div><span class="label">TIME</span><b id="m-time">0:00</b></div>
        <div><span class="label">KM</span><b id="m-km">0.0</b></div>
      </div>
      <div class="gps" id="m-gps">📡 Finding GPS…</div>
    </div>
    <p class="center" style="font-size:22px;margin:16px 0">${m.kids.map(k => esc(k.emoji) + ' ' + esc(k.name)).join(' &nbsp; ')}${m.note ? `<br><span class="small muted">→ ${esc(m.note)}</span>` : ''}</p>
    <button class="btn dark big-go" data-act="stopMeter">🛑 STOP &amp; PRINT</button>
    <p class="small muted center">Keep this screen open while you drive (it stays awake). Phones pause GPS when locked, so you can fix the km at the end.</p>
    <p class="center"><button class="link" data-act="cancelMeter">Cancel this trip</button></p>`;
  },

  end() {
    const d = LS.get('taxi.end');
    if (!d) { setTimeout(() => go('home')); return ''; }
    const rates = S.family;
    const total = Math.max(1, Math.round(fareNow(rates, +d.km || 0, +d.minutes || 0, d.extras)));
    const n = d.kidIds.length;
    return header('🧾 End of trip', esc(d.note || 'Nearly there - add the extras'), null) + `
    <div class="grid2">
      <div><label class="f" for="e-km">Distance (km)</label><input id="e-km" type="number" inputmode="decimal" min="0" step="0.1" value="${esc(d.km)}" data-input="km"></div>
      <div><label class="f" for="e-min">Time (minutes)</label><input id="e-min" type="number" inputmode="numeric" min="0" step="1" value="${esc(d.minutes)}" data-input="minutes"></div>
    </div>

    <h2>Surcharges 😈</h2>
    <div class="chips">${S.extras.map(e =>
      `<button class="chip ${d.extras.includes(e.key) ? 'on' : ''}" data-act="toggleExtra" data-key="${e.key}">${esc(e.label)} +${e.credits}</button>`).join('')}</div>

    <h2>Rate your passenger${n > 1 ? 's' : ''}</h2>
    <p class="small muted" style="margin-top:-4px">5-star passengers get ${Math.round(S.five_star_discount * 100)}% off. Be fair 😇</p>
    ${d.kidIds.map(id => {
      const k = kidById(id) || { name: '?', emoji: '🧒' };
      const r = d.ratings[id] || { stars: 0, tags: [] };
      return `<div class="card">
        <div class="row" style="justify-content:space-between"><b style="flex:0 1 auto;font-size:18px">${esc(k.emoji)} ${esc(k.name)}</b>
          <div class="stars-pick" style="flex:0 0 auto">${[1, 2, 3, 4, 5].map(i =>
            `<button class="${r.stars >= i ? 'on' : ''}" data-act="rate" data-id="${id}" data-val="${i}" aria-label="${i} stars">⭐</button>`).join('')}</div></div>
        <div class="chips" style="margin-top:10px">${S.passenger_tags.map(t =>
          `<button class="chip ${r.tags.includes(t) ? 'on' : ''}" data-act="tag" data-id="${id}" data-val="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      </div>`;
    }).join('')}

    <div class="preview"><span>Trip total${n > 1 ? `<br><span class="small">split ${n} ways</span>` : ''}</span><b id="e-total">${total}</b></div>
    <button class="btn big-go" data-act="issue"><span class="lamp">🧾</span> PRINT RECEIPT${n > 1 ? 'S' : ''}</button>
    <p class="center"><button class="link" data-act="discard">Discard this trip</button></p>`;
  },

  trip() {
    const t = view.trip || S.trips.find(x => x.id === view.id);
    if (!t) { setTimeout(() => go('home')); return ''; }
    return header(view.fresh ? '🧾 Receipts printed!' : '🧾 Trip', `${esc(t.when)} · ${t.distance_km} km · ${t.minutes} min · ${esc(t.driver_emoji)} ${esc(t.driver)}`, 'home') + `
    ${t.passengers.map(p => `
      <div class="ticket">
        <div class="row" style="justify-content:space-between"><b style="font-size:20px">${esc(p.emoji)} ${esc(p.name)}</b><span class="small">${p.passenger_stars ? stars(p.passenger_stars) : ''}</span></div>
        <div class="small">OWES</div>
        <div class="owe">${p.fare} <span class="small">${esc(cur())}</span></div>
        ${p.discount ? `<div class="small">⭐ includes ${p.discount} five-star discount</div>` : ''}
        ${p.driver_stars ? `<div class="small" style="margin-top:6px">Their review: driver ${stars(p.driver_stars)} · journey ${stars(p.journey_stars)}${p.kid_comment ? `<br>“${esc(p.kid_comment)}”` : ''}</div>` : ''}
        <div style="height:12px"></div>
        <a class="btn green" href="${esc(waLink(t, p))}" target="_blank" rel="noopener">💬 Send on WhatsApp</a>
        <div class="grid2" style="margin-top:10px">
          <button class="btn white" data-act="qr" data-token="${esc(p.token)}" data-name="${esc(p.name)}">▦ Show QR</button>
          <a class="btn white" href="${esc(p.receipt_url)}" target="_blank" rel="noopener">👀 View</a>
        </div>
      </div>`).join('')}
    <button class="btn" data-act="go" data-to="home">Done 👍</button>
    ${view.fresh ? '' : `<p class="center"><button class="link" data-act="deleteTrip" data-id="${t.id}">Delete this trip (removes the fares)</button></p>`}
    ` + nav('');
  },

  kid() {
    const k = kidById(view.id);
    if (!k) { setTimeout(() => go('home')); return ''; }
    return header(`${esc(k.emoji)} ${esc(k.name)}`, 'Passenger account', 'home') + `
    <div class="card balance-hero">
      <div class="num ${k.balance > 0 ? 'owes' : 'clear'}" id="k-bal">${k.balance}</div>
      <div class="muted">${esc(cur())} ${k.balance > 0 ? 'on the tab' : k.balance < 0 ? '(in credit!)' : '- all square 🎉'}</div>
      ${k.passenger_stars ? `<div style="margin-top:6px">Passenger rating ${stars(k.passenger_stars)} <span class="small muted">(${k.passenger_stars})</span></div>` : ''}
    </div>
    <h2>Pay it off 💪</h2>
    <p class="small muted" style="margin-top:-4px">Tap a job once it's actually done.</p>
    <div class="jobs">${S.tasks.map(t => `
      <button class="job" data-act="pay" data-kid="${k.id}" data-task="${t.id}"><span class="e">${esc(t.emoji)}</span>${esc(t.name)}<br><span class="c">−${t.credits}</span></button>`).join('')}</div>
    <details class="card" style="margin-top:14px"><summary>Something else?</summary>
      <label class="f" for="k-label">What did they do?</label><input id="k-label" type="text" maxlength="100" placeholder="Helped Grandad with the garden">
      <label class="f" for="k-cr">Worth (${esc(cur())})</label><input id="k-cr" type="number" inputmode="numeric" min="1" value="10">
      <div style="height:10px"></div><button class="btn" data-act="payCustom" data-kid="${k.id}">Knock it off the tab</button>
    </details>
    <h2>History</h2>
    <div class="card"><ul class="list" id="k-ledger"><li class="muted">Loading…</li></ul></div>
    <p class="center"><button class="link" data-act="kidEdit" data-id="${k.id}">Edit ${esc(k.name)}'s details</button></p>
    ` + nav('');
  },

  kidEdit() {
    const k = view.id ? kidById(view.id) : null;
    return header(k ? `Edit ${esc(k.name)}` : '➕ New passenger', '', k ? null : 'home') + `
    <div class="card">
      <label class="f" for="ke-name">Name</label><input id="ke-name" type="text" maxlength="40" value="${esc(k?.name || '')}" placeholder="Keelah">
      <label class="f">Emoji</label>${emojiPicker('kid', KID_EMOJI, k?.emoji)}
      <label class="f" for="ke-phone">WhatsApp number <span class="muted">(optional)</span></label>
      <input id="ke-phone" type="tel" maxlength="20" value="${esc(k?.phone ? '+' + k.phone : '')}" placeholder="087 123 4567">
      <p class="small muted">With a number, receipts open straight to their chat. Without it, you pick the chat in WhatsApp.</p>
      <button class="btn" data-act="saveKid" data-id="${k?.id || ''}">${k ? 'Save' : 'Add passenger'}</button>
    </div>
    ${k ? `<p class="center"><button class="link" data-act="archiveKid" data-id="${k.id}">Retire this passenger (keeps history)</button></p>` : ''}
    ` + nav('');
  },

  settings() {
    const f = S.family;
    const example = Math.round(fareNow(f, 8, 15));
    return header('⚙️ Settings', esc(f.name)) + `
    <div class="card">
      <h2 style="margin-top:0">🤝 Your co-driver</h2>
      <p class="small muted">Send this to Mum / Dad so you share one set of tabs.</p>
      <div style="font-family:var(--display);font-size:26px;text-align:center;margin:8px 0">${esc(f.invite_code)}</div>
      <a class="btn green" target="_blank" rel="noopener" href="${esc('https://wa.me/?text=' + encodeURIComponent(`🚕 Join our family taxi firm "${f.name}" on Taxi of Mum & Dad: ${location.origin}/?join=${f.invite_code}`))}">💬 Send invite on WhatsApp</a>
      <div class="grid2" style="margin-top:10px">
        <button class="btn white" data-act="inviteQr">▦ Show QR</button>
        <button class="btn white" data-act="newCode">🔄 New code</button>
      </div>
      <p class="small muted">Drivers: ${S.parents.map(p => esc(p.emoji + ' ' + p.name)).join(', ')}</p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">🧒 Passengers</h2>
      <ul class="list">${S.kids.map(k => `<li><span style="font-size:24px">${esc(k.emoji)}</span><span class="grow"><b>${esc(k.name)}</b><br><span class="small muted">${k.phone ? '📱 +' + esc(k.phone) : 'no WhatsApp number'}</span></span>
        <button class="btn white slim" data-act="kidEdit" data-id="${k.id}">Edit</button></li>`).join('') || '<li class="muted">None yet</li>'}</ul>
      <button class="btn slim" data-act="kidEdit" style="margin-top:8px">➕ Add passenger</button>
    </div>

    <div class="card">
      <h2 style="margin-top:0">💪 Ways to pay</h2>
      <ul class="list">${S.tasks.map(t => `<li><span style="font-size:22px">${esc(t.emoji)}</span><span class="grow">${esc(t.name)}</span>
        <input type="number" min="1" value="${t.credits}" style="width:74px;padding:8px" data-task-credits="${t.id}" aria-label="Value of ${esc(t.name)}">
        <button class="link" data-act="archiveTask" data-id="${t.id}" aria-label="Remove ${esc(t.name)}">✕</button></li>`).join('')}</ul>
      <details style="margin-top:8px"><summary><b>➕ Add a job</b></summary>
        ${emojiPicker('job', JOB_EMOJI)}
        <label class="f" for="t-name">Job</label><input id="t-name" type="text" maxlength="80" placeholder="Bike ride with Dad instead of Xbox">
        <label class="f" for="t-cr">Worth</label><input id="t-cr" type="number" min="1" value="10">
        <div style="height:10px"></div><button class="btn" data-act="addTask">Add job</button>
      </details>
    </div>

    <div class="card">
      <h2 style="margin-top:0">🚖 Taxi firm &amp; fares</h2>
      <label class="f" for="f-name">Firm name</label><input id="f-name" type="text" maxlength="80" value="${esc(f.name)}">
      <label class="f" for="f-cur">Currency name</label><input id="f-cur" type="text" maxlength="30" value="${esc(f.currency)}">
      <div class="grid2">
        <div><label class="f" for="f-flag">Flag fall</label><input id="f-flag" type="number" step="0.1" min="0" value="${f.flag_fall}"></div>
        <div><label class="f" for="f-km">Per km</label><input id="f-km" type="number" step="0.1" min="0" value="${f.per_km}"></div>
        <div><label class="f" for="f-min">Per minute</label><input id="f-min" type="number" step="0.1" min="0" value="${f.per_min}"></div>
      </div>
      <p class="small muted">Right now a 15-minute, 8 km school run costs <b>${example}</b> ${esc(f.currency)}.</p>
      <button class="btn" data-act="saveFamily">Save</button>
    </div>

    <div class="card">
      <h2 style="margin-top:0">${esc(S.me.emoji)} You</h2>
      <label class="f" for="me-name">Driver name</label><input id="me-name" type="text" maxlength="40" value="${esc(S.me.name)}">
      <label class="f">Face</label>${emojiPicker('me', PARENT_EMOJI, S.me.emoji)}
      <div style="height:10px"></div><button class="btn" data-act="saveMe">Save</button>
    </div>
    <p class="center"><button class="link" data-act="logout">Sign out on this phone</button></p>
    ` + nav('settings');
  },

  offline: () => `<section class="hero"><div class="sign">TAXI</div><h1>No signal 📵</h1><p class="muted">Can't reach the taxi office right now.</p>
    <button class="btn" data-act="reload">Try again</button></section>`,
};

function waLink(trip, p) {
  const text = `🚕 *Taxi of Mum & Dad* receipt for ${p.name}\n` +
    `Ride with ${trip.driver}${trip.note ? ' (' + trip.note + ')' : ''}: *${p.fare} ${cur()}*\n` +
    `See your tab & rate your driver 👉 ${p.receipt_url}`;
  return `https://wa.me/${p.phone || ''}?text=${encodeURIComponent(text)}`;
}

function render() {
  stopTick();
  const fn = VIEWS[view.name] || VIEWS.home;
  if (!S && !['welcome', 'boot', 'offline', 'meter'].includes(view.name)) { view = { name: 'welcome' }; }
  app.innerHTML = (VIEWS[view.name] || fn)();
  if (view.name === 'meter') startTick();
  if (view.name === 'kid') loadLedger(view.id);
}

/* ------------------------------------------------------------------ meter (GPS + clock) */
function haversine(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function onPosition(pos) {
  const m = LS.get('taxi.meter');
  if (!m) return;
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const pt = { lat, lon, t: pos.timestamp || Date.now() };
  if (accuracy > 60) { m.gps = 'weak'; LS.set('taxi.meter', m); return; }
  m.gps = 'ok';
  if (!m.last) m.last = pt;
  else {
    const d = haversine(m.last, pt);
    const secs = Math.max(1, (pt.t - m.last.t) / 1000);
    if (d >= Math.max(10, accuracy * 0.5)) {        // ignore GPS jitter while parked
      if (d / secs < 70) m.distM += d;               // ignore teleports (> 250 km/h)
      m.last = pt;
    }
  }
  LS.set('taxi.meter', m);
}

function onGpsError(err) {
  const m = LS.get('taxi.meter');
  if (!m) return;
  m.gps = err.code === 1 ? 'denied' : 'weak';
  LS.set('taxi.meter', m);
}

function startGps() {
  if (gpsWatch !== null || !('geolocation' in navigator)) return;
  gpsWatch = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
function stopGps() { if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }

async function keepAwake() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch { /* not allowed */ }
}
function letSleep() { try { wakeLock?.release(); } catch { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && LS.get('taxi.meter')) keepAwake(); });

function startTick() {
  startGps(); keepAwake();
  const draw = () => {
    const m = LS.get('taxi.meter');
    if (!m) return;
    const secs = (Date.now() - m.startedAt) / 1000;
    const km = m.distM / 1000;
    const fare = m.rates.flag_fall + km * m.rates.per_km + (secs / 60) * m.rates.per_min;
    const set = (id, v) => { const el = $('#' + id); if (el) el.textContent = v; };
    set('m-fare', fare.toFixed(1));
    set('m-time', mmss(secs));
    set('m-km', km.toFixed(1));
    const g = $('#m-gps');
    if (g) {
      const map = { ok: ['ok', '📡 GPS locked'], weak: ['', '📡 Weak GPS signal…'], denied: ['bad', '📵 No location access - time only'], waiting: ['', '📡 Finding GPS…'] };
      const [cls, txt] = map[m.gps] || map.waiting;
      g.className = 'gps ' + cls; g.textContent = txt;
    }
  };
  draw();
  tickTimer = setInterval(draw, 1000);
}
function stopTick() { clearInterval(tickTimer); tickTimer = null; }

/* ------------------------------------------------------------------ ledger */
async function loadLedger(kidId) {
  try {
    const data = await api(`/api/kids/${kidId}/ledger`);
    const ul = $('#k-ledger');
    if (!ul) return;
    ul.innerHTML = data.entries.map(e => `<li><span style="font-size:22px">${esc(e.emoji || '•')}</span>
      <span class="grow"><span class="ellipsis" style="display:block">${esc(e.label)}</span><span class="small muted">${esc(e.when)}</span></span>
      <span class="amt ${e.credits > 0 ? 'plus' : 'minus'}">${e.credits > 0 ? '+' : '−'}${Math.abs(e.credits)}</span>
      ${e.kind === 'payment' ? `<button class="link" data-act="undoPay" data-id="${e.id}" data-kid="${kidId}" aria-label="Undo">✕</button>` : ''}</li>`).join('')
      || '<li class="muted">Nothing yet</li>';
  } catch (e) { oops(e); }
}

async function afterPayment(kidId, res, label) {
  await refresh();
  const k = kidById(kidId);
  go('kid', { id: kidId });
  if (k && k.balance <= 0) { confetti(['🎉', '⭐', '💪', '🏆']); }
  toast(k && k.balance <= 0 ? `🎉 ${label} - ${k.name} is all square!` : `✅ ${label} - nice one!`, async () => {
    try { await api(`/api/ledger/${res.entry_id}`, { method: 'DELETE' }); await refresh(); go('kid', { id: kidId }); } catch (e) { oops(e); }
  });
}

/* ------------------------------------------------------------------ actions */
const ACTS = {
  go: el => go(el.dataset.to),
  reload: () => location.reload(),
  closeModal,
  pick(el) {
    picks[el.dataset.group] = el.dataset.val;
    el.parentElement.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === el));
  },

  async createFamily() {
    try {
      await api('/api/family', { method: 'POST', body: { family_name: val('w-fam'), parent_name: val('w-name'), emoji: picks.new } });
      await refresh(); confetti(); go('home');
    } catch (e) { oops(e); }
  },
  async joinFamily() {
    try {
      await api('/api/join', { method: 'POST', body: { code: val('j-code'), parent_name: val('j-name'), emoji: picks.join } });
      history.replaceState(null, '', '/');
      await refresh(); confetti(); go('home');
    } catch (e) { oops(e); }
  },

  startOrResume() {
    if (LS.get('taxi.meter')) go('meter');
    else if (LS.get('taxi.end')) go('end');
    else go('start');
  },
  toggleKid(el) {
    const id = +el.dataset.id;
    view.note = val('s-note');
    view.sel = view.sel.includes(id) ? view.sel.filter(x => x !== id) : [...view.sel, id];
    render();
  },
  place(el) { $('#s-note').value = el.dataset.val.replace(/^\S+\s/, ''); },
  startMeter() {
    if (!view.sel?.length) return;
    LS.set('taxi.meter', {
      kidIds: view.sel, note: val('s-note'), startedAt: Date.now(), distM: 0, last: null, gps: 'waiting',
      kids: view.sel.map(id => { const k = kidById(id); return { id, name: k.name, emoji: k.emoji }; }),
      rates: { flag_fall: S.family.flag_fall, per_km: S.family.per_km, per_min: S.family.per_min, currency: S.family.currency },
    });
    go('meter');
  },
  manualTrip() {
    if (!view.sel?.length) return;
    LS.set('taxi.end', { kidIds: view.sel, note: val('s-note'), km: '', minutes: '', extras: autoExtras(new Date()), ratings: {} });
    go('end');
  },
  stopMeter() {
    const m = LS.get('taxi.meter');
    if (!m) return go('home');
    stopGps(); letSleep();
    LS.set('taxi.end', {
      kidIds: m.kidIds, note: m.note, km: +(m.distM / 1000).toFixed(1),
      minutes: Math.max(1, Math.round((Date.now() - m.startedAt) / 60000)), extras: autoExtras(new Date(m.startedAt)), ratings: {},
    });
    LS.del('taxi.meter');
    go('end');
  },
  cancelMeter() {
    if (!confirm('Cancel this trip? Nothing will be charged.')) return;
    stopGps(); letSleep(); LS.del('taxi.meter'); go('home');
  },

  toggleExtra(el) { editDraft(d => { const k = el.dataset.key; d.extras = d.extras.includes(k) ? d.extras.filter(x => x !== k) : [...d.extras, k]; }); },
  rate(el) { editDraft(d => { const id = el.dataset.id; d.ratings[id] = d.ratings[id] || { stars: 0, tags: [] }; const v = +el.dataset.val; d.ratings[id].stars = d.ratings[id].stars === v ? 0 : v; }); },
  tag(el) { editDraft(d => { const id = el.dataset.id, t = el.dataset.val; d.ratings[id] = d.ratings[id] || { stars: 0, tags: [] }; const tags = d.ratings[id].tags; d.ratings[id].tags = tags.includes(t) ? tags.filter(x => x !== t) : [...tags, t]; }); },
  async issue(el) {
    const d = LS.get('taxi.end');
    if (!d) return;
    el.disabled = true;
    try {
      const res = await api('/api/trips', { method: 'POST', body: { kid_ids: d.kidIds, note: d.note, distance_km: +d.km || 0, minutes: +d.minutes || 0, extras: d.extras, ratings: d.ratings } });
      LS.del('taxi.end');
      await refresh();
      confetti(['🧾', '🚕', '🪙']);
      go('trip', { trip: res.trip, fresh: true });
    } catch (e) { el.disabled = false; oops(e.message === 'Failed to fetch' ? 'No signal - your trip is saved, try again in a sec' : e); }
  },
  discard() { if (confirm('Throw away this trip? Nothing will be charged.')) { LS.del('taxi.end'); go('home'); } },

  trip: el => go('trip', { id: +el.dataset.id }),
  qr(el) { modal(`<h2 style="margin-top:0">${esc(el.dataset.name)}, scan me 📱</h2><img src="/r/${encodeURIComponent(el.dataset.token)}/qr.svg" alt="QR code for the receipt"><p class="small muted">Opens the receipt on their phone.</p>`); },
  async deleteTrip(el) {
    if (!confirm('Delete this trip and its fares?')) return;
    try { await api(`/api/trips/${el.dataset.id}`, { method: 'DELETE' }); await refresh(); go('home'); toast('Trip deleted'); } catch (e) { oops(e); }
  },

  kid: el => go('kid', { id: +el.dataset.id }),
  async pay(el) {
    const kidId = +el.dataset.kid, task = S.tasks.find(t => t.id === +el.dataset.task);
    try { const res = await api('/api/payments', { method: 'POST', body: { kid_id: kidId, task_id: task.id } }); await afterPayment(kidId, res, `${task.emoji} ${task.name}`); } catch (e) { oops(e); }
  },
  async payCustom(el) {
    const kidId = +el.dataset.kid;
    try { const res = await api('/api/payments', { method: 'POST', body: { kid_id: kidId, label: val('k-label'), credits: +val('k-cr') } }); await afterPayment(kidId, res, `⭐ ${val('k-label')}`); } catch (e) { oops(e); }
  },
  async undoPay(el) {
    try { await api(`/api/ledger/${el.dataset.id}`, { method: 'DELETE' }); await refresh(); go('kid', { id: +el.dataset.kid }); toast('Removed'); } catch (e) { oops(e); }
  },

  kidEdit(el) { delete picks.kid; go('kidEdit', { id: el.dataset.id ? +el.dataset.id : null }); },
  async saveKid(el) {
    const body = { name: val('ke-name'), emoji: picks.kid, phone: val('ke-phone') };
    try {
      if (el.dataset.id) await api(`/api/kids/${el.dataset.id}`, { method: 'PATCH', body });
      else await api('/api/kids', { method: 'POST', body });
      await refresh(); toast(el.dataset.id ? 'Saved' : `🎉 ${body.name} is on the books`); go(el.dataset.id ? 'settings' : 'home');
    } catch (e) { oops(e); }
  },
  async archiveKid(el) {
    if (!confirm('Retire this passenger? Their history is kept but they leave the app.')) return;
    try { await api(`/api/kids/${el.dataset.id}`, { method: 'PATCH', body: { archive: true } }); await refresh(); go('settings'); } catch (e) { oops(e); }
  },

  async addTask() {
    try { await api('/api/tasks', { method: 'POST', body: { name: val('t-name'), credits: +val('t-cr'), emoji: picks.job } }); await refresh(); go('settings'); toast('Job added 💪'); } catch (e) { oops(e); }
  },
  async archiveTask(el) {
    try { await api(`/api/tasks/${el.dataset.id}`, { method: 'PATCH', body: { archive: true } }); await refresh(); go('settings'); } catch (e) { oops(e); }
  },
  async saveFamily() {
    try {
      await api('/api/family', { method: 'PATCH', body: { name: val('f-name'), currency: val('f-cur'), flag_fall: +val('f-flag'), per_km: +val('f-km'), per_min: +val('f-min') } });
      await refresh(); go('settings'); toast('Fares updated 🚖');
    } catch (e) { oops(e); }
  },
  async saveMe() {
    try { await api('/api/me', { method: 'PATCH', body: { name: val('me-name'), emoji: picks.me } }); await refresh(); go('settings'); toast('Saved'); } catch (e) { oops(e); }
  },
  inviteQr() { modal(`<h2 style="margin-top:0">Scan to join 🤝</h2><img src="/api/family/invite-qr.svg?t=${Date.now()}" alt="QR code to join the family taxi firm"><p class="small muted">Point your co-driver's camera at this.</p>`); },
  async newCode() {
    if (!confirm('Make a new invite code? The old one stops working.')) return;
    try { await api('/api/family/new-code', { method: 'POST' }); await refresh(); go('settings'); } catch (e) { oops(e); }
  },
  async logout() {
    if (!confirm('Sign out on this phone?')) return;
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    S = null; ['taxi.state', 'taxi.meter', 'taxi.end'].forEach(LS.del); go('welcome');
  },
};

function autoExtras(when) {
  const h = when.getHours();
  return h >= 22 || h < 5 ? ['late'] : h < 7 ? ['early'] : [];
}

function editDraft(fn) {
  const d = LS.get('taxi.end');
  if (!d) return;
  fn(d); LS.set('taxi.end', d);
  const y = window.scrollY; render(); window.scrollTo(0, y);
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});

// live edits on the end-of-trip screen and job values
document.addEventListener('input', e => {
  const key = e.target.dataset.input;
  if (key && view.name === 'end') {
    const d = LS.get('taxi.end');
    d[key] = e.target.value; LS.set('taxi.end', d);
    const total = Math.max(1, Math.round(fareNow(S.family, +d.km || 0, +d.minutes || 0, d.extras)));
    $('#e-total').textContent = total;
  }
});
document.addEventListener('change', async e => {
  const id = e.target.dataset.taskCredits;
  if (!id) return;
  try { await api(`/api/tasks/${id}`, { method: 'PATCH', body: { credits: +e.target.value } }); await refresh(); toast('Job value updated'); } catch (err) { oops(err); }
});

/* ------------------------------------------------------------------ boot */
(async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const joining = new URLSearchParams(location.search).get('join');
  if (LS.get('taxi.meter')) go('meter');          // never lose a running meter
  else if (S && !joining) go('home');               // instant start from cache
  try {
    await refresh();
    if (joining) { toast('You\'re already in a taxi firm on this phone'); history.replaceState(null, '', '/'); }
    if (['boot', 'welcome'].includes(view.name)) go(LS.get('taxi.end') ? 'end' : 'home');
    else if (view.name === 'home') render();
  } catch (e) {
    if (view.name === 'boot') go(e.message === 'Please sign in first' ? 'welcome' : 'offline');
  }
})();
