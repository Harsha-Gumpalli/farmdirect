const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { db, seed, seedExtras, setPlace, KINDS, CATEGORIES } = require('./db');
const cities = require('./cities');
const { hashPassword, verifyPassword, signToken, authenticate, requireAuth } = require('./auth');

// Demo farms help people try the app. Set SEED_DEMO=false for a real launch with no example data.
if (process.env.SEED_DEMO !== 'false') { seed(); seedExtras(); }
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set: everyone will be signed out whenever the server restarts.');
}

const app = express();
app.set('trust proxy', 1); // behind the host's HTTPS proxy
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.json({ limit: '100kb' }));
app.use(authenticate);
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- uploaded photos and videos ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MEDIA_TYPES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 50);
const MEDIA_URL = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|gif|mp4|webm|mov)$/;
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '30d', immutable: true,
  setHeaders: (res) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'"); },
}));
// Check the file really is what it says it is (first bytes), so nobody can upload HTML or scripts as an "image".
function looksLike(type, b) {
  const s = (i, str) => b.slice(i, i + str.length).toString('latin1') === str;
  switch (type) {
    case 'image/jpeg': return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case 'image/png': return b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/gif': return s(0, 'GIF8');
    case 'image/webp': return s(0, 'RIFF') && s(8, 'WEBP');
    case 'video/webm': return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    case 'video/mp4': case 'video/quicktime': return s(4, 'ftyp') || s(4, 'moov') || s(4, 'mdat') || s(4, 'wide');
    default: return false;
  }
}
function removeUpload(url) {
  if (!MEDIA_URL.test(url || '')) return;
  const stillUsed = db.prepare("SELECT 1 FROM posts WHERE media LIKE ? UNION SELECT 1 FROM farms WHERE cover_url = ?").get(`%${url}%`, url);
  if (!stillUsed) fs.rm(path.join(UPLOAD_DIR, path.basename(url)), () => {});
}

// ---------- helpers ----------
const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error.' });
  }
};
const fail = (status, message) => Object.assign(new Error(message), { status });

function miles(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

function publicFarm(f) {
  return {
    id: f.id,
    name: f.name,
    kind: f.kind,
    description: f.description,
    address: f.address,
    city: f.city,
    lat: f.lat,
    lng: f.lng,
    phone: f.phone,
    pickup_enabled: !!f.pickup_enabled,
    pickup_instructions: f.pickup_instructions,
    delivery_enabled: !!f.delivery_enabled,
    delivery_radius_miles: f.delivery_radius_miles,
    delivery_fee_cents: f.delivery_fee_cents,
    payment_note: f.payment_note,
    currency: f.currency || 'USD',
    cover_url: f.cover_url || '',
    accepts_snap: !!f.accepts_snap,
    wholesale: !!f.wholesale,
    website: f.website || '',
    hours: f.hours || '',
    place_slug: f.place_slug || '',
    place_label: f.place_label || f.city || '',
  };
}

function ownedFarm(farmId, userId) {
  const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(farmId);
  if (!farm) throw fail(404, 'Farm not found.');
  if (farm.owner_id !== userId) throw fail(403, 'That is not your farm.');
  return farm;
}

// ---------- public config ----------
// The Maps JavaScript API key is meant to be used in the browser. Restrict it to your
// domain (HTTP referrer restriction) in Google Cloud Console.
app.get('/api/config', (_req, res) => {
  res.json({ googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '' });
});

// ---------- auth ----------
app.post('/api/auth/register', wrap((req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const name = str(req.body.name, 100);
  const password = str(req.body.password, 200);
  const role = req.body.role === 'farmer' ? 'farmer' : 'buyer';
  if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, 'Enter a valid email.');
  if (!name) throw fail(400, 'Enter your name.');
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw fail(409, 'An account with that email already exists.');
  }
  const { salt, hash } = hashPassword(password);
  const r = db
    .prepare('INSERT INTO users (email,name,role,salt,password_hash) VALUES (?,?,?,?,?)')
    .run(email, name, role, salt, hash);
  const user = { id: Number(r.lastInsertRowid), name, email, role };
  res.json({ token: signToken({ id: user.id, role }), user });
}));

app.post('/api/auth/login', wrap((req, res) => {
  const email = str(req.body.email, 200).toLowerCase();
  const password = str(req.body.password, 200);
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !verifyPassword(password, row.salt, row.password_hash)) {
    throw fail(401, 'Incorrect email or password.');
  }
  res.json({
    token: signToken({ id: row.id, role: row.role }),
    user: { id: row.id, name: row.name, email: row.email, role: row.role },
  });
}));

app.get('/api/me', requireAuth(), wrap((req, res) => {
  const row = db.prepare('SELECT id,name,email,role FROM users WHERE id = ?').get(req.user.id);
  if (!row) throw fail(401, 'Account not found.');
  res.json({ user: row });
}));

// ---------- farm experiences (definitions) ----------
const EXP_TYPES = { day: 'Spend a day on the farm', learn: 'Learn farming', horse: 'Horseback riding', tour: 'Farm or barn tour', pick: 'Pick your own', other: 'Other experience' };
const activeExperiences = db.prepare('SELECT * FROM experiences WHERE farm_id = ? AND active = 1 AND removed = 0 ORDER BY id');
function publicExp(e) {
  return { id: e.id, farm_id: e.farm_id, type: e.type, title: e.title, about: e.about, price_cents: e.price_cents, per: e.per,
    duration: e.duration, max_people: e.max_people, schedule: e.schedule, min_age: e.min_age, bring: e.bring, active: !!e.active };
}

// ---------- public browsing ----------
// GET /api/farms?lat=&lng=&radius=&q=&category=&fulfillment=pickup|delivery
// Which listings belong to each directory type (the row of filters on the site).
const FARM_KINDS = ['farm', 'barn', 'orchard', 'ranch', 'garden'];
const TYPE_TEST = {
  farms: (f) => FARM_KINDS.includes(f.kind),
  markets: (f) => f.kind === 'market',
  farmstands: (f) => f.kind === 'farmstand',
  restaurants: (f) => f.kind === 'restaurant',
  groceries: (f) => f.kind === 'grocery',
  others: (f) => f.kind === 'other',
  upick: (f) => f.experiences.some((e) => e.type === 'pick'),
  csa: (f) => f.csa_count > 0,
  wholesale: (f) => f.wholesale,
  experiences: (f) => f.experiences.length > 0,
  events: (f) => f.event_count > 0,
  snap: (f) => f.accepts_snap,
};
const today = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); // a little behind UTC so US evenings still count as today
const csaCount = db.prepare('SELECT COUNT(*) AS n FROM csa_shares WHERE farm_id = ? AND active = 1 AND removed = 0');
const eventCount = db.prepare('SELECT COUNT(*) AS n FROM events WHERE farm_id = ? AND removed = 0 AND date >= ?');
const postCount = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE farm_id = ?');

function directory({ lat, lng, radius, type = '', product = '', q = '', fulfillment = '', looking = '' }) {
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng);
  const listingStmt = db.prepare('SELECT id,name,category,unit,price_cents,qty_available,harvest_date FROM listings WHERE farm_id = ? AND active = 1 AND qty_available > 0 ORDER BY name');
  const t = today();
  let out = db.prepare('SELECT * FROM farms').all().map((f) => ({
    ...publicFarm(f), distance_miles: hasLoc ? miles(lat, lng, f.lat, f.lng) : null, items: listingStmt.all(f.id),
    experiences: activeExperiences.all(f.id).map(publicExp), csa_count: csaCount.get(f.id).n, event_count: eventCount.get(f.id, t).n, post_count: postCount.get(f.id).n,
  }));
  if (hasLoc && Number.isFinite(radius) && radius > 0) out = out.filter((f) => f.distance_miles <= radius);
  if (TYPE_TEST[type]) out = out.filter(TYPE_TEST[type]);
  if (product) out = out.filter((f) => f.items.some((i) => i.category === product));
  // Older filters, still accepted
  if (looking === 'produce') out = out.filter((f) => f.items.length > 0);
  else if (looking === 'exp') out = out.filter((f) => f.experiences.length > 0);
  else if (looking.startsWith('exp:')) out = out.filter((f) => f.experiences.some((e) => e.type === looking.slice(4)));
  if (fulfillment === 'pickup') out = out.filter((f) => f.pickup_enabled && f.items.length);
  if (fulfillment === 'delivery') out = out.filter((f) => f.delivery_enabled && (!hasLoc || f.distance_miles <= f.delivery_radius_miles));
  if (q) {
    const has = (s) => String(s || '').toLowerCase().includes(q);
    out = out.filter((f) => has(f.name) || has(f.city) || has(f.place_label) || has(f.description) || f.items.some((i) => has(i.name)) ||
      f.experiences.some((e) => has(e.title) || has(EXP_TYPES[e.type])));
  }
  out.sort(hasLoc ? (a, b) => a.distance_miles - b.distance_miles : (a, b) => a.name.localeCompare(b.name));
  return out;
}

app.get('/api/farms', wrap((req, res) => {
  res.json({ farms: directory({
    lat: num(req.query.lat), lng: num(req.query.lng), radius: num(req.query.radius), type: str(req.query.type, 20),
    product: str(req.query.product || req.query.category, 20), q: str(req.query.q, 100).toLowerCase(),
    fulfillment: str(req.query.fulfillment, 20), looking: str(req.query.looking, 20),
  }) });
}));

app.get('/api/farms/:id', wrap((req, res) => {
  const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(req.params.id);
  if (!farm) throw fail(404, 'Farm not found.');
  const items = db.prepare('SELECT * FROM listings WHERE farm_id = ? AND active = 1 ORDER BY name').all(farm.id);
  const posts = db.prepare('SELECT * FROM posts WHERE farm_id = ? ORDER BY id DESC LIMIT 20').all(farm.id).map(publicPost);
  const csa = db.prepare('SELECT * FROM csa_shares WHERE farm_id = ? AND active = 1 AND removed = 0 ORDER BY id').all(farm.id).map(publicShare);
  const events = db.prepare('SELECT * FROM events WHERE farm_id = ? AND removed = 0 AND date >= ? ORDER BY date, start_time').all(farm.id, today()).map(publicEvent);
  res.json({ farm: publicFarm(farm), listings: items, posts, experiences: activeExperiences.all(farm.id).map(publicExp), csa, events });
}));

// ---------- places: city pages and search ----------
app.get('/api/places', wrap((req, res) => res.json({ places: cities.search(str(req.query.q, 80)) })));
app.get('/api/places/near', wrap((req, res) => {
  const lat = num(req.query.lat), lng = num(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw fail(400, 'Give lat and lng.');
  res.json({ place: cities.nearest(lat, lng) });
}));
app.get('/api/places/:slug', wrap((req, res) => {
  const place = cities.bySlug(req.params.slug);
  if (!place) throw fail(404, 'We could not find that town.');
  res.json({ place });
}));
// Towns that have listings, busiest first ("see more cities")
app.get('/api/cities', wrap((_req, res) => {
  const rows = db.prepare("SELECT place_slug AS slug, place_label AS label, COUNT(*) AS n FROM farms WHERE place_slug != '' GROUP BY place_slug ORDER BY n DESC, label LIMIT 500").all();
  res.json({ cities: rows });
}));

// What's in season: listings nearby plus a typical list for the hemisphere and month.
const SEASONAL = {
  winter: ['Citrus', 'Kale', 'Collard greens', 'Cabbage', 'Carrots', 'Turnips', 'Spinach', 'Lettuce', 'Pecans', 'Sweet potatoes'],
  spring: ['Strawberries', 'Asparagus', 'Peas', 'Lettuce', 'Spinach', 'Radishes', 'Green onions', 'Herbs', 'Eggs'],
  summer: ['Tomatoes', 'Peaches', 'Blackberries', 'Sweet corn', 'Zucchini', 'Peppers', 'Okra', 'Watermelon', 'Cucumbers', 'Green beans'],
  fall: ['Apples', 'Pumpkins', 'Winter squash', 'Sweet potatoes', 'Pecans', 'Pears', 'Persimmons', 'Kale', 'Broccoli', 'Carrots', 'Beets', 'Turnips'],
};
function seasonFor(lat) {
  const m = new Date().getUTCMonth(); // 0-11
  const north = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'fall', 'fall', 'fall', 'winter'][m];
  const flip = { winter: 'summer', summer: 'winter', spring: 'fall', fall: 'spring' };
  return lat < 0 ? flip[north] : north;
}

// Everything a city page shows, in one request.
app.get('/api/local', wrap((req, res) => {
  const lat = num(req.query.lat), lng = num(req.query.lng), radius = num(req.query.radius) || 50;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw fail(400, 'Give lat and lng.');
  const all = directory({ lat, lng, radius });
  const counts = Object.fromEntries(Object.keys(TYPE_TEST).map((k) => [k, all.filter(TYPE_TEST[k]).length]));
  counts.all = all.length;
  const ids = new Set(all.map((f) => f.id));
  const card = (f) => ({ id: f.id, name: f.name, kind: f.kind, place_label: f.place_label, distance_miles: f.distance_miles, cover_url: f.cover_url,
    description: f.description, hours: f.hours, item_count: f.items.length, csa_count: f.csa_count, event_count: f.event_count, accepts_snap: f.accepts_snap });
  const featured = [...all].sort((a, b) => (!!b.cover_url - !!a.cover_url) || (b.post_count + b.items.length + b.experiences.length * 2 + b.csa_count * 2) - (a.post_count + a.items.length + a.experiences.length * 2 + a.csa_count * 2) || a.distance_miles - b.distance_miles)
    .filter((f) => f.kind !== 'market').slice(0, 6).map(card);
  const markets = all.filter((f) => f.kind === 'market').slice(0, 6).map(card);
  const products = {};
  for (const f of all) for (const c of new Set(f.items.map((i) => i.category))) products[c] = (products[c] || 0) + 1;
  const nearbyItems = {};
  for (const f of all) for (const i of f.items) { const k = i.name.toLowerCase(); (nearbyItems[k] ||= { name: i.name, farms: 0 }).farms++; }
  const season = seasonFor(lat);
  const events = db.prepare('SELECT * FROM events WHERE removed = 0 AND date >= ? ORDER BY date, start_time').all(today())
    .filter((e) => ids.has(e.farm_id)).slice(0, 8).map((e) => ({ ...publicEvent(e), farm_name: all.find((f) => f.id === e.farm_id).name }));
  const experiences = all.flatMap((f) => f.experiences.map((e) => ({ ...e, farm_name: f.name, currency: f.currency, distance_miles: f.distance_miles }))).slice(0, 8);
  const csa = db.prepare('SELECT * FROM csa_shares WHERE active = 1 AND removed = 0').all().filter((c) => ids.has(c.farm_id))
    .map((c) => { const f = all.find((x) => x.id === c.farm_id); return { ...publicShare(c), farm_name: f.name, currency: f.currency, distance_miles: f.distance_miles }; })
    .sort((a, b) => a.distance_miles - b.distance_miles).slice(0, 6);
  res.json({
    counts, featured, markets, events, experiences, csa,
    products: Object.entries(products).sort((a, b) => b[1] - a[1]).map(([category, farms]) => ({ category, farms })),
    gallery: gallery(ids, 12),
    in_season: { season, nearby: Object.values(nearbyItems).sort((a, b) => b.farms - a.farms).slice(0, 16), typical: SEASONAL[season] },
  });
}));

function gallery(ids, limit) {
  const out = [];
  for (const f of db.prepare("SELECT id, name, cover_url FROM farms WHERE cover_url != ''").all()) if (!ids || ids.has(f.id)) out.push({ url: f.cover_url, type: 'image', farm_id: f.id, farm_name: f.name, caption: f.name, at: '' });
  for (const p of db.prepare('SELECT p.*, f.name AS farm_name FROM posts p JOIN farms f ON f.id = p.farm_id ORDER BY p.id DESC LIMIT 400').all()) {
    if (ids && !ids.has(p.farm_id)) continue;
    for (const m of publicPost(p).media) out.push({ url: m.url, type: m.type, farm_id: p.farm_id, farm_name: p.farm_name, caption: p.body.slice(0, 120), at: p.created_at });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}
app.get('/api/gallery', wrap((req, res) => {
  const lat = num(req.query.lat), lng = num(req.query.lng), radius = num(req.query.radius) || 50;
  const ids = Number.isFinite(lat) && Number.isFinite(lng) ? new Set(directory({ lat, lng, radius }).map((f) => f.id)) : null;
  res.json({ photos: gallery(ids, 120) });
}));

// ---------- farmer: farms ----------
function farmFromBody(b) {
  const name = str(b.name, 120);
  const lat = num(b.lat);
  const lng = num(b.lng);
  if (!name) throw fail(400, 'Farm name is required.');
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw fail(400, 'Pick your farm location on the map.');
  }
  const delivery = !!b.delivery_enabled;
  const radius = delivery ? Math.max(0, num(b.delivery_radius_miles) || 0) : 0;
  const fee = delivery ? Math.max(0, Math.round((num(b.delivery_fee) || 0) * 100)) : 0;
  const pickup = b.pickup_enabled !== false;
  if (delivery && radius <= 0) throw fail(400, 'Set a delivery radius in miles.');
  let website = str(b.website, 200);
  if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
  if (website && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(website)) throw fail(400, 'That website address does not look right.');
  return {
    name,
    kind: KINDS.includes(b.kind) ? b.kind : 'farm',
    description: str(b.description, 1000),
    address: str(b.address, 200),
    city: str(b.city, 80),
    lat,
    lng,
    phone: str(b.phone, 40),
    pickup_enabled: pickup ? 1 : 0,
    pickup_instructions: str(b.pickup_instructions, 300),
    delivery_enabled: delivery ? 1 : 0,
    delivery_radius_miles: radius,
    delivery_fee_cents: fee,
    payment_note: str(b.payment_note, 300) || 'Pay the farmer directly at pickup or delivery.',
    currency: /^[A-Z]{3}$/.test(b.currency || '') ? b.currency : 'USD',
    accepts_snap: b.accepts_snap ? 1 : 0,
    wholesale: b.wholesale ? 1 : 0,
    website,
    hours: str(b.hours, 120),
  };
}

app.get('/api/my/farms', requireAuth('farmer'), wrap((req, res) => {
  const farms = db.prepare('SELECT * FROM farms WHERE owner_id = ? ORDER BY id').all(req.user.id);
  const stmt = db.prepare('SELECT * FROM listings WHERE farm_id = ? AND active = 1 ORDER BY name');
  const exps = db.prepare('SELECT * FROM experiences WHERE farm_id = ? AND removed = 0 ORDER BY id');
  const shares = db.prepare('SELECT * FROM csa_shares WHERE farm_id = ? AND removed = 0 ORDER BY id');
  const evs = db.prepare('SELECT * FROM events WHERE farm_id = ? AND removed = 0 ORDER BY date DESC, start_time');
  res.json({ farms: farms.map((f) => ({ ...publicFarm(f), listings: stmt.all(f.id), experiences: exps.all(f.id).map(publicExp),
    csa: shares.all(f.id).map(publicShare), events: evs.all(f.id).map(publicEvent) })) });
}));

app.post('/api/farms', requireAuth('farmer'), wrap((req, res) => {
  const f = farmFromBody(req.body);
  const r = db
    .prepare(`INSERT INTO farms (owner_id,name,kind,description,address,city,lat,lng,phone,
      pickup_enabled,pickup_instructions,delivery_enabled,delivery_radius_miles,delivery_fee_cents,payment_note,currency,accepts_snap,wholesale,website,hours)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, f.name, f.kind, f.description, f.address, f.city, f.lat, f.lng, f.phone,
      f.pickup_enabled, f.pickup_instructions, f.delivery_enabled, f.delivery_radius_miles,
      f.delivery_fee_cents, f.payment_note, f.currency, f.accepts_snap, f.wholesale, f.website, f.hours);
  setPlace(Number(r.lastInsertRowid));
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));

app.put('/api/farms/:id', requireAuth('farmer'), wrap((req, res) => {
  ownedFarm(req.params.id, req.user.id);
  const f = farmFromBody(req.body);
  db.prepare(`UPDATE farms SET name=?,kind=?,description=?,address=?,city=?,lat=?,lng=?,phone=?,
      pickup_enabled=?,pickup_instructions=?,delivery_enabled=?,delivery_radius_miles=?,
      delivery_fee_cents=?,payment_note=?,currency=?,accepts_snap=?,wholesale=?,website=?,hours=? WHERE id=?`)
    .run(f.name, f.kind, f.description, f.address, f.city, f.lat, f.lng, f.phone,
      f.pickup_enabled, f.pickup_instructions, f.delivery_enabled, f.delivery_radius_miles,
      f.delivery_fee_cents, f.payment_note, f.currency, f.accepts_snap, f.wholesale, f.website, f.hours, req.params.id);
  setPlace(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- farmer: listings (post yield) ----------
function listingFromBody(b) {
  const name = str(b.name, 120);
  const legacy = { vegetable: 'vegetables', herb: 'herbs' };
  const cat = legacy[b.category] || b.category;
  const price = num(b.price);
  const qty = num(b.qty_available);
  if (!name) throw fail(400, 'Item name is required.');
  if (!Number.isFinite(price) || price < 0) throw fail(400, 'Enter a valid price.');
  if (!Number.isFinite(qty) || qty < 0) throw fail(400, 'Enter a valid quantity.');
  return {
    name,
    category: CATEGORIES.includes(cat) ? cat : 'vegetables',
    unit: str(b.unit, 20) || 'lb',
    price_cents: Math.round(price * 100),
    qty_available: qty,
    description: str(b.description, 500),
    harvest_date: /^\d{4}-\d{2}-\d{2}$/.test(b.harvest_date || '') ? b.harvest_date : null,
  };
}

app.post('/api/farms/:id/listings', requireAuth('farmer'), wrap((req, res) => {
  ownedFarm(req.params.id, req.user.id);
  const l = listingFromBody(req.body);
  const r = db
    .prepare(`INSERT INTO listings (farm_id,name,category,unit,price_cents,qty_available,description,harvest_date)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(req.params.id, l.name, l.category, l.unit, l.price_cents, l.qty_available, l.description, l.harvest_date);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));

function ownedListing(id, userId) {
  const row = db
    .prepare('SELECT l.*, f.owner_id FROM listings l JOIN farms f ON f.id = l.farm_id WHERE l.id = ?')
    .get(id);
  if (!row) throw fail(404, 'Listing not found.');
  if (row.owner_id !== userId) throw fail(403, 'That is not your listing.');
  return row;
}

app.put('/api/listings/:id', requireAuth('farmer'), wrap((req, res) => {
  ownedListing(req.params.id, req.user.id);
  const l = listingFromBody(req.body);
  db.prepare(`UPDATE listings SET name=?,category=?,unit=?,price_cents=?,qty_available=?,description=?,harvest_date=? WHERE id=?`)
    .run(l.name, l.category, l.unit, l.price_cents, l.qty_available, l.description, l.harvest_date, req.params.id);
  res.json({ ok: true });
}));

app.delete('/api/listings/:id', requireAuth('farmer'), wrap((req, res) => {
  ownedListing(req.params.id, req.user.id);
  db.prepare('UPDATE listings SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
}));

// ---------- photos, videos and posts ----------
function publicPost(p) {
  let media = [];
  try { media = JSON.parse(p.media); } catch { /* keep empty */ }
  return { id: p.id, farm_id: p.farm_id, body: p.body, media, created_at: p.created_at };
}

// Upload one photo or video. Send the raw file as the request body with its Content-Type.
app.post('/api/uploads', requireAuth('farmer'),
  express.raw({ type: Object.keys(MEDIA_TYPES), limit: `${MAX_UPLOAD_MB}mb` }),
  wrap((req, res) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim();
    const ext = MEDIA_TYPES[type];
    if (!ext) throw fail(415, 'Use JPEG, PNG, WebP or GIF photos, or MP4, MOV or WebM videos.');
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw fail(400, 'The file was empty.');
    if (!looksLike(type, req.body)) throw fail(415, 'That file does not look like a real photo or video.');
    const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
    res.status(201).json({ url: `/uploads/${name}`, type });
  }));

function cleanMedia(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > 10) throw fail(400, 'Up to 10 photos or videos per update.');
  return list.map((m) => {
    const url = String(m && m.url || '');
    if (!MEDIA_URL.test(url) || !fs.existsSync(path.join(UPLOAD_DIR, path.basename(url)))) throw fail(400, 'A photo or video in this update was not uploaded.');
    const type = Object.keys(MEDIA_TYPES).find((t) => url.endsWith('.' + MEDIA_TYPES[t]));
    return { url, type };
  });
}

app.post('/api/farms/:id/posts', requireAuth('farmer'), wrap((req, res) => {
  ownedFarm(req.params.id, req.user.id);
  const body = str(req.body.body, 2000);
  const media = cleanMedia(req.body.media);
  if (!body && !media.length) throw fail(400, 'Write something or add a photo or video.');
  const r = db.prepare('INSERT INTO posts (farm_id, body, media) VALUES (?,?,?)').run(req.params.id, body, JSON.stringify(media));
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));

app.get('/api/farms/:id/posts', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM posts WHERE farm_id = ? ORDER BY id DESC LIMIT 50').all(req.params.id);
  res.json({ posts: rows.map(publicPost) });
}));

app.delete('/api/posts/:id', requireAuth('farmer'), wrap((req, res) => {
  const post = db.prepare('SELECT p.*, f.owner_id FROM posts p JOIN farms f ON f.id = p.farm_id WHERE p.id = ?').get(req.params.id);
  if (!post) throw fail(404, 'Update not found.');
  if (post.owner_id !== req.user.id) throw fail(403, 'That is not your update.');
  db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
  for (const m of publicPost(post).media) removeUpload(m.url);
  res.json({ ok: true });
}));

app.put('/api/farms/:id/cover', requireAuth('farmer'), wrap((req, res) => {
  const farm = ownedFarm(req.params.id, req.user.id);
  const url = req.body.url ? cleanMedia([{ url: req.body.url }])[0].url : '';
  if (url && !/\.(jpg|png|webp|gif)$/.test(url)) throw fail(400, 'The farm photo must be a photo, not a video.');
  db.prepare('UPDATE farms SET cover_url = ? WHERE id = ?').run(url, farm.id);
  if (farm.cover_url && farm.cover_url !== url) removeUpload(farm.cover_url);
  res.json({ ok: true });
}));

// Newest updates from all farms, or only farms within `radius` miles of lat/lng.
app.get('/api/feed', wrap((req, res) => {
  const lat = num(req.query.lat), lng = num(req.query.lng), radius = num(req.query.radius);
  let rows = db.prepare(`SELECT p.*, f.name AS farm_name, f.kind AS farm_kind, f.city AS farm_city, f.lat, f.lng
    FROM posts p JOIN farms f ON f.id = p.farm_id ORDER BY p.id DESC LIMIT 300`).all();
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng);
  rows = rows.map((r) => ({ ...publicPost(r), farm_name: r.farm_name, farm_kind: r.farm_kind, farm_city: r.farm_city,
    distance_miles: hasLoc ? miles(lat, lng, r.lat, r.lng) : null }));
  if (hasLoc && Number.isFinite(radius) && radius > 0) rows = rows.filter((r) => r.distance_miles <= radius);
  res.json({ posts: rows.slice(0, 60) });
}));

// ---------- farm experiences: farmers ----------
function expFromBody(b) {
  const type = Object.keys(EXP_TYPES).includes(b.type) ? b.type : 'other';
  const price = num(b.price === '' || b.price === undefined ? 0 : b.price);
  const maxPeople = Math.floor(num(b.max_people));
  if (!Number.isFinite(price) || price < 0) throw fail(400, 'Enter a price, or 0 if it is free.');
  if (!(maxPeople >= 1)) throw fail(400, 'Enter how many people you can host in a day.');
  const schedule = str(b.schedule, 200);
  if (!schedule) throw fail(400, 'Say when you offer it, for example "Saturdays, 9am to noon".');
  return {
    type, title: str(b.title, 100) || EXP_TYPES[type], about: str(b.about, 1000), price_cents: Math.round(price * 100),
    per: ['person', 'group', 'hour'].includes(b.per) ? b.per : 'person', duration: str(b.duration, 60), max_people: maxPeople,
    schedule, min_age: Math.max(0, Math.floor(num(b.min_age) || 0)), bring: str(b.bring, 200),
  };
}
function ownedExp(id, userId) {
  const row = db.prepare('SELECT e.*, f.owner_id FROM experiences e JOIN farms f ON f.id = e.farm_id WHERE e.id = ? AND e.removed = 0').get(id);
  if (!row) throw fail(404, 'Experience not found.');
  if (row.owner_id !== userId) throw fail(403, 'That is not your experience.');
  return row;
}
app.post('/api/farms/:id/experiences', requireAuth('farmer'), wrap((req, res) => {
  ownedFarm(req.params.id, req.user.id);
  const e = expFromBody(req.body);
  const r = db.prepare(`INSERT INTO experiences (farm_id,type,title,about,price_cents,per,duration,max_people,schedule,min_age,bring)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.params.id, e.type, e.title, e.about, e.price_cents, e.per, e.duration, e.max_people, e.schedule, e.min_age, e.bring);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
app.put('/api/experiences/:id', requireAuth('farmer'), wrap((req, res) => {
  ownedExp(req.params.id, req.user.id);
  const e = expFromBody(req.body);
  db.prepare(`UPDATE experiences SET type=?,title=?,about=?,price_cents=?,per=?,duration=?,max_people=?,schedule=?,min_age=?,bring=? WHERE id=?`)
    .run(e.type, e.title, e.about, e.price_cents, e.per, e.duration, e.max_people, e.schedule, e.min_age, e.bring, req.params.id);
  res.json({ ok: true });
}));
app.patch('/api/experiences/:id/active', requireAuth('farmer'), wrap((req, res) => {
  ownedExp(req.params.id, req.user.id);
  db.prepare('UPDATE experiences SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/experiences/:id', requireAuth('farmer'), wrap((req, res) => {
  ownedExp(req.params.id, req.user.id);
  db.prepare('UPDATE experiences SET removed = 1, active = 0 WHERE id = ?').run(req.params.id); // bookings keep their history
  res.json({ ok: true });
}));

// ---------- farm experiences: bookings ----------
// A booking is a request; the farmer confirms or declines it. Payment happens directly between guest and farmer.
app.post('/api/bookings', requireAuth('buyer'), wrap((req, res) => {
  const exp = db.prepare('SELECT * FROM experiences WHERE id = ? AND active = 1 AND removed = 0').get(Number(req.body.experience_id));
  if (!exp) throw fail(404, 'This experience is no longer offered.');
  const date = str(req.body.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, 'Pick a date.');
  const today = new Date(Date.now() - 36 * 3600e3).toISOString().slice(0, 10); // allow for time zones
  if (date < today) throw fail(400, 'Pick a date that has not passed.');
  const people = Math.floor(num(req.body.people));
  if (!(people >= 1)) throw fail(400, 'Enter how many people are coming.');
  const contact = str(req.body.contact, 120);
  if (!contact) throw fail(400, 'Add a phone number or email so the farmer can reach you.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const taken = db.prepare(`SELECT COALESCE(SUM(people),0) AS n FROM bookings WHERE experience_id = ? AND date = ? AND status IN ('requested','confirmed')`).get(exp.id, date).n;
    const left = exp.max_people - taken;
    if (people > left) throw fail(409, left > 0 ? `Only ${left} ${left === 1 ? 'spot is' : 'spots are'} left on that date.` : 'That date is full. Try another day.');
    const total = exp.per === 'person' ? exp.price_cents * people : exp.price_cents;
    const r = db.prepare(`INSERT INTO bookings (buyer_id,experience_id,farm_id,date,people,contact,note,title,price_cents,per,total_cents)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, exp.id, exp.farm_id, date, people, contact, str(req.body.note, 500), exp.title, exp.price_cents, exp.per, total);
    db.exec('COMMIT');
    const farm = db.prepare('SELECT payment_note, currency FROM farms WHERE id = ?').get(exp.farm_id);
    res.status(201).json({ id: Number(r.lastInsertRowid), total_cents: total, per: exp.per, currency: farm.currency, payment_note: farm.payment_note });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));
app.get('/api/bookings/mine', requireAuth('buyer'), wrap((req, res) => {
  const rows = db.prepare(`SELECT b.*, f.name AS farm_name, f.address AS farm_address, f.city AS farm_city, f.lat AS farm_lat, f.lng AS farm_lng,
      f.phone AS farm_phone, f.payment_note, f.currency
    FROM bookings b JOIN farms f ON f.id = b.farm_id WHERE b.buyer_id = ? ORDER BY b.date DESC, b.id DESC`).all(req.user.id);
  res.json({ bookings: rows });
}));
app.get('/api/farm-bookings', requireAuth('farmer'), wrap((req, res) => {
  const rows = db.prepare(`SELECT b.*, f.currency, u.name AS buyer_name, u.email AS buyer_email
    FROM bookings b JOIN farms f ON f.id = b.farm_id JOIN users u ON u.id = b.buyer_id
    WHERE f.owner_id = ? ORDER BY b.date ASC, b.id ASC`).all(req.user.id);
  res.json({ bookings: rows });
}));
app.patch('/api/bookings/:id/status', requireAuth(), wrap((req, res) => {
  const status = req.body.status;
  const b = db.prepare('SELECT b.*, f.owner_id FROM bookings b JOIN farms f ON f.id = b.farm_id WHERE b.id = ?').get(req.params.id);
  if (!b) throw fail(404, 'Booking not found.');
  const isFarmer = req.user.role === 'farmer' && b.owner_id === req.user.id;
  const isGuest = req.user.role === 'buyer' && b.buyer_id === req.user.id;
  if (!isFarmer && !isGuest) throw fail(403, 'Not your booking.');
  const allowed = isFarmer
    ? { requested: ['confirmed', 'declined'], confirmed: ['done', 'declined'] }
    : { requested: ['cancelled'], confirmed: ['cancelled'] };
  if (!(allowed[b.status] || []).includes(status)) throw fail(400, `This booking is ${b.status} and can't be changed to ${status}.`);
  db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, b.id);
  res.json({ ok: true });
}));

// ---------- CSA shares (subscriptions) ----------
const CSA_PER = { week: 'per week', month: 'per month', season: 'per season' };
function publicShare(c) {
  const taken = db.prepare("SELECT COUNT(*) AS n FROM csa_signups WHERE share_id = ? AND status IN ('requested','confirmed')").get(c.id).n;
  return { id: c.id, farm_id: c.farm_id, name: c.name, about: c.about, price_cents: c.price_cents, per: c.per, season: c.season, pickup: c.pickup,
    spots: c.spots, spots_left: Math.max(0, c.spots - taken), active: !!c.active };
}
function shareFromBody(b) {
  const name = str(b.name, 100); if (!name) throw fail(400, 'Name the share, for example "Full vegetable share".');
  const price = num(b.price === '' || b.price === undefined ? 0 : b.price); if (!(price >= 0)) throw fail(400, 'Enter a price.');
  const spots = Math.floor(num(b.spots)); if (!(spots >= 1)) throw fail(400, 'Enter how many members you can take.');
  return { name, about: str(b.about, 1000), price_cents: Math.round(price * 100), per: CSA_PER[b.per] ? b.per : 'week',
    season: str(b.season, 100), pickup: str(b.pickup, 200), spots };
}
function ownedShare(id, userId) {
  const row = db.prepare('SELECT c.*, f.owner_id FROM csa_shares c JOIN farms f ON f.id = c.farm_id WHERE c.id = ? AND c.removed = 0').get(id);
  if (!row) throw fail(404, 'Share not found.'); if (row.owner_id !== userId) throw fail(403, 'That is not your share.'); return row;
}
app.post('/api/farms/:id/csa', requireAuth('farmer'), wrap((req, res) => {
  ownedFarm(req.params.id, req.user.id); const c = shareFromBody(req.body);
  const r = db.prepare('INSERT INTO csa_shares (farm_id,name,about,price_cents,per,season,pickup,spots) VALUES (?,?,?,?,?,?,?,?)')
    .run(req.params.id, c.name, c.about, c.price_cents, c.per, c.season, c.pickup, c.spots);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
app.put('/api/csa/:id', requireAuth('farmer'), wrap((req, res) => {
  ownedShare(req.params.id, req.user.id); const c = shareFromBody(req.body);
  db.prepare('UPDATE csa_shares SET name=?,about=?,price_cents=?,per=?,season=?,pickup=?,spots=? WHERE id=?').run(c.name, c.about, c.price_cents, c.per, c.season, c.pickup, c.spots, req.params.id);
  res.json({ ok: true });
}));
app.patch('/api/csa/:id/active', requireAuth('farmer'), wrap((req, res) => {
  ownedShare(req.params.id, req.user.id); db.prepare('UPDATE csa_shares SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, req.params.id); res.json({ ok: true });
}));
app.delete('/api/csa/:id', requireAuth('farmer'), wrap((req, res) => {
  ownedShare(req.params.id, req.user.id); db.prepare('UPDATE csa_shares SET removed = 1, active = 0 WHERE id = ?').run(req.params.id); res.json({ ok: true });
}));
app.post('/api/csa/:id/signup', requireAuth('buyer'), wrap((req, res) => {
  const c = db.prepare('SELECT * FROM csa_shares WHERE id = ? AND active = 1 AND removed = 0').get(req.params.id);
  if (!c) throw fail(404, 'This share is no longer offered.');
  const contact = str(req.body.contact, 120); if (!contact) throw fail(400, 'Add a phone number or email so the farmer can reach you.');
  if (db.prepare("SELECT 1 FROM csa_signups WHERE share_id = ? AND buyer_id = ? AND status IN ('requested','confirmed')").get(c.id, req.user.id)) throw fail(409, 'You already signed up for this share.');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (publicShare(c).spots_left < 1) throw fail(409, 'This share is full for the season.');
    const r = db.prepare('INSERT INTO csa_signups (buyer_id,share_id,farm_id,title,price_cents,per,contact,note) VALUES (?,?,?,?,?,?,?,?)')
      .run(req.user.id, c.id, c.farm_id, c.name, c.price_cents, c.per, contact, str(req.body.note, 500));
    db.exec('COMMIT');
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}));
app.get('/api/csa-signups/mine', requireAuth('buyer'), wrap((req, res) => {
  res.json({ signups: db.prepare(`SELECT s.*, f.name AS farm_name, f.currency, f.phone AS farm_phone, f.payment_note, c.season, c.pickup
    FROM csa_signups s JOIN farms f ON f.id = s.farm_id JOIN csa_shares c ON c.id = s.share_id WHERE s.buyer_id = ? ORDER BY s.id DESC`).all(req.user.id) });
}));
app.get('/api/farm-csa-signups', requireAuth('farmer'), wrap((req, res) => {
  res.json({ signups: db.prepare(`SELECT s.*, f.currency, u.name AS buyer_name, u.email AS buyer_email FROM csa_signups s
    JOIN farms f ON f.id = s.farm_id JOIN users u ON u.id = s.buyer_id WHERE f.owner_id = ? ORDER BY s.id DESC`).all(req.user.id) });
}));
app.patch('/api/csa-signups/:id/status', requireAuth(), wrap((req, res) => {
  const s = db.prepare('SELECT s.*, f.owner_id FROM csa_signups s JOIN farms f ON f.id = s.farm_id WHERE s.id = ?').get(req.params.id);
  if (!s) throw fail(404, 'Sign-up not found.');
  const isFarmer = req.user.role === 'farmer' && s.owner_id === req.user.id, isMember = req.user.role === 'buyer' && s.buyer_id === req.user.id;
  if (!isFarmer && !isMember) throw fail(403, 'Not your sign-up.');
  const allowed = isFarmer ? { requested: ['confirmed', 'declined'], confirmed: ['cancelled'] } : { requested: ['cancelled'], confirmed: ['cancelled'] };
  if (!(allowed[s.status] || []).includes(req.body.status)) throw fail(400, `This sign-up is ${s.status} and can't be changed that way.`);
  db.prepare('UPDATE csa_signups SET status = ? WHERE id = ?').run(req.body.status, s.id);
  res.json({ ok: true });
}));

// ---------- events ----------
function publicEvent(e) {
  const going = db.prepare("SELECT COALESCE(SUM(people),0) AS n FROM event_rsvps WHERE event_id = ? AND status = 'going'").get(e.id).n;
  return { id: e.id, farm_id: e.farm_id, title: e.title, about: e.about, date: e.date, start_time: e.start_time, end_time: e.end_time,
    location: e.location, price_cents: e.price_cents, capacity: e.capacity, going, spots_left: e.capacity > 0 ? Math.max(0, e.capacity - going) : null };
}
function eventFromBody(b) {
  const title = str(b.title, 120); if (!title) throw fail(400, 'Give the event a name.');
  const date = str(b.date, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, 'Pick the date.');
  const time = (v) => (/^\d{2}:\d{2}$/.test(v || '') ? v : '');
  const price = num(b.price === '' || b.price === undefined ? 0 : b.price); if (!(price >= 0)) throw fail(400, 'Enter a price, or 0 if it is free.');
  return { title, about: str(b.about, 1000), date, start_time: time(b.start_time), end_time: time(b.end_time), location: str(b.location, 200),
    price_cents: Math.round(price * 100), capacity: Math.max(0, Math.floor(num(b.capacity) || 0)) };
}
function ownedEvent(id, userId) {
  const row = db.prepare('SELECT e.*, f.owner_id FROM events e JOIN farms f ON f.id = e.farm_id WHERE e.id = ? AND e.removed = 0').get(id);
  if (!row) throw fail(404, 'Event not found.'); if (row.owner_id !== userId) throw fail(403, 'That is not your event.'); return row;
}
app.get('/api/events', wrap((req, res) => {
  const lat = num(req.query.lat), lng = num(req.query.lng), radius = num(req.query.radius) || 50;
  const near = Number.isFinite(lat) && Number.isFinite(lng) ? new Map(directory({ lat, lng, radius }).map((f) => [f.id, f])) : null;
  const farms = new Map(db.prepare('SELECT * FROM farms').all().map((f) => [f.id, f]));
  const rows = db.prepare('SELECT * FROM events WHERE removed = 0 AND date >= ? ORDER BY date, start_time LIMIT 300').all(today())
    .filter((e) => !near || near.has(e.farm_id))
    .map((e) => { const f = farms.get(e.farm_id); return { ...publicEvent(e), farm_name: f.name, farm_kind: f.kind, place_label: f.place_label, currency: f.currency,
      distance_miles: near ? near.get(e.farm_id).distance_miles : null }; });
  res.json({ events: rows });
}));
app.post('/api/farms/:id/events', requireAuth('farmer'), wrap((req, res) => {
  const farm = ownedFarm(req.params.id, req.user.id); const e = eventFromBody(req.body);
  const r = db.prepare('INSERT INTO events (farm_id,title,about,date,start_time,end_time,location,price_cents,capacity) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(farm.id, e.title, e.about, e.date, e.start_time, e.end_time, e.location || farm.name, e.price_cents, e.capacity);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
}));
app.put('/api/events/:id', requireAuth('farmer'), wrap((req, res) => {
  ownedEvent(req.params.id, req.user.id); const e = eventFromBody(req.body);
  db.prepare('UPDATE events SET title=?,about=?,date=?,start_time=?,end_time=?,location=?,price_cents=?,capacity=? WHERE id=?')
    .run(e.title, e.about, e.date, e.start_time, e.end_time, e.location, e.price_cents, e.capacity, req.params.id);
  res.json({ ok: true });
}));
app.delete('/api/events/:id', requireAuth('farmer'), wrap((req, res) => {
  ownedEvent(req.params.id, req.user.id); db.prepare('UPDATE events SET removed = 1 WHERE id = ?').run(req.params.id); res.json({ ok: true });
}));
app.post('/api/events/:id/rsvp', requireAuth('buyer'), wrap((req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ? AND removed = 0').get(req.params.id);
  if (!e || e.date < today()) throw fail(404, 'This event is over or was cancelled.');
  const people = Math.floor(num(req.body.people)); if (!(people >= 1)) throw fail(400, 'Enter how many people are coming.');
  if (db.prepare("SELECT 1 FROM event_rsvps WHERE event_id = ? AND buyer_id = ? AND status = 'going'").get(e.id, req.user.id)) throw fail(409, "You're already going to this event.");
  db.exec('BEGIN IMMEDIATE');
  try {
    const left = publicEvent(e).spots_left;
    if (left !== null && people > left) throw fail(409, left ? `Only ${left} ${left === 1 ? 'spot is' : 'spots are'} left.` : 'This event is full.');
    const r = db.prepare('INSERT INTO event_rsvps (buyer_id,event_id,farm_id,people,contact) VALUES (?,?,?,?,?)').run(req.user.id, e.id, e.farm_id, people, str(req.body.contact, 120));
    db.exec('COMMIT'); res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (ex) { db.exec('ROLLBACK'); throw ex; }
}));
app.get('/api/rsvps/mine', requireAuth('buyer'), wrap((req, res) => {
  res.json({ rsvps: db.prepare(`SELECT r.*, e.title, e.date, e.start_time, e.end_time, e.location, e.price_cents, f.name AS farm_name, f.currency, f.lat, f.lng, f.address
    FROM event_rsvps r JOIN events e ON e.id = r.event_id JOIN farms f ON f.id = r.farm_id WHERE r.buyer_id = ? ORDER BY e.date DESC`).all(req.user.id) });
}));
app.get('/api/farm-rsvps', requireAuth('farmer'), wrap((req, res) => {
  res.json({ rsvps: db.prepare(`SELECT r.*, e.title, e.date, u.name AS buyer_name, u.email AS buyer_email FROM event_rsvps r JOIN events e ON e.id = r.event_id
    JOIN farms f ON f.id = r.farm_id JOIN users u ON u.id = r.buyer_id WHERE f.owner_id = ? ORDER BY e.date, r.id`).all(req.user.id) });
}));
app.patch('/api/rsvps/:id/cancel', requireAuth('buyer'), wrap((req, res) => {
  const r = db.prepare('SELECT * FROM event_rsvps WHERE id = ? AND buyer_id = ?').get(req.params.id, req.user.id);
  if (!r) throw fail(404, 'RSVP not found.');
  db.prepare("UPDATE event_rsvps SET status = 'cancelled' WHERE id = ?").run(r.id); res.json({ ok: true });
}));

// ---------- orders ----------
// Reserving holds stock. Payment happens directly between buyer and farmer; the platform takes no cut.
app.post('/api/orders', requireAuth('buyer'), wrap((req, res) => {
  const farmId = Number(req.body.farm_id);
  const fulfillment = req.body.fulfillment === 'delivery' ? 'delivery' : 'pickup';
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw fail(400, 'Your cart is empty.');

  const farm = db.prepare('SELECT * FROM farms WHERE id = ?').get(farmId);
  if (!farm) throw fail(404, 'Farm not found.');
  if (fulfillment === 'pickup' && !farm.pickup_enabled) throw fail(400, 'This farm does not offer pickup.');

  let deliveryFee = 0;
  let deliveryAddress = '';
  if (fulfillment === 'delivery') {
    if (!farm.delivery_enabled) throw fail(400, 'This farm does not offer delivery.');
    deliveryAddress = str(req.body.delivery_address, 300);
    if (!deliveryAddress) throw fail(400, 'Enter a delivery address.');
    const blat = num(req.body.buyer_lat);
    const blng = num(req.body.buyer_lng);
    if (Number.isFinite(blat) && Number.isFinite(blng)) {
      const d = miles(blat, blng, farm.lat, farm.lng);
      if (d > farm.delivery_radius_miles) {
        throw fail(400, `This farm delivers within ${farm.delivery_radius_miles} miles; you are about ${d.toFixed(1)} miles away.`);
      }
    }
    deliveryFee = farm.delivery_fee_cents;
  }

  const getListing = db.prepare('SELECT * FROM listings WHERE id = ? AND farm_id = ? AND active = 1');
  const decrement = db.prepare(
    'UPDATE listings SET qty_available = qty_available - ? WHERE id = ? AND qty_available >= ?'
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    const lines = [];
    let total = 0;
    for (const it of items) {
      const qty = num(it.qty);
      if (!Number.isFinite(qty) || qty <= 0) throw fail(400, 'Invalid quantity.');
      const l = getListing.get(Number(it.listing_id), farmId);
      if (!l) throw fail(400, 'An item in your cart is no longer available.');
      const r = decrement.run(qty, l.id, qty);
      if (r.changes === 0) throw fail(409, `Only ${l.qty_available} ${l.unit} of ${l.name} left.`);
      lines.push({ l, qty });
      total += Math.round(l.price_cents * qty);
    }
    const o = db
      .prepare(`INSERT INTO orders (buyer_id,farm_id,fulfillment,delivery_address,scheduled_for,note,items_total_cents,delivery_fee_cents)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(req.user.id, farmId, fulfillment, deliveryAddress, str(req.body.scheduled_for, 100),
        str(req.body.note, 500), total, deliveryFee);
    const insItem = db.prepare(
      'INSERT INTO order_items (order_id,listing_id,name,unit,price_cents,qty) VALUES (?,?,?,?,?,?)'
    );
    for (const { l, qty } of lines) insItem.run(o.lastInsertRowid, l.id, l.name, l.unit, l.price_cents, qty);
    db.exec('COMMIT');
    res.status(201).json({
      id: Number(o.lastInsertRowid),
      total_cents: total + deliveryFee,
      payment_note: farm.payment_note,
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}));

function ordersWithItems(rows) {
  const stmt = db.prepare('SELECT name,unit,price_cents,qty FROM order_items WHERE order_id = ?');
  return rows.map((o) => ({ ...o, items: stmt.all(o.id) }));
}

app.get('/api/orders/mine', requireAuth('buyer'), wrap((req, res) => {
  const rows = db
    .prepare(`SELECT o.*, f.name AS farm_name, f.address AS farm_address, f.city AS farm_city,
        f.phone AS farm_phone, f.lat AS farm_lat, f.lng AS farm_lng, f.pickup_instructions, f.payment_note, f.currency
      FROM orders o JOIN farms f ON f.id = o.farm_id WHERE o.buyer_id = ? ORDER BY o.id DESC`)
    .all(req.user.id);
  res.json({ orders: ordersWithItems(rows) });
}));

app.get('/api/farm-orders', requireAuth('farmer'), wrap((req, res) => {
  const rows = db
    .prepare(`SELECT o.*, f.name AS farm_name, f.currency, u.name AS buyer_name, u.email AS buyer_email
      FROM orders o JOIN farms f ON f.id = o.farm_id JOIN users u ON u.id = o.buyer_id
      WHERE f.owner_id = ? ORDER BY o.id DESC`)
    .all(req.user.id);
  res.json({ orders: ordersWithItems(rows) });
}));

app.patch('/api/orders/:id/status', requireAuth(), wrap((req, res) => {
  const status = req.body.status;
  if (!['ready', 'completed', 'cancelled'].includes(status)) throw fail(400, 'Invalid status.');
  const order = db
    .prepare('SELECT o.*, f.owner_id FROM orders o JOIN farms f ON f.id = o.farm_id WHERE o.id = ?')
    .get(req.params.id);
  if (!order) throw fail(404, 'Order not found.');

  const isFarmer = req.user.role === 'farmer' && order.owner_id === req.user.id;
  const isBuyer = req.user.role === 'buyer' && order.buyer_id === req.user.id;
  if (!isFarmer && !isBuyer) throw fail(403, 'Not your order.');
  if (isBuyer && status !== 'cancelled') throw fail(403, 'Buyers can only cancel.');
  if (['completed', 'cancelled'].includes(order.status)) throw fail(400, `Order is already ${order.status}.`);

  db.exec('BEGIN IMMEDIATE');
  try {
    if (status === 'cancelled') {
      const lines = db.prepare('SELECT listing_id, qty FROM order_items WHERE order_id = ?').all(order.id);
      const restore = db.prepare('UPDATE listings SET qty_available = qty_available + ? WHERE id = ?');
      for (const l of lines) restore.run(l.qty, l.listing_id);
    }
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, order.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  res.json({ ok: true });
}));

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// Every other page address (/, /celina-tx, /farm/12, /dashboard...) is handled by the single-page app.
app.get(/^\/(?!uploads\/).*/, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`FarmDirect running on port ${PORT}`));
}
module.exports = app;
