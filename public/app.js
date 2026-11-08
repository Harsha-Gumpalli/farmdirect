/* FarmDirect front end — vanilla JS, no build step. */
(() => {
  'use strict';

  // ---------- state ----------
  const DEFAULT_CENTER = { lat: 20, lng: 0 }; // whole world until the buyer sets a location
  let savedPlace = null;
  try { savedPlace = JSON.parse(localStorage.getItem('fd_place') || 'null'); } catch { /* ignore */ }
  const state = {
    token: null,
    user: null,
    view: 'browse',
    center: savedPlace ? { lat: savedPlace.lat, lng: savedPlace.lng } : { ...DEFAULT_CENTER },
    located: !!savedPlace,    // true once we know where the buyer is
    placeLabel: savedPlace ? savedPlace.label : '',
    farms: [],
    cart: null,               // { farm, lines: { [listingId]: { listing, qty } } }
    map: null,
    markers: null,
    pickMap: null,
  };
  try { state.token = localStorage.getItem('fd_token'); } catch { /* storage unavailable */ }

  const $ = (sel, root = document) => root.querySelector(sel);
  const view = $('#view');
  const authDialog = $('#authDialog');
  const farmDialog = $('#farmDialog');

  // ---------- utils ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (cents, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(cents / 100); } catch { return `${cur || ''} ${(cents / 100).toFixed(2)}`; } };
  const CURRENCIES = ['USD','CAD','MXN','EUR','GBP','INR','AUD','NZD','ZAR','KES','NGN','GHS','BRL','JPY','CNY','SGD','PHP','AED','SEK','NOK','DKK','CHF','PKR','BDT','LKR','NPR'];
  const qtyText = (n) => String(Math.round(n * 100) / 100);
  const KINDS = ['farm', 'barn', 'orchard', 'ranch', 'garden'];
  const kindLabel = (k) => k.charAt(0).toUpperCase() + k.slice(1);

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

  // ---------- auth ----------
  function setSession(token, user) {
    state.token = token;
    state.user = user;
    try { localStorage.setItem('fd_token', token); } catch { /* ignore */ }
    renderNav();
  }
  function signOut(silent) {
    state.token = null;
    state.user = null;
    state.cart = null;
    try { localStorage.removeItem('fd_token'); } catch { /* ignore */ }
    renderNav();
    if (state.view !== 'browse') go('browse');
    if (!silent) toast('Signed out.');
  }

  function openAuth(tab = 'login', message = '') {
    authDialog.innerHTML = `
      <div class="dlg">
        <div class="dlg-head">
          <h2 id="authTitle">${tab === 'login' ? 'Sign in' : 'Create your account'}</h2>
          <button class="close" type="button" aria-label="Close" data-close>✕</button>
        </div>
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
                <label><input type="radio" name="role" value="buyer" checked> Buy from farms</label>
                <label><input type="radio" name="role" value="farmer"> Sell my harvest</label>
              </div>
            </fieldset>` : ''}
          <div class="field"><label for="a-email">Email</label><input id="a-email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="a-pass">Password ${tab === 'register' ? '<span class="hint">(8+ characters)</span>' : ''}</label>
            <input id="a-pass" type="password" autocomplete="${tab === 'login' ? 'current-password' : 'new-password'}" required></div>
          <p class="error" id="authError" role="alert"></p>
          <button class="btn" type="submit">${tab === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p class="demo">Demo accounts (password <strong>farmdemo123</strong>): <strong>buyer@demo.farm</strong> to shop, <strong>bluebonnet@demo.farm</strong> to manage a farm.</p>
      </div>`;
    authDialog.showModal();
    $('#a-email', authDialog).focus();

    authDialog.querySelectorAll('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => openAuth(b.dataset.tab, message)));
    $('#authForm', authDialog).addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#authError', authDialog);
      err.textContent = '';
      const body = { email: $('#a-email', authDialog).value, password: $('#a-pass', authDialog).value };
      if (tab === 'register') {
        body.name = $('#a-name', authDialog).value;
        body.role = authDialog.querySelector('input[name=role]:checked').value;
      }
      try {
        const data = await api(tab === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body });
        setSession(data.token, data.user);
        authDialog.close();
        toast(`Welcome, ${data.user.name.split(' ')[0]}.`);
        go(data.user.role === 'farmer' ? 'farm' : state.view === 'farm' ? 'browse' : state.view);
        if (state.view === 'browse' && farmDialog.open) openFarm(state.cart?.farm?.id || currentFarmId);
      } catch (ex) {
        err.textContent = ex.message;
      }
    });
  }

  // generic dialog behaviors
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
  });
  [authDialog, farmDialog].forEach((d) =>
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  // ---------- nav / routing ----------
  function renderNav() {
    const nav = $('#nav');
    const u = state.user;
    const cur = (v) => (state.view === v ? ' aria-current="page"' : '');
    nav.innerHTML = `
      <button data-go="browse"${cur('browse')}>Home</button>
      <button data-go="feed"${cur('feed')}>Farm updates</button>
      ${u?.role === 'farmer' ? `<button data-go="farm"${cur('farm')}>My farm</button>` : ''}
      ${u?.role === 'buyer' ? `<button data-go="orders"${cur('orders')}>My orders</button>` : ''}
      ${u
        ? `<span class="who">${esc(u.name)}</span><button data-act="signout">Sign out</button>`
        : `<button data-act="signin">Sign in</button><button class="cta" data-act="register">Sell your harvest</button>`}`;
  }
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.go) go(b.dataset.go);
    if (b.dataset.act === 'signout') signOut();
    if (b.dataset.act === 'signin') openAuth('login');
    if (b.dataset.act === 'register') openAuth('register');
  });

  function destroyMaps() {
    if (state.map) { state.map.remove(); state.map = null; }
    if (state.pickMap) { state.pickMap.remove(); state.pickMap = null; }
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

  function go(v) {
    state.view = v;
    destroyMaps();
    renderNav();
    ({ browse: renderBrowse, feed: renderFeed, farm: renderFarmDashboard, orders: renderOrders }[v] || renderBrowse)();
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

  // ---------- browse ----------
  function renderBrowse() {
    view.innerHTML = `
      <section class="browse">
        <div class="panel">
          <div class="intro">
            <h1>Fresh food and farm days, straight from the farmer</h1>
            <p>Find farms, barns and ranches near you, anywhere in the world. Reserve what they just harvested, or book a day on the farm, a farming class or a horseback ride. You pay the farmer, not a middleman.</p>
          </div>
          <form id="filters" class="filters" role="search">
            <div class="field"><label for="f-place">Where are you?</label>
              <div style="display:flex;gap:.5rem"><input id="f-place" type="search" style="flex:1;min-width:0" value="${esc(state.placeLabel || '')}" placeholder="Town, city or address, or a Google Maps link">
              <button class="btn secondary" type="button" id="placeGo">Find</button></div></div>
            <div class="field"><label for="f-look">Looking for</label>
              <select id="f-look"><option value="">Food and experiences</option><option value="produce">Fresh produce</option><option value="exp">Any farm experience</option>
                ${Object.entries(EXP_TYPES).filter(([k]) => k !== 'other').map(([k, t]) => `<option value="exp:${k}">${esc(t)}</option>`).join('')}</select></div>
            <div class="field"><label for="f-q">Search</label>
              <input id="f-q" type="search" placeholder="tomatoes, mangoes, eggs"></div>
            <div class="row">
              <div class="field"><label for="f-cat">Type</label>
                <select id="f-cat"><option value="">Everything</option><option value="vegetable">Vegetables</option>
                  <option value="fruit">Fruit</option><option value="herb">Herbs</option><option value="other">Other</option></select></div>
              <div class="field"><label for="f-how">Get it by</label>
                <select id="f-how"><option value="">Pickup or delivery</option><option value="pickup">Pickup</option><option value="delivery">Delivery</option></select></div>
            </div>
            <div class="row">
              <div class="field"><label for="f-rad">Within</label>
                <select id="f-rad"><option value="10">10 miles</option><option value="25">25 miles</option>
                  <option value="50" selected>50 miles</option><option value="100">100 miles</option><option value="250">250 miles</option><option value="0">Any distance</option></select></div>
              <div class="field" style="align-self:end"><button class="btn secondary" type="button" id="locate">Use my location</button></div>
            </div>
          </form>
          <p class="result-note" id="resultNote" aria-live="polite"></p>
          <ul class="farm-list" id="farmList"></ul>
        </div>
        <div id="map" class="map" role="region" aria-label="Map of farms"></div>
      </section>`;

    state.map = Maps.create($('#map'), state.center.lat, state.center.lng, state.located ? 10 : 2);
    const findPlace = async () => {
      const qv = $('#f-place').value.trim();
      if (!qv) return;
      const hit = await geocode(qv);
      if (!hit) return toast('Could not find that place. Try adding the state or country, like "Celina, Texas".', true);
      state.center = { lat: hit.lat, lng: hit.lng }; state.located = true; state.placeLabel = hit.label;
      try { localStorage.setItem('fd_place', JSON.stringify({ ...state.center, label: hit.label })); } catch { /* ignore */ }
      $('#f-place').value = hit.label;
      loadFarms();
    };
    $('#placeGo').addEventListener('click', findPlace);
    $('#f-place').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findPlace(); } });

    let t;
    $('#filters').addEventListener('input', (e) => { if (e.target.id === 'f-place') return; clearTimeout(t); t = setTimeout(loadFarms, 250); });
    $('#filters').addEventListener('submit', (e) => { e.preventDefault(); loadFarms(); });
    $('#locate').addEventListener('click', () => locate(() => {
      state.map.setView(state.center.lat, state.center.lng, 11);
      loadFarms();
    }));
    $('#farmList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-farm]');
      if (b) openFarm(Number(b.dataset.farm));
    });
    loadFarms();
  }

  async function loadFarms() {
    const q = new URLSearchParams(state.located ? { lat: state.center.lat, lng: state.center.lng } : {});
    const val = (id) => $(id)?.value || '';
    if (val('#f-q')) q.set('q', val('#f-q'));
    if (val('#f-cat')) q.set('category', val('#f-cat'));
    if (val('#f-look')) q.set('looking', val('#f-look'));
    const expOnly = val('#f-look').startsWith('exp');
    if ($('#f-cat')) { $('#f-cat').disabled = expOnly; $('#f-how').disabled = expOnly; }
    if (val('#f-how')) q.set('fulfillment', val('#f-how'));
    if (state.located && Number(val('#f-rad')) > 0) q.set('radius', val('#f-rad'));
    try {
      const { farms } = await api('/farms?' + q);
      state.farms = farms;
      if (state.view === 'browse') drawFarms();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function drawFarms() {
    const farms = state.farms;
    const from = state.located ? (state.placeLabel || 'you') : 'everywhere';
    $('#resultNote').textContent = farms.length
      ? `${farms.length} ${farms.length === 1 ? 'farm' : 'farms'} ${state.located ? 'near ' + from : 'everywhere'}`
      : '';
    $('#farmList').innerHTML = farms.length
      ? farms.map(farmCard).join('')
      : `<li class="empty"><strong>No farms match yet.</strong><br>Try a wider distance or clear the search. Are you a grower? Create a farmer account and be the first on the map.</li>`;

    state.map.clear();
    const pts = [];
    if (!state.located) $('#resultNote').textContent += farms.length ? '. Tell us where you are to see the closest first.' : '';
    farms.forEach((f) => {
      state.map.addPin(f.lat, f.lng, { title: f.name, kind: f.kind, onClick: () => openFarm(f.id) });
      pts.push([f.lat, f.lng]);
    });
    if (state.located) pts.push([state.center.lat, state.center.lng]);
    state.map.fit(pts);
  }

  function farmCard(f) {
    const how = [];
    if (f.pickup_enabled) how.push('Pickup');
    if (f.delivery_enabled) how.push(`Delivers ${qtyText(f.delivery_radius_miles)} mi`);
    const items = f.items.slice(0, 4)
      .map((i) => `<span class="chip price">${esc(i.name)} ${money(i.price_cents, f.currency)}/${esc(i.unit)}</span>`).join('');
    const more = f.items.length > 4 ? `<span class="chip">+${f.items.length - 4} more</span>` : '';
    const thumb = f.cover_url ? `<img class="thumb media" src="${esc(f.cover_url)}" alt="" loading="lazy">` : '';
    return `<li><button class="farm-card kind-${esc(f.kind)}${thumb ? ' has-thumb' : ''}" data-farm="${f.id}">${thumb}<span class="fc-body">
      <span class="head"><h3>${esc(f.name)}</h3>
        ${f.distance_miles != null && state.located ? `<span class="dist">${f.distance_miles.toFixed(1)} mi</span>` : ''}</span>
      <span class="where" style="display:block">${esc(kindLabel(f.kind))} in ${esc(f.city || 'an unnamed place')}</span>
      <span class="chips">${how.map((h) => `<span class="chip how">${esc(h)}</span>`).join('')}</span>
      <span class="chips" style="margin-top:.45rem">${items}${more}${(f.experiences || []).slice(0, 3).map((e) => `<span class="chip exp">${esc(EXP_SHORT[e.type] || 'Experience')}, ${esc(expPrice(e, f.currency))}</span>`).join('')}</span>
    </span></button></li>`;
  }

  // ---------- farm dialog + checkout ----------
  let currentFarmId = null;

  async function openFarm(id) {
    currentFarmId = id;
    try {
      const { farm, listings, posts, experiences } = await api('/farms/' + id);
      if (state.cart && state.cart.farm.id !== farm.id) {
        state.cart = null;
        toast('Your order is for one farm at a time, so the cart was cleared.');
      }
      if (!state.cart) state.cart = { farm, lines: {} };
      state.cart.farm = farm;
      state.cart.listings = listings;
      state.cart.posts = posts || [];
      state.cart.experiences = experiences || [];
      state.cart.bookExp = null;
      drawFarmDialog();
      if (!farmDialog.open) farmDialog.showModal();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function drawFarmDialog() {
    const { farm, listings } = state.cart;
    const avail = listings.filter((l) => l.qty_available > 0);
    farmDialog.innerHTML = `
      <div class="dlg">
        <div class="dlg-head">
          <div><h2 id="farmTitle">${esc(farm.name)}</h2>
            <p class="hint">${esc(kindLabel(farm.kind))} in ${esc(farm.city || 'an unnamed place')}</p></div>
          <button class="close" type="button" aria-label="Close" data-close>✕</button>
        </div>
        ${farm.cover_url ? `<img class="cover media" src="${esc(farm.cover_url)}" alt="Photo of ${esc(farm.name)}">` : ''}
        ${farm.description ? `<p>${esc(farm.description)}</p>` : ''}
        <div class="facts">
          ${farm.address ? `<p><strong>Where:</strong> ${esc(farm.address)}${farm.city ? ', ' + esc(farm.city) : ''}</p>` : ''}
          ${farm.pickup_enabled ? `<p><strong>Pickup:</strong> ${esc(farm.pickup_instructions || 'Arrange a time with the farmer.')}</p>` : ''}
          ${farm.delivery_enabled ? `<p><strong>Delivery:</strong> within ${qtyText(farm.delivery_radius_miles)} miles, ${farm.delivery_fee_cents ? money(farm.delivery_fee_cents, farm.currency) + ' fee' : 'free'}</p>` : ''}
          ${farm.phone ? `<p><strong>Phone:</strong> <a href="tel:${esc(farm.phone)}">${esc(farm.phone)}</a></p>` : ''}
          <p><strong>Payment:</strong> ${esc(farm.payment_note)}</p>
        </div>
        <div class="btn-group" style="margin-bottom:1rem">${gmLink(gmPlace(farm.lat, farm.lng), 'Open in Google Maps')}${gmLink(gmDir(farmDest(farm)), 'Get directions')}</div>
        <h3 style="margin-bottom:.6rem">Available now</h3>
        ${avail.length ? avail.map(listingRow).join('') : '<p class="empty">Nothing is listed right now. Check back soon.</p>'}
        <div id="cartBox"></div>
        ${(state.cart.experiences || []).length ? `<h3 style="margin:1.2rem 0 .6rem">Experiences</h3><div class="rows" id="expBox"></div>` : ''}
        ${(state.cart.posts || []).length ? `<h3 style="margin:1.2rem 0 .6rem">Latest from the farm</h3><div class="rows">${state.cart.posts.slice(0, 4).map((p) => postHtml(p)).join('')}</div>` : ''}
      </div>`;
    drawCart();
    drawExps();
    farmDialog.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.add);
      const listing = listings.find((l) => l.id === id);
      const input = farmDialog.querySelector(`#q-${id}`);
      const qty = Number(input.value);
      if (!(qty > 0)) return toast('Enter how much you want.', true);
      const already = state.cart.lines[id]?.qty || 0;
      if (already + qty > listing.qty_available) {
        return toast(`Only ${qtyText(listing.qty_available)} ${listing.unit} available.`, true);
      }
      state.cart.lines[id] = { listing, qty: already + qty };
      drawCart();
      toast(`Added ${qtyText(qty)} ${listing.unit} of ${listing.name}.`);
    }));
  }

  function listingRow(l) {
    return `<div class="listing">
      <div>
        <strong>${esc(l.name)}</strong>
        <div class="meta">${[harvestLabel(l.harvest_date), `${qtyText(l.qty_available)} ${esc(l.unit)} left`].filter(Boolean).join(', ')}</div>
        ${l.description ? `<div class="meta">${esc(l.description)}</div>` : ''}
      </div>
      <div class="buy">
        <span class="price">${money(l.price_cents, state.cart.farm.currency)}/${esc(l.unit)}</span>
        <label class="sr" for="q-${l.id}" style="position:absolute;left:-999px">Quantity of ${esc(l.name)}</label>
        <input id="q-${l.id}" type="number" min="${stepFor(l.unit)}" step="${stepFor(l.unit)}" value="1" inputmode="decimal">
        <button class="btn small" type="button" data-add="${l.id}">Add</button>
      </div>
    </div>`;
  }

  function cartTotals() {
    const lines = Object.values(state.cart.lines);
    const items = lines.reduce((s, l) => s + Math.round(l.listing.price_cents * l.qty), 0);
    return { lines, items };
  }

  function drawCart() {
    const box = $('#cartBox', farmDialog);
    if (!box) return;
    const farm = state.cart.farm;
    const { lines, items } = cartTotals();
    if (!lines.length) { box.innerHTML = ''; return; }

    const canPickup = farm.pickup_enabled;
    const canDeliver = farm.delivery_enabled;
    const defaultHow = canPickup ? 'pickup' : 'delivery';
    box.innerHTML = `
      <form class="cart" id="checkout" novalidate>
        <h3>Your order</h3>
        <table>
          ${lines.map((l) => `<tr><td>${esc(l.listing.name)}, ${qtyText(l.qty)} ${esc(l.listing.unit)}</td>
            <td>${money(Math.round(l.listing.price_cents * l.qty), farm.currency)}
              <button class="btn small danger" type="button" data-rm="${l.listing.id}" aria-label="Remove ${esc(l.listing.name)}">Remove</button></td></tr>`).join('')}
          <tr class="deliv-row" hidden><td>Delivery fee</td><td>${money(farm.delivery_fee_cents, farm.currency)}</td></tr>
          <tr class="total"><td>Total</td><td id="grand">${money(items, farm.currency)}</td></tr>
        </table>
        <fieldset style="border:0;padding:0;margin:0">
          <legend style="font-weight:700;font-size:.92rem">How do you want it?</legend>
          <div class="radio-row">
            ${canPickup ? `<label><input type="radio" name="how" value="pickup" ${defaultHow === 'pickup' ? 'checked' : ''}> Pick up at the farm</label>` : ''}
            ${canDeliver ? `<label><input type="radio" name="how" value="delivery" ${defaultHow === 'delivery' ? 'checked' : ''}> Delivery (${esc(qtyText(farm.delivery_radius_miles))} mi radius)</label>` : ''}
          </div>
        </fieldset>
        <div class="field" id="addrField" hidden><label for="c-addr">Delivery address</label>
          <input id="c-addr" type="text" autocomplete="street-address">
          ${state.located ? '' : '<p class="hint">Tap “Use my location” on the browse page so we can check you are inside this farm’s delivery area. Otherwise the farmer confirms.</p>'}</div>
        <div class="field"><label for="c-when">Preferred pickup or delivery time <span class="hint">(optional)</span></label>
          <input id="c-when" type="datetime-local"></div>
        <div class="field"><label for="c-note">Note to the farmer <span class="hint">(optional)</span></label>
          <textarea id="c-note"></textarea></div>
        <p class="hint" style="margin-bottom:.7rem">Reserving holds this produce for you. ${esc(farm.payment_note)}</p>
        <p class="error" id="coError" role="alert"></p>
        <button class="btn" type="submit">Reserve order</button>
      </form>`;

    const form = $('#checkout', farmDialog);
    const how = () => form.querySelector('input[name=how]:checked').value;
    const sync = () => {
      const del = how() === 'delivery';
      $('#addrField', form).hidden = !del;
      $('.deliv-row', form).hidden = !del;
      $('#grand', form).textContent = money(items + (del ? farm.delivery_fee_cents : 0), farm.currency);
    };
    form.querySelectorAll('input[name=how]').forEach((r) => r.addEventListener('change', sync));
    sync();

    form.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => {
      delete state.cart.lines[b.dataset.rm];
      drawCart();
    }));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#coError', form);
      err.textContent = '';
      if (!state.user) return openAuth('login', 'Sign in or create a buyer account to reserve this order.');
      if (state.user.role !== 'buyer') { err.textContent = 'Sign in with a buyer account to place orders.'; return; }
      const del = how() === 'delivery';
      const body = {
        farm_id: farm.id,
        fulfillment: how(),
        items: lines.map((l) => ({ listing_id: l.listing.id, qty: l.qty })),
        scheduled_for: $('#c-when', form).value,
        note: $('#c-note', form).value,
      };
      if (del) {
        body.delivery_address = $('#c-addr', form).value;
        if (state.located) { body.buyer_lat = state.center.lat; body.buyer_lng = state.center.lng; }
      }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const r = await api('/orders', { method: 'POST', body });
        state.cart = null;
        farmDialog.querySelector('.dlg').innerHTML = `
          <div class="dlg-head"><h2 id="farmTitle">Order reserved</h2>
            <button class="close" type="button" aria-label="Close" data-close>✕</button></div>
          <div class="success">
            <p><strong>Total: ${money(r.total_cents, farm.currency)}</strong></p>
            <p>${esc(r.payment_note)}</p>
            <p style="margin-top:.5rem">Track it under <strong>My orders</strong>. The farmer will mark it ready.</p>
          </div>
          <p style="margin-top:1rem"><button class="btn" type="button" id="viewOrders">View my orders</button></p>`;
        $('#viewOrders', farmDialog).addEventListener('click', () => { farmDialog.close(); go('orders'); });
        if (state.view === 'browse') loadFarms();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    });
  }

  // ---------- buyer: orders ----------
  async function renderOrders() {
    if (!state.user) { go('browse'); return openAuth('login'); }
    view.innerHTML = '<div class="page"><h1>My orders</h1><p class="hint">Loading…</p></div>';
    try {
      const { orders } = await api('/orders/mine');
      const { bookings } = await api('/bookings/mine');
      view.innerHTML = `<div class="page"><h1>My orders</h1>
        ${orders.length ? `<div class="rows">${orders.map(buyerOrder).join('')}</div>`
          : `<p class="empty"><strong>No produce orders yet.</strong> Find a farm near you and reserve something fresh.</p>`}
        ${orders.length ? '' : '<p><button class="btn" data-go-browse>Go to Home</button></p>'}
        <h2>Farm experiences</h2>
        ${bookings.length ? `<div class="rows">${bookings.map(guestBooking).join('')}</div>` : '<p class="empty">No bookings yet. Look for farm days, farming classes and horseback rides on Home.</p>'}</div>`;
      view.querySelectorAll('[data-bcancel]').forEach((b) => b.addEventListener('click', async () => {
        if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Tap again to cancel'; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Cancel booking'; }, 4000); return; }
        try { await api(`/bookings/${b.dataset.bcancel}/status`, { method: 'PATCH', body: { status: 'cancelled' } }); toast('Booking cancelled.'); renderOrders(); }
        catch (e) { toast(e.message, true); }
      }));
      view.querySelector('[data-go-browse]')?.addEventListener('click', () => go('browse'));
      view.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('Cancel this order? The produce goes back on sale.')) return;
        try { await api(`/orders/${b.dataset.cancel}/status`, { method: 'PATCH', body: { status: 'cancelled' } }); toast('Order cancelled.'); renderOrders(); }
        catch (e) { toast(e.message, true); }
      }));
    } catch (e) { toast(e.message, true); }
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
      <p class="meta">${o.fulfillment === 'pickup'
        ? `Pickup at ${esc(o.farm_address || o.farm_city)}. ${esc(o.pickup_instructions || '')}`
        : `Delivery to ${esc(o.delivery_address)}`}
        ${o.scheduled_for ? `<br>Requested time: ${esc(o.scheduled_for.replace('T', ' '))}` : ''}</p>
      ${o.fulfillment === 'pickup' ? `<p>${gmLink(gmDir(o.farm_address ? `${o.farm_address}, ${o.farm_city}, TX` : `${o.farm_lat},${o.farm_lng}`), 'Directions to the farm')}</p>` : ''}
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

  function drawExps() {
    const box = $('#expBox', farmDialog); if (!box) return;
    const { farm, experiences, bookExp } = state.cart;
    const today = new Date().toLocaleDateString('en-CA');
    box.innerHTML = experiences.map((e) => `<div class="exp">
      <div class="exp-hd"><div><strong>${esc(e.title)}</strong><div class="hint">${esc(EXP_TYPES[e.type] || 'Experience')}</div></div><span class="price">${esc(expPrice(e, farm.currency))}</span></div>
      ${e.about ? `<p>${esc(e.about)}</p>` : ''}
      <div class="meta">${e.duration ? `How long: ${esc(e.duration)}. ` : ''}${e.schedule ? `When: ${esc(e.schedule)}. ` : ''}Up to ${e.max_people} people a day.${e.min_age > 0 ? ` Ages ${e.min_age} and up.` : ''}${e.bring ? ` Bring: ${esc(e.bring)}.` : ''}</div>
      ${bookExp === e.id ? `<form class="cart" id="bookForm" novalidate>
          <div class="row"><div class="field"><label for="b-date">Date</label><input id="b-date" type="date" min="${today}"></div>
            <div class="field"><label for="b-people">How many people</label><input id="b-people" type="number" min="1" step="1" value="1"></div></div>
          <div class="field"><label for="b-contact">Your phone or email <span class="hint">so the farmer can reach you</span></label><input id="b-contact" type="text" autocomplete="tel"></div>
          <div class="field"><label for="b-note">Note to the farmer <span class="hint">(optional)</span></label><textarea id="b-note"></textarea></div>
          <p class="error" id="bErr" role="alert"></p>
          <div class="btn-group"><button class="btn" type="submit">Request booking</button><button class="btn secondary" type="button" data-bookx>Cancel</button></div>
          <p class="hint">The farmer confirms each booking. Nothing is charged here.</p>
        </form>` : `<div class="btn-group"><button class="btn small" type="button" data-book="${e.id}">Book this</button></div>`}
    </div>`).join('');
    box.querySelectorAll('[data-book]').forEach((b) => b.addEventListener('click', () => { state.cart.bookExp = Number(b.dataset.book); drawExps(); $('#b-date', farmDialog)?.focus(); }));
    box.querySelector('[data-bookx]')?.addEventListener('click', () => { state.cart.bookExp = null; drawExps(); });
    box.querySelector('#bookForm')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('#bErr', farmDialog); err.textContent = '';
      if (!state.user) return openAuth('login', 'Sign in or create a buyer account to book this experience.');
      if (state.user.role !== 'buyer') { err.textContent = 'Sign in with a buyer account to book.'; return; }
      const e = experiences.find((x) => x.id === bookExp);
      const body = { experience_id: e.id, date: $('#b-date', farmDialog).value, people: $('#b-people', farmDialog).value,
        contact: $('#b-contact', farmDialog).value, note: $('#b-note', farmDialog).value };
      const btn = ev.submitter || box.querySelector('#bookForm button[type=submit]'); btn.disabled = true;
      try {
        const r = await api('/bookings', { method: 'POST', body });
        state.cart.bookExp = null;
        box.closest('.dlg').innerHTML = `<div class="dlg-head"><h2 id="farmTitle">Booking requested</h2><button class="close" type="button" aria-label="Close" data-close>✕</button></div>
          <div class="success"><p><strong>${esc(e.title)}</strong>, ${esc(niceDate(body.date))}, ${body.people} ${Number(body.people) === 1 ? 'person' : 'people'}.</p>
            <p>Estimated ${r.total_cents ? money(r.total_cents, r.currency) + (r.per === 'hour' ? ' per hour' : '') : 'free'}. ${esc(r.payment_note)}</p>
            <p style="margin-top:.5rem">${esc(farm.name)} will confirm or decline. Follow it under <strong>My orders</strong>.</p></div>
          <div class="btn-group" style="margin-top:1rem">${gmLink(gmDir(farmDest(farm)), 'Directions to the farm')}</div>`;
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
  }

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
        <div class="hint">${esc(kindLabel(farm.kind))} in ${esc(farm.city || '')}${farm.distance_miles != null ? `, ${farm.distance_miles.toFixed(1)} mi away` : ''}</div>` : ''}</div>
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

  async function renderFeed() {
    view.innerHTML = '<div class="page"><h1>Farm updates</h1><p class="hint">Loading…</p></div>';
    try {
      const q = new URLSearchParams(state.located ? { lat: state.center.lat, lng: state.center.lng } : {});
      if (state.located && state.feedNear !== false) q.set('radius', 100);
      const { posts } = await api('/feed?' + q);
      view.innerHTML = `<div class="page"><div class="feed">
        <h1>Farm updates</h1>
        <p class="hint">Photos, videos and news from the farmers themselves: what's growing, what was just picked, and when to come by.</p>
        ${state.located ? `<label class="check"><input type="checkbox" id="feedNear" ${state.feedNear !== false ? 'checked' : ''}> Only farms within 100 miles of ${esc(state.placeLabel || 'you')}</label>`
          : '<p class="hint">Showing updates from everywhere. Set where you are on Home to see farms near you.</p>'}
        ${posts.length ? posts.map((p) => postHtml(p, { farm: { id: p.farm_id, name: p.farm_name, kind: p.farm_kind, city: p.farm_city, distance_miles: p.distance_miles } })).join('')
          : '<p class="empty"><strong>No farm updates yet.</strong> When farmers share photos, videos and news, they show up here.</p>'}
      </div></div>`;
      $('#feedNear')?.addEventListener('change', (e) => { state.feedNear = e.target.checked; renderFeed(); });
      view.querySelectorAll('[data-farm]').forEach((b) => b.addEventListener('click', () => openFarm(Number(b.dataset.farm))));
    } catch (e) { toast(e.message, true); }
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

  // ---------- farmer dashboard ----------
  async function renderFarmDashboard() {
    if (state.user?.role !== 'farmer') { go('browse'); return openAuth('register', 'Create a farmer account to list your harvest.'); }
    view.innerHTML = '<div class="page"><h1>My farm</h1><p class="hint">Loading…</p></div>';
    try {
      const { farms } = await api('/my/farms');
      const farm = farms[0] || null;
      let orders = [], posts = [], bookings = [];
      if (farm) {
        orders = (await api('/farm-orders')).orders;
        bookings = (await api('/farm-bookings')).bookings;
        posts = (await api(`/farms/${farm.id}/posts`)).posts;
      }

      view.innerHTML = `<div class="page">
        <h1>${farm ? esc(farm.name) : 'Put your farm on the map'}</h1>
        ${farm ? incomingOrders(orders) : ''}
        ${farm ? bookingsCard(bookings, farm) : ''}
        ${farm ? listingsCard(farm) : ''}
        ${farm ? expsCard(farm) : ''}
        ${farm ? postsCard(farm, posts) : ''}
        ${farmFormCard(farm)}
      </div>`;
      bindFarmForm(farm);
      if (farm) { bindListings(farm); bindOrderButtons(); bindPosts(farm, posts); bindExps(farm); bindBookings(); }
    } catch (e) { toast(e.message, true); }
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
          <div class="field"><label for="l-cat">Type</label><select id="l-cat"><option value="vegetable">Vegetable</option><option value="fruit">Fruit</option><option value="herb">Herb</option><option value="other">Other</option></select></div>
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
    return `<section class="card"><h2>${farm ? 'Farm details' : 'Tell buyers about your farm'}</h2>
      <form id="farmForm" novalidate>
        <div class="row">
          <div class="field"><label for="fm-name">Farm or barn name</label><input id="fm-name" type="text" value="${esc(f.name)}" required></div>
          <div class="field"><label for="fm-kind">Kind</label><select id="fm-kind">${KINDS.map((k) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${kindLabel(k)}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label for="fm-desc">About your farm</label><textarea id="fm-desc">${esc(f.description)}</textarea></div>
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
        <h3 style="margin:1rem 0 .5rem">How buyers get their order</h3>
        <label class="check"><input type="checkbox" id="fm-pickup" ${f.pickup_enabled ? 'checked' : ''}> Pickup at the farm</label>
        <div class="field"><label for="fm-pinst">Pickup instructions</label><input id="fm-pinst" type="text" value="${esc(f.pickup_instructions)}" placeholder="Farm stand by the red barn, open 9 to 5"></div>
        <label class="check"><input type="checkbox" id="fm-deliv" ${f.delivery_enabled ? 'checked' : ''}> I deliver</label>
        <div class="row">
          <div class="field"><label for="fm-rad">Delivery radius (miles)</label><input id="fm-rad" type="number" min="1" step="1" value="${esc(f.delivery_radius_miles || 10)}"></div>
          <div class="field"><label for="fm-fee">Delivery fee</label><input id="fm-fee" type="number" min="0" step="0.5" value="${((f.delivery_fee_cents || 0) / 100).toFixed(2)}"></div>
        </div>
        <div class="row">
          <div class="field"><label for="fm-cur">Your prices are in</label><select id="fm-cur">${CURRENCIES.map((c) => `<option value="${c}" ${(f.currency || 'USD') === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
          <div class="field"><label for="fm-pay">How buyers pay you</label><input id="fm-pay" type="text" value="${esc(f.payment_note)}"></div>
        </div>
        <p class="error" id="fError" role="alert"></p>
        <button class="btn" type="submit">${farm ? 'Save farm details' : 'Create my farm'}</button>
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
        delivery_enabled: $('#fm-deliv').checked, delivery_radius_miles: $('#fm-rad').value, delivery_fee: $('#fm-fee').value,
        payment_note: $('#fm-pay').value, currency: $('#fm-cur').value,
      };
      try {
        await api(farm ? '/farms/' + farm.id : '/farms', { method: farm ? 'PUT' : 'POST', body });
        toast(farm ? 'Farm details saved.' : 'Your farm is on the map. Post your first harvest.');
        renderFarmDashboard();
      } catch (ex) { $('#fError').textContent = ex.message; }
    });
  }

  // ---------- boot ----------
  async function boot() {
    await Maps.init();
    if (state.token) {
      try { state.user = (await api('/me')).user; } catch { state.token = null; }
    }
    renderNav();
    go(state.user?.role === 'farmer' ? 'farm' : 'browse');
  }
  boot();
})();
