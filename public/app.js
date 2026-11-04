/* Hebrew admin UI. Plain JS, talks to the same REST API that customers use. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmtDate = (d) => (d ? new Date(d).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');
  let token = null;
  try { token = localStorage.getItem('token'); } catch {}
  let me = null;

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 401 && token) { logout(); throw new Error('יש להתחבר מחדש'); }
    if (!res.ok) throw new Error(data?.error?.message || `שגיאה ${res.status}`);
    return data;
  }

  // Stroke icons (24x24), inline SVG
  const ICONS = {
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    template: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    building: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    upload: '<path d="M12 15V3M7 8l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    pointer: '<path d="m4 4 7 16 2.5-6.5L20 11z"/>',
    bounce: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
    book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v18H6.5A2.5 2.5 0 0 0 4 22.5z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
  };
  const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon, el.classList.contains('brand-mark') ? 20 : 18); el.style.color = el.classList.contains('brand-mark') ? '#fff' : ''; });
  const empty = (ic, title, text, action = '') => `<div class="empty"><div class="ico">${icon(ic, 26)}</div><b>${title}</b><p>${text}</p>${action}</div>`;

  function toast(msg, kind = 'ok') {
    const t = $('#toast');
    t.innerHTML = `${icon(kind === 'error' ? 'alert' : 'check', 18)}<span></span>`;
    t.querySelector('span').textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 3000);
  }
  function modal(html) { $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }
  function closeModal() { $('#modal').classList.add('hidden'); }
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.dataset.close !== undefined) closeModal(); });

  /** Downloads a file from an authenticated API path. */
  async function download(path, filename) {
    const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) { toast('ההורדה נכשלה'); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-zone]'); if (b) download(`/v1/domains/${b.dataset.zone}/zone`, `dns-${b.dataset.name}.txt`); });

  async function copy(text) { try { await navigator.clipboard.writeText(text); toast('הועתק'); } catch { toast('ההעתקה נכשלה'); } }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copy(b.dataset.copy); });

  const STATUS = {
    verified: ['מאומת', 'good'], pending: ['ממתין', 'warn'], failed: ['נכשל', 'bad'], degraded: ['נפגע', 'bad'],
    active: ['פעיל', 'good'], suspended: ['מושעה', 'bad'], unsubscribed: ['הוסר', 'warn'], bounced: ['חזר', 'bad'], complained: ['התלונן', 'bad'],
    queued: ['בתור', 'warn'], sending: ['בשליחה', 'warn'], sent: ['נשלח', 'good'], delivered: ['נמסר', 'good'], suppressed: ['חסום', 'bad'],
    draft: ['טיוטה', ''], scheduled: ['מתוזמן', 'warn'], paused: ['מושהה', 'bad'], cancelled: ['בוטל', ''],
  };
  const badge = (s) => { const [l, c] = STATUS[s] || [s, '']; return `<span class="badge ${c}">${esc(l)}</span>`; };

  // ---------- Auth ----------
  document.querySelectorAll('[data-auth-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-auth-tab]').forEach((x) => x.classList.toggle('active', x === b));
      $('#login-form').classList.toggle('hidden', b.dataset.authTab !== 'login');
      $('#signup-form').classList.toggle('hidden', b.dataset.authTab !== 'signup');
      const signup = b.dataset.authTab === 'signup';
      $('#auth-title').textContent = signup ? 'פותחים חשבון' : 'ברוך שובך';
      $('#auth-sub').textContent = signup ? 'כמה פרטים, ואפשר להתחיל לשלוח' : 'התחברות לחשבון הדיוור שלך';
    }),
  );
  const formData = (f) => Object.fromEntries(new FormData(f).entries());
  async function authSubmit(e, path) {
    e.preventDefault();
    $('#auth-error').textContent = '';
    try {
      const r = await api('POST', path, formData(e.target));
      token = r.token;
      try { localStorage.setItem('token', token); } catch {}
      await boot();
    } catch (err) { $('#auth-error').textContent = err.message; }
  }
  $('#login-form').addEventListener('submit', (e) => authSubmit(e, '/v1/auth/login'));
  $('#signup-form').addEventListener('submit', (e) => authSubmit(e, '/v1/auth/signup'));
  function logout() {
    if (token) fetch('/v1/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {});
    token = null;
    try { localStorage.removeItem('token'); } catch {}
    $('#shell').classList.add('hidden');
    $('#auth').classList.remove('hidden');
  }
  $('#logout').addEventListener('click', logout);

  // ---------- Routing ----------
  const routes = {
    dashboard: ['לוח בקרה', dashboard, null, 'home', 'ראשי'],
    campaigns: ['דיוורים', campaigns, null, 'send', 'ראשי'],
    templates: ['תבניות', templates, null, 'template', 'ראשי'],
    contacts: ['אנשי קשר', contacts, null, 'users', 'קהל'],
    lists: ['רשימות', lists, null, 'list', 'קהל'],
    emails: ['מיילים שנשלחו', emails, null, 'inbox', 'קהל'],
    domains: ['דומיינים', domains, null, 'globe', 'שליחה'],
    senders: ['שולחים', senders, () => me.account.type === 'platform', 'building', 'שליחה'],
    keys: ['מפתחות API', keys, null, 'key', 'פיתוח'],
    webhooks: ['Webhooks', webhooks, null, 'zap', 'פיתוח'],
    docs: ['תיעוד API', null, null, 'book', 'פיתוח'],
    settings: ['הגדרות חשבון', settings, null, 'settings', 'חשבון'],
    admin: ['ניהול חשבונות', admin, () => me.user?.is_superadmin, 'shield', 'חשבון'],
  };
  function renderNav(current) {
    let group = '';
    $('#nav').innerHTML = Object.entries(routes)
      .filter(([, r]) => !r[2] || r[2]())
      .map(([k, r]) => {
        const head = r[4] !== group ? `<div class="nav-group">${(group = r[4])}</div>` : '';
        if (k === 'docs') return `${head}<a href="/docs" target="_blank" rel="noopener">${icon(r[3])}<span>${esc(r[0])}</span></a>`;
        return `${head}<a href="#/${k}" class="${k === current ? 'active' : ''}">${icon(r[3])}<span>${esc(r[0])}</span></a>`;
      })
      .join('');
    $('#topbar-title').textContent = routes[current]?.[0] || '';
    $('#shell').classList.remove('menu-open');
  }
  $('#menu').addEventListener('click', () => $('#shell').classList.toggle('menu-open'));
  $('#shell').addEventListener('click', (e) => { if (e.target.id === 'shell') $('#shell').classList.remove('menu-open'); });
  async function route() {
    const [name, ...rest] = (location.hash.replace(/^#\//, '').split('?')[0] || 'dashboard').split('/');
    const r = (routes[name] && routes[name][1]) ? routes[name] : routes.dashboard;
    renderNav(routes[name] ? name : 'dashboard');
    $('#view').innerHTML = '<div class="loading"><div class="spinner"></div>טוען…</div>';
    window.scrollTo(0, 0);
    try { await r[1](...rest); } catch (err) { $('#view').innerHTML = empty('alert', 'משהו השתבש', esc(err.message)); return; }
    // A table with only its header row becomes a friendly empty state
    const E = EMPTY[name];
    if (E && !rest.length) $('#view').querySelectorAll('.table-wrap').forEach((w) => { if (w.querySelectorAll('tr').length <= 1) w.outerHTML = empty(...E); });
  }
  window.addEventListener('hashchange', route);
  const EMPTY = {
    campaigns: ['send', 'עוד אין דיוורים', 'בוחרים תבנית, רשימת יעד ושולחים. אפשר לשלוח בדיקה לפני.', '<a href="#/campaigns/new"><button class="primary">דיוור חדש</button></a>'],
    emails: ['inbox', 'עוד לא נשלחו מיילים בודדים', 'מיילים שנשלחים דרך ה-API, כמו חשבוניות ואישורים, יופיעו כאן עם מצב המסירה שלהם.'],
    contacts: ['users', 'עוד אין אנשי קשר', 'מייבאים קובץ CSV, מוסיפים דרך ה-API או מחברים טופס הרשמה לרשימה.'],
    lists: ['list', 'עוד אין רשימות', 'יוצרים רשימה למעלה, ומייבאים אליה אנשי קשר.'],
    keys: ['key', 'עוד אין מפתחות API', 'יוצרים מפתח כדי לשלוח מיילים ולנהל את החשבון מהמערכות שלך.'],
    webhooks: ['zap', 'עוד אין Webhooks', 'מוסיפים כתובת, והמערכת תודיע לה על מסירה, חזרות, תלונות והסרות.'],
    senders: ['building', 'עוד אין שולחים', 'כל שולח הוא לקוח שלך עם דומיין משלו.'],
  };

  async function boot() {
    if (!token) { $('#auth').classList.remove('hidden'); return; }
    me = await api('GET', '/v1/me');
    $('#auth').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    $('#brand').textContent = me.account.name;
    $('#brand-sub').textContent = me.account.type === 'platform' ? 'חשבון פלטפורמה' : 'חשבון דיוור';
    $('#who').textContent = me.user?.email || '';
    $('#who-name').textContent = me.user?.name || me.account.name;
    $('#avatar').textContent = (me.user?.name || me.account.name || '?').trim().charAt(0);
    $('#banner').innerHTML = me.account.status === 'pending'
      ? `<div class="banner">${icon('alert')}<span>החשבון ממתין לאישור. עד האישור אפשר לשלוח עד ${me.account.daily_limit} מיילים ביום, ודיוורים לרשימות לא זמינים.</span></div>`
      : me.account.status === 'suspended' ? `<div class="banner">${icon('alert')}<span>החשבון מושעה. לבירור פנו לתמיכה.</span></div>` : '';
    route();
  }

  // ---------- Views ----------
  /** Bar chart (sent per day, problems stacked in red) with an opens line. Plain SVG. */
  function chartSvg(daily) {
    const W = 720, H = 220, padL = 8, padR = 36, padT = 10, padB = 26;
    const max = Math.max(4, ...daily.map((d) => d.sent));
    const step = Math.pow(10, Math.floor(Math.log10(max)));
    const top = Math.ceil(max / step) * step;
    const iw = W - padL - padR, ih = H - padT - padB, bw = iw / daily.length;
    const y = (v) => padT + ih - (v / top) * ih;
    const ticks = [0, top / 2, top];
    const grid = ticks.map((t) => `<line class="grid-line" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/><text x="${W - padR + 6}" y="${y(t) + 4}">${Math.round(t).toLocaleString('he-IL')}</text>`).join('');
    const bars = daily.map((d, i) => {
      const x = padL + i * bw + bw * 0.18, w = bw * 0.64;
      const ok = Math.max(0, d.sent - d.problems);
      return `<g><title>${d.day.slice(8, 10)}/${d.day.slice(5, 7)}: נשלחו ${d.sent}, נפתחו ${d.opened}, בעיות ${d.problems}</title>
        <rect class="bar-sent" x="${x}" y="${y(ok)}" width="${w}" height="${ih + padT - y(ok)}" rx="3"/>
        ${d.problems ? `<rect class="bar-problem" x="${x}" y="${y(d.sent)}" width="${w}" height="${y(ok) - y(d.sent)}" rx="2"/>` : ''}</g>`;
    }).join('');
    const pts = daily.map((d, i) => [padL + i * bw + bw / 2, y(d.opened)]);
    const line = `<path class="line-open" d="${pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')}"/>${pts.map((p) => `<circle class="dot-open" cx="${p[0]}" cy="${p[1]}" r="3"/>`).join('')}`;
    const labels = daily.map((d, i) => (i % 2 === daily.length % 2 ? '' : `<text x="${padL + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${Number(d.day.slice(8, 10))}/${Number(d.day.slice(5, 7))}</text>`)).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="מיילים שנשלחו ונפתחו ב-14 הימים האחרונים">${grid}${bars}${line}${labels}</svg>`;
  }

  async function dashboard() {
    me = await api('GET', '/v1/me');
    const [stats, camps, keysList] = await Promise.all([api('GET', '/v1/stats?days=14'), api('GET', '/v1/campaigns?limit=5'), api('GET', '/v1/api-keys')]);
    const t = stats.totals, c = stats.counts;
    const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');
    const used = me.usage.daily_limit ? Math.min(100, (me.usage.today / me.usage.daily_limit) * 100) : 0;
    const hour = new Date().getHours();
    const hello = hour < 12 ? 'בוקר טוב' : hour < 17 ? 'צהריים טובים' : hour < 21 ? 'ערב טוב' : 'לילה טוב';
    const steps = [
      [c.verified_domains > 0, 'לאמת דומיין שליחה', 'כדי שהמיילים יגיעו לתיבה ולא לספאם', '#/domains'],
      [c.contacts > 0, 'לייבא אנשי קשר', 'מקובץ CSV או דרך ה-API', '#/contacts'],
      [c.lists > 0, 'ליצור רשימת תפוצה', 'אליה שולחים את הדיוורים', '#/lists'],
      [camps.some((x) => x.status === 'sent' || x.status === 'sending'), 'לשלוח דיוור ראשון', 'עם תבנית מוכנה ותצוגה מקדימה', '#/campaigns/new'],
      [keysList.length > 0, 'לחבר מערכת דרך ה-API', 'אופציונלי: מפתח API ושליחה מהקוד', '#/keys'],
    ];
    const done = steps.filter((x) => x[0]).length;
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>${hello}${me.user?.name ? `, ${esc(me.user.name.split(' ')[0])}` : ''}</h1><p>מה קורה עם המיילים של ${esc(me.account.name)} ב-14 הימים האחרונים</p></div>
        <div class="actions"><a href="#/campaigns/new"><button class="primary">${icon('plus')}דיוור חדש</button></a></div></div>
      <div class="grid">
        <div class="card stat"><div class="ico">${icon('send', 20)}</div><div class="n">${t.sent.toLocaleString('he-IL')}</div><div class="l">מיילים נשלחו</div></div>
        <div class="card stat"><div class="ico good">${icon('check', 20)}</div><div class="n">${pct(t.delivered, t.sent)}</div><div class="l">נמסרו בהצלחה</div></div>
        <div class="card stat"><div class="ico info">${icon('eye', 20)}</div><div class="n">${pct(t.opened, t.sent)}</div><div class="l">נפתחו · ${pct(t.clicked, t.sent)} הקליקו</div></div>
        <div class="card stat"><div class="ico warn">${icon('bounce', 20)}</div><div class="n">${pct(t.problems, t.sent)}</div><div class="l">חזרות, תלונות ושגיאות</div></div>
      </div>
      <div class="grid-2" style="margin-top:16px">
        <div class="card chart-card">
          <div class="row between"><h3>פעילות יומית</h3><div class="legend"><span><i style="background:var(--brand)"></i>נשלחו</span><span><i style="background:var(--accent)"></i>נפתחו</span><span><i style="background:var(--bad)"></i>בעיות</span></div></div>
          ${t.sent ? chartSvg(stats.daily) : `<div class="empty" style="margin-top:12px;border-style:dashed">${''}<b>עוד אין נתונים</b><p>הגרף יתמלא אחרי הדיוור הראשון.</p></div>`}
        </div>
        <div class="card">
          <h3 style="margin:0 0 4px;font-size:16px">מכסה יומית</h3>
          <div class="stat" style="box-shadow:none"><div class="n">${me.usage.today.toLocaleString('he-IL')} <small style="font-size:15px;font-weight:500">/ ${me.usage.daily_limit.toLocaleString('he-IL')}</small></div></div>
          <div class="meter"><i style="width:${used}%"></i></div>
          <p class="muted" style="margin:10px 0 0;font-size:13px">מתאפס כל יום בחצות · רמת חשבון: <b>${esc(me.trust.name)}</b></p>
          ${me.trust.next_step ? `<p style="margin:8px 0 0;font-size:13px;padding:10px 12px;border-radius:10px;background:var(--brand-soft)">${esc(me.trust.next_step)}</p>` : ''}
          <div style="display:flex;gap:16px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line-2)">
            <div><div style="font-size:20px;font-weight:800">${c.contacts.toLocaleString('he-IL')}</div><small>אנשי קשר פעילים</small></div>
            <div><div style="font-size:20px;font-weight:800">${c.verified_domains}/${c.domains}</div><small>דומיינים מאומתים</small></div>
          </div>
        </div>
      </div>
      ${done < steps.length ? `<div class="card" style="margin-top:16px"><div class="row between"><h3 style="margin:0;font-size:16px">צעדים ראשונים</h3><small>${done} מתוך ${steps.length}</small></div>
        <div class="meter" style="margin:10px 0 16px"><i style="width:${(done / steps.length) * 100}%"></i></div>
        <div class="steps">${steps.map((x, i) => `<a class="step ${x[0] ? 'done' : ''}" href="${x[3]}" style="color:inherit;text-decoration:none"><span class="num">${x[0] ? icon('check', 14) : i + 1}</span><div><b>${x[1]}</b><small class="muted">${x[2]}</small></div></a>`).join('')}</div></div>` : ''}
      <h2>דיוורים אחרונים</h2>
      ${camps.length ? `<div class="table-wrap"><table><tr><th>שם</th><th>נושא</th><th>מצב</th><th>נוצר</th></tr>${camps.map((x) => `<tr><td><a href="#/campaigns/${x.id}">${esc(x.name)}</a></td><td>${esc(x.subject)}</td><td>${badge(x.status)}</td><td>${fmtDate(x.created_at)}</td></tr>`).join('')}</table></div>`
        : empty('send', 'עוד אין דיוורים', 'יוצרים דיוור מתבנית מוכנה, בוחרים רשימה ושולחים.', '<a href="#/campaigns/new"><button class="primary">דיוור חדש</button></a>')}`;
  }

  const PURPOSE = { dkim: 'חתימת DKIM', mail_from_mx: 'כתובת החזרות (MX)', mail_from_spf: 'SPF', dmarc: 'מדיניות DMARC', bimi: 'לוגו (BIMI)' };
  const CF_ACTION = { created: ['נוספה', 'good'], updated: ['עודכנה', 'good'], unchanged: ['כבר הייתה תקינה', 'good'], skipped: ['דילגנו', ''], error: ['שגיאה', 'bad'] };
  function cloudflareCard(d) {
    if (!d.records.some((r) => r.status !== 'verified')) return '';
    return `<div class="card" style="margin-bottom:12px">
      <div class="row" style="align-items:flex-start;gap:14px">
        <div style="width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:#fff4e6;color:#f38020;flex:none">${icon('zap', 22)}</div>
        <div style="flex:1;min-width:220px"><b>הדרך הכי קלה: חיבור אוטומטי ל-Cloudflare</b>
          <p class="muted" style="margin:4px 0 0">המערכת מוסיפה את כל הרשומות בעצמה ומאמתת מיד. המפתח משמש רק לפעולה הזו ולא נשמר.</p></div></div>
      ${me.cloudflare_operator ? `<div class="row" style="margin-top:14px"><button class="primary" id="cf-operator">${icon('zap')}הוספה אוטומטית עם החיבור של המערכת</button><small class="muted">לדומיינים שלך ב-Cloudflare</small></div>` : ''}
      <details style="margin-top:12px" ${me.cloudflare_operator ? '' : 'open'}><summary style="cursor:pointer;font-weight:600">${me.cloudflare_operator ? 'או עם מפתח של חשבון Cloudflare אחר' : 'איך יוצרים מפתח (דקה אחת)'}</summary>
        <ol style="margin:10px 0;padding-inline-start:20px;line-height:1.9;color:var(--ink-2)">
          <li>נכנסים ל-<a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">Cloudflare ← My Profile ← API Tokens</a> ← <b>Create Token</b>.</li>
          <li>בוחרים בתבנית <b>Edit zone DNS</b> ← Use template.</li>
          <li>ב-Zone Resources בוחרים <b>Specific zone</b> ← הדומיין <span class="ltr">${esc(d.name.split('.').slice(-3).join('.'))}</span> (או הדומיין הראשי שלו).</li>
          <li>Continue to summary ← <b>Create Token</b> ← מעתיקים ומדביקים כאן.</li>
        </ol>
        <div class="row"><input id="cf-token" type="password" placeholder="מפתח API של Cloudflare" class="ltr" style="flex:1;min-width:220px;margin:0" autocomplete="off">
          <button class="primary" id="cf-apply">${icon('zap')}הוספת הרשומות</button></div>
      </details>
      <div id="cf-result"></div></div>`;
  }
  /** One-click setup through Domain Connect, shown only when the customer's DNS provider supports our template. */
  async function loadDomainConnect(d) {
    const slot = $('#dc-slot');
    if (!slot) return;
    let info;
    try { info = await api('GET', `/v1/domains/${d.id}/domain-connect`); } catch { return; }
    if (!info.available || !$('#dc-slot')) return;
    slot.innerHTML = `<div class="card" style="margin-bottom:12px;border:1.5px solid var(--brand);background:linear-gradient(135deg,var(--brand-soft),var(--surface))">
      <div class="row between"><div><b style="font-size:16px">חיבור ל-${esc(info.provider)} בלחיצה אחת</b>
        <p class="muted" style="margin:4px 0 0">עוברים ל-${esc(info.provider)}, מאשרים את הרשומות, וחוזרים לכאן מאומתים. בלי מפתחות ובלי העתקה.</p></div>
        <button class="primary" id="dc-go" style="padding:12px 22px">${icon('zap')}חיבור ל-${esc(info.provider)}</button></div></div>`;
    $('#dc-go').onclick = async (e) => {
      e.currentTarget.disabled = true;
      try { const r = await api('POST', `/v1/domains/${d.id}/domain-connect`); location.href = r.url; }
      catch (err) { toast(err.message, 'error'); e.currentTarget.disabled = false; }
    };
  }
  function bindCloudflare(d) {
    const run = async (btn, body) => {
      btn.disabled = true; const label = btn.innerHTML; btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> מוסיף…';
      try {
        const r = await api('POST', `/v1/domains/${d.id}/cloudflare`, body);
        $('#cf-result').innerHTML = `<div class="table-wrap" style="margin-top:14px"><table><tr><th>רשומה</th><th>סוג</th><th>תוצאה</th></tr>
          ${r.results.map((x) => `<tr><td class="ltr">${esc(x.name)}</td><td>${x.type}</td><td><span class="badge ${CF_ACTION[x.action][1]}">${CF_ACTION[x.action][0]}</span>${x.detail && x.action !== 'unchanged' ? `<br><small class="muted">${esc(x.detail)}</small>` : ''}</td></tr>`).join('')}</table></div>
          <p style="margin:10px 0 0">${r.domain.status === 'verified' ? '<span class="badge good">הדומיין מאומת</span>' : 'הרשומות נוספו. האימות מתעדכן תוך כמה דקות, והמערכת ממשיכה לבדוק לבד.'}</p>`;
        toast(r.domain.status === 'verified' ? 'הדומיין מאומת' : 'הרשומות נוספו ל-Cloudflare');
        if (r.domain.status === 'verified') setTimeout(() => domains(d.id), 1800);
      } catch (err) { toast(err.message, 'error'); }
      finally { btn.disabled = false; btn.innerHTML = label; if ($('#cf-token')) $('#cf-token').value = ''; }
    };
    const op = $('#cf-operator'); if (op) op.onclick = () => run(op, { use_operator: true });
    const ap = $('#cf-apply'); if (ap) ap.onclick = () => { const t = $('#cf-token').value.trim(); if (!t) return toast('צריך להדביק מפתח', 'error'); run(ap, { token: t }); };
  }
  function recordsTable(d, withCloudflare = false) {
    const pending = d.records.some((r) => r.status !== 'verified');
    return `${withCloudflare && pending ? '<div id="dc-slot"></div>' : ''}${withCloudflare ? cloudflareCard(d) : ''}${pending ? `<div class="card row between" style="margin-bottom:12px"><div><b>או: ייבוא קובץ</b><br><small class="muted">ב-Cloudflare: DNS ← Records ← Import and Export ← Import. בלי לסמן "Proxy imported DNS records".</small></div>
      <button class="primary" data-zone="${d.id}" data-name="${esc(d.name)}">הורדת קובץ DNS</button></div>` : ''}<div class="table-wrap"><table><tr><th>מטרה</th><th>סוג</th><th>שם (Host)</th><th>ערך</th><th>מצב</th></tr>
      ${d.records.map((r) => `<tr><td>${PURPOSE[r.purpose] || r.purpose}</td><td>${r.type}</td>
        <td class="ltr">${esc(r.name)} <button class="copy" data-copy="${esc(r.name)}">העתקה</button></td>
        <td class="ltr">${r.priority ? `${r.priority} ` : ''}${esc(r.value)} <button class="copy" data-copy="${esc(r.value)}">העתקה</button></td>
        <td>${badge(r.status || 'pending')}</td></tr>`).join('')}</table></div>
      <p class="muted">או ידנית: מוסיפים את הרשומות אצל ספק ה-DNS של הדומיין (למשל Cloudflare, Box, GoDaddy). בחלק מהספקים כותבים בשדה השם רק את החלק שלפני הדומיין. הבדיקה רצה אוטומטית כל 10 דקות, למשך 72 שעות.</p>`;
  }
  const check = (ok, text, hint = '') => `<div class="step ${ok ? 'done' : ''}" style="align-items:center"><span class="num">${ok ? icon('check', 14) : icon('x', 14)}</span><div><b>${text}</b>${hint ? `<small class="muted">${hint}</small>` : ''}</div></div>`;
  function bimiCard(d) {
    const b = d.bimi || {};
    const upload = `<div class="row" style="margin-top:12px;align-items:flex-end">
        <label style="flex:1;margin:0">קובץ לוגו (SVG Tiny PS, ריבועי)<input type="file" id="bimi-svg" accept=".svg,image/svg+xml"></label>
        <label style="flex:1;margin:0">תעודת VMC/CMC <small>(לא חובה, ל-Gmail ולאייפון)</small><input type="file" id="bimi-cert" accept=".pem,.crt,.cer,text/plain"></label>
        <button class="primary" id="bimi-save">${icon('upload')}${b.enabled ? 'החלפה' : 'העלאה'}</button></div><p class="error" id="bimi-err"></p>`;
    if (!b.enabled) {
      return `<h2>לוגו השולח (BIMI)</h2><div class="card"><div class="row" style="align-items:flex-start;gap:16px">
        <div class="ico" style="width:48px;height:48px;border-radius:14px;display:grid;place-items:center;background:var(--brand-soft);color:var(--brand)">${icon('image', 22)}</div>
        <div style="flex:1"><b>הלוגו של העסק ליד המייל בתיבת הדואר</b><p class="muted" style="margin:4px 0 0">ב-Yahoo וב-AOL מספיק לוגו ומדיניות DMARC מחמירה. ב-Gmail ובאייפון נדרשת גם תעודת VMC או CMC בתשלום.</p></div></div>${upload}</div>`;
    }
    const pol = b.dmarc || {};
    const where = (b.shows_in || []).map((x) => ({ yahoo: 'Yahoo', aol: 'AOL', gmail: 'Gmail', apple: 'Apple Mail' })[x]).join(', ');
    return `<h2>לוגו השולח (BIMI)</h2><div class="card"><div class="row" style="align-items:flex-start;gap:20px">
      <img src="${esc(b.logo_url)}" alt="לוגו" style="width:88px;height:88px;border-radius:50%;border:1px solid var(--line);background:#fff;object-fit:contain">
      <div style="flex:1;min-width:240px"><div class="steps">
        ${check(true, 'הלוגו תקין ומאוחסן', `<span class="ltr">${esc(b.logo_url)}</span>`)}
        ${check(pol.ready, `מדיניות DMARC: ${esc(pol.policy || 'none')}${pol.pct !== 100 ? ` (${pol.pct}%)` : ''}`, pol.ready ? '' : pol.record ? `צריך p=quarantine או p=reject ב-100%. הרשומה היום ב-<span class="ltr">${esc(pol.location)}</span>: <span class="ltr">${esc(pol.record)}</span>` : 'עוד אין רשומת DMARC. קובץ ה-DNS להורדה כולל רשומה מחמירה שמתאימה ללוגו')}
        ${check(b.dns_record?.status === 'verified', 'רשומת BIMI ב-DNS', b.dns_record?.status === 'verified' ? '' : 'נמצאת בקובץ ה-DNS להורדה, או בטבלת הרשומות למעלה')}
        ${check(b.certificate, b.certificate ? 'תעודה הועלתה' : 'בלי תעודה', b.certificate ? 'הלוגו יכול להופיע גם ב-Gmail ובאייפון' : 'הלוגו יופיע רק ב-Yahoo וב-AOL')}
      </div>
      <p style="margin:14px 0 0">${where ? `<span class="badge good">מוכן</span> הלוגו יופיע ב: ${esc(where)}` : '<span class="badge warn">עוד לא מוכן</span> כשכל הסעיפים יסומנו, הלוגו יתחיל להופיע (ספקי הדואר מתעדכנים תוך כמה ימים)'}</p></div></div>
      ${upload}<button class="link danger" id="bimi-del" style="margin-top:4px">הסרת הלוגו</button></div>`;
  }
  function bindBimi(d) {
    const save = $('#bimi-save');
    if (save) save.onclick = async () => {
      const f = $('#bimi-svg').files[0], c = $('#bimi-cert').files[0];
      if (!f) { $('#bimi-err').textContent = 'צריך לבחור קובץ SVG'; return; }
      save.disabled = true;
      try { await api('PUT', `/v1/domains/${d.id}/bimi`, { svg: await f.text(), certificate: c ? await c.text() : null }); toast('הלוגו נשמר'); domains(d.id); }
      catch (err) { $('#bimi-err').textContent = err.message; save.disabled = false; }
    };
    const del = $('#bimi-del');
    if (del) del.onclick = async () => { if (confirm('להסיר את הלוגו?')) { await api('DELETE', `/v1/domains/${d.id}/bimi`); domains(d.id); } };
  }
  async function domains(id) {
    if (id) {
      const d = await api('GET', `/v1/domains/${id}`);
      $('#view').innerHTML = `<div class="row between"><h1 class="ltr" style="text-align:right">${esc(d.name)} ${badge(d.status)}</h1>
        <div class="row"><button class="primary" id="verify">בדיקה עכשיו</button><button class="danger" id="del">מחיקה</button></div></div>
        <p>${d.status === 'verified' ? 'הדומיין מאומת ואפשר לשלוח ממנו מכל כתובת.' : 'כדי לאמת, צריך להוסיף את הרשומות הבאות ב-DNS של הדומיין:'}</p>
        ${recordsTable(d, true)}${bimiCard(d)}<p><a href="#/domains">חזרה לרשימה</a></p>`;
      bindBimi(d);
      bindCloudflare(d);
      loadDomainConnect(d);
      const dc = new URLSearchParams(location.hash.split('?')[1] || '').get('dc');
      if (dc) { toast(dc === 'ok' ? 'הרשומות אושרו אצל ספק ה-DNS. האימות מתעדכן תוך כמה דקות' : 'החיבור בוטל או נכשל אצל ספק ה-DNS', dc === 'ok' ? 'ok' : 'error'); history.replaceState(null, '', `#/domains/${d.id}`); }
      $('#verify').onclick = async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'בודק…';
        try { const r = await api('POST', `/v1/domains/${id}/verify`); toast(r.status === 'verified' ? 'הדומיין מאומת' : 'נבדק. חלק מהרשומות עדיין לא נמצאו'); domains(id); }
        catch (err) { toast(err.message); b.disabled = false; b.textContent = 'בדיקה עכשיו'; }
      };
      $('#del').onclick = async () => {
        if (!confirm('למחוק את הדומיין? לא יהיה אפשר לשלוח ממנו.')) return;
        try { await api('DELETE', `/v1/domains/${id}`); location.hash = '#/domains'; } catch (err) { toast(err.message); }
      };
      return;
    }
    const list = await api('GET', '/v1/domains');
    $('#view').innerHTML = `<h1>דומיינים</h1>
      <form id="add" class="card row"><input name="name" placeholder="example.co.il" class="ltr" required style="flex:1;min-width:200px"><button class="primary">הוספת דומיין</button></form>
      <h2>הדומיינים שלך</h2>
      ${list.length ? `<div class="table-wrap"><table><tr><th>דומיין</th><th>מצב</th><th>DKIM</th><th>MAIL FROM</th><th>DMARC</th></tr>
      ${list.filter((d) => !d.sender_id).map((d) => `<tr><td class="ltr"><a href="#/domains/${d.id}">${esc(d.name)}</a></td><td>${badge(d.status)}</td><td>${badge(d.checks.dkim)}</td><td>${badge(d.checks.mail_from)}</td><td>${badge(d.checks.dmarc)}</td></tr>`).join('')}
      </table></div>` : empty('globe', 'עוד אין דומיינים', 'מוסיפים את הדומיין שממנו שולחים, מורידים קובץ DNS ומייבאים אותו. המערכת מאמתת לבד.')}`;
    $('#add').onsubmit = async (e) => {
      e.preventDefault();
      try { const d = await api('POST', '/v1/domains', formData(e.target)); location.hash = `#/domains/${d.id}`; } catch (err) { toast(err.message); }
    };
  }

  async function senders(id) {
    if (id) {
      const s = await api('GET', `/v1/senders/${id}`);
      $('#view').innerHTML = `<h1>${esc(s.name)} ${badge(s.status)}</h1><p class="muted">מזהה חיצוני: <span class="ltr">${esc(s.external_id || '—')}</span> · מזהה: <span class="ltr">${s.id}</span></p>
        <form id="add" class="card row"><input name="name" placeholder="הדומיין של השולח" class="ltr" required style="flex:1"><button class="primary">הוספת דומיין</button></form>
        ${s.domains.map((d) => `<h2 class="ltr" style="text-align:right">${esc(d.name)} ${badge(d.status)}</h2>${recordsTable(d)}`).join('')}
        <p><a href="#/senders">חזרה</a></p>`;
      $('#add').onsubmit = async (e) => { e.preventDefault(); try { await api('POST', `/v1/senders/${id}/domains`, formData(e.target)); senders(id); } catch (err) { toast(err.message); } };
      return;
    }
    const list = await api('GET', '/v1/senders?limit=200');
    $('#view').innerHTML = `<h1>שולחים</h1><p class="muted">כל שולח הוא לקוח שלך (למשל עסק ברצף) עם דומיין משלו. שולח שלא אימת דומיין שולח מכתובת הגיבוי שלך.</p>
      <form id="add" class="card row"><input name="name" placeholder="שם השולח" required style="flex:1"><input name="external_id" placeholder="מזהה אצלך (לא חובה)" class="ltr" style="flex:1"><button class="primary">הוספה</button></form>
      <div class="table-wrap" style="margin-top:16px"><table><tr><th>שם</th><th>מזהה חיצוני</th><th>דומיינים</th></tr>
      ${list.map((s) => `<tr><td><a href="#/senders/${s.id}">${esc(s.name)}</a></td><td class="ltr">${esc(s.external_id || '')}</td><td>${(s.domains || []).map((d) => `<span class="ltr">${esc(d.name)}</span> ${badge(d.status)}`).join('<br>')}</td></tr>`).join('')}</table></div>`;
    $('#add').onsubmit = async (e) => { e.preventDefault(); const b = formData(e.target); if (!b.external_id) delete b.external_id; try { await api('POST', '/v1/senders', b); senders(); } catch (err) { toast(err.message); } };
  }

  async function emails() {
    const list = await api('GET', '/v1/emails?limit=100');
    $('#view').innerHTML = `<h1>מיילים שנשלחו</h1><p class="muted">מיילים בודדים שנשלחו דרך ה-API (לא כולל דיוורים).</p>
      <div class="table-wrap"><table><tr><th>נמען</th><th>נושא</th><th>שולח</th><th>מצב</th><th>זמן</th></tr>
      ${list.map((m) => `<tr><td class="ltr">${esc(m.to_email)}${m.cc?.length || m.bcc?.length ? ` <span class="badge info">+${(m.cc?.length || 0) + (m.bcc?.length || 0)}</span>` : ''}${m.test ? ' <span class="badge">בדיקה</span>' : ''}</td><td>${esc(m.subject)}</td><td class="ltr">${esc(m.from_email)}${m.used_fallback ? ' <span class="badge warn">גיבוי</span>' : ''}</td><td>${badge(m.status)}${m.last_error ? `<br><small>${esc(m.last_error)}</small>` : ''}</td><td>${fmtDate(m.created_at)}</td></tr>`).join('')}</table></div>`;
  }

  function parseCsv(text) {
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, '')));
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.toLowerCase());
    const hasHead = head.some((h) => ['email', 'מייל', 'אימייל', 'דוא"ל'].includes(h));
    const ei = hasHead ? head.findIndex((h) => ['email', 'מייל', 'אימייל', 'דוא"ל'].includes(h)) : 0;
    const ni = hasHead ? head.findIndex((h) => ['name', 'שם'].includes(h)) : 1;
    return rows.slice(hasHead ? 1 : 0).filter((r) => /@/.test(r[ei] || '')).map((r) => ({ email: r[ei], name: ni >= 0 ? r[ni] || null : null }));
  }
  async function contacts() {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const [data, ls] = await Promise.all([api('GET', `/v1/contacts?limit=100&search=${encodeURIComponent(q.get('s') || '')}`), api('GET', '/v1/lists')]);
    $('#view').innerHTML = `<div class="page-head"><h1>אנשי קשר <small>(${data.total.toLocaleString('he-IL')})</small></h1><button class="primary" id="imp">ייבוא מקובץ</button></div>
      <form id="search" class="row"><input name="s" value="${esc(q.get('s') || '')}" placeholder="חיפוש לפי מייל או שם" style="flex:1"><button>חיפוש</button></form>
      <div class="table-wrap" style="margin-top:12px"><table><tr><th>מייל</th><th>שם</th><th>מצב</th><th>מקור ההסכמה</th><th>נוסף</th></tr>
      ${data.items.map((c) => `<tr><td class="ltr">${esc(c.email)}</td><td>${esc(c.name)}</td><td>${badge(c.status)}</td><td>${esc(c.consent_source)}</td><td>${fmtDate(c.created_at)}</td></tr>`).join('')}</table></div>`;
    $('#search').onsubmit = (e) => { e.preventDefault(); location.hash = `#/contacts?s=${encodeURIComponent(formData(e.target).s)}`; };
    $('#imp').onclick = () => {
      modal(`<h2>ייבוא אנשי קשר</h2><p class="muted">קובץ CSV עם עמודת מייל, ואפשר גם עמודת שם. אפשר גם להדביק.</p>
        <input type="file" id="file" accept=".csv,.txt"><label>או הדבקה<textarea id="paste" placeholder="email,name"></textarea></label>
        <label>לרשימה<select id="list"><option value="">בלי רשימה</option>${ls.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select></label>
        <label>מאיפה הגיעה ההסכמה של הנמענים?<input id="src" placeholder="למשל: טופס הרשמה באתר" required></label>
        <label><input type="checkbox" id="decl"> אני מאשר/ת שכל הנמענים בקובץ הסכימו לקבל ממני דיוור, כנדרש בחוק</label>
        <p class="error" id="err"></p><div class="row"><button class="primary" id="go">ייבוא</button><button data-close>ביטול</button></div>`);
      $('#file').onchange = async (e) => { $('#paste').value = await e.target.files[0].text(); };
      $('#go').onclick = async () => {
        const rows = parseCsv($('#paste').value);
        if (!rows.length) return ($('#err').textContent = 'לא נמצאו כתובות מייל');
        try {
          const r = await api('POST', '/v1/contacts/import', { contacts: rows, list_ids: $('#list').value ? [$('#list').value] : [], consent_source: $('#src').value, consent_declared: $('#decl').checked });
          closeModal(); toast(`יובאו ${r.imported} אנשי קשר`); contacts();
        } catch (err) { $('#err').textContent = err.message; }
      };
    };
  }

  async function lists() {
    const ls = await api('GET', '/v1/lists');
    $('#view').innerHTML = `<h1>רשימות</h1>
      <form id="add" class="card row"><input name="name" placeholder="שם הרשימה" required style="flex:1"><button class="primary">יצירת רשימה</button></form>
      <div class="table-wrap" style="margin-top:16px"><table><tr><th>שם</th><th>חברים מאושרים</th><th>אישור כפול</th><th>טופס הרשמה</th></tr>
      ${ls.map((l) => `<tr><td>${esc(l.name)}</td><td>${l.members.toLocaleString('he-IL')}</td><td>${l.double_opt_in ? (l.from_email ? 'כן' : '<small>חסרה כתובת שולח למייל האישור</small>') : 'לא'}</td>
        <td class="ltr">POST ${location.origin}/s/${l.id} <button class="copy" data-copy="${location.origin}/s/${l.id}">העתקה</button></td></tr>`).join('')}</table></div>
      <p class="muted">טופס הרשמה באתר שולח את השדות email ו-name לכתובת שבטבלה. ברשימה עם אישור כפול הנרשם מקבל מייל אישור לפני שהוא נכנס לרשימה.</p>`;
    $('#add').onsubmit = async (e) => { e.preventDefault(); await api('POST', '/v1/lists', { ...formData(e.target), double_opt_in: false }); lists(); };
  }

  const STARTER_HTML = `<!doctype html>
<html lang="he" dir="rtl">
<body style="margin:0;background:#f5f5f4">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px">
        <tr><td dir="rtl" style="padding:32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.7;color:#1c1917;text-align:right">
          <h1 style="margin:0 0 16px;font-size:24px">כותרת</h1>
          <p style="margin:0 0 16px">שלום {{name}},</p>
          <p style="margin:0 0 24px">כאן כותבים את התוכן.</p>
          <a href="https://example.co.il" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold">לפרטים</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  /** HTML textarea with a live preview underneath. Merge tags are filled with sample values. */
  function htmlEditor(value, name = 'html') {
    return `<label>תוכן HTML <small>(אפשר {{name}}, {{email}}, {{attr.שדה}}. בדיוור, התחתית עם פרטי העסק וקישור ההסרה מתווספת אוטומטית)</small>
      <textarea name="${name}" data-preview="pv-${name}" style="min-height:260px">${esc(value)}</textarea></label>
      <div class="row between"><b>תצוגה מקדימה</b><small class="muted">עם נתוני דוגמה</small></div>
      <iframe id="pv-${name}" sandbox style="width:100%;height:420px;border:1px solid var(--line);border-radius:10px;background:#fff;margin:6px 0 16px"></iframe>`;
  }
  const sampleVars = { name: 'דנה', email: 'dana@example.co.il', attr: {} };
  function fillSample(html) {
    return html.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, k) => {
      const key = k === 'שם' ? 'name' : k === 'מייל' ? 'email' : k;
      const v = key.split('.').reduce((o, x) => (o == null ? undefined : o[x]), sampleVars);
      return esc(v ?? `[${k}]`);
    });
  }
  function bindPreviews(root = document) {
    root.querySelectorAll('textarea[data-preview]').forEach((ta) => {
      const frame = document.getElementById(ta.dataset.preview);
      const update = () => { frame.srcdoc = fillSample(ta.value); };
      let t;
      ta.addEventListener('input', () => { clearTimeout(t); t = setTimeout(update, 250); });
      update();
    });
  }

  function campaignForm(c, ls, tpls, preset, doms = []) {
    const sel = new Set((c?.lists || []).map((l) => l.id));
    const html = c?.html || preset?.html || STARTER_HTML;
    return `<form id="cf" class="card">
      ${tpls.length ? `<label>טעינה מתבנית<select id="tpl-pick"><option value="">בחירת תבנית…</option>${tpls.map((t) => `<option value="${t.id}" ${preset?.id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>` : ''}
      <label>שם פנימי<input name="name" value="${esc(c?.name || (preset ? preset.name : ''))}" required></label>
      <label>נושא <small>(אפשר {{name}})</small><input name="subject" value="${esc(c?.subject || preset?.subject || '')}" required></label>
      <label style="font-weight:500"><input type="checkbox" name="is_advertisement" ${(c ? c.is_advertisement : me.account.ad_label_default) ? 'checked' : ''}> להוסיף «פרסומת» בתחילת הנושא <small>(חובה בדיוור פרסומי לפי חוק התקשורת)</small></label>
      <div class="row"><label style="flex:1">שם השולח<input name="from_name" value="${esc(c?.from_name || me.account.name)}" required></label>
      <div style="flex:1">${senderField(c?.from_email || '', doms)}</div></div>
      <label>כתובת לתשובות (לא חובה)<input name="reply_to" class="ltr" value="${esc(c?.reply_to)}"></label>
      <label>רשימות יעד</label><div class="row" style="margin-bottom:12px">${ls.map((l) => `<label style="font-weight:400"><input type="checkbox" name="list" value="${l.id}" ${sel.has(l.id) ? 'checked' : ''}>${esc(l.name)} (${l.members})</label>`).join('') || '<span class="muted">אין רשימות</span>'}</div>
      ${htmlEditor(html)}
      <div class="row"><button class="primary">שמירה</button><button type="button" id="save-tpl">שמירה כתבנית</button><a href="#/campaigns">ביטול</a></div></form>`;
  }
  /**
   * Sender address: the local part is typed, the domain is picked from the account's verified domains,
   * so a campaign can't be saved with an address the system would refuse to send from.
   */
  function senderField(current, doms) {
    const [local, dom] = current.includes('@') ? current.split('@') : ['', ''];
    const verified = doms.filter((d) => d.status === 'verified' && !d.sender_id).map((d) => d.name);
    const options = [...verified];
    if (dom && !options.includes(dom)) options.push(dom);
    if (!options.length) {
      return `<label>כתובת השולח</label><div class="banner" style="margin:6px 0 0">${icon('alert')}<span>עוד אין דומיין מאומת. <a href="#/domains">מוסיפים ומאמתים דומיין</a>, ואז אפשר לבחור כתובת שולח.</span></div><input type="hidden" name="from_email" value="">`;
    }
    return `<label>כתובת השולח</label>
      <div style="display:flex;direction:ltr;align-items:stretch;margin-top:6px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface);overflow:hidden">
        <input name="from_local" value="${esc(local || 'news')}" required pattern="[A-Za-z0-9._%+-]+" title="אותיות באנגלית, ספרות, נקודה, מקף או קו תחתון" class="ltr"
          style="border:0;margin:0;flex:1;min-width:80px;border-radius:0;background:transparent;box-shadow:none" placeholder="news">
        <span style="display:grid;place-items:center;padding:0 8px;color:var(--muted);background:var(--surface-2);font-family:ui-monospace,Consolas,monospace">@</span>
        ${options.length === 1
          ? `<span class="ltr" style="display:grid;place-items:center;padding:0 12px;background:var(--surface-2)">${esc(options[0])}</span><input type="hidden" name="from_domain" value="${esc(options[0])}">`
          : `<select name="from_domain" class="ltr" style="border:0;margin:0;width:auto;border-radius:0;background:var(--surface-2);box-shadow:none">${options.map((o) => `<option value="${esc(o)}" ${o === (dom || verified[0]) ? 'selected' : ''}>${esc(o)}${verified.includes(o) ? '' : ' (לא מאומת)'}</option>`).join('')}</select>`}
      </div>
      <small class="muted">אפשר לשלוח מכל כתובת בדומיין מאומת.</small>`;
  }
  function readCampaignForm(f) {
    const b = formData(f);
    delete b.list;
    b.is_advertisement = f.is_advertisement.checked;
    if (b.from_local !== undefined) {
      b.from_email = `${String(b.from_local).trim()}@${b.from_domain}`;
      delete b.from_local;
      delete b.from_domain;
    }
    b.list_ids = [...f.querySelectorAll('input[name=list]:checked')].map((x) => x.value);
    if (!b.reply_to) b.reply_to = null;
    return b;
  }
  async function campaigns(id, sub) {
    const ls = await api('GET', '/v1/lists');
    if (id === 'new' || sub === 'edit') {
      const c = id === 'new' ? null : await api('GET', `/v1/campaigns/${id}`);
      const [tpls, doms] = await Promise.all([api('GET', '/v1/templates'), api('GET', '/v1/domains')]);
      const presetId = new URLSearchParams(location.hash.split('?')[1] || '').get('template');
      const preset = !c && presetId ? tpls.find((t) => t.id === presetId) : null;
      $('#view').innerHTML = `<h1>${c ? 'עריכת דיוור' : 'דיוור חדש'}</h1>${campaignForm(c, ls, tpls, preset, doms)}`;
      bindPreviews();
      const form = $('#cf');
      const pick = $('#tpl-pick');
      if (pick) pick.onchange = () => {
        const t = tpls.find((x) => x.id === pick.value);
        if (!t) return;
        const dirty = form.html.value.trim() && form.html.value !== STARTER_HTML;
        if (dirty && !confirm('לטעון את התבנית? התוכן הנוכחי יוחלף.')) { pick.value = ''; return; }
        form.html.value = t.html;
        if (t.subject && (!form.subject.value || confirm('להחליף גם את הנושא בנושא של התבנית?'))) form.subject.value = t.subject;
        form.html.dispatchEvent(new Event('input'));
      };
      $('#save-tpl').onclick = async () => {
        const name = prompt('שם התבנית:', form.name.value || '');
        if (!name) return;
        try { await api('POST', '/v1/templates', { name, subject: form.subject.value, html: form.html.value }); toast('נשמרה תבנית'); } catch (err) { toast(err.message); }
      };
      $('#cf').onsubmit = async (e) => {
        e.preventDefault();
        try { const r = await api(c ? 'PATCH' : 'POST', c ? `/v1/campaigns/${id}` : '/v1/campaigns', readCampaignForm(e.target)); location.hash = `#/campaigns/${r.id}`; } catch (err) { toast(err.message); }
      };
      return;
    }
    if (id) {
      const c = await api('GET', `/v1/campaigns/${id}`);
      const s = c.stats;
      const pct = (n) => (s.sent ? `${((n / s.sent) * 100).toFixed(1)}%` : '—');
      $('#view').innerHTML = `<div class="page-head"><h1>${esc(c.name)} ${badge(c.status)}</h1><div class="row">
        ${['draft', 'scheduled', 'paused'].includes(c.status) ? `<a href="#/campaigns/${id}/edit"><button>עריכה</button></a><button id="test">שליחת בדיקה</button>` : ''}
        ${['draft'].includes(c.status) ? '<button class="primary" id="send">שליחה</button>' : ''}
        ${['scheduled', 'sending'].includes(c.status) ? '<button id="pause">השהיה</button>' : ''}
        ${c.status === 'paused' ? '<button class="primary" id="resume">המשך שליחה</button>' : ''}
        ${!['sent', 'cancelled', 'draft'].includes(c.status) ? '<button class="danger" id="cancel">ביטול</button>' : ''}</div></div>
        ${c.paused_reason ? `<div class="banner">${esc(c.paused_reason)}</div>` : ''}
        <p><b>נושא:</b> ${esc(c.subject)} · <b>שולח:</b> <span class="ltr">${esc(c.from_name)} &lt;${esc(c.from_email)}&gt;</span> · <b>רשימות:</b> ${c.lists.map((l) => esc(l.name)).join(', ') || '—'}</p>
        <div class="grid">
          <div class="card stat"><div class="n">${s.sent}</div><div class="l">נשלחו (${s.queued} בתור)</div></div>
          <div class="card stat"><div class="n">${pct(s.opened)}</div><div class="l">פתחו (${s.opened})</div></div>
          <div class="card stat"><div class="n">${pct(s.clicked)}</div><div class="l">הקליקו (${s.clicked})</div></div>
          <div class="card stat"><div class="n">${pct(s.bounced)}</div><div class="l">חזרו (${s.bounced})</div></div>
          <div class="card stat"><div class="n">${s.complained}</div><div class="l">תלונות ספאם</div></div>
          <div class="card stat"><div class="n">${s.unsubscribed}</div><div class="l">הסירו את עצמם</div></div>
        </div>
        <h2>תצוגה מקדימה</h2><iframe sandbox style="width:100%;height:480px;border:1px solid var(--line);border-radius:10px;background:#fff" srcdoc="${esc(c.html)}"></iframe>`;
      const act = (sel, fn) => { const b = $(sel); if (b) b.onclick = async () => { try { await fn(); campaigns(id); } catch (err) { toast(err.message); } }; };
      act('#send', async () => { if (confirm('לשלוח את הדיוור עכשיו לכל הנמענים ברשימות?')) await api('POST', `/v1/campaigns/${id}/send`, {}); });
      act('#pause', () => api('POST', `/v1/campaigns/${id}/pause`));
      act('#resume', () => api('POST', `/v1/campaigns/${id}/resume`));
      act('#cancel', async () => { if (confirm('לבטל את הדיוור? מיילים שעוד לא נשלחו לא יישלחו.')) await api('POST', `/v1/campaigns/${id}/cancel`); });
      act('#test', async () => { const to = prompt('לאיזו כתובת לשלוח בדיקה?', me.user?.email || ''); if (to) { await api('POST', `/v1/campaigns/${id}/test`, { to: [to] }); toast('נשלחה בדיקה'); } });
      return;
    }
    const list = await api('GET', '/v1/campaigns?limit=100');
    $('#view').innerHTML = `<div class="page-head"><h1>דיוורים</h1><a href="#/campaigns/new"><button class="primary">דיוור חדש</button></a></div>
      <div class="table-wrap"><table><tr><th>שם</th><th>נושא</th><th>מצב</th><th>נוצר</th></tr>
      ${list.map((c) => `<tr><td><a href="#/campaigns/${c.id}">${esc(c.name)}</a></td><td>${esc(c.subject)}</td><td>${badge(c.status)}</td><td>${fmtDate(c.created_at)}</td></tr>`).join('')}</table></div>`;
  }

  async function templates(id) {
    if (id) {
      const t = id === 'new' ? null : await api('GET', `/v1/templates/${id}`);
      $('#view').innerHTML = `<h1>${t ? 'עריכת תבנית' : 'תבנית חדשה'}</h1>
        <form id="tf" class="card">
          <label>שם התבנית<input name="name" value="${esc(t?.name)}" required></label>
          <label>נושא ברירת מחדל <small>(לא חובה)</small><input name="subject" value="${esc(t?.subject)}"></label>
          ${htmlEditor(t?.html || STARTER_HTML)}
          <div class="row"><button class="primary">שמירה</button>
          ${t ? `<a href="#/campaigns/new?template=${t.id}"><button type="button">דיוור חדש מהתבנית</button></a><button type="button" id="dup">שכפול</button><button type="button" class="danger" id="del">מחיקה</button>` : ''}
          <a href="#/templates">ביטול</a></div>
        </form>`;
      bindPreviews();
      $('#tf').onsubmit = async (e) => {
        e.preventDefault();
        const b = formData(e.target);
        try {
          const r = await api(t ? 'PATCH' : 'POST', t ? `/v1/templates/${id}` : '/v1/templates', b);
          toast('נשמר');
          if (!t) location.hash = `#/templates/${r.id}`;
        } catch (err) { toast(err.message); }
      };
      if (t) {
        $('#dup').onclick = async () => { const r = await api('POST', '/v1/templates', { name: `${t.name} (עותק)`, subject: t.subject, html: $('#tf').html.value }); location.hash = `#/templates/${r.id}`; };
        $('#del').onclick = async () => { if (confirm('למחוק את התבנית? דיוורים שכבר נוצרו ממנה לא יושפעו.')) { await api('DELETE', `/v1/templates/${id}`); location.hash = '#/templates'; } };
      }
      return;
    }
    const list = await api('GET', '/v1/templates');
    $('#view').innerHTML = `<div class="page-head"><h1>תבניות</h1><a href="#/templates/new"><button class="primary">תבנית חדשה</button></a></div>
      <p class="muted">תבנית היא עיצוב ותוכן שאפשר לטעון לכל דיוור חדש. שינוי בתבנית לא משנה דיוורים שכבר נוצרו ממנה.</p>
      ${list.length ? `<div class="table-wrap"><table><tr><th>שם</th><th>נושא</th><th>עודכנה</th><th></th></tr>
      ${list.map((t) => `<tr><td><a href="#/templates/${t.id}">${esc(t.name)}</a></td><td>${esc(t.subject)}</td><td>${fmtDate(t.updated_at)}</td>
        <td><a href="#/campaigns/new?template=${t.id}">דיוור מהתבנית</a></td></tr>`).join('')}</table></div>` : empty('template', 'עוד אין תבניות', 'אפשר ליצור תבנית כאן, או לשמור דיוור קיים כתבנית.', '<a href="#/templates/new"><button class="primary">תבנית חדשה</button></a>')}`;
  }

  async function keys() {
    const list = await api('GET', '/v1/api-keys');
    $('#view').innerHTML = `<h1>מפתחות API</h1><p class="muted">שולחים את המפתח בכותרת <span class="ltr">Authorization: Bearer &lt;key&gt;</span>. המפתח מוצג פעם אחת בלבד.</p>
      <form id="add" class="card row"><input name="name" placeholder="שם המפתח, למשל: שרת ייצור" required style="flex:1">
        <select name="mode" style="width:auto;margin:0"><option value="live">מפתח אמיתי</option><option value="test">מפתח בדיקה</option></select>
        <button class="primary">${icon('plus')}יצירת מפתח</button></form>
      <div class="card" style="margin-bottom:16px;background:var(--surface-2)"><b>מפתח בדיקה (mk_test_…)</b><p class="muted" style="margin:4px 0 0">עובר את כל התהליך, מחזיר מזהים ושולח webhooks, אבל לא שולח מיילים באמת. אפשר להתחיל בו לפני שהדומיין מאומת. כתובת שמתחילה ב-<span class="ltr">bounce</span> מדמה חזרה, <span class="ltr">complaint</span> מדמה תלונה ו-<span class="ltr">delay</span> מדמה עיכוב.</p></div>
      <div id="newkey"></div>
      <div class="table-wrap" style="margin-top:16px"><table><tr><th>שם</th><th>סוג</th><th>תחילית</th><th>שימוש אחרון</th><th></th></tr>
      ${list.map((k) => `<tr><td>${esc(k.name)}</td><td>${k.mode === 'test' ? '<span class="badge warn">בדיקה</span>' : '<span class="badge good">אמיתי</span>'}</td><td class="ltr">${esc(k.prefix)}…</td><td>${fmtDate(k.last_used_at) || '—'}</td><td><button class="danger" data-revoke="${k.id}">ביטול</button></td></tr>`).join('')}</table></div>`;
    $('#add').onsubmit = async (e) => {
      e.preventDefault();
      const k = await api('POST', '/v1/api-keys', formData(e.target));
      $('#newkey').innerHTML = `<div class="keybox" style="margin-top:12px"><b>המפתח החדש (שמרו אותו עכשיו):</b><div class="ltr" style="margin:8px 0">${esc(k.key)}</div><button class="copy" data-copy="${esc(k.key)}">העתקה</button></div>`;
    };
    document.querySelectorAll('[data-revoke]').forEach((b) => (b.onclick = async () => { if (confirm('לבטל את המפתח? מערכות שמשתמשות בו יפסיקו לעבוד.')) { await api('DELETE', `/v1/api-keys/${b.dataset.revoke}`); keys(); } }));
  }

  async function webhooks() {
    const list = await api('GET', '/v1/webhooks');
    $('#view').innerHTML = `<h1>Webhooks</h1><p class="muted">המערכת שולחת POST לכתובת שלך על כל אירוע (נמסר, חזר, תלונה, פתיחה, הסרה, אימות דומיין). הבקשה חתומה בכותרת <span class="ltr">X-Mailer-Signature</span>.</p>
      <form id="add" class="card row"><input name="url" class="ltr" placeholder="https://example.co.il/hooks/mail" required style="flex:1"><button class="primary">הוספה</button></form>
      <div id="secret"></div>
      <div class="table-wrap" style="margin-top:16px"><table><tr><th>כתובת</th><th>אירועים</th><th></th></tr>
      ${list.map((w) => `<tr><td class="ltr">${esc(w.url)}</td><td>${w.events.length ? w.events.join(', ') : 'הכל'}</td><td><button class="danger" data-del="${w.id}">מחיקה</button></td></tr>`).join('')}</table></div>`;
    $('#add').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const w = await api('POST', '/v1/webhooks', formData(e.target));
        $('#secret').innerHTML = `<div class="keybox" style="margin-top:12px"><b>סוד החתימה (מוצג פעם אחת):</b><div class="ltr">${esc(w.secret)}</div><button class="copy" data-copy="${esc(w.secret)}">העתקה</button></div>`;
      } catch (err) { toast(err.message); }
    };
    document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { await api('DELETE', `/v1/webhooks/${b.dataset.del}`); webhooks(); }));
  }

  async function settings() {
    me = await api('GET', '/v1/me');
    const a = me.account;
    $('#view').innerHTML = `<h1>הגדרות חשבון</h1><form id="f" class="card">
      <label>שם החשבון<input name="name" value="${esc(a.name)}"></label>
      <h2>פרטים לתחתית הדיוור <small>(חובה לפי חוק הספאם)</small></h2>
      <label>שם העסק<input name="company_name" value="${esc(a.company_name)}"></label>
      <label>כתובת<input name="company_address" value="${esc(a.company_address)}"></label>
      <label>מייל ליצירת קשר<input name="contact_email" class="ltr" value="${esc(a.contact_email)}"></label>
      <label><input type="checkbox" name="track_transactional" ${a.track_transactional ? 'checked' : ''}> מעקב פתיחות והקלקות גם במיילים תפעוליים</label>
      <label><input type="checkbox" name="ad_label_default" ${a.ad_label_default ? 'checked' : ''}> להוסיף «פרסומת» אוטומטית לנושא של דיוורים חדשים</label>
      <p class="muted" style="margin:-8px 0 16px;font-size:13px">לפי חוק התקשורת (סעיף 30א), דיוור פרסומי חייב לכלול את המילה «פרסומת» בכותרת. אפשר לכבות את זה לדיוורים שאינם פרסומיים, או אם מוסיפים את המילה בעצמכם. בכל דיוור אפשר גם להחליט בנפרד. האחריות על השימוש בהגדרה היא של בעל החשבון.</p>
      ${a.type === 'platform' ? `<h2>כתובת גיבוי לשולחים לא מאומתים</h2>
      <label>כתובת השולח <small>(על דומיין מאומת של החשבון, אי אפשר להשיב אליה)</small><input name="fallback_from_email" class="ltr" value="${esc(a.fallback_from_email)}" placeholder="noreply@docs.example.co.il"></label>
      <label>תבנית שם השולח<input name="fallback_name_template" value="${esc(a.fallback_name_template)}"></label>
      <p class="muted">{{name}} = השם שהתבקש, {{account}} = שם החשבון. למשל: «{{name}} באמצעות רצף».</p>` : ''}
      <button class="primary">שמירה</button></form>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      b.track_transactional = !!e.target.track_transactional.checked;
      b.ad_label_default = !!e.target.ad_label_default.checked;
      for (const k of ['company_name', 'company_address', 'contact_email', 'fallback_from_email']) if (k in b && !b[k]) b[k] = null;
      try { await api('PATCH', '/v1/account', b); toast('נשמר'); } catch (err) { toast(err.message); }
    };
  }

  const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);
  async function adminBackups() {
    const box = $('#backup-admin');
    if (!box) return;
    let b;
    try { b = await api('GET', '/admin/backups'); } catch (err) { box.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
    if (!b.configured) {
      box.innerHTML = `<div class="banner">${icon('alert')}<span>הגיבוי לא מוגדר עדיין. צריך להוסיף ב-CapRover את משתני <span class="ltr">BACKUP_S3_*</span> ו-<span class="ltr">BACKUP_PASSPHRASE</span>. ההוראות ב-<span class="ltr">docs/backup.md</span>.</span></div>`;
      return;
    }
    const last = b.last;
    box.innerHTML = `<div class="card">
      <div class="row between"><div>
        ${last ? (last.ok ? `<span class="badge good">הגיבוי האחרון הצליח</span> ${fmtDate(last.at)} · ${fmtSize(last.bytes)} · ${last.seconds} שניות` : `<span class="badge bad">הגיבוי האחרון נכשל</span> ${fmtDate(last.at)}<br><small class="muted">${esc(last.error)}</small>`) : '<span class="badge warn">עוד לא בוצע גיבוי</span>'}
        <p class="muted" style="margin:6px 0 0;font-size:13px">גיבוי מוצפן כל יום אחרי ${String(b.hour).padStart(2, '0')}:00 לדלי <span class="ltr">${esc(b.bucket)}</span>, נשמר ${b.retention_days} ימים.</p></div>
        <button class="primary" id="backup-now">${icon('upload')}גיבוי עכשיו</button></div>
      ${b.list_error ? `<p class="error">לא הצלחתי לקרוא את הדלי: ${esc(b.list_error)}</p>` : ''}
      ${b.backups.length ? `<div class="table-wrap" style="margin-top:14px"><table><tr><th>תאריך</th><th>גודל</th><th>קובץ</th></tr>
        ${b.backups.slice(0, 10).map((x) => `<tr><td>${fmtDate(x.modified)}</td><td>${fmtSize(x.size)}</td><td class="ltr">${esc(x.key)}</td></tr>`).join('')}</table></div>` : ''}
    </div>`;
    $('#backup-now').onclick = async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> מגבה…';
      try { const r = await api('POST', '/admin/backups/run'); toast(`הגיבוי הושלם (${fmtSize(r.bytes)})`); adminBackups(); }
      catch (err) { toast(err.message, 'error'); adminBackups(); }
    };
  }
  async function adminDomainConnect() {
    const box = $('#dc-admin');
    if (!box) return;
    let s;
    try { s = await api('GET', '/admin/domain-connect'); } catch (err) { box.innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
    box.innerHTML = `<div class="card"><p class="muted" style="margin-top:0">חיבור בלחיצה אצל ספקי DNS (Cloudflare, GoDaddy ועוד) דורש שהתבנית שלנו תירשם אצלם. ההוראות המלאות במאגר: <span class="ltr">docs/domain-connect.md</span></p>
      <div class="steps">
        ${check(s.public_key_published, 'מפתח החתימה מפורסם ב-DNS', s.public_key_published ? '' : 'מוסיפים ב-Cloudflare של retsef.co.il את רשומות ה-TXT שלמטה')}
        ${s.templates.map((t) => check(t.cloudflare_supported, `${esc(t.name)}: ${t.cloudflare_supported ? 'אושרה ב-Cloudflare' : 'ממתינה לאישור Cloudflare'}`, `<span class="ltr">${esc(t.file)}</span>`)).join('')}
      </div>
      <h3 style="font-size:15px;margin:18px 0 8px">רשומות המפתח הציבורי (TXT)</h3>
      <div class="table-wrap"><table><tr><th>שם</th><th>ערך</th></tr>${s.public_key_records.map((r) => `<tr><td class="ltr">${esc(r.name)} <button class="copy" data-copy="${esc(r.name)}">העתקה</button></td><td class="ltr">${esc(r.value)} <button class="copy" data-copy="${esc(r.value)}">העתקה</button></td></tr>`).join('')}</table></div>
      <div class="row" style="margin-top:12px"><button class="primary" id="dc-keyzone">${icon('download')}הורדת קובץ DNS של המפתח (לייבוא ל-Cloudflare)</button></div>
      <h3 style="font-size:15px;margin:18px 0 8px">קובצי התבניות (להגשה ב-GitHub)</h3>
      <div class="row">${s.templates.map((t, i) => `<button data-tpl="${i}">${icon('download')}${esc(t.file)}</button>`).join('')}</div></div>`;
    $('#dc-keyzone').onclick = () => {
      const lines = [';; Domain Connect signing key for retsef.co.il', ';; Import into the retsef.co.il zone in Cloudflare (DNS > Records > Import and Export > Import)']
        .concat(s.public_key_records.map((r) => `${r.name}.\t3600\tIN\tTXT\t"${r.value}"`));
      const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }));
      Object.assign(document.createElement('a'), { href: url, download: 'dns-domain-connect-key.txt' }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    box.querySelectorAll('[data-tpl]').forEach((b) => (b.onclick = () => {
      const t = s.templates[Number(b.dataset.tpl)];
      const url = URL.createObjectURL(new Blob([JSON.stringify(t.json, null, 2) + '\n'], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: t.file }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
  }
  async function admin() {
    const list = await api('GET', '/admin/accounts');
    setTimeout(adminDomainConnect, 0);
    setTimeout(adminBackups, 0);
    $('#view').innerHTML = `<h1>ניהול חשבונות</h1><div class="table-wrap"><table><tr><th>חשבון</th><th>סוג</th><th>מצב</th><th>רמה</th><th>מכסה יומית</th><th>30 יום: נשלחו / חזרו / תלונות</th><th></th></tr>
      ${list.map((a) => `<tr><td>${esc(a.name)}<br><small class="ltr">${esc(a.contact_email)}</small></td><td>${a.type === 'platform' ? 'פלטפורמה' : 'רגיל'}</td><td>${badge(a.status)}${a.paused_reason ? `<br><small class="muted">${esc(a.paused_reason)}</small>` : ''}</td><td>${['חדש', 'מאומת', 'מבוסס', 'ותיק', 'מוביל'][a.trust_level] || a.trust_level}${a.trust_manual ? ' <small class="muted">(ידני)</small>' : ''}</td><td>${a.daily_limit.toLocaleString('he-IL')}</td>
        <td>${a.sent_30d} / ${a.bounced_30d} / ${a.complained_30d}</td><td><button data-edit="${a.id}">עריכה</button></td></tr>`).join('')}</table></div>
      <h2>גיבויים</h2><div id="backup-admin"><div class="loading"><div class="spinner"></div>בודק…</div></div>
      <h2>חיבור בלחיצה לספקי DNS (Domain Connect)</h2><div id="dc-admin"><div class="loading"><div class="spinner"></div>בודק…</div></div>`;
    document.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => {
      const a = list.find((x) => x.id === b.dataset.edit);
      modal(`<h2>${esc(a.name)}</h2><form id="af">
        <label>מצב<select name="status">${['pending', 'active', 'suspended'].map((s) => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${STATUS[s][0]}</option>`).join('')}</select></label>
        <label>סוג<select name="type"><option value="standard" ${a.type === 'standard' ? 'selected' : ''}>רגיל</option><option value="platform" ${a.type === 'platform' ? 'selected' : ''}>פלטפורמה</option></select></label>
        <label>מכסה יומית<input name="daily_limit" type="number" value="${a.daily_limit}"></label>
        <label><input type="checkbox" name="auto_trust" ${a.trust_manual ? '' : 'checked'}> הגדלה אוטומטית של המכסה לפי איכות השליחה</label>
        <label><input type="checkbox" name="can_use_reserved_domains" ${a.can_use_reserved_domains ? 'checked' : ''}> מותר לאמת תת-דומיינים של דומיינים שמורים (למשל mail.retsef.co.il)</label>
        <div class="row"><button class="primary">שמירה</button><button type="button" data-close>ביטול</button></div></form>`);
      $('#af').onsubmit = async (e) => {
        e.preventDefault();
        const f = formData(e.target);
        const body = { status: f.status, type: f.type, can_use_reserved_domains: e.target.can_use_reserved_domains.checked, auto_trust: e.target.auto_trust.checked };
        if (Number(f.daily_limit) !== a.daily_limit) body.daily_limit = Number(f.daily_limit);
        try { await api('PATCH', `/admin/accounts/${a.id}`, body); closeModal(); admin(); } catch (err) { toast(err.message, 'error'); }
      };
    }));
  }

  boot().catch(() => logout());
})();
