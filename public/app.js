/* FarmDirect front end: a local food directory. Vanilla JS, no build step. */
(() => {
  'use strict';

  // ---------- state ----------
  const state = {
    token: null, user: null, place: null, radius: 50, cart: null, pickMap: null, maps: [],
    center: { lat: 20, lng: 0 }, located: false, placeLabel: '', dtab: 'overview',
    units: /-(US|GB|LR|MM)$/i.test(navigator.language || 'en-US') ? 'mi' : 'km', mode: 'visitor',
  };
  try { const u = localStorage.getItem('fd_units'); if (u === 'mi' || u === 'km') state.units = u; } catch { /* ignore */ }
  try { const m = localStorage.getItem('fd_mode'); if (m === 'owner' || m === 'visitor') state.mode = m; } catch { /* ignore */ }
  try { state.token = localStorage.getItem('fd_token'); } catch { /* storage unavailable */ }
  try { const p = JSON.parse(localStorage.getItem('fd_place2') || 'null'); if (p && p.slug) setPlaceState(p); } catch { /* ignore */ }
  try { const r = Number(localStorage.getItem('fd_radius')); if (r >= 0) state.radius = r || 50; } catch { /* ignore */ }

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  const authDialog = $('#authDialog');
  const dlg = $('#dlg');

  // ---------- utils ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (cents, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(cents / 100); } catch { return `${cur || ''} ${(cents / 100).toFixed(2)}`; } };
  const CURRENCIES = ['USD','CAD','MXN','EUR','GBP','INR','AUD','NZD','ZAR','KES','NGN','GHS','BRL','JPY','CNY','SGD','PHP','AED','SEK','NOK','DKK','CHF','PKR','BDT','LKR','NPR'];
  const qtyText = (n) => String(Math.round(n * 100) / 100);
  const kindLabel = (k) => k.charAt(0).toUpperCase() + k.slice(1);
  const KINDS = ['farm', 'barn', 'orchard', 'ranch', 'garden', 'market', 'farmstand', 'restaurant', 'grocery', 'other'];
  const KIND_LABEL = { farm: 'Farm', barn: 'Barn', orchard: 'Orchard', ranch: 'Ranch', garden: 'Market garden', market: "Farmers' market", farmstand: 'Farm stand', restaurant: 'Farm-to-table restaurant', grocery: 'Grocery or co-op', other: 'Other' };
  const kindName = (k) => KIND_LABEL[k] || kindLabel(k);
  const CATS = { vegetables: 'Vegetables', fruit: 'Fruit', eggs: 'Eggs', dairy: 'Dairy and cheese', meat: 'Meat', poultry: 'Poultry', seafood: 'Seafood', bakery: 'Bakery',
    honey: 'Honey', herbs: 'Herbs', plants: 'Live plants', flowers: 'Flowers', preserves: 'Jams and preserves', nuts: 'Nuts', grains: 'Grains and flour',
    beverages: 'Coffee, tea and drinks', crafts: 'Crafts and soap', other: 'Other' };
  const catName = (c) => CATS[c] || kindLabel(c);
  // Distances are stored in miles; shown in miles or kilometres (switch in the header).
  const KM = 1.609344;
  const uLong = () => (state.units === 'km' ? 'km' : 'miles');
  const toU = (mi) => (state.units === 'km' ? mi * KM : mi);
  const fromU = (v) => (state.units === 'km' ? v / KM : v);
  const dist = (mi) => { if (mi == null) return ''; const v = toU(mi); return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${state.units === 'km' ? 'km' : 'mi'}`; };
  const radText = (mi) => `${Math.round(toU(mi))} ${uLong()}`;
  function setMode(m) { state.mode = m; try { localStorage.setItem('fd_mode', m); } catch { /* ignore */ } }
  function milesBetween(a, b, c, d) {
    const r = (x) => (x * Math.PI) / 180;
    const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
    return 2 * 3958.8 * Math.asin(Math.sqrt(h));
  }
  const fromHere = (f) => (state.place ? milesBetween(state.place.lat, state.place.lng, f.lat, f.lng) : null);
  const initial = (name) => esc((name || '?').trim().charAt(0).toUpperCase());
  const thumb = (f, cls = 'img') => (f.cover_url
    ? `<img class="${cls} media" src="${esc(f.cover_url)}" alt="" loading="lazy">`
    : `<div class="${cls} ph k-${esc(f.kind)}" aria-hidden="true">${initial(f.name)}</div>`);
  const badges = (f) => [
    `<span class="badge kind k-${esc(f.kind)}">${esc(kindName(f.kind))}</span>`,
    f.accepts_snap ? '<span class="badge snap">Accepts SNAP/EBT</span>' : '',
    f.wholesale ? '<span class="badge">Wholesale</span>' : '',
  ].join(' ');
  const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
  const calBox = (d) => { const x = new Date(d + 'T12:00'); return `<div class="cal"><span>${x.toLocaleDateString(undefined, { month: 'short' })}</span><b>${x.getDate()}</b></div>`; };

  function toast(message, bad = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.className = ''), 3800);
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (state.token) headers.authorization = 'Bearer ' + state.token;
    const res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && state.token) signOut(true);
      throw new Error(data.error || 'Something went wrong. Try again.');
    }
    return data;
  }

  function harvestLabel(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(y, m - 1, d)) / 86400000);
    if (days <= 0) return 'Picked today';
    if (days === 1) return 'Picked yesterday';
    if (days < 14) return `Picked ${days} days ago`;
    return 'Picked ' + new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const when = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const stepFor = (unit) => (['lb', 'oz', 'kg'].includes(unit) ? '0.25' : '1');

  // ---------- place (Local to:) ----------
  function setPlaceState(p) {
    state.place = p;
    if (p) { state.center = { lat: p.lat, lng: p.lng }; state.located = true; state.placeLabel = p.label; }
  }
  function setPlace(p) {
    setPlaceState(p);
    try { localStorage.setItem('fd_place2', JSON.stringify(p)); } catch { /* ignore */ }
    renderChrome();
  }
  const base = () => (state.place ? '/' + state.place.slug : '/all');
  const townName = () => (state.place ? state.place.label.split(',')[0] : 'you');

  function bindPlaceSearch(input, onPick) {
    const list = document.createElement('ul'); list.className = 'sugg'; list.hidden = true; list.setAttribute('role', 'listbox'); list.id = input.id + '-list';
    input.parentNode.appendChild(list);
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', list.id); input.autocomplete = 'off';
    let items = [], act = -1, seq = 0;
    const close = () => { list.hidden = true; act = -1; input.setAttribute('aria-expanded', 'false'); };
    const draw = () => {
      list.innerHTML = items.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === act}">${esc(p.label)}</li>`).join('');
      list.hidden = !items.length; input.setAttribute('aria-expanded', String(!!items.length));
    };
    const choose = (i) => { const p = items[i]; if (!p) return; input.value = p.label; close(); onPick(p); };
    input.addEventListener('input', async () => {
      const q = input.value.trim(), my = ++seq;
      if (q.length < 2) { items = []; draw(); return; }
      try { const { places } = await api('/places?q=' + encodeURIComponent(q)); if (my === seq) { items = places; act = items.length ? 0 : -1; draw(); } } catch { /* ignore */ }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); act = Math.min(items.length - 1, act + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); act = Math.max(0, act - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (items.length) choose(act < 0 ? 0 : act); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
    input.addEventListener('blur', () => setTimeout(close, 150));
  }
  function useMyLocation() {
    if (!navigator.geolocation) return toast('Your browser cannot share location. Type your town instead.', true);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try { const { place } = await api(`/places/near?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`); if (place) { dlg.open && dlg.close(); navigate('/' + place.slug); } }
      catch (e) { toast(e.message, true); }
    }, () => toast('Location is blocked. Allow it in your browser, or type your town.', true), { timeout: 10000 });
  }
  function openPlacePicker() {
    dlg.innerHTML = `<div class="dlg"><div class="dlg-head"><h2 id="dlgTitle">Where are you?</h2><button class="close" type="button" aria-label="Close" data-close>✕</button></div>
      <div class="field"><label for="pp-q">Town or city</label><input id="pp-q" type="text" placeholder="Celina, TX or Nairobi" value=""></div>
      <div class="btn-group"><button class="btn secondary" type="button" id="pp-here">Use my location</button>
        ${state.place ? '<button class="btn secondary" type="button" id="pp-any">Show everywhere</button>' : ''}</div></div>`;
    dlg.showModal();
    const inp = $('#pp-q', dlg); inp.focus();
    bindPlaceSearch(inp, (p) => { dlg.close(); navigate('/' + p.slug); });
    $('#pp-here', dlg).addEventListener('click', useMyLocation);
    $('#pp-any', dlg)?.addEventListener('click', () => { dlg.close(); setPlace(null); try { localStorage.removeItem('fd_place2'); } catch { /* ignore */ } navigate('/all/listings'); });
  }
  $('#localTo').addEventListener('click', openPlacePicker);

  // ---------- auth ----------
  function setSession(token, user) {
    state.token = token; state.user = user;
    try { localStorage.setItem('fd_token', token); } catch { /* ignore */ }
    renderChrome();
  }
  function signOut(silent) {
    state.token = null; state.user = null; state.cart = null;
    try { localStorage.removeItem('fd_token'); } catch { /* ignore */ }
    renderChrome();
    if (/^\/(dashboard|orders)/.test(location.pathname)) navigate('/');
    if (!silent) toast('Signed out.');
  }
  function openAuth(tab = 'login', message = '', role = 'buyer') {
    authDialog.innerHTML = `
      <div class="dlg">
        <div class="dlg-head"><h2 id="authTitle">${tab === 'login' ? 'Sign in' : 'Create your account'}</h2>
          <button class="close" type="button" aria-label="Close" data-close>✕</button></div>
        ${message ? `<p class="hint" style="margin-bottom:.75rem">${esc(message)}</p>` : ''}
        <div class="tabs" role="tablist">
          <button role="tab" type="button" data-tab="login" aria-selected="${tab === 'login'}">Sign in</button>
          <button role="tab" type="button" data-tab="register" aria-selected="${tab === 'register'}">Create account</button>
        </div>
        <form id="authForm" novalidate>
          ${tab === 'register' ? `
            <div class="field"><label for="a-name">Your name</label><input id="a-name" type="text" autocomplete="name" required></div>
            <fieldset class="field" style="border:0;padding:0;margin:0 0 .9rem">
              <legend style="font-weight:700;font-size:.92rem;margin-bottom:.25rem">I want to</legend>
              <div class="radio-row" style="margin:0">
                <label><input type="radio" name="role" value="buyer" ${role === 'buyer' ? 'checked' : ''}> Buy food and book farm visits</label>
                <label><input type="radio" name="role" value="farmer" ${role === 'farmer' ? 'checked' : ''}> List my farm, market or stand</label>
              </div>
              <p class="hint" style="margin-top:.3rem">This only picks where you start. One account can do both: switch between Visitor and Farm owner at the top.</p>
            </fieldset>` : ''}
          <div class="field"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="a-pass">Password ${tab === 'register' ? '<span class="hint">(8+ characters)</span>' : ''}</label>
            <input id="a-pass" type="password" autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}" required></div>
          <p class="error" id="authError" role="alert"></p>
          <button class="btn" type="submit">${tab === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p class="demo">Try it with a demo account (password <strong>farmdemo123</strong>): <strong>buyer@demo.farm</strong> to shop, <strong>bluebonnet@demo.farm</strong> to run a farm.</p>
      </div>`;
    if (!authDialog.open) authDialog.showModal();
    $('#a-email', authDialog).focus();
    authDialog.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => openAuth(b.dataset.tab, message, role)));
    $('#authForm', authDialog).addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#authError', authDialog); err.textContent = '';
      const body = { email: $('#a-email', authDialog).value, password: $('#a-pass', authDialog).value };
      if (tab === 'register') { body.name = $('#a-name', authDialog).value; body.role = authDialog.querySelector('input[name=role]:checked').value; }
      try {
        const data = await api(tab === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body });
        setSession(data.token, data.user);
        authDialog.close();
        toast(`Welcome, ${data.user.name.split(' ')[0]}.`);
        if (tab === 'register') setMode(body.role === 'farmer' ? 'owner' : 'visitor');
        else if (data.user.role === 'farmer') setMode('owner');
        try { state.mine = (await api('/my/farms')).farms[0]?.id || null; } catch { state.mine = null; }
        if (state.mode === 'owner' && (tab === 'register' || /^\/(orders)?$/.test(location.pathname))) navigate('/dashboard'); else route();
      } catch (ex) { err.textContent = ex.message; }
    });
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) e.target.closest('dialog').close(); });
  [authDialog, dlg].forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  // ---------- header and routing ----------
  const SECTIONS = [
    ['', 'Home'], ['farms', 'Farms'], ['experiences', 'Farm visits'], ['barns', 'Barns and ranches'], ['markets', "Farmers' markets"],
    ['group-orders', 'Group orders'], ['csa', 'CSA'], ['events', 'Events'], ['products', 'Shop local'], ['photos', 'Photos'],
  ];
  function renderChrome() {
    $('#localTo').innerHTML = state.place ? `Local to: <b>${esc(state.place.label)}</b> ▾` : 'Choose your town ▾';
    const u = state.user;
    const owner = state.mode === 'owner';
    const sw = `<span class="modesw" role="group" aria-label="See the site as"><button type="button" data-act="mode" data-mode="visitor" aria-pressed="${!owner}">Visitor</button><button type="button" data-act="mode" data-mode="owner" aria-pressed="${owner}">Farm owner</button></span>
      <button type="button" class="units" data-act="units" aria-label="Show distances in ${state.units === 'km' ? 'miles' : 'kilometres'}" title="Switch miles and kilometres"><span ${state.units === 'mi' ? 'class="on"' : ''}>mi</span><span ${state.units === 'km' ? 'class="on"' : ''}>km</span></button>`;
    $('#account').innerHTML = u
      ? `${sw}${owner ? '<a href="/dashboard" data-link>My farm</a>' : '<a href="/orders" data-link>My orders</a>'}
         <span class="who">${esc(u.name)}</span><button type="button" data-act="signout">Sign out</button>`
      : `${sw}<button type="button" data-act="signin">Sign in</button><button type="button" class="cta" data-act="list">List your farm</button>`;
    const path = location.pathname.split('/').filter(Boolean);
    const curSec = path[0] === 'farm' || !path.length ? (path.length ? null : '') : (path[1] || '');
    $('#tabs').innerHTML = SECTIONS.map(([k, t]) => {
      const href = k ? `${base()}/${k}` : (state.place ? base() : '/');
      return `<a href="${href}" data-link ${curSec === k && path[0] !== 'updates' && path[0] !== 'cities' && path[0] !== 'dashboard' && path[0] !== 'orders' ? 'aria-current="page"' : ''}>${esc(t)}</a>`;
    }).join('') + `<a href="/updates" data-link ${path[0] === 'updates' ? 'aria-current="page"' : ''}>Farm updates</a>`;
    $('#footFind').innerHTML = [['farms', 'Farms near you'], ['markets', "Farmers' markets"], ['csa', 'CSA shares'], ['u-pick', 'U-pick'], ['farm-stands', 'Farm stands'], ['events', 'Events']]
      .map(([k, t]) => `<li><a href="${base()}/${k}" data-link>${t}</a></li>`).join('');
  }
  $('#account').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.act === 'signout') signOut();
    if (b.dataset.act === 'signin') openAuth('login');
    if (b.dataset.act === 'units') { state.units = state.units === 'km' ? 'mi' : 'km'; try { localStorage.setItem('fd_units', state.units); } catch { /* ignore */ } route(); toast(`Distances now in ${uLong()}.`); }
    if (b.dataset.act === 'mode') {
      setMode(b.dataset.mode);
      if (b.dataset.mode === 'owner') navigate('/dashboard');
      else if (/^\/dashboard/.test(location.pathname)) navigate(state.place ? base() : '/');
      else renderChrome();
    }
    if (b.dataset.act === 'list') { if (state.user) navigate('/dashboard'); else openAuth('register', 'Create a free account to list your farm, market or stand.', 'farmer'); }
  });

  function navigate(path) {
    if (path !== location.pathname + location.search) history.pushState({}, '', path);
    route();
    window.scrollTo(0, 0);
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
    e.preventDefault(); navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', route);

  function destroyMaps() {
    for (const m of state.maps) { try { m.remove(); } catch { /* ignore */ } }
    state.maps = [];
    if (state.pickMap) { try { state.pickMap.remove(); } catch { /* ignore */ } state.pickMap = null; }
  }
  const loading = (title) => { view.innerHTML = `<div class="wrap page"><h1>${esc(title)}</h1><p class="hint">Loading…</p></div>`; };
  const notFound = (msg) => { view.innerHTML = `<div class="wrap page"><h1>Not found</h1><p class="empty">${esc(msg)} <a href="/" data-link>Go to the home page</a>.</p></div>`; };

  const placeCache = {};
  async function resolvePlace(slug) {
    if (slug === 'all') return null;
    if (state.place && state.place.slug === slug) return state.place;
    if (!placeCache[slug]) placeCache[slug] = api('/places/' + encodeURIComponent(slug)).then((r) => r.place);
    return placeCache[slug];
  }

  async function route() {
    destroyMaps();
    if (dlg.open) dlg.close();
    const seg = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    renderChrome();
    try {
      if (!seg.length) return state.place ? renderCity() : renderLanding();
      switch (seg[0]) {
        case 'farm': return renderListing(Number(seg[1]));
        case 'orders': return renderOrders();
        case 'dashboard': return renderFarmDashboard();
        case 'updates': return renderFeed();
        case 'cities': return renderCities();
        case 'group': return renderGroup(Number(seg[1]));
      }
      let place;
      try { place = await resolvePlace(seg[0]); } catch { return notFound("We couldn't find that town."); }
      if (place) setPlace(place); else if (seg[0] === 'all') { /* everywhere */ }
      renderChrome();
      const sec = seg[1] || '';
      if (!sec) return place ? renderCity() : renderDirectory('listings');
      if (sec === 'events') return renderEvents();
      if (sec === 'photos') return renderPhotos();
      if (sec === 'group-orders') return renderGroups();
      if (sec === 'experiences') return renderDirectory('experiences', '', VISITS.some(([k]) => k && k === seg[2]) ? seg[2] : '');
      if (sec === 'products' && !seg[2]) return renderProducts();
      if (sec === 'products') return renderDirectory('products', seg[2]);
      if (DIR[sec]) return renderDirectory(sec);
      return notFound("That page doesn't exist.");
    } catch (e) { toast(e.message, true); }
  }


  // ---------- Google Maps links (work with or without an API key) ----------
  const gmPlace = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  const gmDir = (dest) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  function parseGm(s) {
    s = (s || '').trim(); let m;
    try { s = decodeURIComponent(s); } catch { /* keep raw */ }
    if ((m = s.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/))) return [+m[1], +m[2]];
    if ((m = s.match(/[?&](?:q|query|destination|ll|center)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/))) return [+m[1], +m[2]];
    if ((m = s.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/))) return [+m[1], +m[2]];
    if ((m = s.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/))) return [+m[1], +m[2]];
    return null;
  }
  // Find a place anywhere: Google Maps link or coordinates, then Google's geocoder (when a key is set), else OpenStreetMap.
  async function geocode(q) {
    const ll = parseGm(q);
    if (ll) return { lat: ll[0], lng: ll[1], label: `${ll[0].toFixed(4)}, ${ll[1].toFixed(4)}` };
    if (Maps.kind === 'google') {
      try {
        const { results } = await new google.maps.Geocoder().geocode({ address: q });
        if (results && results[0]) { const l = results[0].geometry.location; return { lat: l.lat(), lng: l.lng(), label: results[0].formatted_address }; }
      } catch { /* fall through to OpenStreetMap */ }
    }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': navigator.language || 'en' } });
      const [hit] = await r.json();
      if (hit) return { lat: +hit.lat, lng: +hit.lon, label: hit.display_name.split(',').slice(0, 3).join(',').trim() };
    } catch { /* offline or blocked */ }
    return null;
  }
  const gmLink = (href, text) => `<a class="btn small secondary" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const farmDest = (f) => (f.address ? `${f.address}, ${f.city || ''}, TX` : `${f.lat},${f.lng}`);

  // ---------- map adapter: Google Maps when a key is configured, OpenStreetMap otherwise ----------
  const Maps = {
    kind: 'osm',
    async init() {
      try {
        const { googleMapsKey } = await api('/config');
        if (!googleMapsKey) return;
        await new Promise((resolve, reject) => {
          window.__fdGmReady = resolve;
          window.gm_authFailure = () => toast('Google Maps rejected the API key. Check GOOGLE_MAPS_API_KEY and its allowed websites.', true);
          const s = document.createElement('script');
          s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(googleMapsKey)}&v=weekly&callback=__fdGmReady`;
          s.async = true;
          s.onerror = reject;
          document.head.appendChild(s);
          setTimeout(() => reject(new Error('timeout')), 10000);
        });
        if (window.google && window.google.maps) this.kind = 'google';
      } catch {
        toast('Google Maps could not load, so the free OpenStreetMap map is shown instead.', true);
      }
    },
    color(kind) {
      return getComputedStyle(document.documentElement).getPropertyValue(`--kind-${kind}`).trim() || '#1f4d32';
    },
    create(el, lat, lng, zoom) {
      return this.kind === 'google' ? googleMap(el, lat, lng, zoom) : leafletMap(el, lat, lng, zoom);
    },
  };

  function googleMap(el, lat, lng, zoom) {
    const g = google.maps;
    const map = new g.Map(el, { center: { lat, lng }, zoom, mapTypeControl: true, streetViewControl: false, fullscreenControl: true, clickableIcons: false });
    let pins = [];
    return {
      setView(la, ln, z) { map.setCenter({ lat: la, lng: ln }); if (z) map.setZoom(z); },
      clear() { pins.forEach((p) => p.setMap(null)); pins = []; },
      addPin(la, ln, { title, kind, onClick }) {
        const m = new g.Marker({
          map, position: { lat: la, lng: ln }, title,
          icon: { path: g.SymbolPath.CIRCLE, scale: 10, fillColor: Maps.color(kind), fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 3 },
        });
        if (onClick) m.addListener('click', onClick);
        pins.push(m);
      },
      fit(points) {
        if (points.length === 1) { map.setCenter({ lat: points[0][0], lng: points[0][1] }); map.setZoom(12); return; }
        const b = new g.LatLngBounds();
        points.forEach(([la, ln]) => b.extend({ lat: la, lng: ln }));
        map.fitBounds(b, 40);
        g.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 12) map.setZoom(12); });
      },
      onClick(cb) { map.addListener('click', (e) => cb(e.latLng.lat(), e.latLng.lng())); },
      dragPin(la, ln, onMove) {
        const m = new g.Marker({ map, position: { lat: la, lng: ln }, draggable: true });
        m.addListener('dragend', () => { const p = m.getPosition(); onMove(p.lat(), p.lng()); });
        return { set(a, b) { m.setPosition({ lat: a, lng: b }); } };
      },
      remove() { this.clear(); el.innerHTML = ''; },
    };
  }

  function leafletMap(el, lat, lng, zoom) {
    if (!window.L) {
      el.innerHTML = '<p class="empty" style="margin:1rem">The map could not load. Check your connection; the farm list still works.</p>';
      const noop = () => {};
      return { setView: noop, clear: noop, addPin: noop, fit: noop, onClick: noop, dragPin: () => ({ set: noop }), remove: () => { el.innerHTML = ''; } };
    }
    const map = L.map(el).setView([lat, lng], zoom);
    tiles(map);
    const layer = L.layerGroup().addTo(map);
    return {
      setView(la, ln, z) { map.setView([la, ln], z || map.getZoom()); },
      clear() { layer.clearLayers(); },
      addPin(la, ln, { title, kind, onClick }) {
        const icon = L.divIcon({ className: '', html: `<div class="pin kind-${esc(kind)}"></div>`, iconSize: [26, 26], iconAnchor: [13, 26] });
        const m = L.marker([la, ln], { icon, title, keyboard: false }).addTo(layer);
        m.bindTooltip(title);
        if (onClick) m.on('click', onClick);
      },
      fit(points) {
        if (points.length === 1) map.setView(points[0], 12);
        else if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 12 });
      },
      onClick(cb) { map.on('click', (e) => cb(e.latlng.lat, e.latlng.lng)); },
      dragPin(la, ln, onMove) {
        const m = L.marker([la, ln], { draggable: true }).addTo(map);
        m.on('dragend', () => { const p = m.getLatLng(); onMove(p.lat, p.lng); });
        return { set(a, b) { m.setLatLng([a, b]); } };
      },
      remove() { map.remove(); },
    };
  }


  function tiles(map) {
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
  }

  function locate(onDone) {
    if (!navigator.geolocation) return toast('Your browser cannot share location. Type your town instead.', true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.center = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.located = true;
        state.placeLabel = 'your location';
        onDone();
      },
      () => toast('Location is blocked. Allow it in your browser to sort farms by distance.', true),
      { timeout: 10000 }
    );
  }



  function orderLines(o) {
    return `<ul>${o.items.map((i) => `<li>${esc(i.name)}, ${qtyText(i.qty)} ${esc(i.unit)} at ${money(i.price_cents, o.currency)}</li>`).join('')}</ul>`;
  }

  function buyerOrder(o) {
    const total = o.items_total_cents + o.delivery_fee_cents;
    const active = ['reserved', 'ready'].includes(o.status);
    return `<article class="order">
      <div class="item-row" style="border:0;padding:0">
        <div><h3>${esc(o.farm_name)}</h3><div class="meta">${when(o.created_at)}</div></div>
        <span class="status ${esc(o.status)}">${esc(o.status === 'ready' ? 'Ready' : kindLabel(o.status))}</span>
      </div>
      ${orderLines(o)}
      <p><strong>${money(total, o.currency)}</strong> ${o.delivery_fee_cents ? `(includes ${money(o.delivery_fee_cents, o.currency)} delivery)` : ''}</p>
      ${o.group_id ? `<p class="meta"><span class="badge">Group order</span> Drop-off at ${esc(o.group_dropoff)} on ${niceDate(o.group_date)} · <a href="/group/${o.group_id}" data-link>see the group</a>
        ${o.group_discount ? `<br><strong>${o.group_discount}% group discount: you pay ${money(Math.round(total * (1 - o.group_discount / 100)), o.currency)}</strong>` : ''}</p>` : `<p class="meta">${o.fulfillment === 'pickup'
        ? `Pickup at ${esc(o.farm_address || o.farm_city)}. ${esc(o.pickup_instructions || '')}`
        : `Delivery to ${esc(o.delivery_address)}`}
        ${o.scheduled_for ? `<br>Requested time: ${esc(o.scheduled_for.replace('T', ' '))}` : ''}</p>`}
      ${o.fulfillment === 'pickup' && !o.group_id ? `<p>${gmLink(gmDir(o.farm_address ? `${o.farm_address}, ${o.farm_city}, TX` : `${o.farm_lat},${o.farm_lng}`), 'Directions to the farm')}</p>` : ''}
      <p class="meta">${esc(o.payment_note)}${o.farm_phone ? ` Phone: ${esc(o.farm_phone)}` : ''}</p>
      ${active ? `<p style="margin-top:.5rem"><button class="btn small danger" data-cancel="${o.id}">Cancel order</button></p>` : ''}
    </article>`;
  }

  // ---------- farm experiences ----------
  const EXP_TYPES = { day: 'Spend a day on the farm', learn: 'Learn farming', horse: 'Horseback riding', tour: 'Farm or barn tour', pick: 'Pick your own', other: 'Other experience' };
  const EXP_SHORT = { day: 'Farm day', learn: 'Farming class', horse: 'Horseback riding', tour: 'Tour', pick: 'Pick your own', other: 'Experience' };
  const PER = { person: 'per person', group: 'per group', hour: 'per hour' };
  const expPrice = (e, cur) => e.price_cents > 0 ? `${money(e.price_cents, cur)} ${PER[e.per] || ''}`.trim() : 'Free';
  const BK_LABEL = { requested: 'Waiting for farmer', confirmed: 'Confirmed', declined: 'Declined by farm', done: 'Completed', cancelled: 'Cancelled' };
  const niceDate = (d) => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  function guestBooking(b) {
    const total = b.total_cents ? money(b.total_cents, b.currency) + (b.per === 'hour' ? ' per hour' : '') : 'Free';
    return `<article class="order">
      <div class="item-row" style="border:0;padding:0"><div><h3>${esc(b.title)}</h3><div class="meta">${esc(b.farm_name)}, ${esc(niceDate(b.date))}, ${b.people} ${b.people === 1 ? 'person' : 'people'}</div></div>
        <span class="status ${esc(b.status)}">${BK_LABEL[b.status]}</span></div>
      <p><strong>${total}</strong>${b.total_cents ? ' to pay the farmer' : ''}</p>
      <p>${gmLink(gmDir(b.farm_address ? `${b.farm_address}, ${b.farm_city}` : `${b.farm_lat},${b.farm_lng}`), 'Directions to the farm')}</p>
      <p class="meta">${esc(b.payment_note)}${b.farm_phone ? ` Phone: ${esc(b.farm_phone)}` : ''}</p>
      ${['requested', 'confirmed'].includes(b.status) ? `<p style="margin-top:.5rem"><button class="btn small danger" data-bcancel="${b.id}">Cancel booking</button></p>` : ''}
    </article>`;
  }

  function bookingsCard(bookings, farm) {
    if (!bookings.length && !(farm.experiences || []).length) return '';
    const open = bookings.filter((b) => ['requested', 'confirmed'].includes(b.status));
    const past = bookings.filter((b) => !['requested', 'confirmed'].includes(b.status)).slice(-8).reverse();
    const c = (b) => `<article class="order">
      <div class="item-row" style="border:0;padding:0"><div><h3>${esc(b.title)}</h3>
        <div class="meta">${esc(b.buyer_name)}, ${esc(niceDate(b.date))}, ${b.people} ${b.people === 1 ? 'person' : 'people'}. Contact: ${esc(b.contact)}</div></div>
        <span class="status ${esc(b.status)}">${BK_LABEL[b.status]}</span></div>
      <p><strong>${b.total_cents ? money(b.total_cents, b.currency) + (b.per === 'hour' ? ' per hour' : '') : 'Free'}</strong>${b.total_cents ? ' to collect' : ''}</p>
      ${b.note ? `<p class="meta">Note: ${esc(b.note)}</p>` : ''}
      ${['requested', 'confirmed'].includes(b.status) ? `<div class="btn-group" style="margin-top:.5rem">
        ${b.status === 'requested' ? `<button class="btn small" data-bst="confirmed" data-b="${b.id}">Confirm</button>` : `<button class="btn small secondary" data-bst="done" data-b="${b.id}">Mark completed</button>`}
        <button class="btn small danger" data-bst="declined" data-b="${b.id}">${b.status === 'requested' ? 'Decline' : 'Cancel booking'}</button></div>` : ''}
    </article>`;
    return `<section class="card"><h2>Booking requests</h2>
      ${open.length ? `<div class="rows">${open.map(c).join('')}</div>` : '<p class="empty">No booking requests yet. When someone books one of your experiences it shows up here for you to confirm.</p>'}
      ${past.length ? `<h3 style="margin:1rem 0 .5rem">Recent</h3><div class="rows">${past.map(c).join('')}</div>` : ''}</section>`;
  }
  function bindBookings() {
    view.querySelectorAll('[data-bst]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.bst === 'declined' && b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to decline'; return; }
      try { await api(`/bookings/${b.dataset.b}/status`, { method: 'PATCH', body: { status: b.dataset.bst } }); toast('Booking updated.'); renderFarmDashboard(); }
      catch (e) { toast(e.message, true); }
    }));
  }

  let editExpId = null;
  function expsCard(farm) {
    const list = farm.experiences || [];
    const e = editExpId ? list.find((x) => x.id === editExpId) : null;
    const v = e || { type: 'day', title: '', about: '', price_cents: '', per: 'person', duration: '', max_people: 6, schedule: '', min_age: '', bring: '' };
    return `<section class="card"><h2>${e ? 'Edit experience' : 'Experiences you offer'}</h2>
      ${e ? '' : '<p class="hint" style="margin-bottom:.8rem">Optional. If you welcome visitors, offer a day on the farm, a farming class, horseback rides, tours or pick-your-own. You set the price, group size and schedule, and you confirm every booking.</p>'}
      <form id="expForm" novalidate>
        <div class="row"><div class="field"><label for="e-type">Kind of experience</label><select id="e-type">${Object.entries(EXP_TYPES).map(([k, t]) => `<option value="${k}" ${v.type === k ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
          <div class="field"><label for="e-title">Name</label><input id="e-title" type="text" maxlength="100" value="${esc(v.title)}" placeholder="${esc(EXP_TYPES[v.type])}"></div></div>
        <div class="field"><label for="e-about">What guests will do</label><textarea id="e-about" maxlength="1000" placeholder="Feed the animals, help in the fields, share a farm lunch">${esc(v.about)}</textarea></div>
        <div class="row"><div class="field"><label for="e-price">Price (${esc(farm.currency || 'USD')}) <span class="hint">0 for free</span></label><input id="e-price" type="number" min="0" step="0.5" value="${v.price_cents === '' ? '' : (v.price_cents / 100).toFixed(2)}"></div>
          <div class="field"><label for="e-per">Charged</label><select id="e-per">${Object.entries(PER).map(([k, t]) => `<option value="${k}" ${v.per === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="field"><label for="e-dur">How long</label><input id="e-dur" type="text" value="${esc(v.duration)}" placeholder="3 hours, full day"></div>
          <div class="field"><label for="e-max">Most people per day</label><input id="e-max" type="number" min="1" step="1" value="${esc(v.max_people)}"></div></div>
        <div class="row"><div class="field"><label for="e-when">When you offer it</label><input id="e-when" type="text" value="${esc(v.schedule)}" placeholder="Saturdays, 9am to noon"></div>
          <div class="field"><label for="e-age">Minimum age <span class="hint">(optional)</span></label><input id="e-age" type="number" min="0" step="1" value="${esc(v.min_age || '')}"></div>
          <div class="field"><label for="e-bring">What to bring or wear <span class="hint">(optional)</span></label><input id="e-bring" type="text" value="${esc(v.bring)}" placeholder="Closed-toe shoes"></div></div>
        <p class="error" id="eErr" role="alert"></p>
        <div class="btn-group"><button class="btn" type="submit">${e ? 'Save changes' : 'Offer this experience'}</button>${e ? '<button class="btn secondary" type="button" id="e-cancel">Cancel edit</button>' : ''}</div>
      </form>
      ${list.length ? `<h3 style="margin:1.25rem 0 .6rem">Offered now</h3><div class="rows">${list.map((x) => `<div class="item-row"><div><strong>${esc(x.title)}</strong> ${esc(expPrice(x, farm.currency))}
          <div class="meta">${esc(EXP_TYPES[x.type])}${x.schedule ? ', ' + esc(x.schedule) : ''}, up to ${x.max_people} people a day${x.active ? '' : ' (paused, hidden from guests)'}</div></div>
          <div class="btn-group"><button class="btn small secondary" data-eedit="${x.id}">Edit</button><button class="btn small secondary" data-epause="${x.id}" data-on="${x.active ? 0 : 1}">${x.active ? 'Pause' : 'Resume'}</button>
          <button class="btn small danger" data-edel="${x.id}" aria-label="Remove ${esc(x.title)}">Remove</button></div></div>`).join('')}</div>` : ''}
    </section>`;
  }
  function bindExps(farm) {
    $('#e-type').addEventListener('change', (ev) => { $('#e-title').placeholder = EXP_TYPES[ev.target.value]; });
    $('#e-cancel')?.addEventListener('click', () => { editExpId = null; renderFarmDashboard(); });
    view.querySelectorAll('[data-eedit]').forEach((b) => b.addEventListener('click', () => { editExpId = Number(b.dataset.eedit); renderFarmDashboard(); }));
    view.querySelectorAll('[data-epause]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/experiences/${b.dataset.epause}/active`, { method: 'PATCH', body: { active: b.dataset.on === '1' } }); toast(b.dataset.on === '1' ? 'Open for bookings again.' : 'Paused. Guests no longer see it.'); renderFarmDashboard(); }
      catch (e) { toast(e.message, true); }
    }));
    view.querySelectorAll('[data-edel]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to remove'; return; }
      try { await api('/experiences/' + b.dataset.edel, { method: 'DELETE' }); toast('Experience removed.'); renderFarmDashboard(); }
      catch (e) { toast(e.message, true); }
    }));
    $('#expForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = { type: $('#e-type').value, title: $('#e-title').value, about: $('#e-about').value, price: $('#e-price').value || 0, per: $('#e-per').value,
        duration: $('#e-dur').value, max_people: $('#e-max').value, schedule: $('#e-when').value, min_age: $('#e-age').value, bring: $('#e-bring').value };
      try {
        await api(editExpId ? '/experiences/' + editExpId : `/farms/${farm.id}/experiences`, { method: editExpId ? 'PUT' : 'POST', body });
        toast(editExpId ? 'Changes saved.' : 'Experience added. Guests can book it now.'); editExpId = null; renderFarmDashboard();
      } catch (ex) { $('#eErr').textContent = ex.message; }
    });
  }

  // ---------- photos, videos and posts ----------
  const MAX_FILES = 6, MAX_MB = 50;
  const isVideo = (m) => String(m.type || '').startsWith('video/');
  function mediaHtml(list) {
    if (!list || !list.length) return '';
    return `<div class="media-grid${list.length === 1 ? ' one' : ''}">${list.map((m) => isVideo(m)
      ? `<video class="media" src="${esc(m.url)}" controls preload="metadata" playsinline></video>`
      : `<img class="media" src="${esc(m.url)}" alt="Photo from the farm" loading="lazy">`).join('')}</div>`;
  }
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (el && el.classList && el.classList.contains('media')) {
      const d = document.createElement('div'); d.className = 'media-missing' + (el.classList.contains('thumb') ? ' thumb' : '');
      d.textContent = el.classList.contains('thumb') ? 'No photo' : 'This photo or video could not load.'; el.replaceWith(d);
    }
  }, true);
  const when2 = (s) => new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  function postHtml(p, { farm = null, canDelete = false } = {}) {
    return `<article class="post">
      <div class="post-hd"><div>${farm ? `<button class="linkish" data-farm="${farm.id}">${esc(farm.name)}</button>
        <div class="hint">${esc(kindLabel(farm.kind))} in ${esc(farm.city || '')}${farm.distance_miles != null ? `, ${dist(farm.distance_miles)} away` : ''}</div>` : ''}</div>
        <span class="hint">${when2(p.created_at)}</span></div>
      ${p.body ? `<p class="txt">${esc(p.body)}</p>` : ''}
      ${mediaHtml(p.media)}
      ${canDelete ? `<div class="btn-group"><button class="btn small danger" data-delpost="${p.id}">Delete update</button></div>` : ''}
    </article>`;
  }
  async function prepareFile(file) {
    const t = file.type || '';
    if (t.startsWith('video/')) {
      if (!['video/mp4', 'video/webm', 'video/quicktime'].includes(t)) throw new Error(`${file.name}: use an MP4, MOV or WebM video.`);
      if (file.size > MAX_MB * 1024 * 1024) throw new Error(`${file.name} is over ${MAX_MB} MB. Trim it or record a shorter clip.`);
      return { blob: file, type: t };
    }
    if (t === 'image/gif') return { blob: file, type: t };
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error(`${file.name}: this photo format can't be read. Save it as JPEG or PNG and try again.`); }
    const sc = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    if (sc === 1 && file.size < 1.5e6 && ['image/jpeg', 'image/png', 'image/webp'].includes(t)) return { blob: file, type: t };
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return { blob, type: 'image/jpeg' };
  }
  async function uploadFile(file) {
    const p = await prepareFile(file);
    const res = await fetch('/api/uploads', { method: 'POST', headers: { 'content-type': p.type, authorization: 'Bearer ' + state.token }, body: p.blob });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 413 ? `${file.name} is too large (limit ${MAX_MB} MB).` : (data.error || 'The upload did not finish. Try again.'));
    return data;
  }

  function postsCard(farm, posts) {
    return `<section class="card"><h2>Photos and updates</h2>
      <p class="hint" style="margin-bottom:.8rem">Show buyers your fields, your harvest and what's coming next. Updates appear on your farm page and in Farm updates.</p>
      <div class="item-row"><div><strong>Farm photo</strong><div class="meta">Shown at the top of your farm page and next to your farm in the list.</div></div>
        <div class="btn-group"><label class="btn small secondary" for="coverFile" style="margin:0">${farm.cover_url ? 'Replace photo' : 'Add a farm photo'}</label>
          <input id="coverFile" type="file" accept="image/*" hidden>
          ${farm.cover_url ? '<button class="btn small danger" type="button" id="coverRm">Remove</button>' : ''}</div></div>
      ${farm.cover_url ? `<img class="cover media" src="${esc(farm.cover_url)}" alt="Your farm photo" style="margin:.6rem 0">` : ''}
      <form id="postForm" novalidate style="margin-top:1rem">
        <div class="field"><label for="p-text">Share an update</label><textarea id="p-text" maxlength="2000" placeholder="Strawberries are ripe this week. Come pick your own on Saturday!"></textarea></div>
        <div class="field"><label for="p-files">Add photos or videos <span class="hint">(up to ${MAX_FILES}; videos MP4, MOV or WebM up to ${MAX_MB} MB each)</span></label>
          <input id="p-files" type="file" accept="image/*,video/mp4,video/quicktime,video/webm" multiple></div>
        <div class="media-grid" id="p-prev"></div>
        <p class="error" id="pErr" role="alert"></p><p class="hint" id="pProg" aria-live="polite"></p>
        <button class="btn" type="submit" id="p-go">Share update</button>
      </form>
      <h3 style="margin:1.25rem 0 .6rem">Your updates</h3>
      ${posts.length ? `<div class="rows">${posts.map((p) => postHtml(p, { canDelete: true })).join('')}</div>` : '<p class="empty">No updates yet. A photo of today\'s harvest is a great first post.</p>'}
    </section>`;
  }

  function bindPosts(farm) {
    let pending = [], urls = [];
    const drawPrev = () => {
      urls.forEach((u) => URL.revokeObjectURL(u)); urls = pending.map((f) => URL.createObjectURL(f));
      $('#p-prev').innerHTML = pending.map((f, i) => f.type.startsWith('video/')
        ? `<video src="${urls[i]}" muted playsinline controls preload="metadata"></video>` : `<img src="${urls[i]}" alt="Selected photo ${i + 1}">`).join('');
    };
    $('#p-files').addEventListener('change', (e) => {
      const picked = [...e.target.files];
      if (picked.length + pending.length > MAX_FILES) toast(`Only ${MAX_FILES} photos or videos per update. The first ${MAX_FILES} were kept.`);
      pending = [...pending, ...picked].slice(0, MAX_FILES); e.target.value = ''; drawPrev();
    });
    $('#coverFile').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try { toast('Uploading your farm photo…'); const up = await uploadFile(file); await api(`/farms/${farm.id}/cover`, { method: 'PUT', body: { url: up.url } }); toast('Farm photo saved.'); renderFarmDashboard(); }
      catch (ex) { toast(ex.message, true); }
    });
    $('#coverRm')?.addEventListener('click', async () => {
      try { await api(`/farms/${farm.id}/cover`, { method: 'PUT', body: { url: '' } }); toast('Farm photo removed.'); renderFarmDashboard(); }
      catch (ex) { toast(ex.message, true); }
    });
    $('#postForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#pErr'), prog = $('#pProg'), btn = $('#p-go'); err.textContent = '';
      const body = $('#p-text').value.trim();
      if (!body && !pending.length) { err.textContent = 'Write something or add a photo or video.'; return; }
      btn.disabled = true; btn.textContent = 'Sharing…';
      try {
        const media = [];
        for (let i = 0; i < pending.length; i++) { prog.textContent = `Uploading ${i + 1} of ${pending.length}…`; media.push(await uploadFile(pending[i])); }
        await api(`/farms/${farm.id}/posts`, { method: 'POST', body: { body, media } });
        toast('Update shared. Buyers can see it now.');
        renderFarmDashboard();
      } catch (ex) { err.textContent = ex.message; prog.textContent = ''; btn.disabled = false; btn.textContent = 'Share update'; }
    });
    view.querySelectorAll('[data-delpost]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to delete'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Delete update'; }, 4000); return; }
      try { await api('/posts/' + b.dataset.delpost, { method: 'DELETE' }); toast('Update deleted.'); renderFarmDashboard(); }
      catch (ex) { toast(ex.message, true); }
    }));
  }

  function incomingOrders(orders) {
    const open = orders.filter((o) => ['reserved', 'ready'].includes(o.status));
    const past = orders.filter((o) => !['reserved', 'ready'].includes(o.status)).slice(0, 5);
    const card = (o) => {
      const total = o.items_total_cents + o.delivery_fee_cents;
      return `<article class="order">
        <div class="item-row" style="border:0;padding:0">
          <div><h3>${esc(o.buyer_name)}</h3><div class="meta">${when(o.created_at)}, <a href="mailto:${esc(o.buyer_email)}">${esc(o.buyer_email)}</a></div></div>
          <span class="status ${esc(o.status)}">${esc(kindLabel(o.status))}</span>
        </div>
        ${orderLines(o)}
        <p><strong>${money(total, o.currency)}</strong> to collect. ${o.fulfillment === 'pickup' ? 'Pickup' : `Deliver to ${esc(o.delivery_address)}`}
          ${o.scheduled_for ? `, requested ${esc(o.scheduled_for.replace('T', ' '))}` : ''}</p>
        ${o.note ? `<p class="meta">Note: ${esc(o.note)}</p>` : ''}
        ${o.fulfillment === 'delivery' && o.delivery_address ? `<p>${gmLink(gmDir(o.delivery_address), 'Directions to buyer')}</p>` : ''}
        ${['reserved', 'ready'].includes(o.status) ? `<div class="btn-group" style="margin-top:.5rem">
          ${o.status === 'reserved' ? `<button class="btn small" data-status="ready" data-oid="${o.id}">Mark ready</button>` : ''}
          <button class="btn small secondary" data-status="completed" data-oid="${o.id}">Mark picked up or delivered</button>
          <button class="btn small danger" data-status="cancelled" data-oid="${o.id}">Cancel</button></div>` : ''}
      </article>`;
    };
    return `<section class="card"><h2>Orders</h2>
      ${open.length ? `<div class="rows">${open.map(card).join('')}</div>` : '<p class="empty">No open orders. Reservations from buyers show up here.</p>'}
      ${past.length ? `<h3 style="margin:1rem 0 .5rem">Recent history</h3><div class="rows">${past.map(card).join('')}</div>` : ''}
    </section>`;
  }

  function bindOrderButtons() {
    view.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.status === 'cancelled' && !confirm('Cancel this order? The produce goes back on sale.')) return;
      try {
        await api(`/orders/${b.dataset.oid}/status`, { method: 'PATCH', body: { status: b.dataset.status } });
        toast('Order updated.');
        renderFarmDashboard();
      } catch (e) { toast(e.message, true); }
    }));
  }

  function listingsCard(farm) {
    return `<section class="card"><h2>Post your harvest</h2>
      <form id="listingForm" novalidate>
        <input type="hidden" id="l-id">
        <div class="row">
          <div class="field"><label for="l-name">Item</label><input id="l-name" type="text" placeholder="Heirloom tomatoes" required></div>
          <div class="field"><label for="l-cat">Type</label><select id="l-cat">${Object.entries(CATS).map(([k, t]) => `<option value="${k}">${esc(t)}</option>`).join('')}</select></div>
        </div>
        <div class="row">
          <div class="field"><label for="l-price">Price (${esc(farm.currency || 'USD')})</label><input id="l-price" type="number" min="0" step="0.01" inputmode="decimal" required></div>
          <div class="field"><label for="l-unit">Sold by</label><input id="l-unit" type="text" value="lb" list="units"><datalist id="units"><option>lb</option><option>bunch</option><option>each</option><option>pint</option><option>bag</option><option>dozen</option></datalist></div>
          <div class="field"><label for="l-qty">How much do you have?</label><input id="l-qty" type="number" min="0" step="any" inputmode="decimal" required></div>
          <div class="field"><label for="l-date">Harvest date</label><input id="l-date" type="date"></div>
        </div>
        <div class="field"><label for="l-desc">Details <span class="hint">(optional)</span></label><input id="l-desc" type="text"></div>
        <p class="error" id="lError" role="alert"></p>
        <div class="btn-group"><button class="btn" type="submit" id="l-save">Post item</button>
          <button class="btn secondary" type="button" id="l-cancel" hidden>Cancel edit</button></div>
      </form>
      <h3 style="margin:1.25rem 0 .6rem">On sale now</h3>
      ${farm.listings.length ? `<div class="rows">${farm.listings.map((l) => `
        <div class="item-row">
          <div><strong>${esc(l.name)}</strong> ${money(l.price_cents, farm.currency)}/${esc(l.unit)}
            <div class="meta">${qtyText(l.qty_available)} ${esc(l.unit)} left${l.harvest_date ? ', ' + esc(harvestLabel(l.harvest_date).toLowerCase()) : ''}${l.qty_available === 0 ? ', sold out' : ''}</div></div>
          <div class="btn-group"><button class="btn small secondary" data-edit="${l.id}">Edit</button>
            <button class="btn small danger" data-del="${l.id}" aria-label="Remove ${esc(l.name)}">Remove</button></div>
        </div>`).join('')}</div>` : '<p class="empty">Nothing posted yet. Add what you harvested today and neighbors can reserve it right away.</p>'}
    </section>`;
  }

  function bindListings(farm) {
    const f = $('#listingForm');
    const set = (id, v) => ($(id).value = v ?? '');
    const reset = () => {
      f.reset(); set('#l-id', ''); set('#l-unit', 'lb');
      set('#l-date', new Date().toLocaleDateString('en-CA'));
      $('#l-save').textContent = 'Post item'; $('#l-cancel').hidden = true;
    };
    reset();
    $('#l-cancel').addEventListener('click', reset);
    view.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      const l = farm.listings.find((x) => x.id === Number(b.dataset.edit));
      set('#l-id', l.id); set('#l-name', l.name); set('#l-cat', l.category); set('#l-price', (l.price_cents / 100).toFixed(2));
      set('#l-unit', l.unit); set('#l-qty', l.qty_available); set('#l-date', l.harvest_date); set('#l-desc', l.description);
      $('#l-save').textContent = 'Save changes'; $('#l-cancel').hidden = false;
      $('#l-name').focus();
    }));
    view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remove this item from sale?')) return;
      try { await api('/listings/' + b.dataset.del, { method: 'DELETE' }); toast('Item removed.'); renderFarmDashboard(); }
      catch (e) { toast(e.message, true); }
    }));
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('#l-id').value;
      const body = {
        name: $('#l-name').value, category: $('#l-cat').value, price: $('#l-price').value, unit: $('#l-unit').value,
        qty_available: $('#l-qty').value, harvest_date: $('#l-date').value, description: $('#l-desc').value,
      };
      try {
        await api(id ? '/listings/' + id : `/farms/${farm.id}/listings`, { method: id ? 'PUT' : 'POST', body });
        toast(id ? 'Changes saved.' : 'Item posted. Buyers can see it now.');
        renderFarmDashboard();
      } catch (ex) { $('#lError').textContent = ex.message; }
    });
  }

  function farmFormCard(farm) {
    const f = farm || { name: '', kind: 'farm', description: '', address: '', city: '', phone: '', pickup_enabled: true, pickup_instructions: '',
      delivery_enabled: false, delivery_radius_miles: 10, delivery_fee_cents: 500, payment_note: 'Pay the farmer directly at pickup or delivery.', lat: '', lng: '' };
    return `<section class="card"><h2>${farm ? 'Listing details' : 'Tell people about your place'}</h2>
      <form id="farmForm" novalidate>
        <div class="row">
          <div class="field"><label for="fm-name">Name</label><input id="fm-name" type="text" value="${esc(f.name)}" required></div>
          <div class="field"><label for="fm-kind">What is it?</label><select id="fm-kind">${KINDS.map((k) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${esc(kindName(k))}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label for="fm-desc">About <span class="hint">(what you grow or sell, how you grow it, what visitors can expect)</span></label><textarea id="fm-desc">${esc(f.description)}</textarea></div>
        <div class="row">
          <div class="field"><label for="fm-addr">Street address</label><input id="fm-addr" type="text" value="${esc(f.address)}"></div>
          <div class="field"><label for="fm-city">Town or city, and country</label><input id="fm-city" type="text" value="${esc(f.city)}" placeholder="Celina, Texas or Nashik, India"></div>
          <div class="field"><label for="fm-phone">Phone</label><input id="fm-phone" type="tel" value="${esc(f.phone)}"></div>
        </div>
        <div class="field"><label>Location on the map <span class="hint">Click the map to drop your pin, or use your current location.</span></label>
          <div id="pickMap" class="pick-map" role="application" aria-label="Map to choose your farm location"></div>
          <div class="btn-group"><button class="btn small secondary" type="button" id="findTown">Find my address or town on the map</button>
          <button class="btn small secondary" type="button" id="useHere">Use my current location</button></div>
          <input type="hidden" id="fm-lat" value="${esc(f.lat)}"><input type="hidden" id="fm-lng" value="${esc(f.lng)}">
          <p class="hint" id="pinNote"></p></div>
        <div class="field"><label for="fm-gm">Or paste a Google Maps link to your farm</label>
          <div style="display:flex;gap:.5rem"><input id="fm-gm" type="text" placeholder="https://www.google.com/maps/place/..." style="flex:1;min-width:0">
          <button class="btn secondary" type="button" id="gmGo">Use this link</button></div>
          <p class="hint">In Google Maps, open your farm and copy the link from the address bar. Coordinates like 33.2, -96.6 also work.</p></div>
        <div class="row">
          <div class="field"><label for="fm-hours">Hours <span class="hint">(optional)</span></label><input id="fm-hours" type="text" value="${esc(f.hours || '')}" placeholder="Saturdays 8am to noon"></div>
          <div class="field"><label for="fm-web">Website <span class="hint">(optional)</span></label><input id="fm-web" type="url" value="${esc(f.website || '')}" placeholder="https://"></div>
        </div>
        <label class="check"><input type="checkbox" id="fm-snap" ${f.accepts_snap ? 'checked' : ''}> We accept SNAP/EBT</label>
        <label class="check"><input type="checkbox" id="fm-whole" ${f.wholesale ? 'checked' : ''}> We sell wholesale (to restaurants, stores)</label>
        <h3 style="margin:1rem 0 .5rem">If you sell produce online: how buyers get their order</h3>
        <label class="check"><input type="checkbox" id="fm-pickup" ${f.pickup_enabled ? 'checked' : ''}> Pickup at the farm</label>
        <div class="field"><label for="fm-pinst">Pickup instructions</label><input id="fm-pinst" type="text" value="${esc(f.pickup_instructions)}" placeholder="Farm stand by the red barn, open 9 to 5"></div>
        <label class="check"><input type="checkbox" id="fm-deliv" ${f.delivery_enabled ? 'checked' : ''}> I deliver</label>
        <div class="row">
          <div class="field"><label for="fm-rad">Delivery radius (${uLong()})</label><input id="fm-rad" type="number" min="1" step="1" value="${Math.round(toU(f.delivery_radius_miles || 10))}"></div>
          <div class="field"><label for="fm-fee">Delivery fee</label><input id="fm-fee" type="number" min="0" step="0.5" value="${((f.delivery_fee_cents || 0) / 100).toFixed(2)}"></div>
        </div>
        <div class="row">
          <div class="field"><label for="fm-cur">Your prices are in</label><select id="fm-cur">${CURRENCIES.map((c) => `<option value="${c}" ${(f.currency || 'USD') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <div class="field"><label for="fm-pay">How buyers pay you</label><input id="fm-pay" type="text" value="${esc(f.payment_note)}"></div>
        </div>
        <p class="error" id="fError" role="alert"></p>
        <button class="btn" type="submit">${farm ? 'Save listing' : 'Put me on the map'}</button>
      </form></section>`;
  }

  function bindFarmForm(farm) {
    const start = farm ? [farm.lat, farm.lng] : [state.center.lat, state.center.lng];
    state.pickMap = Maps.create($('#pickMap'), start[0], start[1], farm ? 12 : state.located ? 9 : 2);
    let pin = null;
    const place = (lat, lng) => {
      lat = Math.round(lat * 1e5) / 1e5; lng = Math.round(lng * 1e5) / 1e5;
      $('#fm-lat').value = lat; $('#fm-lng').value = lng;
      if (pin) pin.set(lat, lng); else pin = state.pickMap.dragPin(lat, lng, place);
      $('#pinNote').innerHTML = `Pin set at ${lat.toFixed(4)}, ${lng.toFixed(4)}. <a href="${esc(gmPlace(lat, lng))}" target="_blank" rel="noopener">Check it in Google Maps</a>`;
    };
    if (farm) place(farm.lat, farm.lng);
    state.pickMap.onClick(place);
    $('#useHere').addEventListener('click', () => locate(() => {
      place(state.center.lat, state.center.lng);
      state.pickMap.setView(state.center.lat, state.center.lng, 13);
    }));
    $('#findTown').addEventListener('click', async () => {
      const qv = [$('#fm-addr').value, $('#fm-city').value].map((x) => x.trim()).filter(Boolean).join(', ');
      if (!qv) { $('#fError').textContent = 'Type your town or address first.'; return; }
      const hit = await geocode(qv);
      if (!hit) { $('#fError').textContent = 'Could not find that place. Add the state or country, or click the map instead.'; return; }
      $('#fError').textContent = '';
      place(hit.lat, hit.lng);
      state.pickMap.setView(hit.lat, hit.lng, 13);
      toast('Pin placed. Drag it to the exact spot if needed.');
    });
    $('#gmGo').addEventListener('click', () => {
      const ll = parseGm($('#fm-gm').value);
      if (!ll) { $('#fError').textContent = 'That link has no location in it. Copy the full link from the Google Maps address bar, or type coordinates like 33.2, -96.6.'; return; }
      $('#fError').textContent = '';
      place(ll[0], ll[1]);
      state.pickMap.setView(ll[0], ll[1], 14);
      toast('Location set from Google Maps.');
    });

    $('#farmForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        name: $('#fm-name').value, kind: $('#fm-kind').value, description: $('#fm-desc').value,
        address: $('#fm-addr').value, city: $('#fm-city').value, phone: $('#fm-phone').value,
        lat: $('#fm-lat').value, lng: $('#fm-lng').value,
        pickup_enabled: $('#fm-pickup').checked, pickup_instructions: $('#fm-pinst').value,
        delivery_enabled: $('#fm-deliv').checked, delivery_radius_miles: fromU(Number($('#fm-rad').value)), delivery_fee: $('#fm-fee').value,
        payment_note: $('#fm-pay').value, currency: $('#fm-cur').value,
        hours: $('#fm-hours').value, website: $('#fm-web').value, accepts_snap: $('#fm-snap').checked, wholesale: $('#fm-whole').checked,
        ...(farm ? groupBody(farm) : {}),
      };
      try {
        await api(farm ? '/farms/' + farm.id : '/farms', { method: farm ? 'PUT' : 'POST', body });
        toast(farm ? 'Listing saved.' : 'You are on the map. Next, add a photo and what you sell.');
        state.dtab = 'overview'; renderFarmDashboard();
      } catch (ex) { $('#fError').textContent = ex.message; }
    });
  }


  // ---------- landing (no town chosen yet) ----------
  async function renderLanding() {
    view.innerHTML = `<div class="wrap page">
      <section class="hero">
        <h1>Find local farms, markets and farm days near you</h1>
        <p>Farms, farmers' markets, farm stands, CSA shares, u-pick and farm events, all listed by the people who run them. Buy straight from the farmer, with no middlemen.</p>
        <div class="search"><div class="field"><label for="land-q">Your town or city</label><input id="land-q" type="text" placeholder="Celina, TX"></div>
          <button class="btn squash" type="button" id="land-here" style="align-self:end">Use my location</button></div>
      </section>
      <section class="steps3">
        <div><h3>Find what's local</h3><p class="muted">Farms, markets, stands, CSA shares and events near your town, on a map.</p></div>
        <div><h3>Buy direct</h3><p class="muted">Reserve produce, join a CSA or book a farm day. You pay the farm, not a middleman.</p></div>
        <div><h3>Run a farm or market?</h3><p class="muted">List it free, post what you harvested and share photos. <a href="/dashboard" data-link>Get started</a>.</p></div>
      </section>
      <section class="card"><div class="sec-hd"><h2>Towns with listings</h2><a class="more" href="/cities" data-link>see all towns ›</a></div><div id="landCities" class="chips"><span class="hint">Loading…</span></div></section>
    </div>`;
    bindPlaceSearch($('#land-q'), (p) => navigate('/' + p.slug));
    $('#land-here').addEventListener('click', useMyLocation);
    try {
      const { cities } = await api('/cities');
      $('#landCities').innerHTML = cities.length ? cities.slice(0, 30).map((c) => `<a class="chip" href="/${esc(c.slug)}" data-link>${esc(c.label)} (${c.n})</a>`).join('') : '<p class="empty">No listings yet. Be the first: <a href="/dashboard" data-link>list your farm</a>.</p>';
    } catch { /* ignore */ }
  }

  async function renderCities() {
    loading('Towns with listings');
    const { cities } = await api('/cities');
    view.innerHTML = `<div class="wrap page"><h1>Towns with listings</h1>
      <p class="muted">Pick a town to see its farms, markets, CSA shares and events. Don't see yours? <button class="linkish" type="button" id="pickTown">Search any town</button>.</p>
      ${cities.length ? `<ul class="mlist card">${cities.map((c) => `<li><a href="/${esc(c.slug)}" data-link>${esc(c.label)}</a><span class="meta">${c.n} ${c.n === 1 ? 'listing' : 'listings'}</span></li>`).join('')}</ul>` : '<p class="empty">No listings yet.</p>'}</div>`;
    $('#pickTown').addEventListener('click', openPlacePicker);
  }

  // ---------- city page ----------
  const NEAR_LINKS = [['farms', 'farms'], ['experiences', 'farm visits', 'experiences'], ['barns', 'barns and ranches', 'barns'], ['markets', 'markets'], ['groups', 'group orders', 'group-orders'],
    ['upick', 'u-pick', 'u-pick'], ['farmstands', 'farm stands', 'farm-stands'], ['csa', 'CSA'], ['events', 'events'], ['restaurants', 'restaurants'], ['groceries', 'groceries'], ['all', 'all listings', 'listings']];
  async function renderCity() {
    const p = state.place;
    loading(`Local food near ${p.label}`);
    const d = await api(`/local?lat=${p.lat}&lng=${p.lng}&radius=${state.radius || 50}`);
    const town = townName();
    const seasonName = { fall: 'this fall', winter: 'this winter', spring: 'this spring', summer: 'this summer' }[d.in_season.season];
    const near = NEAR_LINKS.filter(([k]) => d.counts[k] > 0 || ['farms', 'experiences', 'markets', 'csa', 'events'].includes(k))
      .map(([k, label, path]) => `<a href="${base()}/${path || k}" data-link>${esc(label)} <span>${d.counts[k] || 0}</span></a>`).join('');
    const fcard = (f) => `<a class="fcard" href="/farm/${f.id}" data-link>${thumb(f)}<div class="body"><h3>${esc(f.name)}</h3>
      <span class="meta">${esc(kindName(f.kind))}, ${esc(f.place_label)}${f.distance_miles != null ? ` · ${dist(f.distance_miles)}` : ''}</span></div></a>`;
    view.innerHTML = `<div class="wrap page">
      <div class="city-hd"><h1>Local food near ${esc(p.label)}</h1>
        <div class="sub"><span class="muted">Within ${radText(state.radius || 50)}. Listings are posted by the farms and markets themselves.</span><a class="more" href="/cities" data-link>see more towns ›</a></div></div>
      <nav class="near" aria-label="Near ${esc(town)}"><b>Near ${esc(town)}:</b>${near}<a href="${base()}/photos" data-link>photos</a></nav>
      <section class="visits"><div class="sec-hd"><h2>Visit a farm near ${esc(town)}</h2><a class="more" href="${base()}/experiences" data-link>all farm visits ›</a></div>
        <div class="vtiles">${VISITS.slice(1).map(([k, t]) => { const c = d.counts['exp_' + k] || 0; return `<a class="vt vt-${k}" href="${base()}/experiences/${k}" data-link><b>${esc(t)}</b><span>${c ? `${c} ${c === 1 ? 'place' : 'places'}` : 'None listed yet'}</span></a>`; }).join('')}
          <a class="vt vt-barn" href="${base()}/barns" data-link><b>Barns and ranches</b><span>${d.counts.barns ? `${d.counts.barns} nearby, with their produce` : 'None listed yet'}</span></a></div></section>
      ${d.counts.all ? '' : `<div class="notice">Nothing is listed near ${esc(town)} yet. Know a farm, market or stand here? <a href="/dashboard" data-link>List it free</a>, or <button class="linkish" type="button" id="widen">look further away</button>.</div>`}
      <div class="city-grid">
        <div class="page" style="gap:1.25rem">
          <section class="card"><div class="sec-hd"><h2>Featured farms</h2><a class="more" href="${base()}/farms" data-link>search all farms ›</a></div>
            ${d.featured.length ? `<div class="fcards">${d.featured.map(fcard).join('')}</div>` : '<p class="empty">No farms listed nearby yet.</p>'}</section>
          <section class="card"><div class="sec-hd"><h2>Group orders near ${esc(town)}</h2><a class="more" href="${base()}/group-orders" data-link>how group orders work ›</a></div>
            <p class="hint" style="margin-bottom:.6rem">Neighbors order together so the farm makes one trip to one drop-off spot, often with a bulk discount.</p>
            ${d.groups && d.groups.length ? `<div class="rows">${d.groups.map(groupRow).join('')}</div>` : `<p class="empty">No open group orders nearby. <a href="${base()}/group-orders" data-link>Start one for your street or office</a>.</p>`}</section>
          <section class="card"><div class="sec-hd"><h2>Farmers' markets</h2><a class="more" href="${base()}/markets" data-link>local farmers' markets ›</a></div>
            ${d.markets.length ? `<ul class="mlist">${d.markets.map((m) => `<li><span><a href="/farm/${m.id}" data-link>${esc(m.name)}</a><br><span class="meta">${esc(m.hours || m.place_label)}</span></span><span class="meta tnum">${dist(m.distance_miles)}</span></li>`).join('')}</ul>` : '<p class="empty">No markets listed nearby yet. Run one? <a href="/dashboard" data-link>List it free</a>.</p>'}</section>
          <section class="card"><div class="sec-hd"><h2>From your local farmers</h2><a class="more" href="${base()}/products" data-link>more local products ›</a></div>
            ${d.products.length ? `<div class="cats">${d.products.map((c) => `<a href="${base()}/products/${esc(c.category)}" data-link>${esc(catName(c.category))}<span>${c.farms}</span></a>`).join('')}</div>` : '<p class="empty">No products listed nearby yet.</p>'}</section>
          <section class="card"><div class="sec-hd"><h2>In season near ${esc(town)} ${seasonName}</h2><a class="more" href="${base()}/products" data-link>see more farm products ›</a></div>
            ${d.in_season.nearby.length ? `<p class="meta" style="margin-bottom:.4rem">Listed by farms near you right now:</p><div class="chips">${d.in_season.nearby.map((i) => `<span class="chip price">${esc(i.name)}${i.farms > 1 ? ` · ${i.farms} farms` : ''}</span>`).join('')}</div>` : ''}
            <p class="meta" style="margin:.7rem 0 .4rem">Usually in season ${seasonName}:</p><div class="chips">${d.in_season.typical.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div></section>
          <section class="card"><div class="sec-hd"><h2>Photo gallery</h2><a class="more" href="${base()}/photos" data-link>local farm photos ›</a></div>
            ${d.gallery.length ? `<div class="gallery">${d.gallery.map(galleryItem).join('')}</div>` : '<p class="empty">No photos yet. Farmers can add photos from their dashboard.</p>'}</section>
          ${d.experiences.length ? `<section class="card"><div class="sec-hd"><h2>Farm visits: rides, farm days, classes and u-pick</h2><a class="more" href="${base()}/experiences" data-link>all farm visits ›</a></div>
            <ul class="mlist">${d.experiences.map((e) => `<li><span><a href="/farm/${e.farm_id}#experiences" data-link>${esc(e.title)}</a><br><span class="meta">${esc(e.farm_name)} · ${esc(EXP_TYPES[e.type] || 'Experience')}</span></span><span class="meta">${esc(expPrice(e, e.currency))}</span></li>`).join('')}</ul></section>` : ''}
        </div>
        <aside class="city-side">
          <div id="cityMap" class="minimap" style="height:280px" role="region" aria-label="Map of listings near ${esc(town)}"></div>
          <section class="card"><div class="sec-hd"><h2>Upcoming events</h2><a class="more" href="${base()}/events" data-link>all events ›</a></div>
            ${d.events.length ? `<ul class="evlist">${d.events.map((e) => `<li class="ev">${calBox(e.date)}<div><a href="/farm/${e.farm_id}#events" data-link><b>${esc(e.title)}</b></a><br><span class="meta">${esc(e.farm_name)}${e.start_time ? ` · ${fmtTime(e.start_time)}` : ''}${e.price_cents ? ` · ${money(e.price_cents)}` : ' · Free'}</span></div></li>`).join('')}</ul>` : '<p class="empty">No upcoming events nearby.</p>'}</section>
          <section class="card"><div class="sec-hd"><h2>CSA shares</h2><a class="more" href="${base()}/csa" data-link>all CSAs ›</a></div>
            ${d.csa.length ? `<ul class="mlist">${d.csa.map((c) => `<li><span><a href="/farm/${c.farm_id}#csa" data-link>${esc(c.name)}</a><br><span class="meta">${esc(c.farm_name)}${c.season ? ` · ${esc(c.season)}` : ''}</span></span><span class="meta">${money(c.price_cents, c.currency)} ${esc(CSA_PER[c.per])}</span></li>`).join('')}</ul>` : '<p class="empty">No CSA shares nearby yet.</p>'}
            <p class="hint" style="margin-top:.6rem">With a CSA (community supported agriculture) share you pay a farm up front and get a box of its harvest every week of the season.</p></section>
          <div class="listbox"><h3>Grow food or run a market near ${esc(town)}?</h3><p>List it free. Post what you harvested, sell CSA shares, host events and share photos. Buyers pay you directly.</p>
            <a class="btn" href="/dashboard" data-link>List your farm</a></div>
        </aside>
      </div></div>`;
    $('#widen')?.addEventListener('click', () => { state.radius = 250; try { localStorage.setItem('fd_radius', '250'); } catch { /* ignore */ } renderCity(); });
    const all = (await api(`/farms?lat=${p.lat}&lng=${p.lng}&radius=${state.radius || 50}`)).farms;
    const map = Maps.create($('#cityMap'), p.lat, p.lng, 10); state.maps.push(map);
    all.forEach((f) => map.addPin(f.lat, f.lng, { title: f.name, kind: f.kind, onClick: () => navigate('/farm/' + f.id) }));
    map.fit([[p.lat, p.lng], ...all.slice(0, 15).map((f) => [f.lat, f.lng])]);
  }
  const galleryItem = (g) => `<a href="/farm/${g.farm_id}" data-link title="${esc(g.farm_name)}">${String(g.type).startsWith('video')
    ? `<video class="media" src="${esc(g.url)}" muted preload="metadata"></video>` : `<img class="media" src="${esc(g.url)}" alt="${esc(g.caption || g.farm_name)}" loading="lazy">`}<span>${esc(g.farm_name)}</span></a>`;

  // ---------- directory (list + map) ----------
  const DIR = {
    listings: { type: '', title: 'All local listings' }, farms: { type: 'farms', title: 'Farms' }, markets: { type: 'markets', title: "Farmers' markets" },
    'u-pick': { type: 'upick', title: 'U-pick farms' }, 'farm-stands': { type: 'farmstands', title: 'Farm stands' }, csa: { type: 'csa', title: 'CSA farms' },
    experiences: { type: 'experiences', title: 'Farm visits' }, barns: { type: 'barns', title: 'Barns and ranches' }, wholesale: { type: 'wholesale', title: 'Wholesale farms' },
    restaurants: { type: 'restaurants', title: 'Farm-to-table restaurants' }, groceries: { type: 'groceries', title: 'Groceries and co-ops' },
    snap: { type: 'snap', title: 'Places that accept SNAP/EBT' }, others: { type: 'others', title: 'Other local food' }, products: { type: '', title: 'Local products' },
  };
  const FILTERS = [['listings', 'Show all'], ['farms', 'Farms'], ['experiences', 'Farm visits'], ['barns', 'Barns and ranches'], ['markets', "Farmers' markets"], ['u-pick', 'U-pick'], ['farm-stands', 'Farm stands'], ['csa', 'CSA'],
    ['wholesale', 'Wholesale'], ['restaurants', 'Restaurants'], ['groceries', 'Groceries'], ['snap', 'Accepts SNAP'], ['others', 'Others']];
  const VISITS = [['', 'All farm visits'], ['horse', 'Horseback riding'], ['day', 'Spend a day on a farm'], ['learn', 'Learn farming'], ['tour', 'Farm and barn tours'], ['pick', 'U-pick']];
  const VISIT_BLURB = { horse: 'Trail rides, lessons and pony rides at barns and ranches.', day: 'Feed animals, collect eggs, help with chores and eat what you picked.',
    learn: 'Hands-on classes: growing vegetables, keeping chickens, beekeeping, cheesemaking.', tour: 'Walk the fields and barns with the people who run them.', pick: 'Pick your own fruit, berries, pumpkins and flowers.' };
  async function renderDirectory(sec, product = '', xtype = '') {
    const d = { ...DIR[sec] };
    if (xtype) { d.type = 'exp:' + xtype; d.title = VISITS.find(([k]) => k === xtype)[1]; }
    const where = state.place && location.pathname.split('/')[1] !== 'all' ? state.place : null;
    const title = product ? `${catName(product)} ${where ? `near ${where.label}` : 'from local farms'}` : `${d.title} ${where ? `near ${where.label}` : 'everywhere'}`;
    const params = new URLSearchParams(location.search);
    const q = params.get('q') || '';
    view.innerHTML = `<div class="wrap page">
      <div><h1>${esc(title)}</h1>${where ? '' : '<p class="muted">Choose your town at the top to see the closest first.</p>'}</div>
      <nav class="filterrow" aria-label="Type of place">${FILTERS.map(([k, t]) => `<a href="${base()}/${k}" data-link ${k === sec ? 'aria-current="page"' : ''}>${esc(t)}</a>`).join('')}</nav>
      ${sec === 'experiences' ? `<div class="visit-intro"><p>Book time on a working farm, barn or ranch. You send a request, the owner confirms, and you pay them directly when you arrive.</p>
        <nav class="pills" aria-label="Kind of visit">${VISITS.map(([k, t]) => `<a href="${base()}/experiences${k ? '/' + k : ''}" data-link ${k === xtype ? 'aria-current="page"' : ''}>${esc(t)}</a>`).join('')}</nav>
        ${xtype ? `<p class="meta">${esc(VISIT_BLURB[xtype])}</p>` : ''}</div>` : ''}
      ${sec === 'barns' ? '<p class="muted">Barns and ranches near you: horses and riding, eggs, meat, hay and barn-raised produce, farm days and tours.</p>' : ''}
      <form class="toolbar" id="dirForm" role="search">
        <div class="field"><label for="d-q">Search</label><input id="d-q" type="search" value="${esc(q)}" placeholder="name, product or town"></div>
        <div class="field"><label for="d-prod">Product</label><select id="d-prod"><option value="">Any product</option>${Object.entries(CATS).map(([k, t]) => `<option value="${k}" ${k === product ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>
        <div class="field"><label for="d-rad">Within</label><select id="d-rad" ${where ? '' : 'disabled'}>${[10, 25, 50, 100, 250, 0].map((r) => `<option value="${r}" ${state.radius === r ? 'selected' : ''}>${r ? radText(r) : 'Any distance'}</option>`).join('')}</select></div>
      </form>
      <p class="meta" id="d-count" aria-live="polite"></p>
      <div class="dir"><ul class="results" id="d-list"><li class="hint">Loading…</li></ul><div id="d-map" class="map" role="region" aria-label="Map of results"></div></div>
    </div>`;
    const map = Maps.create($('#d-map'), where ? where.lat : 30, where ? where.lng : -40, where ? 10 : 2); state.maps.push(map);
    const load = async () => {
      const qs = new URLSearchParams();
      if (where) { qs.set('lat', where.lat); qs.set('lng', where.lng); if (state.radius) qs.set('radius', state.radius); }
      if (d.type) qs.set('type', d.type);
      const prod = $('#d-prod').value; if (prod) qs.set('product', prod);
      const qq = $('#d-q').value.trim(); if (qq) qs.set('q', qq);
      const { farms } = await api('/farms?' + qs);
      $('#d-count').textContent = `${farms.length} ${farms.length === 1 ? 'result' : 'results'}`;
      $('#d-list').innerHTML = farms.length ? farms.map((f) => resultRow(f, prod, sec === 'experiences' ? xtype || '*' : '')).join('')
        : `<li class="empty"><strong>Nothing found.</strong> Try a wider distance, another type, or <a href="/dashboard" data-link>list your own farm</a>.</li>`;
      map.clear();
      farms.forEach((f) => map.addPin(f.lat, f.lng, { title: f.name, kind: f.kind, onClick: () => navigate('/farm/' + f.id) }));
      map.fit([...(where ? [[where.lat, where.lng]] : []), ...farms.slice(0, 25).map((f) => [f.lat, f.lng])]);
    };
    let t;
    $('#dirForm').addEventListener('submit', (e) => e.preventDefault());
    $('#d-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    $('#d-prod').addEventListener('change', () => { const v = $('#d-prod').value; navigate(v ? `${base()}/products/${v}` : `${base()}/${sec === 'products' ? 'listings' : sec}`); });
    $('#d-rad').addEventListener('change', () => { state.radius = Number($('#d-rad').value); try { localStorage.setItem('fd_radius', String(state.radius)); } catch { /* ignore */ } load(); });
    await load();
  }
  function resultRow(f, prod, visits = '') {
    const items = (prod ? f.items.filter((i) => i.category === prod) : f.items).slice(0, 6);
    const extra = [];
    if (f.csa_count) extra.push('<span class="chip how">CSA shares</span>');
    if (f.experiences.some((e) => e.type === 'pick')) extra.push('<span class="chip how">U-pick</span>');
    if (f.event_count) extra.push(`<span class="chip how">${f.event_count} upcoming ${f.event_count === 1 ? 'event' : 'events'}</span>`);
    if (f.delivery_enabled) extra.push('<span class="chip how">Delivers</span>');
    return `<li class="res"><a href="/farm/${f.id}" data-link tabindex="-1" aria-hidden="true">${thumb(f)}</a><div class="body">
      <div class="sec-hd" style="margin:0"><h3><a href="/farm/${f.id}" data-link>${esc(f.name)}</a></h3><span class="meta tnum">${dist(f.distance_miles)}</span></div>
      <div class="meta">${badges(f)} ${esc(f.place_label || f.city)}${f.hours ? ` · ${esc(f.hours)}` : ''}</div>
      ${f.description ? `<p class="desc">${esc(f.description)}</p>` : ''}
      ${visits ? `<ul class="xplist">${f.experiences.filter((e) => visits === '*' || e.type === visits).map((e) => `<li><a href="/farm/${f.id}#experiences" data-link><b>${esc(e.title)}</b></a>
        <span class="meta">${esc(EXP_SHORT[e.type])}${e.duration ? ` · ${esc(e.duration)}` : ''}${e.min_age ? ` · ages ${e.min_age}+` : ''}</span><span class="price">${esc(expPrice(e, f.currency))}</span></li>`).join('')}</ul>` : ''}
      ${extra.length || items.length ? `<div class="chips">${extra.join('')}${items.map((i) => `<span class="chip price">${esc(i.name)} ${money(i.price_cents, f.currency)}/${esc(i.unit)}</span>`).join('')}${f.experiences.filter((e) => e.type !== 'pick').slice(0, 2).map((e) => `<span class="chip xp">${esc(e.title)}</span>`).join('')}</div>` : ''}
    </div></li>`;
  }

  async function renderProducts() {
    const where = state.place && location.pathname.split('/')[1] !== 'all' ? state.place : null;
    loading('Shop local');
    const qs = where ? `?lat=${where.lat}&lng=${where.lng}&radius=${state.radius || 50}` : '';
    const { farms } = await api('/farms' + qs);
    const counts = {};
    for (const f of farms) for (const c of new Set(f.items.map((i) => i.category))) counts[c] = (counts[c] || 0) + 1;
    view.innerHTML = `<div class="wrap page"><h1>Shop local ${where ? `near ${esc(where.label)}` : ''}</h1>
      <p class="muted">Pick a category to see which farms, stands and markets have it, with prices. Reserve online and pay the farm when you pick up.</p>
      <div class="cats">${Object.keys(CATS).map((c) => `<a href="${base()}/products/${c}" data-link>${esc(CATS[c])}<span>${counts[c] || 0}</span></a>`).join('')}</div></div>`;
  }

  async function renderEvents() {
    const where = state.place && location.pathname.split('/')[1] !== 'all' ? state.place : null;
    loading('Farm events');
    const qs = where ? `?lat=${where.lat}&lng=${where.lng}&radius=${state.radius || 50}` : '';
    const { events } = await api('/events' + qs);
    view.innerHTML = `<div class="wrap page"><h1>Farm and market events ${where ? `near ${esc(where.label)}` : ''}</h1>
      <p class="muted">Market days, harvest festivals, workshops and open farm days. RSVP so the host knows you're coming.</p>
      ${events.length ? `<ul class="evlist card">${events.map((e) => `<li class="ev">${calBox(e.date)}<div><a href="/farm/${e.farm_id}#events" data-link><b>${esc(e.title)}</b></a>
        <br><span class="meta">${new Date(e.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${e.start_time ? `, ${fmtTime(e.start_time)}${e.end_time ? ` to ${fmtTime(e.end_time)}` : ''}` : ''}
        · ${esc(e.farm_name)}${e.distance_miles != null ? ` · ${dist(e.distance_miles)}` : ''} · ${e.price_cents ? money(e.price_cents, e.currency) : 'Free'}</span>
        ${e.about ? `<p class="meta">${esc(e.about)}</p>` : ''}</div></li>`).join('')}</ul>` : '<p class="empty">No upcoming events here yet.</p>'}</div>`;
  }

  async function renderPhotos() {
    const where = state.place && location.pathname.split('/')[1] !== 'all' ? state.place : null;
    loading('Farm photos');
    const qs = where ? `?lat=${where.lat}&lng=${where.lng}&radius=${state.radius || 50}` : '';
    const { photos } = await api('/gallery' + qs);
    view.innerHTML = `<div class="wrap page"><h1>Farm photos ${where ? `near ${esc(where.label)}` : ''}</h1>
      ${photos.length ? `<div class="gallery">${photos.map(galleryItem).join('')}</div>` : '<p class="empty">No photos yet. Farmers add them from their dashboard.</p>'}</div>`;
  }

  // ---------- one listing (farm, market, stand...) ----------
  async function renderListing(id) {
    loading('Loading');
    let d;
    try { d = await api('/farms/' + id); } catch { return notFound('That listing was removed or never existed.'); }
    try { d.groups = (await api('/groups?farm_id=' + id)).groups; } catch { d.groups = []; }
    const f = d.farm, mi = fromHere(f);
    const own = !!state.user && state.mine === f.id;
    state.cart = state.cart && state.cart.farm.id === f.id ? { ...state.cart, farm: f, listings: d.listings } : { farm: f, listings: d.listings, lines: {} };
    const sections = [['about', 'About'], d.listings.length && ['products', 'Products'], (d.farm.group_orders || d.groups.length) && ['groups', 'Group orders'], d.csa.length && ['csa', 'CSA'], d.experiences.length && ['experiences', 'Farm visits'],
      d.events.length && ['events', 'Events'], d.posts.length && ['updates', 'Updates'], ['location', 'Location']].filter(Boolean);
    document.title = `${f.name}: ${kindName(f.kind)} in ${f.place_label || f.city} | FarmDirect`;
    view.innerHTML = `<div class="wrap page">
      ${own ? `<div class="notice">This is your public page, the way visitors see it. <a href="/dashboard" data-link>Edit it in your dashboard</a>.</div>` : ''}
      <section class="lp-hero">${f.cover_url ? `<img class="cover media" src="${esc(f.cover_url)}" alt="Photo of ${esc(f.name)}">` : `<div class="ph k-${esc(f.kind)}" aria-hidden="true">${initial(f.name)}</div>`}
        <div class="in"><h1>${esc(f.name)}</h1>
          <div class="meta">${badges(f)} ${esc(f.place_label || f.city)}${mi != null ? ` · ${dist(mi)} from ${esc(townName())}` : ''}${f.hours ? ` · ${esc(f.hours)}` : ''}</div>
          <div class="btn-group">${gmLink(gmDir(farmDest(f)), 'Get directions')}${gmLink(gmPlace(f.lat, f.lng), 'Open in Google Maps')}
            ${f.website ? `<a class="btn small secondary" href="${esc(f.website)}" target="_blank" rel="noopener">Website</a>` : ''}
            ${f.phone ? `<span class="chip">Phone: <span style="user-select:all">${esc(f.phone)}</span></span>` : ''}</div>
          <nav class="jump" aria-label="On this page">${sections.map(([k, t]) => `<a href="#${k}">${t}</a>`).join('')}</nav></div></section>
      <div class="lp-grid"><div class="page" style="gap:1.25rem">
        <section class="card" id="about"><h2>About ${esc(f.name)}</h2><p>${esc(f.description || 'No description yet.')}</p></section>
        ${d.listings.length ? `<section class="card" id="products"><h2>For sale now</h2><div class="rows" id="lp-items"></div><div id="cartBox" style="margin-top:.8rem"></div></section>` : ''}
        ${f.group_orders || d.groups.length ? `<section class="card" id="groups"><h2>Order with your neighbors</h2>
          <p style="margin-bottom:.6rem">${esc(f.name)} delivers group orders: everyone on a street, at an office or a school orders by one deadline, and the farm brings it all in one trip to one drop-off spot.
          ${groupTerms(f)}</p>
          ${d.groups.length ? `<div class="rows">${d.groups.map(groupRow).join('')}</div>` : '<p class="empty">No open group orders right now.</p>'}
          ${f.group_orders && !own ? '<div class="btn-group" style="margin-top:.7rem"><button class="btn" type="button" id="startGroup">Start a group order</button><span class="hint">You choose the drop-off spot and dates. Neighbors join with a link.</span></div>' : ''}
          ${own ? '<p class="hint" style="margin-top:.6rem">Visitors see a Start a group order button here. Manage drop-offs in your dashboard under Group orders.</p>' : ''}</section>` : ''}
        ${d.csa.length ? `<section class="card" id="csa"><h2>CSA shares</h2><p class="hint" style="margin-bottom:.6rem">Sign up for a weekly share of the harvest. The farm confirms your spot and tells you how to pay.</p><div class="rows">${d.csa.map((c) => offerHtml('csa', c, f)).join('')}</div></section>` : ''}
        ${d.experiences.length ? `<section class="card" id="experiences"><h2>Visit the farm</h2><div class="rows">${d.experiences.map((e) => offerHtml('exp', e, f)).join('')}</div></section>` : ''}
        ${d.events.length ? `<section class="card" id="events"><h2>Upcoming events</h2><div class="rows">${d.events.map((e) => offerHtml('event', e, f)).join('')}</div></section>` : ''}
        ${d.posts.length ? `<section class="card" id="updates"><h2>Updates from the farm</h2><div class="rows">${d.posts.map((p) => postHtml(p)).join('')}</div></section>` : ''}
      </div>
      <aside class="lp-side"><section class="card" id="location"><h2>Location and details</h2>
        <div id="lpMap" class="minimap" role="region" aria-label="Map"></div>
        <div class="facts" style="margin-top:.8rem">
          ${f.address ? `<p><strong>Address:</strong> ${esc(f.address)}, ${esc(f.city || f.place_label)}</p>` : `<p><strong>Near:</strong> ${esc(f.place_label)}</p>`}
          ${f.hours ? `<p><strong>Hours:</strong> ${esc(f.hours)}</p>` : ''}
          ${d.listings.length && f.pickup_enabled ? `<p><strong>Pickup:</strong> ${esc(f.pickup_instructions || 'Arrange a time with the farmer.')}</p>` : ''}
          ${f.delivery_enabled ? `<p><strong>Delivery:</strong> within ${radText(f.delivery_radius_miles)}, ${f.delivery_fee_cents ? money(f.delivery_fee_cents, f.currency) + ' fee' : 'free'}</p>` : ''}
          <p><strong>Payment:</strong> ${esc(f.payment_note)}</p>
          ${f.accepts_snap ? '<p><strong>SNAP/EBT:</strong> accepted</p>' : ''}
        </div></section></aside></div></div>`;
    const map = Maps.create($('#lpMap'), f.lat, f.lng, 12); state.maps.push(map);
    map.addPin(f.lat, f.lng, { title: f.name, kind: f.kind });
    if (d.listings.length) drawItems();
    bindOffers(f, own);
    $('#startGroup')?.addEventListener('click', () => openStartGroup(f));
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }

  const CSA_PER = { week: 'per week', month: 'per month', season: 'per season' };
  function offerHtml(kind, o, f) {
    const today = new Date().toLocaleDateString('en-CA');
    const btn = { csa: 'Sign up', exp: 'Book this', event: 'RSVP' }[kind];
    const price = kind === 'csa' ? `${money(o.price_cents, f.currency)} ${CSA_PER[o.per]}` : kind === 'exp' ? expPrice(o, f.currency) : (o.price_cents ? money(o.price_cents, f.currency) : 'Free');
    const sub = kind === 'csa' ? [o.season, o.pickup && `Pickup: ${o.pickup}`, `${o.spots_left} of ${o.spots} spots left`].filter(Boolean).join(' · ')
      : kind === 'exp' ? [EXP_TYPES[o.type], o.duration, o.schedule, `up to ${o.max_people} people a day`, o.min_age ? `ages ${o.min_age}+` : '', o.bring ? `bring ${o.bring}` : ''].filter(Boolean).join(' · ')
      : [new Date(o.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) + (o.start_time ? `, ${fmtTime(o.start_time)}${o.end_time ? ` to ${fmtTime(o.end_time)}` : ''}` : ''), o.location, o.spots_left != null ? `${o.spots_left} spots left` : `${o.going} going`].filter(Boolean).join(' · ');
    const full = (kind === 'csa' && o.spots_left < 1) || (kind === 'event' && o.spots_left === 0);
    const form = kind === 'csa' ? `<div class="field"><label for="f-contact-${kind}${o.id}">Your phone or email</label><input id="f-contact-${kind}${o.id}" name="contact" type="text" autocomplete="tel"></div>
        <div class="field"><label for="f-note-${kind}${o.id}">Note to the farm <span class="hint">(optional)</span></label><input id="f-note-${kind}${o.id}" name="note" type="text"></div>`
      : kind === 'exp' ? `<div class="row"><div class="field"><label for="f-date-${o.id}">Date</label><input id="f-date-${o.id}" name="date" type="date" min="${today}"></div>
        <div class="field"><label for="f-people-exp${o.id}">How many people</label><input id="f-people-exp${o.id}" name="people" type="number" min="1" value="1"></div></div>
        <div class="field"><label for="f-contact-exp${o.id}">Your phone or email</label><input id="f-contact-exp${o.id}" name="contact" type="text" autocomplete="tel"></div>
        <div class="field"><label for="f-note-exp${o.id}">Note <span class="hint">(optional)</span></label><input id="f-note-exp${o.id}" name="note" type="text"></div>`
      : `<div class="row"><div class="field"><label for="f-people-ev${o.id}">How many people</label><input id="f-people-ev${o.id}" name="people" type="number" min="1" value="1"></div>
        <div class="field"><label for="f-contact-ev${o.id}">Phone or email <span class="hint">(optional)</span></label><input id="f-contact-ev${o.id}" name="contact" type="text"></div></div>`;
    return `<div class="offer"><div class="offer-hd"><div><strong>${esc(o.name || o.title)}</strong><div class="meta">${esc(sub)}</div></div><span class="price">${esc(price)}</span></div>
      ${o.about ? `<p>${esc(o.about)}</p>` : ''}
      <div class="btn-group"><button class="btn small" type="button" data-open="${kind}-${o.id}" ${full ? 'disabled' : ''}>${full ? 'Full' : btn}</button></div>
      <form class="form-box" id="form-${kind}-${o.id}" data-kind="${kind}" data-id="${o.id}" hidden novalidate>${form}
        <p class="error" role="alert"></p><div class="btn-group"><button class="btn" type="submit">${btn === 'Book this' ? 'Request booking' : btn === 'Sign up' ? 'Request a spot' : 'RSVP'}</button>
        <button class="btn secondary" type="button" data-shut="${kind}-${o.id}">Cancel</button><span class="hint">Nothing is charged here. You pay the farm directly.</span></div></form></div>`;
  }
  function bindOffers(f, own) {
    view.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      if (own) return toast('This is your own listing.', true);
      if (!state.user) return openAuth('login', 'Sign in or create a free account to continue.');
      const form = $('#form-' + b.dataset.open); form.hidden = false; form.querySelector('input')?.focus();
    }));
    view.querySelectorAll('[data-shut]').forEach((b) => b.addEventListener('click', () => { $('#form-' + b.dataset.shut).hidden = true; }));
    view.querySelectorAll('form[data-kind]').forEach((form) => form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = form.querySelector('.error'); err.textContent = '';
      const v = (n) => form.querySelector(`[name=${n}]`)?.value || '';
      const id = form.dataset.id, kind = form.dataset.kind;
      try {
        if (kind === 'csa') await api(`/csa/${id}/signup`, { method: 'POST', body: { contact: v('contact'), note: v('note') } });
        if (kind === 'exp') await api('/bookings', { method: 'POST', body: { experience_id: Number(id), date: v('date'), people: v('people'), contact: v('contact'), note: v('note') } });
        if (kind === 'event') await api(`/events/${id}/rsvp`, { method: 'POST', body: { people: v('people'), contact: v('contact') } });
        form.outerHTML = `<div class="success"><strong>${kind === 'event' ? "You're going." : 'Request sent.'}</strong><span>${kind === 'event' ? 'See it under My orders.' : `${esc(f.name)} will confirm. Follow it under My orders.`} ${esc(f.payment_note)}</span></div>`;
        toast(kind === 'event' ? 'RSVP saved.' : 'Request sent to the farm.');
      } catch (ex) { err.textContent = ex.message; }
    }));
  }

  // ---------- reserve produce ----------
  function drawItems() {
    const { farm, listings } = state.cart;
    const avail = listings.filter((l) => l.qty_available > 0);
    $('#lp-items').innerHTML = avail.length ? avail.map((l) => `<div class="item">
      <div><strong>${esc(l.name)}</strong> <span class="badge">${esc(catName(l.category))}</span>
        <div class="meta">${[harvestLabel(l.harvest_date), `${qtyText(l.qty_available)} ${esc(l.unit)} left`].filter(Boolean).join(', ')}</div>
        ${l.description ? `<div class="meta">${esc(l.description)}</div>` : ''}</div>
      <div class="buy"><span class="price">${money(l.price_cents, farm.currency)}/${esc(l.unit)}</span>
        <label class="sr" for="q-${l.id}">Quantity of ${esc(l.name)}</label>
        <input id="q-${l.id}" type="number" min="${stepFor(l.unit)}" step="${stepFor(l.unit)}" value="1" inputmode="decimal">
        <button class="btn small" type="button" data-add="${l.id}">Add</button></div></div>`).join('') : '<p class="empty">Everything is sold out right now. Check back soon.</p>';
    view.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.add), listing = listings.find((l) => l.id === id), qty = Number($(`#q-${id}`).value);
      if (!(qty > 0)) return toast('Enter how much you want.', true);
      const already = state.cart.lines[id]?.qty || 0;
      if (already + qty > listing.qty_available) return toast(`Only ${qtyText(listing.qty_available)} ${listing.unit} available.`, true);
      state.cart.lines[id] = { listing, qty: already + qty }; drawCart(); toast(`Added ${qtyText(qty)} ${listing.unit} of ${listing.name}.`);
    }));
    drawCart();
  }
  function drawCart() {
    const box = $('#cartBox'); if (!box) return;
    const farm = state.cart.farm, lines = Object.values(state.cart.lines);
    const items = lines.reduce((s, l) => s + Math.round(l.listing.price_cents * l.qty), 0);
    if (!lines.length) { box.innerHTML = ''; return; }
    const mi = fromHere(farm), canP = farm.pickup_enabled, canD = farm.delivery_enabled && (mi == null || mi <= farm.delivery_radius_miles);
    box.innerHTML = `<form class="cart" id="checkout" novalidate><h3>Your order</h3>
      <table>${lines.map((l) => `<tr><td>${esc(l.listing.name)}, ${qtyText(l.qty)} ${esc(l.listing.unit)}</td><td class="r">${money(Math.round(l.listing.price_cents * l.qty), farm.currency)}
        <button class="btn small danger" type="button" data-rm="${l.listing.id}" aria-label="Remove ${esc(l.listing.name)}">Remove</button></td></tr>`).join('')}
        <tr class="deliv-row" hidden><td>Delivery fee</td><td class="r">${money(farm.delivery_fee_cents, farm.currency)}</td></tr>
        <tr class="total"><td>Total, paid to the farm</td><td class="r" id="grand">${money(items, farm.currency)}</td></tr></table>
      <div class="radio-row">${canP ? '<label><input type="radio" name="how" value="pickup" checked> Pick up</label>' : ''}
        ${canD ? `<label><input type="radio" name="how" value="delivery" ${canP ? '' : 'checked'}> Delivery</label>` : ''}</div>
      ${!canP && !canD ? '<p class="error">This farm does not deliver to your town and has no pickup. Contact them directly.</p>' : ''}
      <div class="field" id="addrField" hidden><label for="c-addr">Delivery address</label><input id="c-addr" type="text" autocomplete="street-address"></div>
      <div class="row"><div class="field"><label for="c-when">When works for you <span class="hint">(optional)</span></label><input id="c-when" type="text" placeholder="Saturday morning"></div>
        <div class="field"><label for="c-note">Note <span class="hint">(optional)</span></label><input id="c-note" type="text"></div></div>
      <p class="error" id="coError" role="alert"></p>
      <div class="btn-group"><button class="btn" type="submit" ${!canP && !canD ? 'disabled' : ''}>Reserve order</button><span class="hint">Reserving holds it for you. ${esc(farm.payment_note)}</span></div></form>`;
    const form = $('#checkout');
    const how = () => (form.querySelector('input[name=how]:checked') || {}).value;
    const sync = () => { const del = how() === 'delivery'; $('#addrField').hidden = !del; form.querySelector('.deliv-row').hidden = !del; $('#grand').textContent = money(items + (del ? farm.delivery_fee_cents : 0), farm.currency); };
    form.querySelectorAll('input[name=how]').forEach((r) => r.addEventListener('change', sync)); sync();
    form.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { delete state.cart.lines[b.dataset.rm]; drawCart(); }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#coError'); err.textContent = '';
      if (!state.user) return openAuth('login', 'Sign in or create a free account to reserve.');
      const body = { farm_id: farm.id, fulfillment: how(), items: lines.map((l) => ({ listing_id: l.listing.id, qty: l.qty })), scheduled_for: $('#c-when').value, note: $('#c-note').value };
      if (how() === 'delivery') { body.delivery_address = $('#c-addr').value; if (state.place) { body.buyer_lat = state.place.lat; body.buyer_lng = state.place.lng; } }
      try {
        const r = await api('/orders', { method: 'POST', body });
        state.cart.lines = {};
        box.innerHTML = `<div class="success"><strong>Order reserved. Total ${money(r.total_cents, farm.currency)}.</strong><span>${esc(r.payment_note)} Track it under <a href="/orders" data-link>My orders</a>.</span></div>`;
        const { listings } = await api('/farms/' + farm.id); state.cart.listings = listings; const keep = box.innerHTML; drawItems(); box.innerHTML = keep;
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  // ---------- buyer: orders, bookings, CSA, events ----------
  async function renderOrders() {
    if (!state.user) { view.innerHTML = '<div class="wrap page"><h1>My orders</h1><p class="empty">Sign in to see your orders.</p></div>'; return openAuth('login'); }
    if (state.mode !== 'visitor') { setMode('visitor'); renderChrome(); }
    loading('My orders');
    const [{ orders }, { bookings }, { signups }, { rsvps }, { groups: hosting }] = await Promise.all([api('/orders/mine'), api('/bookings/mine'), api('/csa-signups/mine'), api('/rsvps/mine'), api('/groups-hosting')]);
    view.innerHTML = `<div class="wrap page"><h1>My orders</h1>
      ${hosting.length ? `<section><h2 style="margin-bottom:.6rem">Group orders you're hosting</h2><div class="rows">${hosting.map(groupRow).join('')}</div></section>` : ''}
      <section><h2 style="margin-bottom:.6rem">Produce orders</h2>${orders.length ? `<div class="rows">${orders.map(buyerOrder).join('')}</div>` : `<p class="empty">No orders yet. <a href="${base()}/products" data-link>Shop local</a>.</p>`}</section>
      <section><h2 style="margin-bottom:.6rem">CSA memberships</h2>${signups.length ? `<div class="rows">${signups.map((s) => `<article class="order"><div class="item-row" style="border:0;padding:0"><div><h3>${esc(s.title)}</h3><div class="meta">${esc(s.farm_name)}${s.season ? ` · ${esc(s.season)}` : ''}${s.pickup ? ` · Pickup: ${esc(s.pickup)}` : ''}</div></div><span class="status ${esc(s.status)}">${esc(kindLabel(s.status === 'requested' ? 'waiting for farm' : s.status))}</span></div>
        <p><strong>${money(s.price_cents, s.currency)} ${esc(CSA_PER[s.per])}</strong>, paid to the farm. ${esc(s.payment_note)}</p>
        ${['requested', 'confirmed'].includes(s.status) ? `<div class="btn-group"><button class="btn small danger" data-csacancel="${s.id}">Cancel membership</button></div>` : ''}</article>`).join('')}</div>` : `<p class="empty">No CSA shares yet. <a href="${base()}/csa" data-link>Find a CSA</a>.</p>`}</section>
      <section><h2 style="margin-bottom:.6rem">Farm visits</h2>${bookings.length ? `<div class="rows">${bookings.map(guestBooking).join('')}</div>` : `<p class="empty">No bookings yet. <a href="${base()}/experiences" data-link>Find farm visits: riding, farm days, classes and tours</a>.</p>`}</section>
      <section><h2 style="margin-bottom:.6rem">Events</h2>${rsvps.length ? `<div class="rows">${rsvps.map((r) => `<article class="order"><div class="item-row" style="border:0;padding:0"><div><h3>${esc(r.title)}</h3><div class="meta">${esc(r.farm_name)} · ${new Date(r.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${r.start_time ? `, ${fmtTime(r.start_time)}` : ''} · ${r.people} ${r.people === 1 ? 'person' : 'people'}</div></div><span class="status ${esc(r.status)}">${r.status === 'going' ? 'Going' : 'Cancelled'}</span></div>
        <p>${gmLink(gmDir(r.address || `${r.lat},${r.lng}`), 'Directions')}</p>${r.status === 'going' ? `<div class="btn-group"><button class="btn small danger" data-rsvpcancel="${r.id}">Cancel RSVP</button></div>` : ''}</article>`).join('')}</div>` : `<p class="empty">No events yet. <a href="${base()}/events" data-link>See what's on</a>.</p>`}</section></div>`;
    const act = async (fn, msg) => { try { await fn(); toast(msg); renderOrders(); } catch (e) { toast(e.message, true); } };
    view.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => confirm('Cancel this order? The produce goes back on sale.') && act(() => api(`/orders/${b.dataset.cancel}/status`, { method: 'PATCH', body: { status: 'cancelled' } }), 'Order cancelled.')));
    view.querySelectorAll('[data-bcancel]').forEach((b) => b.addEventListener('click', () => confirm('Cancel this booking?') && act(() => api(`/bookings/${b.dataset.bcancel}/status`, { method: 'PATCH', body: { status: 'cancelled' } }), 'Booking cancelled.')));
    view.querySelectorAll('[data-csacancel]').forEach((b) => b.addEventListener('click', () => confirm('Cancel this CSA membership?') && act(() => api(`/csa-signups/${b.dataset.csacancel}/status`, { method: 'PATCH', body: { status: 'cancelled' } }), 'Membership cancelled.')));
    view.querySelectorAll('[data-rsvpcancel]').forEach((b) => b.addEventListener('click', () => act(() => api(`/rsvps/${b.dataset.rsvpcancel}/cancel`, { method: 'PATCH' }), 'RSVP cancelled.')));
  }

  // ---------- farm updates feed ----------
  async function renderFeed() {
    loading('Farm updates');
    const q = new URLSearchParams(state.place ? { lat: state.place.lat, lng: state.place.lng, radius: 100 } : {});
    const { posts } = await api('/feed?' + q);
    view.innerHTML = `<div class="wrap page" style="max-width:780px"><h1>Farm updates</h1>
      <p class="muted">Photos, videos and news from farms ${state.place ? `within ${radText(100)} of ${esc(state.place.label)}` : 'everywhere'}.</p>
      ${posts.length ? posts.map((p) => postHtml(p, { farm: { id: p.farm_id, name: p.farm_name, kind: p.farm_kind, city: p.farm_city, distance_miles: p.distance_miles } })).join('')
        : '<p class="empty">No updates yet. Farmers post them from their dashboard.</p>'}</div>`;
  }
  function openFarm(id) { navigate('/farm/' + id); }
  document.addEventListener('click', (e) => { const b = e.target.closest('button.linkish[data-farm]'); if (b) openFarm(Number(b.dataset.farm)); });

  // ---------- farm owner dashboard ----------
  const DTABS = [['overview', 'Overview'], ['orders', 'Orders'], ['groups', 'Group orders'], ['bookings', 'Bookings'], ['csa', 'CSA'], ['events', 'Events'], ['products', 'Products'],
    ['experiences', 'Farm visits'], ['updates', 'Photos and updates'], ['details', 'Listing details']];
  async function renderFarmDashboard() {
    if (!state.user) { view.innerHTML = '<div class="wrap page"><h1>List your farm, market or stand</h1><p class="empty">Create a free farm account to get started.</p></div>'; return openAuth('register', 'Create a free account to list your farm, market or stand.', 'farmer'); }
    if (state.mode !== 'owner') { setMode('owner'); renderChrome(); }
    loading('My farm');
    try {
      const { farms } = await api('/my/farms');
      const farm = farms[0] || null;
      state.mine = farm ? farm.id : null;
      if (!farm) {
        view.innerHTML = `<div class="wrap page"><h1>List your farm, market or stand</h1>
          <p class="muted" style="max-width:65ch">Farms, barns, orchards, ranches, market gardens, farmers' markets, farm stands, farm-to-table restaurants and co-op groceries can all list here, anywhere in the world. It's free.</p>${farmFormCard(null)}</div>`;
        bindFarmForm(null); return;
      }
      const [{ orders }, { bookings }, { signups }, { rsvps }, { posts }, { groups }] = await Promise.all([api('/farm-orders'), api('/farm-bookings'), api('/farm-csa-signups'), api('/farm-rsvps'), api(`/farms/${farm.id}/posts`), api('/farm-groups')]);
      const n = { groups: groups.filter((g) => ['open', 'confirmed'].includes(g.status)).length, orders: orders.filter((o) => ['reserved', 'ready'].includes(o.status)).length, bookings: bookings.filter((b) => b.status === 'requested').length, csa: signups.filter((s) => s.status === 'requested').length };
      const tab = DTABS.some(([k]) => k === state.dtab) ? state.dtab : 'overview';
      const body = {
        overview: () => overviewHtml(farm, n, posts, orders, bookings, signups, rsvps),
        orders: () => incomingOrders(orders), groups: () => groupsCard(farm, groups),
        bookings: () => bookingsCard(bookings, farm) || '<section class="card"><h2>Booking requests</h2><p class="empty">No bookings yet. Add farm days, classes or u-pick under Farm days.</p></section>',
        csa: () => csaCard(farm, signups), events: () => eventsCard(farm, rsvps), products: () => listingsCard(farm), experiences: () => expsCard(farm),
        updates: () => postsCard(farm, posts), details: () => farmFormCard(farm),
      }[tab]();
      view.innerHTML = `<div class="wrap page">
        <div class="dash-hd"><div><h1>${esc(farm.name)}</h1><p class="muted">${esc(kindName(farm.kind))} in ${esc(farm.place_label || farm.city)}</p></div>
          <a class="btn secondary" href="/farm/${farm.id}" data-link>View my public page</a></div>
        <div class="otabs" role="tablist">${DTABS.map(([k, t]) => `<button role="tab" type="button" data-dtab="${k}" aria-selected="${k === tab}">${esc(t)}${n[k] ? `<span class="n">${n[k]}</span>` : ''}</button>`).join('')}</div>
        ${body}</div>`;
      view.querySelectorAll('[data-dtab]').forEach((b) => b.addEventListener('click', () => { state.dtab = b.dataset.dtab; renderFarmDashboard(); }));
      ({ orders: bindOrderButtons, groups: () => bindGroups(farm, groups), bookings: bindBookings, csa: () => bindCsa(farm), events: () => bindEvents(farm), products: () => bindListings(farm),
        experiences: () => bindExps(farm), updates: () => bindPosts(farm, posts), details: () => bindFarmForm(farm) }[tab] || (() => {}))();
    } catch (e) { toast(e.message, true); }
  }
  function overviewHtml(farm, n, posts, orders, bookings, signups, rsvps) {
    const upcoming = (farm.events || []).filter((e) => e.date >= new Date().toLocaleDateString('en-CA')).length;
    const tile = (num, label, k, hot) => `<button type="button" class="tile${hot ? ' hot' : ''}" data-dtab="${k}"><b>${num}</b><span>${esc(label)}</span></button>`;
    const steps = [[!!farm.cover_url, 'Add a photo of your farm', 'updates'], [!!farm.description, 'Describe your farm', 'details'],
      [farm.listings.length > 0, 'List products for sale', 'products'], [(farm.csa || []).length > 0, 'Offer CSA shares (optional)', 'csa'],
      [(farm.experiences || []).length > 0, 'Offer farm visits: riding, farm days, classes, tours or u-pick (optional)', 'experiences'],
      [!!farm.group_orders, 'Take group orders from neighborhoods (optional)', 'groups'], [upcoming > 0, 'Post an event (optional)', 'events'], [posts.length > 0, 'Share a photo update', 'updates']];
    return `<div class="tiles">${tile(n.orders, 'open orders', 'orders', n.orders)}${tile(n.groups, 'active group orders', 'groups')}${tile(n.bookings, 'bookings to confirm', 'bookings', n.bookings)}${tile(n.csa, 'CSA requests', 'csa', n.csa)}
      ${tile(signups.filter((s) => s.status === 'confirmed').length, 'CSA members', 'csa')}${tile(upcoming, 'upcoming events', 'events')}${tile(farm.listings.length, 'products listed', 'products')}</div>
      <section class="card"><h2>Get your listing ready</h2><ul class="steps">${steps.map(([done, label, k]) => `<li class="${done ? 'done' : ''}"><span><span class="tick" aria-hidden="true">${done ? '✓' : ''}</span>${esc(label)}</span>
        <button class="btn small ${done ? 'secondary' : ''}" type="button" data-dtab="${k}">${done ? 'Review' : 'Start'}</button></li>`).join('')}</ul></section>`;
  }

  // CSA shares (owner)
  let editShare = null;
  function csaCard(farm, signups) {
    const list = farm.csa || [], s = editShare ? list.find((x) => x.id === editShare) : null;
    const v = s || { name: '', about: '', price_cents: '', per: 'week', season: '', pickup: '', spots: 20 };
    const row = (x) => `<article class="order"><div class="item-row" style="border:0;padding:0"><div><h3>${esc(x.title)}</h3><div class="meta">${esc(x.buyer_name)} · Contact: ${esc(x.contact)}${x.note ? ` · Note: ${esc(x.note)}` : ''}</div></div>
      <span class="status ${esc(x.status)}">${esc(kindLabel(x.status))}</span></div>
      ${x.status === 'requested' ? `<div class="btn-group"><button class="btn small" data-csast="confirmed" data-s="${x.id}">Confirm</button><button class="btn small danger" data-csast="declined" data-s="${x.id}">Decline</button></div>`
        : x.status === 'confirmed' ? `<div class="btn-group"><button class="btn small danger" data-csast="cancelled" data-s="${x.id}">End membership</button></div>` : ''}</article>`;
    return `<section class="card"><h2>CSA members</h2>${signups.length ? `<div class="rows">${signups.map(row).join('')}</div>` : '<p class="empty">No sign-ups yet. Once you offer a share, members can request a spot.</p>'}</section>
      <section class="card"><h2>${s ? 'Edit share' : 'Offer a CSA share'}</h2>
      <form id="csaForm" novalidate>
        <div class="row"><div class="field"><label for="c-name">Name</label><input id="c-name" type="text" value="${esc(v.name)}" placeholder="Full vegetable share"></div>
          <div class="field"><label for="c-price">Price (${esc(farm.currency)})</label><input id="c-price" type="number" min="0" step="0.5" value="${v.price_cents === '' ? '' : (v.price_cents / 100).toFixed(2)}"></div>
          <div class="field"><label for="c-per">Charged</label><select id="c-per">${Object.entries(CSA_PER).map(([k, t]) => `<option value="${k}" ${v.per === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="field"><label for="c-spots">Members you can take</label><input id="c-spots" type="number" min="1" value="${esc(v.spots)}"></div></div>
        <div class="field"><label for="c-about">What's in a share</label><textarea id="c-about" placeholder="8 to 10 seasonal vegetables each week">${esc(v.about)}</textarea></div>
        <div class="row"><div class="field"><label for="c-season">Season</label><input id="c-season" type="text" value="${esc(v.season)}" placeholder="March to November"></div>
          <div class="field"><label for="c-pickup">Pickup</label><input id="c-pickup" type="text" value="${esc(v.pickup)}" placeholder="Saturdays at the farm stand"></div></div>
        <p class="error" id="cErr" role="alert"></p>
        <div class="btn-group"><button class="btn" type="submit">${s ? 'Save changes' : 'Offer this share'}</button>${s ? '<button class="btn secondary" type="button" id="c-cancel">Cancel edit</button>' : ''}</div></form>
      ${list.length ? `<h3 style="margin:1.2rem 0 .6rem">Your shares</h3><div class="rows">${list.map((x) => `<div class="item-row"><div><strong>${esc(x.name)}</strong> ${money(x.price_cents, farm.currency)} ${esc(CSA_PER[x.per])}
        <div class="meta">${x.spots_left} of ${x.spots} spots left${x.active ? '' : ' (paused, hidden)'}</div></div>
        <div class="btn-group"><button class="btn small secondary" data-sedit="${x.id}">Edit</button><button class="btn small secondary" data-spause="${x.id}" data-on="${x.active ? 0 : 1}">${x.active ? 'Pause' : 'Resume'}</button>
        <button class="btn small danger" data-sdel="${x.id}">Remove</button></div></div>`).join('')}</div>` : ''}</section>`;
  }
  function bindCsa(farm) {
    const act = async (fn, msg) => { try { await fn(); toast(msg); renderFarmDashboard(); } catch (e) { toast(e.message, true); } };
    view.querySelectorAll('[data-csast]').forEach((b) => b.addEventListener('click', () => act(() => api(`/csa-signups/${b.dataset.s}/status`, { method: 'PATCH', body: { status: b.dataset.csast } }), 'Membership updated.')));
    view.querySelectorAll('[data-sedit]').forEach((b) => b.addEventListener('click', () => { editShare = Number(b.dataset.sedit); renderFarmDashboard(); }));
    view.querySelectorAll('[data-spause]').forEach((b) => b.addEventListener('click', () => act(() => api(`/csa/${b.dataset.spause}/active`, { method: 'PATCH', body: { active: b.dataset.on === '1' } }), 'Share updated.')));
    view.querySelectorAll('[data-sdel]').forEach((b) => b.addEventListener('click', () => confirm('Remove this share? Existing members stay on your list.') && act(() => api('/csa/' + b.dataset.sdel, { method: 'DELETE' }), 'Share removed.')));
    $('#c-cancel')?.addEventListener('click', () => { editShare = null; renderFarmDashboard(); });
    $('#csaForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { name: $('#c-name').value, price: $('#c-price').value || 0, per: $('#c-per').value, spots: $('#c-spots').value, about: $('#c-about').value, season: $('#c-season').value, pickup: $('#c-pickup').value };
      try { await api(editShare ? '/csa/' + editShare : `/farms/${farm.id}/csa`, { method: editShare ? 'PUT' : 'POST', body }); toast(editShare ? 'Share saved.' : 'Share offered. Members can sign up now.'); editShare = null; renderFarmDashboard(); }
      catch (ex) { $('#cErr').textContent = ex.message; }
    });
  }

  // Events (owner)
  let editEvent = null;
  function eventsCard(farm, rsvps) {
    const list = farm.events || [], ev = editEvent ? list.find((x) => x.id === editEvent) : null, today = new Date().toLocaleDateString('en-CA');
    const v = ev || { title: '', about: '', date: '', start_time: '', end_time: '', location: farm.name, price_cents: 0, capacity: 0 };
    const upcoming = list.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
    return `<section class="card"><h2>${ev ? 'Edit event' : 'Post an event'}</h2>
      <p class="hint" style="margin-bottom:.7rem">Market days, harvest festivals, workshops, open farm days. Events show on your page, on your town's page and under Events.</p>
      <form id="evForm" novalidate>
        <div class="field"><label for="e-title">Event name</label><input id="e-title" type="text" value="${esc(v.title)}" placeholder="Fall harvest festival"></div>
        <div class="row"><div class="field"><label for="e-date">Date</label><input id="e-date" type="date" min="${today}" value="${esc(v.date)}"></div>
          <div class="field"><label for="e-start">Starts</label><input id="e-start" type="time" value="${esc(v.start_time)}"></div>
          <div class="field"><label for="e-end">Ends</label><input id="e-end" type="time" value="${esc(v.end_time)}"></div></div>
        <div class="row"><div class="field"><label for="e-loc">Where</label><input id="e-loc" type="text" value="${esc(v.location)}"></div>
          <div class="field"><label for="e-price">Price (${esc(farm.currency)}) <span class="hint">0 for free</span></label><input id="e-price" type="number" min="0" step="0.5" value="${(v.price_cents / 100).toFixed(2)}"></div>
          <div class="field"><label for="e-cap">Capacity <span class="hint">0 for no limit</span></label><input id="e-cap" type="number" min="0" value="${esc(v.capacity)}"></div></div>
        <div class="field"><label for="e-about">What's happening</label><textarea id="e-about">${esc(v.about)}</textarea></div>
        <p class="error" id="eErr2" role="alert"></p>
        <div class="btn-group"><button class="btn" type="submit">${ev ? 'Save changes' : 'Post event'}</button>${ev ? '<button class="btn secondary" type="button" id="ev-cancel">Cancel edit</button>' : ''}</div></form></section>
      <section class="card"><h2>Upcoming events</h2>${upcoming.length ? `<div class="rows">${upcoming.map((e) => {
        const rs = rsvps.filter((r) => r.event_id === e.id && r.status === 'going');
        return `<div class="item-row"><div><strong>${esc(e.title)}</strong><div class="meta">${new Date(e.date + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}${e.start_time ? `, ${fmtTime(e.start_time)}` : ''} · ${e.going} going${e.capacity ? ` of ${e.capacity}` : ''}</div>
          ${rs.length ? `<div class="meta">${rs.map((r) => `${esc(r.buyer_name)} (${r.people})${r.contact ? `, ${esc(r.contact)}` : ''}`).join('; ')}</div>` : ''}</div>
          <div class="btn-group"><button class="btn small secondary" data-eedit2="${e.id}">Edit</button><button class="btn small danger" data-edel2="${e.id}">Cancel event</button></div></div>`; }).join('')}</div>` : '<p class="empty">No upcoming events.</p>'}</section>`;
  }
  function bindEvents(farm) {
    view.querySelectorAll('[data-eedit2]').forEach((b) => b.addEventListener('click', () => { editEvent = Number(b.dataset.eedit2); renderFarmDashboard(); }));
    view.querySelectorAll('[data-edel2]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Cancel this event? It disappears from the site.')) return;
      try { await api('/events/' + b.dataset.edel2, { method: 'DELETE' }); toast('Event cancelled.'); renderFarmDashboard(); } catch (e) { toast(e.message, true); }
    }));
    $('#ev-cancel')?.addEventListener('click', () => { editEvent = null; renderFarmDashboard(); });
    $('#evForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { title: $('#e-title').value, date: $('#e-date').value, start_time: $('#e-start').value, end_time: $('#e-end').value, location: $('#e-loc').value, price: $('#e-price').value || 0, capacity: $('#e-cap').value || 0, about: $('#e-about').value };
      try { await api(editEvent ? '/events/' + editEvent : `/farms/${farm.id}/events`, { method: editEvent ? 'PUT' : 'POST', body }); toast(editEvent ? 'Event saved.' : 'Event posted.'); editEvent = null; renderFarmDashboard(); }
      catch (ex) { $('#eErr2').textContent = ex.message; }
    });
  }

  // ---------- group orders: neighbors order together, the farm makes one delivery ----------
  const G_STATUS = { open: 'Open for orders', confirmed: 'Confirmed by the farm', delivered: 'Delivered', cancelled: 'Cancelled' };
  const groupBody = (f) => ({ group_orders: !!f.group_orders, group_min: (f.group_min_cents || 0) / 100, group_discount_pct: f.group_discount_pct || 0,
    group_discount_over: (f.group_discount_over_cents || 0) / 100, group_radius_miles: f.group_radius_miles || 25 });
  const farmBody = (f) => ({ name: f.name, kind: f.kind, description: f.description, address: f.address, city: f.city, phone: f.phone, lat: f.lat, lng: f.lng,
    pickup_enabled: f.pickup_enabled, pickup_instructions: f.pickup_instructions, delivery_enabled: f.delivery_enabled, delivery_radius_miles: f.delivery_radius_miles,
    delivery_fee: (f.delivery_fee_cents || 0) / 100, payment_note: f.payment_note, currency: f.currency, hours: f.hours, website: f.website,
    accepts_snap: f.accepts_snap, wholesale: f.wholesale, ...groupBody(f) });
  function groupTerms(f) {
    const cur = f.currency, bits = [];
    if (f.group_min_cents) bits.push(`The group needs at least ${money(f.group_min_cents, cur)} in orders in total`);
    if (f.group_discount_pct) bits.push(`everyone gets ${f.group_discount_pct}% off when the group passes ${money(f.group_discount_over_cents, cur)}`);
    if (f.group_radius_miles) bits.push(`drop-offs within ${radText(f.group_radius_miles)} of the farm`);
    return bits.length ? esc(bits.join('; ').replace(/^./, (c) => c.toUpperCase()) + '.') : '';
  }
  function groupProgress(g) {
    const cur = g.currency, t = g.total_cents, min = g.min_cents, over = g.discount_pct ? g.discount_over_cents : 0;
    const goal = Math.max(min, over) || 0;
    let label;
    if (g.status === 'confirmed' || g.status === 'delivered') label = g.applied_discount_pct ? `${money(t, cur)} ordered · ${g.applied_discount_pct}% group discount applied` : `${money(t, cur)} ordered`;
    else if (min && t < min) label = `${money(t, cur)} of the ${money(min, cur)} minimum`;
    else if (over && t < over) label = `${money(t, cur)} ordered · ${money(over - t, cur)} more unlocks ${g.discount_pct}% off for everyone`;
    else if (over) label = `${money(t, cur)} ordered · ${g.discount_pct}% off unlocked`;
    else label = `${money(t, cur)} ordered${min ? ' · minimum reached' : ''}`;
    const pct = goal ? Math.min(100, Math.round((t / goal) * 100)) : 100;
    const minAt = goal && min && over > min ? Math.round((min / goal) * 100) : null;
    return `<div class="gprog"><div class="bar" role="img" aria-label="${esc(label)}"><i style="width:${pct}%"></i>${minAt ? `<s style="left:${minAt}%" title="Minimum"></s>` : ''}</div><span class="meta">${esc(label)}</span></div>`;
  }
  function groupRow(g) {
    return `<a class="grow" href="/group/${g.id}" data-link><div class="gtop"><div><b>${esc(g.farm_name)}</b> to <b>${esc(g.dropoff_name)}</b>
      <div class="meta">Delivery ${niceDate(g.deliver_date)} · order by ${niceDate(g.deadline)} · ${g.households} ${g.households === 1 ? 'household' : 'households'} · hosted by ${esc(g.host_kind === 'farm' ? 'the farm' : g.host_name)}${g.distance_miles != null ? ` · ${dist(g.distance_miles)} away` : ''}</div></div>
      <span class="status ${esc(g.status)}">${esc(g.open || g.status !== 'open' ? G_STATUS[g.status] : 'Closed')}</span></div>${groupProgress(g)}</a>`;
  }

  async function renderGroups() {
    const where = state.place && location.pathname.split('/')[1] !== 'all' ? state.place : null;
    loading('Group orders');
    const qs = where ? `lat=${where.lat}&lng=${where.lng}&radius=${state.radius || 50}` : '';
    const [{ groups }, { farms }] = await Promise.all([api('/groups?' + qs), api('/farms?type=groups&' + qs)]);
    view.innerHTML = `<div class="wrap page"><h1>Group orders ${where ? `near ${esc(where.label)}` : ''}</h1>
      <section class="card gexplain"><h2>Order together, get it in one delivery</h2>
        <ol class="gsteps"><li><b>Someone starts it.</b> A farm sets up a drop-off, or a neighbor starts one for their street, office, school or church.</li>
          <li><b>Everyone adds their own order</b> from that farm before the deadline, using the group's link.</li>
          <li><b>The farm confirms</b> once the minimum is reached. Big groups can unlock a discount for everyone.</li>
          <li><b>One trip, one stop.</b> The farm brings every order to the drop-off spot on delivery day. Each household pays the farm directly.</li></ol>
        <p class="hint">Fewer trips for the farmer, fresher food and lower prices for you. Nothing is charged online.</p></section>
      <section><h2 style="margin-bottom:.6rem">Open group orders</h2>${groups.length ? `<div class="rows">${groups.map(groupRow).join('')}</div>` : '<p class="empty">No open group orders here yet. Start one below.</p>'}</section>
      <section><h2 style="margin-bottom:.6rem">Farms that deliver group orders</h2>${farms.length ? `<div class="rows">${farms.map((f) => `<div class="card gfarm">${thumb(f)}<div>
          <h3><a href="/farm/${f.id}" data-link>${esc(f.name)}</a></h3><div class="meta">${badges(f)} ${esc(f.place_label || f.city)}${f.distance_miles != null ? ` · ${dist(f.distance_miles)}` : ''}</div>
          <p class="meta">${groupTerms(f)}</p>
          <div class="btn-group"><button class="btn small" type="button" data-start="${f.id}">Start a group order</button><a class="btn small secondary" href="/farm/${f.id}#groups" data-link>See the farm</a></div></div></div>`).join('')}</div>`
        : '<p class="empty">No farms here take group orders yet. Farm owners can turn them on under Group orders in their dashboard.</p>'}</section></div>`;
    view.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => openStartGroup(farms.find((f) => f.id === Number(b.dataset.start)))));
  }

  // Start a group order (a neighbor) or add a drop-off (the farm itself).
  function openStartGroup(farm, asFarm = false) {
    if (!state.user) return openAuth('login', 'Sign in or create a free account to start a group order.');
    const today = new Date().toLocaleDateString('en-CA');
    const plus = (n) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA');
    let spot = state.place && !asFarm ? { lat: state.place.lat, lng: state.place.lng, label: state.place.label } : { lat: farm.lat, lng: farm.lng, label: farm.place_label || farm.city };
    dlg.innerHTML = `<div class="dlg"><div class="dlg-head"><h2 id="dlgTitle">${asFarm ? 'Add a drop-off point' : `Start a group order from ${esc(farm.name)}`}</h2><button class="close" type="button" aria-label="Close" data-close>✕</button></div>
      <form id="gForm" novalidate>
        ${asFarm ? '' : `<p class="hint" style="margin-bottom:.7rem">${groupTerms(farm)} You'll get a link to share with neighbors. ${esc(farm.name)} gets an email and can cancel if it can't deliver.</p>`}
        <div class="field"><label for="g-name">Drop-off spot</label><input id="g-name" type="text" placeholder="${asFarm ? 'Celina library parking lot' : 'My driveway, Maple Ct'}"></div>
        <div class="row"><div class="field"><label for="g-addr">Street address <span class="hint">(optional)</span></label><input id="g-addr" type="text" autocomplete="street-address"></div>
          <div class="field" style="position:relative"><label for="g-town">Town</label><input id="g-town" type="text" value="${esc(spot.label)}"></div></div>
        <div class="row"><div class="field"><label for="g-dead">Orders close</label><input id="g-dead" type="date" min="${today}" value="${plus(5)}"></div>
          <div class="field"><label for="g-del">Delivery day</label><input id="g-del" type="date" min="${today}" value="${plus(7)}"></div></div>
        <div class="field"><label for="g-note">Note for the group <span class="hint">(optional)</span></label><input id="g-note" type="text" placeholder="Pickup 4 to 6pm, look for the green tent"></div>
        <p class="error" id="gErr" role="alert"></p>
        <div class="btn-group"><button class="btn" type="submit">${asFarm ? 'Add drop-off' : 'Start group order'}</button><button class="btn secondary" type="button" data-close>Cancel</button></div></form></div>`;
    dlg.showModal();
    $('#g-name', dlg).focus();
    bindPlaceSearch($('#g-town', dlg), (p) => { spot = { lat: p.lat, lng: p.lng, label: p.label }; $('#g-town', dlg).value = p.label; });
    $('#gForm', dlg).addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#gErr', dlg); err.textContent = '';
      let { lat, lng } = spot;
      const addr = $('#g-addr', dlg).value.trim();
      if (addr) { const hit = await geocode(`${addr}, ${$('#g-town', dlg).value}`); if (hit) ({ lat, lng } = hit); }
      try {
        const r = await api(`/farms/${farm.id}/groups`, { method: 'POST', body: { dropoff_name: $('#g-name', dlg).value, dropoff_address: addr, lat, lng,
          deadline: $('#g-dead', dlg).value, deliver_date: $('#g-del', dlg).value, note: $('#g-note', dlg).value } });
        dlg.close();
        if (asFarm) { toast('Drop-off added. Buyers nearby can join it now.'); renderFarmDashboard(); }
        else { toast('Group order started. Share the link with your neighbors.'); navigate('/group/' + r.id); }
      } catch (ex) { err.textContent = ex.message; }
    });
  }

  async function renderGroup(id) {
    loading('Group order');
    let d;
    try { d = await api('/groups/' + id); } catch { return notFound('That group order was removed or never existed.'); }
    const g = d.group, f = d.farm, role = d.role || null;
    const mine = (d.orders || []).filter((o) => state.user && o.buyer_id === state.user.id);
    const canOrder = g.open && role !== 'farm';
    const disc = g.applied_discount_pct;
    const orderBox = (o, showWho) => {
      const total = o.items_total_cents, pay = disc ? Math.round(total * (1 - disc / 100)) : total;
      return `<article class="order"><div class="item-row" style="border:0;padding:0"><div><h3>${showWho ? esc(o.buyer_name) : 'Your order'}</h3><div class="meta">${when(o.created_at)}</div></div>
        <span class="status ${esc(o.status)}">${esc(o.status === 'ready' ? 'Confirmed' : kindLabel(o.status))}</span></div>${orderLines(o)}
        <p><strong>${money(pay, f.currency)}</strong>${disc ? ` <span class="meta">(${money(total, f.currency)} less ${disc}% group discount)</span>` : ''}</p>
        ${o.note ? `<p class="meta">Note: ${esc(o.note)}</p>` : ''}
        ${!showWho && ['reserved', 'ready'].includes(o.status) && g.status === 'open' ? `<p style="margin-top:.4rem"><button class="btn small danger" data-gcancel="${o.id}">Cancel my order</button></p>` : ''}</article>`;
    };
    document.title = `Group order: ${f.name} to ${g.dropoff_name} | FarmDirect`;
    view.innerHTML = `<div class="wrap page">
      <p><a href="/farm/${f.id}" data-link>‹ ${esc(f.name)}</a></p>
      <section class="card ghd"><div class="sec-hd" style="align-items:flex-start"><div><span class="badge">Group order</span>
          <h1 style="margin-top:.3rem">${esc(f.name)} to ${esc(g.dropoff_name)}</h1></div>
          <span class="status ${esc(g.status)}">${esc(g.open || g.status !== 'open' ? G_STATUS[g.status] : 'Closed to new orders')}</span></div>
        <dl class="gfacts"><div><dt>Delivery</dt><dd>${niceDate(g.deliver_date)}</dd></div><div><dt>Orders close</dt><dd>${niceDate(g.deadline)}</dd></div>
          <div><dt>Drop-off</dt><dd>${esc(g.dropoff_name)}${g.dropoff_address ? `, ${esc(g.dropoff_address)}` : ''}${g.place_label ? `<br><span class="meta">${esc(g.place_label)}</span>` : ''}</dd></div>
          <div><dt>Hosted by</dt><dd>${g.host_kind === 'farm' ? esc(f.name) : `${esc(g.host_name)}, a neighbor`}</dd></div></dl>
        ${groupProgress(g)}
        <p class="meta" style="margin-top:.5rem">${g.households} ${g.households === 1 ? 'household has' : 'households have'} joined. ${groupTerms(f)} Each household pays ${esc(f.name)} directly: ${esc(f.payment_note)}</p>
        ${g.note ? `<p style="margin-top:.4rem"><strong>Note:</strong> ${esc(g.note)}</p>` : ''}
        <div class="btn-group" style="margin-top:.7rem"><button class="btn small" type="button" id="gShare">Copy link to share</button>${gmLink(gmDir(g.dropoff_address ? `${g.dropoff_address}, ${g.place_label}` : `${g.lat},${g.lng}`), 'Directions to the drop-off')}
          ${role === 'host' && g.status === 'open' ? '<button class="btn small danger" type="button" id="gHostCancel">Cancel this group order</button>' : ''}
          ${role === 'farm' ? '<a class="btn small secondary" href="/dashboard" data-link id="gDash">Manage in my dashboard</a>' : ''}</div></section>
      <div class="lp-grid"><div class="page" style="gap:1.25rem">
        ${canOrder ? `<section class="card"><h2>${mine.length ? 'Add more to your order' : 'Add your order'}</h2><div class="rows" id="g-items"></div><div id="g-cart" style="margin-top:.8rem"></div></section>`
          : role === 'farm' ? '<div class="notice">This is your group order. Buyers add their orders here; you see the picking list in your dashboard.</div>'
          : `<div class="notice">This group order is ${g.status === 'open' ? 'closed to new orders' : G_STATUS[g.status].toLowerCase()}. ${f.group_orders ? `<a href="/farm/${f.id}#groups" data-link>See other group orders from ${esc(f.name)}</a>.` : ''}</div>`}
        ${(d.orders || []).length ? `<section class="card"><h2>${role === 'member' ? 'Your order' : 'Orders in this group'}</h2><div class="rows">${d.orders.map((o) => orderBox(o, role !== 'member' && o.buyer_id !== state.user.id)).join('')}</div></section>` : ''}
      </div><aside class="lp-side"><section class="card"><h2>Where</h2><div id="gMap" class="minimap" role="region" aria-label="Map of the drop-off and the farm"></div>
        <p class="meta" style="margin-top:.5rem">${esc(f.name)} is about ${dist(milesBetween(g.lat, g.lng, f.lat, f.lng))} from the drop-off.</p></section></aside></div></div>`;
    const map = Maps.create($('#gMap'), g.lat, g.lng, 11); state.maps.push(map);
    map.addPin(g.lat, g.lng, { title: g.dropoff_name, kind: 'other' }); map.addPin(f.lat, f.lng, { title: f.name, kind: f.kind });
    map.fit([[g.lat, g.lng], [f.lat, f.lng]]);
    $('#gShare').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.origin + '/group/' + g.id); toast('Link copied. Send it to your neighbors.'); } catch { toast('Copy this link: ' + location.origin + '/group/' + g.id); } });
    $('#gDash')?.addEventListener('click', () => { state.dtab = 'groups'; });
    $('#gHostCancel')?.addEventListener('click', async () => {
      if (!confirm('Cancel this group order? Everyone who joined is told and their items go back on sale.')) return;
      try { await api(`/groups/${g.id}/status`, { method: 'POST', body: { status: 'cancelled' } }); toast('Group order cancelled.'); renderGroup(g.id); } catch (e) { toast(e.message, true); }
    });
    view.querySelectorAll('[data-gcancel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Cancel your order in this group?')) return;
      try { await api(`/orders/${b.dataset.gcancel}/status`, { method: 'PATCH', body: { status: 'cancelled' } }); toast('Order cancelled.'); renderGroup(g.id); } catch (e) { toast(e.message, true); }
    }));
    if (canOrder) drawGroupItems(g, f, d.listings, {});
  }
  function drawGroupItems(g, f, listings, lines) {
    $('#g-items').innerHTML = listings.length ? listings.map((l) => `<div class="item"><div><strong>${esc(l.name)}</strong> <span class="badge">${esc(catName(l.category))}</span>
        <div class="meta">${[harvestLabel(l.harvest_date), `${qtyText(l.qty_available)} ${esc(l.unit)} left`].filter(Boolean).join(', ')}</div></div>
      <div class="buy"><span class="price">${money(l.price_cents, f.currency)}/${esc(l.unit)}</span><label class="sr" for="gq-${l.id}">Quantity of ${esc(l.name)}</label>
        <input id="gq-${l.id}" type="number" min="${stepFor(l.unit)}" step="${stepFor(l.unit)}" value="1" inputmode="decimal"><button class="btn small" type="button" data-gadd="${l.id}">Add</button></div></div>`).join('')
      : '<p class="empty">Nothing is for sale right now. Check back before the deadline.</p>';
    const drawCartBox = () => {
      const ls = Object.values(lines), sum = ls.reduce((s, x) => s + Math.round(x.l.price_cents * x.qty), 0), box = $('#g-cart');
      if (!ls.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<form class="cart" id="gCheckout" novalidate><h3>Your part of the group order</h3><table>${ls.map((x) => `<tr><td>${esc(x.l.name)}, ${qtyText(x.qty)} ${esc(x.l.unit)}</td>
        <td class="r">${money(Math.round(x.l.price_cents * x.qty), f.currency)} <button class="btn small danger" type="button" data-grm="${x.l.id}" aria-label="Remove ${esc(x.l.name)}">Remove</button></td></tr>`).join('')}
        <tr class="total"><td>Your total${g.discount_pct ? ` (before any group discount)` : ''}</td><td class="r">${money(sum, f.currency)}</td></tr></table>
        <div class="field"><label for="g-onote">Note for the farm <span class="hint">(optional)</span></label><input id="g-onote" type="text" placeholder="Apartment 4B, I'll pick up after 5"></div>
        <p class="error" id="gcErr" role="alert"></p>
        <div class="btn-group"><button class="btn" type="submit">Join the group order</button><span class="hint">Delivered to ${esc(g.dropoff_name)} on ${niceDate(g.deliver_date)}. Pay ${esc(f.name)} at the drop-off.</span></div></form>`;
      box.querySelectorAll('[data-grm]').forEach((b) => b.addEventListener('click', () => { delete lines[b.dataset.grm]; drawCartBox(); }));
      $('#gCheckout').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!state.user) return openAuth('login', 'Sign in or create a free account to join this group order.');
        try {
          await api('/orders', { method: 'POST', body: { farm_id: f.id, group_id: g.id, items: ls.map((x) => ({ listing_id: x.l.id, qty: x.qty })), note: $('#g-onote').value } });
          toast("You're in. We'll email you when the farm confirms."); renderGroup(g.id);
        } catch (ex) { $('#gcErr').textContent = ex.message; }
      });
    };
    view.querySelectorAll('[data-gadd]').forEach((b) => b.addEventListener('click', () => {
      const l = listings.find((x) => x.id === Number(b.dataset.gadd)), qty = Number($('#gq-' + l.id).value), had = lines[l.id]?.qty || 0;
      if (!(qty > 0)) return toast('Enter how much you want.', true);
      if (had + qty > l.qty_available) return toast(`Only ${qtyText(l.qty_available)} ${l.unit} available.`, true);
      lines[l.id] = { l, qty: had + qty }; drawCartBox(); toast(`Added ${qtyText(qty)} ${l.unit} of ${l.name}.`);
    }));
    drawCartBox();
  }

  // Group orders (owner dashboard)
  function groupsCard(farm, groups) {
    const cur = farm.currency;
    const card = (g) => {
      const live = ['open', 'confirmed'].includes(g.status);
      return `<article class="order"><div class="item-row" style="border:0;padding:0"><div><h3>${esc(g.dropoff_name)}</h3>
        <div class="meta">Delivery ${niceDate(g.deliver_date)} · orders close ${niceDate(g.deadline)} · ${g.host_kind === 'farm' ? 'your drop-off' : `started by ${esc(g.host_name)}, a neighbor`} · ${g.households} ${g.households === 1 ? 'household' : 'households'}</div></div>
        <span class="status ${esc(g.status)}">${esc(G_STATUS[g.status])}</span></div>
        ${groupProgress(g)}
        ${g.orders.length ? `<details><summary>Picking list: ${g.picking.length} ${g.picking.length === 1 ? 'item' : 'items'}</summary><table class="pick">${g.picking.map((p) => `<tr><td>${esc(p.name)}</td><td class="r tnum">${qtyText(p.qty)} ${esc(p.unit)}</td></tr>`).join('')}</table></details>
        <details><summary>By household</summary>${g.orders.map((o) => `<div class="hh"><strong>${esc(o.buyer_name)}</strong> <span class="meta">${esc(o.buyer_email)}${o.note ? ` · ${esc(o.note)}` : ''}</span>
          <div class="meta">${o.items.map((i) => `${esc(i.name)} ${qtyText(i.qty)} ${esc(i.unit)}`).join(', ')} · ${money(o.items_total_cents, cur)}${g.applied_discount_pct ? `, pays ${money(Math.round(o.items_total_cents * (1 - g.applied_discount_pct / 100)), cur)}` : ''}</div></div>`).join('')}</details>` : '<p class="meta">No orders yet. Share the link: <a href="/group/' + g.id + '" data-link>/group/' + g.id + '</a></p>'}
        <div class="btn-group" style="margin-top:.5rem"><a class="btn small secondary" href="/group/${g.id}" data-link>Open group page</a>${gmLink(gmDir(g.dropoff_address ? `${g.dropoff_address}, ${g.place_label}` : `${g.lat},${g.lng}`), 'Directions')}
          ${g.status === 'open' ? `<button class="btn small" data-gst="confirmed" data-g="${g.id}">Confirm and close orders</button>` : ''}
          ${g.status === 'confirmed' ? `<button class="btn small" data-gst="delivered" data-g="${g.id}">Mark delivered</button>` : ''}
          ${live ? `<button class="btn small danger" data-gst="cancelled" data-g="${g.id}">Cancel</button>` : ''}</div></article>`;
    };
    const active = groups.filter((g) => ['open', 'confirmed'].includes(g.status)), past = groups.filter((g) => !['open', 'confirmed'].includes(g.status));
    return `<section class="card"><h2>Group orders</h2>
      <p class="hint" style="margin-bottom:.7rem">A street, office or school orders together by a deadline; you make one trip to one drop-off spot. You can add your own drop-offs, or let neighbors start them.</p>
      <form id="grpSet" novalidate>
        <label class="check"><input type="checkbox" id="gs-on" ${farm.group_orders ? 'checked' : ''}> Let neighbors start group orders for my farm</label>
        <div class="row"><div class="field"><label for="gs-min">Minimum per group (${esc(cur)}) <span class="hint">0 for none</span></label><input id="gs-min" type="number" min="0" step="1" value="${(farm.group_min_cents || 0) / 100}"></div>
          <div class="field"><label for="gs-pct">Bulk discount (%)</label><input id="gs-pct" type="number" min="0" max="50" step="1" value="${farm.group_discount_pct || 0}"></div>
          <div class="field"><label for="gs-over">when the group passes (${esc(cur)})</label><input id="gs-over" type="number" min="0" step="1" value="${(farm.group_discount_over_cents || 0) / 100}"></div>
          <div class="field"><label for="gs-rad">Deliver within (${uLong()})</label><input id="gs-rad" type="number" min="1" step="1" value="${Math.round(toU(farm.group_radius_miles || 25))}"></div></div>
        <p class="error" id="gsErr" role="alert"></p>
        <div class="btn-group"><button class="btn" type="submit">Save settings</button><button class="btn secondary" type="button" id="gNew">Add a drop-off point</button></div></form></section>
      <section class="card"><h2>Active</h2>${active.length ? `<div class="rows">${active.map(card).join('')}</div>` : '<p class="empty">No active group orders. Add a drop-off point, or turn on neighbor group orders above.</p>'}</section>
      ${past.length ? `<section class="card"><h2>Past</h2><div class="rows">${past.map(card).join('')}</div></section>` : ''}`;
  }
  function bindGroups(farm) {
    $('#gNew').addEventListener('click', () => openStartGroup(farm, true));
    $('#grpSet').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { ...farmBody(farm), group_orders: $('#gs-on').checked, group_min: $('#gs-min').value || 0, group_discount_pct: $('#gs-pct').value || 0,
        group_discount_over: $('#gs-over').value || 0, group_radius_miles: fromU(Number($('#gs-rad').value) || 25) };
      try { await api('/farms/' + farm.id, { method: 'PUT', body }); toast('Group order settings saved.'); renderFarmDashboard(); } catch (ex) { $('#gsErr').textContent = ex.message; }
    });
    view.querySelectorAll('[data-gst]').forEach((b) => b.addEventListener('click', async () => {
      const st = b.dataset.gst;
      const ask = { confirmed: 'Confirm this group order? It closes to new orders, and everyone gets an email that it is coming. Any bulk discount is locked in now.',
        delivered: 'Mark every order in this group delivered?', cancelled: 'Cancel this group order? Everyone is told and the produce goes back on sale.' }[st];
      if (!confirm(ask)) return;
      try { await api(`/groups/${b.dataset.g}/status`, { method: 'POST', body: { status: st } }); toast({ confirmed: 'Confirmed. Buyers were told.', delivered: 'Marked delivered.', cancelled: 'Group order cancelled.' }[st]); renderFarmDashboard(); }
      catch (ex) { toast(ex.message, true); }
    }));
  }

  // ---------- boot ----------
  async function boot() {
    await Maps.init();
    if (state.token) { try { state.user = (await api('/me')).user; } catch { state.token = null; } }
    if (state.user) { try { const { farms } = await api('/my/farms'); state.mine = farms[0]?.id || null; } catch { /* ignore */ } }
    route();
  }
  boot();
})();
