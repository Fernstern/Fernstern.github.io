/* ============================================================
   LEDGER — personal budget tracker
   All data stored locally on-device (localStorage). Nothing
   is sent anywhere. Works fully offline.
   ============================================================ */

const STORAGE_KEY = 'ledger_state_v1';
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const CATEGORY_ICONS = {
  'Rent': '🏠', 'Internet': '📶', 'Power': '⚡', 'Water': '🚿', 'Phone': '📱',
  'Groceries': '🛒', 'Eating Out': '🍜', 'Transport': '🚗', 'Subscriptions': '🔁',
  'Pets': '🐾', 'Health': '💊', 'Fun': '🎲', 'Shopping': '🛍️', 'Other': '✦'
};
const RECURRING_DEFAULTS = ['Rent', 'Internet', 'Power'];
const ALL_CATEGORIES = Object.keys(CATEGORY_ICONS);

function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function fmt(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}
function fmtShort(n) {
  return `$${Math.abs(n).toFixed(n % 1 === 0 ? 0 : 2)}`;
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
function daysInMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function dayOfMonth(d = new Date()) { return d.getDate(); }
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

/* ---------------- default state ---------------- */
function defaultState() {
  return {
    onboarded: false,
    income: 2500,
    payday: 1, // day of month
    recurring: [
      { id: uid(), name: 'Rent', category: 'Rent', amount: 900, day: 1 },
      { id: uid(), name: 'Internet', category: 'Internet', amount: 25, day: 1 },
      { id: uid(), name: 'Power', category: 'Power', amount: 85, day: 1 },
    ],
    transactions: [], // {id, date, amount, category, note, isIOU, person, settled}
    monthlyLogged: {}, // { '2026-06': true } -> recurring confirmed for month
    notifPrefs: {
      monthly: true,
      weekly: true,
      iou: true,
      time: '09:00',
    },
    lastWeeklyPromptWeek: null,
    createdAt: new Date().toISOString(),
  };
}

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...defaultState(), ...JSON.parse(raw) };
  } catch (e) { console.warn('load failed', e); }
  return defaultState();
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/* ---------------- derived helpers ---------------- */
function currentMonthKey() { return monthKey(new Date()); }

function recurringTotal() {
  return state.recurring.reduce((s, r) => s + r.amount, 0);
}

function monthTransactions(key = currentMonthKey()) {
  return state.transactions.filter(t => t.date.slice(0, 7) === key);
}

function spentThisMonth(key = currentMonthKey()) {
  // excludes IOU amounts that are owed BY someone else (those aren't really "your" spending loss,
  // but you did pay cash out, so we count them as spent, separately track reimbursement)
  return monthTransactions(key).reduce((s, t) => s + t.amount, 0);
}

function recurringLoggedThisMonth() {
  return !!state.monthlyLogged[currentMonthKey()];
}

function openIOUs() {
  return state.transactions.filter(t => t.isIOU && !t.settled);
}

function iousByPerson() {
  const map = {};
  openIOUs().forEach(t => {
    if (!map[t.person]) map[t.person] = { person: t.person, total: 0, items: [] };
    map[t.person].total += t.amount;
    map[t.person].items.push(t);
  });
  return Object.values(map).sort((a, b) => b.total - a.total);
}

function remainingBudget() {
  return state.income - spentThisMonth();
}

function daysLeftInMonth() {
  const now = new Date();
  return daysInMonth(currentMonthKey()) - now.getDate() + 1;
}

/* ============================================================
   NOTIFICATIONS
   Uses Notification API directly (works while app/tab is open
   or installed as PWA on Android Chrome with periodic checks).
   We schedule via setTimeout chains keyed off localStorage so
   reminders persist across app opens, checked on each load.
   ============================================================ */
async function ensureNotifPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const res = await Notification.requestPermission();
  return res === 'granted';
}

function fireNotification(title, body, tag) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    navigator.serviceWorker?.getRegistration().then(reg => {
      if (reg) {
        reg.showNotification(title, { body, tag, icon: undefined, badge: undefined });
      } else {
        new Notification(title, { body, tag });
      }
    }).catch(() => new Notification(title, { body, tag }));
  } catch (e) { console.warn(e); }
}

function checkReminders() {
  const now = new Date();
  const key = currentMonthKey();

  // Monthly: prompt to confirm recurring bills at the start of the month
  if (state.notifPrefs.monthly && !state.monthlyLogged[key] && now.getDate() <= 5) {
    const lastFired = localStorage.getItem('lf_monthly_' + key);
    if (!lastFired) {
      fireNotification(
        'Start-of-month check-in',
        `Confirm your ${monthLabel(key)} bills — rent, internet, power — so your budget's accurate from day one.`,
        'monthly-' + key
      );
      localStorage.setItem('lf_monthly_' + key, '1');
    }
  }

  // Weekly: prompt to log everyday spending
  if (state.notifPrefs.weekly) {
    const weekNum = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 604800000);
    const wkTag = `${now.getFullYear()}-w${weekNum}`;
    if (state.lastWeeklyPromptWeek !== wkTag) {
      const lastFired = localStorage.getItem('lf_weekly_' + wkTag);
      if (!lastFired) {
        fireNotification(
          'Weekly spending check',
          `Log anything you've spent this week so your ${monthLabel(key)} total stays accurate.`,
          'weekly-' + wkTag
        );
        localStorage.setItem('lf_weekly_' + wkTag, '1');
        state.lastWeeklyPromptWeek = wkTag;
        save();
      }
    }
  }

  // IOU: nudge for anything open longer than 7 days
  if (state.notifPrefs.iou) {
    openIOUs().forEach(t => {
      const ageDays = (now - new Date(t.date)) / 86400000;
      if (ageDays >= 7) {
        const tag = 'iou-' + t.id + '-' + Math.floor(ageDays / 7);
        if (!localStorage.getItem('lf_' + tag)) {
          fireNotification(
            `${t.person} owes you ${fmtShort(t.amount)}`,
            `It's been ${Math.floor(ageDays)} days. Worth a friendly nudge?`,
            tag
          );
          localStorage.setItem('lf_' + tag, '1');
        }
      }
    });
  }
}

// Check reminders on load and every 60s while app is open (covers most realistic in-app cases)
setInterval(checkReminders, 60000);

/* ============================================================
   RENDERING
   ============================================================ */
let activeScreen = 'home';

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function setHeader(eyebrow, title) {
  $('#header-eyebrow').textContent = eyebrow;
  $('#header-title').textContent = title;
}

function render() {
  if (!state.onboarded) {
    renderOnboarding();
    return;
  }
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === activeScreen));
  $('#fab-add').style.display = activeScreen === 'settings' ? 'none' : 'flex';

  if (activeScreen === 'home') renderHome();
  else if (activeScreen === 'ledger') renderLedger();
  else if (activeScreen === 'ious') renderIOUs();
  else if (activeScreen === 'settings') renderSettings();
}

/* ---------------- ONBOARDING ---------------- */
function renderOnboarding() {
  $('.tabbar') && (document.querySelector('nav.tabbar').style.display = 'none');
  $('#fab-add').style.display = 'none';
  setHeader('Welcome', 'Let\u2019s set up your budget');
  const main = $('#main');
  main.innerHTML = `
    <div class="card torn">
      <div class="stamp">Step 1 of 2 · Income</div>
      <h2 style="margin-top:8px; font-size:18px;">What do you bring home monthly?</h2>
      <p class="sub" style="margin-top:6px;">After taxes — the number that actually lands in your account.</p>
      <label>Monthly income</label>
      <input type="number" id="ob-income" inputmode="decimal" value="${state.income}" placeholder="2500" />

      <label>Which day does it usually land?</label>
      <input type="number" id="ob-payday" min="1" max="31" value="${state.payday}" placeholder="1" />
    </div>

    <div class="card torn">
      <div class="stamp">Step 2 of 2 · Recurring bills</div>
      <h2 style="margin-top:8px; font-size:18px;">Your fixed monthly costs</h2>
      <p class="sub" style="margin-top:6px;">Your rent split and any other bill that repeats. Add or edit as needed.</p>
      <div id="ob-recurring-list" style="margin-top:14px;"></div>
      <button class="btn ghost small" id="ob-add-recurring" style="margin-top:10px; width:100%;">+ Add another bill</button>
    </div>

    <button class="btn accent" id="ob-finish" style="margin: 18px 0 30px;">Set up my budget</button>
  `;

  renderOnboardingRecurring();
  $('#ob-add-recurring').onclick = () => {
    state.recurring.push({ id: uid(), name: '', category: 'Other', amount: 0, day: 1 });
    renderOnboardingRecurring();
  };
  $('#ob-finish').onclick = () => {
    const income = parseFloat($('#ob-income').value) || 0;
    const payday = parseInt($('#ob-payday').value) || 1;
    if (income <= 0) { toast('Add your monthly income first'); return; }
    state.income = income;
    state.payday = Math.min(31, Math.max(1, payday));
    state.recurring = state.recurring.filter(r => r.name.trim() && r.amount > 0);
    if (state.recurring.length === 0) { toast('Add at least one bill'); return; }
    state.onboarded = true;
    save();
    document.querySelector('nav.tabbar').style.display = 'flex';
    activeScreen = 'home';
    logRecurringForCurrentMonth(); // logs this month's rent/internet/power as actual transactions, silently
    ensureNotifPermission();
    render();
    toast('Budget set up — welcome in');
  };
}

function renderOnboardingRecurring() {
  const list = $('#ob-recurring-list');
  list.innerHTML = state.recurring.map((r, i) => `
    <div class="row" style="gap:8px; margin-bottom:10px; align-items:flex-end;">
      <div style="flex:1;">
        <label style="margin-top:0;">Name</label>
        <input type="text" data-i="${i}" class="ob-r-name" value="${r.name}" placeholder="e.g. Rent" />
      </div>
      <div style="width:100px;">
        <label style="margin-top:0;">Amount</label>
        <input type="number" data-i="${i}" class="ob-r-amt" inputmode="decimal" value="${r.amount || ''}" placeholder="0" />
      </div>
      <button class="btn ghost small ob-r-del" data-i="${i}" style="padding:11px 13px;">✕</button>
    </div>
  `).join('');
  $$('.ob-r-name').forEach(inp => inp.oninput = (e) => { state.recurring[+e.target.dataset.i].name = e.target.value; });
  $$('.ob-r-amt').forEach(inp => inp.oninput = (e) => { state.recurring[+e.target.dataset.i].amount = parseFloat(e.target.value) || 0; });
  $$('.ob-r-del').forEach(btn => btn.onclick = (e) => {
    state.recurring.splice(+e.target.dataset.i, 1);
    renderOnboardingRecurring();
  });
}

/* ---------------- HOME ---------------- */
function renderHome() {
  const key = currentMonthKey();
  setHeader(monthLabel(key), 'Ledger');
  const spent = spentThisMonth(key);
  const remaining = state.income - spent;
  const pct = Math.min(100, (spent / state.income) * 100);
  const over = remaining < 0;
  const dLeft = daysLeftInMonth();
  const perDayLeft = dLeft > 0 ? remaining / dLeft : remaining;

  const recurringPending = !recurringLoggedThisMonth();
  const ious = iousByPerson();
  const iouTotal = ious.reduce((s, p) => s + p.total, 0);

  const recent = monthTransactions(key).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);

  $('#main').innerHTML = `
    ${recurringPending ? `
    <div class="card torn" style="background:var(--accent-soft); border-color:var(--accent);">
      <div class="row">
        <div>
          <div class="stamp" style="color:var(--owe);">Start of month</div>
          <h3 style="margin-top:4px; font-size:15.5px;">Confirm this month's bills</h3>
          <p class="sub">Rent, internet, power — ${fmtShort(recurringTotal())} total</p>
        </div>
        <button class="btn accent small" id="confirm-recurring" style="white-space:nowrap;">Confirm</button>
      </div>
    </div>` : ''}

    <div class="card torn">
      <div class="stamp">${monthLabel(key)}</div>
      <div class="bigstat" style="margin-top:6px; ${over ? 'color:var(--owe);' : ''}">${fmt(remaining)}</div>
      <div class="sub">${over ? 'over your income this month' : 'left to spend this month'}</div>
      <div class="barwrap">
        <div class="bartrack"><div class="barfill ${over ? 'over' : ''}" style="width:${Math.min(100, pct)}%"></div></div>
        <div class="barlabels"><span>${fmtShort(spent)} spent</span><span>${fmtShort(state.income)} income</span></div>
      </div>
      <div class="row" style="margin-top:16px; padding-top:14px; border-top:1px solid var(--line);">
        <div>
          <div class="sub" style="margin:0;">Days left this month</div>
          <div style="font-family:'JetBrains Mono'; font-weight:600; font-size:15px;">${dLeft}</div>
        </div>
        <div style="text-align:right;">
          <div class="sub" style="margin:0;">Safe to spend / day</div>
          <div style="font-family:'JetBrains Mono'; font-weight:600; font-size:15px; ${perDayLeft < 0 ? 'color:var(--owe);' : ''}">${fmt(perDayLeft)}</div>
        </div>
      </div>
    </div>

    ${iouTotal > 0 ? `
    <div class="card" id="home-iou-card" style="cursor:pointer;">
      <div class="row">
        <div>
          <div class="stamp" style="color:var(--good);">Owed to you</div>
          <div class="bigstat" style="font-size:24px; margin-top:4px; color:var(--good);">${fmt(iouTotal)}</div>
          <div class="sub">${ious.length} ${ious.length === 1 ? 'person' : 'people'} — tap to view</div>
        </div>
        <span style="font-size:20px;">→</span>
      </div>
    </div>` : ''}

    <div class="section-title">
      <h2>Recent activity</h2>
      <span class="count">${monthTransactions(key).length} this month</span>
    </div>
    <div class="card" style="padding: 6px 16px;">
      ${recent.length === 0 ? `
        <div class="empty">
          <div class="glyph">📓</div>
          <p>Nothing logged yet this month.</p>
          <p>Tap the + button to add your first expense.</p>
        </div>
      ` : recent.map(txItemHTML).join('')}
    </div>
  `;

  $('#confirm-recurring')?.addEventListener('click', confirmRecurring);
  $('#home-iou-card')?.addEventListener('click', () => { activeScreen = 'ious'; render(); });
  bindTxItemClicks();
}

function txItemHTML(t) {
  const icon = CATEGORY_ICONS[t.category] || '✦';
  const dateLabel = new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  let sub = `${t.category} · ${dateLabel}`;
  if (t.isIOU) sub = `${t.settled ? 'Settled' : 'Owed by'} ${t.person} · ${dateLabel}`;
  return `
    <div class="list-item" data-id="${t.id}" style="cursor:pointer;">
      <div class="icon">${icon}</div>
      <div class="meta">
        <div class="name">${t.note || t.category}</div>
        <div class="sub">${sub}</div>
      </div>
      <div class="amt neg">${fmt(t.amount)}</div>
    </div>
  `;
}

function bindTxItemClicks() {
  $$('.list-item[data-id]').forEach(el => {
    el.onclick = () => openTxDetail(el.dataset.id);
  });
}

function logRecurringForCurrentMonth() {
  const key = currentMonthKey();
  const day1 = `${key}-01`;
  state.recurring.forEach(r => {
    const already = state.transactions.some(t => t.date.slice(0, 7) === key && t.note === r.name && t.category === r.category && t.recurringId === r.id);
    if (!already) {
      state.transactions.push({
        id: uid(), date: day1, amount: r.amount, category: r.category,
        note: r.name, isIOU: false, recurringId: r.id,
      });
    }
  });
  state.monthlyLogged[key] = true;
  save();
}

function confirmRecurring() {
  logRecurringForCurrentMonth();
  toast(`${monthLabel(currentMonthKey())} bills confirmed`);
  render();
}

/* ---------------- LEDGER (full transaction list) ---------------- */
function renderLedger() {
  setHeader('All transactions', 'Ledger');
  const months = [...new Set(state.transactions.map(t => t.date.slice(0, 7)))].sort().reverse();
  if (!months.includes(currentMonthKey())) months.unshift(currentMonthKey());

  $('#main').innerHTML = months.map(key => {
    const txs = monthTransactions(key).slice().sort((a, b) => b.date.localeCompare(a.date));
    const total = txs.reduce((s, t) => s + t.amount, 0);
    return `
      <div class="section-title">
        <h2>${monthLabel(key)}</h2>
        <span class="count">${fmtShort(total)}</span>
      </div>
      <div class="card" style="padding:6px 16px;">
        ${txs.length === 0 ? `<div class="empty"><p>No transactions.</p></div>` : txs.map(txItemHTML).join('')}
      </div>
    `;
  }).join('') || `<div class="empty"><div class="glyph">📓</div><p>No transactions yet.</p></div>`;

  bindTxItemClicks();
}

/* ---------------- IOUs ---------------- */
function renderIOUs() {
  setHeader('People who owe you', 'Owed to you');
  const groups = iousByPerson();
  const settled = state.transactions.filter(t => t.isIOU && t.settled).sort((a, b) => b.date.localeCompare(a.date));
  const total = groups.reduce((s, g) => s + g.total, 0);

  $('#main').innerHTML = `
    <div class="card torn">
      <div class="stamp" style="color:var(--good);">Total outstanding</div>
      <div class="bigstat" style="margin-top:6px; color:var(--good);">${fmt(total)}</div>
      <div class="sub">across ${groups.length} ${groups.length === 1 ? 'person' : 'people'}</div>
    </div>

    ${groups.length === 0 ? `
      <div class="empty">
        <div class="glyph">🤝</div>
        <p>No one owes you anything right now.</p>
        <p>When you add an expense, mark it as "paid for someone else" to track it here.</p>
      </div>
    ` : groups.map(g => `
      <div class="card" style="padding-bottom:10px;">
        <div class="row">
          <div>
            <div style="font-weight:700; font-size:16px;">${g.person}</div>
            <div class="sub">${g.items.length} ${g.items.length === 1 ? 'item' : 'items'}</div>
          </div>
          <div class="amt pos" style="font-size:18px;">${fmt(g.total)}</div>
        </div>
        <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--line);">
          ${g.items.map(t => `
            <div class="list-item" style="padding:8px 0;">
              <div class="icon" style="width:32px;height:32px;font-size:14px;">${CATEGORY_ICONS[t.category] || '✦'}</div>
              <div class="meta">
                <div class="name" style="font-size:13.5px;">${t.note || t.category}</div>
                <div class="sub">${new Date(t.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
              </div>
              <div class="amt" style="font-size:13.5px;">${fmt(t.amount)}</div>
            </div>
          `).join('')}
        </div>
        <div class="row" style="gap:8px; margin-top:12px;">
          <button class="btn ghost small remind-btn" data-person="${g.person}" style="flex:1;">Remind me later</button>
          <button class="btn accent small settle-btn" data-person="${g.person}" style="flex:1;">Mark paid back</button>
        </div>
      </div>
    `).join('')}

    ${settled.length > 0 ? `
      <div class="section-title"><h2>Settled</h2><span class="count">${settled.length}</span></div>
      <div class="card" style="padding:6px 16px; opacity:.7;">
        ${settled.slice(0, 10).map(t => `
          <div class="list-item">
            <div class="icon">✓</div>
            <div class="meta"><div class="name">${t.person} — ${t.note || t.category}</div><div class="sub">paid back</div></div>
            <div class="amt pos">${fmt(t.amount)}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;

  $$('.settle-btn').forEach(btn => btn.onclick = (e) => settlePerson(e.target.dataset.person));
  $$('.remind-btn').forEach(btn => btn.onclick = (e) => {
    toast(`We'll nudge you about ${e.target.dataset.person} if it's still open in a week`);
  });
}

function settlePerson(person) {
  openSheet(`
    <h2>Mark ${person} as paid back?</h2>
    <p class="sub" style="margin-bottom:18px;">This clears their open balance. You can still see it under Settled.</p>
    <button class="btn accent" id="confirm-settle">Yes, they paid me back</button>
    <button class="btn ghost" style="margin-top:10px;" id="cancel-settle">Cancel</button>
  `);
  $('#confirm-settle').onclick = () => {
    state.transactions.forEach(t => { if (t.isIOU && t.person === person && !t.settled) t.settled = true; });
    save();
    closeSheet();
    toast(`Marked ${person} as settled`);
    render();
  };
  $('#cancel-settle').onclick = closeSheet;
}

/* ---------------- SETTINGS ---------------- */
function renderSettings() {
  setHeader('Settings', 'Your setup');
  $('#main').innerHTML = `
    <div class="section-title"><h2>Income</h2></div>
    <div class="card">
      <label>Monthly income</label>
      <input type="number" id="set-income" value="${state.income}" />
      <label>Payday (day of month)</label>
      <input type="number" id="set-payday" min="1" max="31" value="${state.payday}" />
      <button class="btn primary small" id="save-income" style="margin-top:14px; width:100%;">Save</button>
    </div>

    <div class="section-title">
      <h2>Recurring bills</h2>
      <span class="count">${fmtShort(recurringTotal())}/mo</span>
    </div>
    <div class="card" id="set-recurring-card"></div>
    <button class="btn ghost small" id="add-recurring-settings" style="width:100%; margin-bottom:10px;">+ Add a recurring bill</button>

    <div class="section-title"><h2>Reminders</h2></div>
    <div class="card">
      <div class="toggle-row">
        <div>
          <div style="font-weight:600; font-size:14.5px;">Start-of-month check-in</div>
          <div class="sub">Confirm rent, internet, power each month</div>
        </div>
        <label class="switch"><input type="checkbox" id="pref-monthly" ${state.notifPrefs.monthly ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="toggle-row">
        <div>
          <div style="font-weight:600; font-size:14.5px;">Weekly spending check</div>
          <div class="sub">A nudge to log everyday purchases</div>
        </div>
        <label class="switch"><input type="checkbox" id="pref-weekly" ${state.notifPrefs.weekly ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="toggle-row">
        <div>
          <div style="font-weight:600; font-size:14.5px;">Money owed to you</div>
          <div class="sub">Reminder after 7+ days unpaid</div>
        </div>
        <label class="switch"><input type="checkbox" id="pref-iou" ${state.notifPrefs.iou ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <button class="btn ghost small" id="enable-notifs" style="margin-top:14px; width:100%;">
        ${('Notification' in window) && Notification.permission === 'granted' ? '✓ Notifications enabled' : 'Enable notifications'}
      </button>
    </div>

    <div class="section-title"><h2>Data</h2></div>
    <div class="card">
      <p class="sub" style="margin-bottom:12px;">Everything is stored only on this device. Nothing is uploaded anywhere.</p>
      <button class="btn ghost small" id="export-data" style="width:100%; margin-bottom:8px;">Export as JSON</button>
      <button class="btn ghost small" id="reset-data" style="width:100%; color:var(--owe);">Reset all data</button>
    </div>
    <p class="sub" style="text-align:center; margin: 18px 0 30px;">Ledger · a quiet little budget notebook</p>
  `;

  renderSettingsRecurring();

  $('#save-income').onclick = () => {
    state.income = parseFloat($('#set-income').value) || state.income;
    state.payday = parseInt($('#set-payday').value) || state.payday;
    save(); toast('Saved'); render();
  };
  $('#add-recurring-settings').onclick = () => {
    state.recurring.push({ id: uid(), name: 'New bill', category: 'Other', amount: 0, day: 1 });
    save(); renderSettingsRecurring();
  };
  $('#pref-monthly').onchange = (e) => { state.notifPrefs.monthly = e.target.checked; save(); };
  $('#pref-weekly').onchange = (e) => { state.notifPrefs.weekly = e.target.checked; save(); };
  $('#pref-iou').onchange = (e) => { state.notifPrefs.iou = e.target.checked; save(); };
  $('#enable-notifs').onclick = async () => {
    const ok = await ensureNotifPermission();
    toast(ok ? 'Notifications enabled' : 'Notifications blocked — check browser settings');
    render();
  };
  $('#export-data').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ledger-export-${todayISO()}.json`;
    a.click();
    toast('Exported');
  };
  $('#reset-data').onclick = () => {
    openSheet(`
      <h2>Reset everything?</h2>
      <p class="sub" style="margin-bottom:18px;">This deletes all transactions, bills, and settings from this device. There's no undo.</p>
      <button class="btn accent" id="confirm-reset" style="background:var(--owe);">Delete everything</button>
      <button class="btn ghost" style="margin-top:10px;" id="cancel-reset">Cancel</button>
    `);
    $('#confirm-reset').onclick = () => {
      localStorage.removeItem(STORAGE_KEY);
      state = defaultState();
      closeSheet();
      activeScreen = 'home';
      document.querySelector('nav.tabbar').style.display = 'flex';
      render();
    };
    $('#cancel-reset').onclick = closeSheet;
  };
}

function renderSettingsRecurring() {
  const card = $('#set-recurring-card');
  if (!card) return;
  card.innerHTML = state.recurring.map((r, i) => `
    <div class="list-item">
      <div class="icon">${CATEGORY_ICONS[r.category] || '✦'}</div>
      <div class="meta">
        <input type="text" class="rs-name" data-i="${i}" value="${r.name}" style="border:none; padding:2px 0; font-weight:600; font-size:14.5px;" />
      </div>
      <input type="number" class="rs-amt num" data-i="${i}" value="${r.amount}" style="width:80px; border:none; text-align:right; padding:2px 0;" />
      <button class="rs-del" data-i="${i}" style="background:none; border:none; color:var(--ink-soft); font-size:16px; padding:0 0 0 6px;">✕</button>
    </div>
  `).join('');
  $$('.rs-name').forEach(inp => inp.onchange = (e) => { state.recurring[+e.target.dataset.i].name = e.target.value; save(); });
  $$('.rs-amt').forEach(inp => inp.onchange = (e) => { state.recurring[+e.target.dataset.i].amount = parseFloat(e.target.value) || 0; save(); renderSettings(); });
  $$('.rs-del').forEach(btn => btn.onclick = (e) => { state.recurring.splice(+e.target.dataset.i, 1); save(); renderSettings(); });
}

/* ============================================================
   ADD TRANSACTION SHEET
   ============================================================ */
function openAddTransaction() {
  let selectedCategory = 'Groceries';
  let isIOU = false;

  const html = `
    <h2>Add a transaction</h2>
    <label>Amount</label>
    <input type="number" id="tx-amount" inputmode="decimal" placeholder="0.00" autofocus style="font-size:22px; font-weight:600;" />

    <label>Category</label>
    <div class="chip-row" id="tx-categories">
      ${ALL_CATEGORIES.map(c => `<button type="button" class="chip ${c === selectedCategory ? 'selected' : ''}" data-cat="${c}">${CATEGORY_ICONS[c]} ${c}</button>`).join('')}
    </div>

    <label>Note (optional)</label>
    <input type="text" id="tx-note" placeholder="e.g. Trader Joe's run" />

    <label>Date</label>
    <input type="date" id="tx-date" value="${todayISO()}" />

    <div class="toggle-row" style="border-top:1px solid var(--line); margin-top:18px; padding-top:16px;">
      <div>
        <div style="font-weight:600; font-size:14.5px;">Someone else owes you for this</div>
        <div class="sub">e.g. you covered a friend, or paid the whole grocery bill</div>
      </div>
      <label class="switch"><input type="checkbox" id="tx-iou"><span class="slider"></span></label>
    </div>
    <div id="tx-person-wrap" style="display:none;">
      <label>Who owes you?</label>
      <input type="text" id="tx-person" placeholder="e.g. Jordan" />
    </div>

    <button class="btn accent" id="tx-save" style="margin-top:20px;">Add transaction</button>
  `;
  openSheet(html);

  $$('#tx-categories .chip').forEach(chip => {
    chip.onclick = () => {
      $$('#tx-categories .chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      selectedCategory = chip.dataset.cat;
    };
  });
  $('#tx-iou').onchange = (e) => {
    isIOU = e.target.checked;
    $('#tx-person-wrap').style.display = isIOU ? 'block' : 'none';
  };
  $('#tx-save').onclick = () => {
    const amount = parseFloat($('#tx-amount').value);
    if (!amount || amount <= 0) { toast('Enter an amount'); return; }
    const person = $('#tx-person').value.trim();
    if (isIOU && !person) { toast('Add who owes you'); return; }
    state.transactions.push({
      id: uid(),
      date: $('#tx-date').value || todayISO(),
      amount,
      category: selectedCategory,
      note: $('#tx-note').value.trim(),
      isIOU,
      person: isIOU ? person : null,
      settled: false,
    });
    save();
    closeSheet();
    toast('Added');
    render();
  };
}

function openTxDetail(id) {
  const t = state.transactions.find(x => x.id === id);
  if (!t) return;
  openSheet(`
    <h2>${t.note || t.category}</h2>
    <p class="sub">${new Date(t.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
    <div class="bigstat" style="margin:14px 0;">${fmt(t.amount)}</div>
    <div class="row" style="margin-bottom:6px;"><span class="sub">Category</span><span>${CATEGORY_ICONS[t.category] || ''} ${t.category}</span></div>
    ${t.isIOU ? `<div class="row" style="margin-bottom:6px;"><span class="sub">Owed by</span><span>${t.person}${t.settled ? ' (settled)' : ''}</span></div>` : ''}
    <button class="btn ghost" id="tx-delete" style="margin-top:18px; color:var(--owe);">Delete this transaction</button>
  `);
  $('#tx-delete').onclick = () => {
    state.transactions = state.transactions.filter(x => x.id !== id);
    save();
    closeSheet();
    toast('Deleted');
    render();
  };
}

/* ============================================================
   SHEET / MODAL helpers
   ============================================================ */
function openSheet(html) {
  $('#sheet-content').innerHTML = html;
  $('#modal-backdrop').classList.add('open');
}
function closeSheet() {
  $('#modal-backdrop').classList.remove('open');
}
$('#modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modal-backdrop') closeSheet();
});

/* ============================================================
   NAV BINDINGS
   ============================================================ */
$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    activeScreen = btn.dataset.screen;
    render();
    window.scrollTo(0, 0);
  });
});
$('#fab-add').addEventListener('click', openAddTransaction);

/* ============================================================
   SERVICE WORKER REGISTRATION
   ============================================================ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('SW failed', e));
  });
}

/* ============================================================
   INIT
   ============================================================ */
render();
checkReminders();
