// Built-in list of ~24,600 towns and cities (US/Canada down to 5,000 people, larger cities elsewhere).
// Used for city pages (/celina-tx), place search and naming where a farm is.
const fs = require('node:fs');
const path = require('node:path');

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slugify = (s) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let regionNames = null;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* older runtimes */ }
const country = (cc) => { try { return (regionNames && regionNames.of(cc)) || cc; } catch { return cc; } };

const CITIES = fs.readFileSync(path.join(__dirname, '..', 'data', 'cities.txt'), 'utf8').trim().split('\n').map((line) => {
  const [n, cc, adm, la, ln, pk] = line.split('|');
  const local = cc === 'US' || cc === 'CA';
  const slug = `${slugify(n)}-${(local && adm ? adm : cc).toLowerCase()}`;
  const label = local && adm ? `${n}, ${adm}${cc === 'CA' ? ', Canada' : ''}` : `${n}, ${country(cc)}`;
  return { name: n, cc, adm, lat: +la, lng: +ln, pop: +pk * 1000, slug, label, f: fold(n) };
});
const BY_SLUG = new Map();
for (const c of CITIES) if (!BY_SLUG.has(c.slug)) BY_SLUG.set(c.slug, c); // list is sorted by population, so the biggest wins

function miles(a, b, c, d) {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

const pub = (c) => ({ slug: c.slug, name: c.name, label: c.label, lat: c.lat, lng: c.lng });

function bySlug(slug) { const c = BY_SLUG.get(String(slug || '').toLowerCase()); return c ? pub(c) : null; }

function nearest(lat, lng) {
  let best = null, d = Infinity;
  for (const c of CITIES) {
    if (Math.abs(c.lat - lat) > 1.5) continue;
    const m = miles(lat, lng, c.lat, c.lng);
    if (m < d) { d = m; best = c; }
  }
  return best ? { ...pub(best), miles: d } : null;
}

function search(q, max = 8) {
  const [first, ...rest] = String(q || '').split(',');
  const name = fold(first.trim()); const extra = fold(rest.join(' ').trim());
  if (name.length < 2) return [];
  const ok = (c) => !extra || fold(c.adm).startsWith(extra) || fold(country(c.cc)).startsWith(extra) || c.cc.toLowerCase().startsWith(extra);
  const out = [];
  for (const c of CITIES) if (c.f.startsWith(name) && ok(c)) { out.push(c); if (out.length >= max) break; }
  if (out.length < max) for (const c of CITIES) if (!c.f.startsWith(name) && c.f.includes(name) && ok(c)) { out.push(c); if (out.length >= max) break; }
  return out.map(pub);
}

module.exports = { bySlug, nearest, search, miles };
