const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { hashPassword } = require('./auth');
const cities = require('./cities');

// Listing types and product categories (validated in code so new ones can be added without a migration).
const KINDS = ['farm', 'barn', 'orchard', 'ranch', 'garden', 'market', 'farmstand', 'restaurant', 'grocery', 'other'];
const CATEGORIES = ['vegetables', 'fruit', 'eggs', 'dairy', 'meat', 'poultry', 'seafood', 'bakery', 'honey', 'herbs', 'plants', 'flowers', 'preserves', 'nuts', 'grains', 'beverages', 'crafts', 'other'];

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'farmdirect.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('farmer','buyer')),
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS farms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'farm',
  description TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  phone TEXT DEFAULT '',
  pickup_enabled INTEGER NOT NULL DEFAULT 1,
  pickup_instructions TEXT DEFAULT '',
  delivery_enabled INTEGER NOT NULL DEFAULT 0,
  delivery_radius_miles REAL NOT NULL DEFAULT 0,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  payment_note TEXT DEFAULT 'Pay the farmer directly at pickup or delivery.',
  currency TEXT NOT NULL DEFAULT 'USD',
  cover_url TEXT NOT NULL DEFAULT '',
  accepts_snap INTEGER NOT NULL DEFAULT 0,
  wholesale INTEGER NOT NULL DEFAULT 0,
  website TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '',
  place_slug TEXT NOT NULL DEFAULT '',
  place_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'vegetables',
  unit TEXT NOT NULL DEFAULT 'lb',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  qty_available REAL NOT NULL CHECK (qty_available >= 0),
  description TEXT DEFAULT '',
  harvest_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listings_farm ON listings(farm_id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  farm_id INTEGER NOT NULL REFERENCES farms(id),
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('pickup','delivery')),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','ready','completed','cancelled')),
  delivery_address TEXT DEFAULT '',
  scheduled_for TEXT DEFAULT '',
  note TEXT DEFAULT '',
  items_total_cents INTEGER NOT NULL,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  media TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_farm ON posts(farm_id, id);

CREATE TABLE IF NOT EXISTS experiences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('day','learn','horse','tour','pick','other')),
  title TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  per TEXT NOT NULL DEFAULT 'person' CHECK (per IN ('person','group','hour')),
  duration TEXT NOT NULL DEFAULT '',
  max_people INTEGER NOT NULL DEFAULT 10 CHECK (max_people >= 1),
  schedule TEXT NOT NULL DEFAULT '',
  min_age INTEGER NOT NULL DEFAULT 0,
  bring TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exp_farm ON experiences(farm_id);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  experience_id INTEGER NOT NULL REFERENCES experiences(id),
  farm_id INTEGER NOT NULL REFERENCES farms(id),
  date TEXT NOT NULL,
  people INTEGER NOT NULL CHECK (people >= 1),
  contact TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  per TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','declined','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bookings_exp_date ON bookings(experience_id, date);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  qty REAL NOT NULL
);
`);

// Older databases created before currencies were added get the column here.
if (!db.prepare("SELECT 1 FROM pragma_table_info('farms') WHERE name = 'currency'").get()) {
  db.exec("ALTER TABLE farms ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
}

if (!db.prepare("SELECT 1 FROM pragma_table_info('farms') WHERE name = 'cover_url'").get()) {
  db.exec("ALTER TABLE farms ADD COLUMN cover_url TEXT NOT NULL DEFAULT ''");
}

// ---------- Upgrades for databases created by earlier versions ----------
function addColumn(table, col, def) {
  if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
for (const [col, def] of [['accepts_snap', 'INTEGER NOT NULL DEFAULT 0'], ['wholesale', 'INTEGER NOT NULL DEFAULT 0'], ['website', "TEXT NOT NULL DEFAULT ''"],
  ['hours', "TEXT NOT NULL DEFAULT ''"], ['place_slug', "TEXT NOT NULL DEFAULT ''"], ['place_label', "TEXT NOT NULL DEFAULT ''"]]) addColumn('farms', col, def);

// Early versions limited farm kinds and produce categories with CHECK constraints. Rebuild those tables without them.
function rebuildWithout(table, marker, createSql, after) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row || !row.sql.includes(marker)) return;
  const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map((c) => c.name).join(', ');
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;');
  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${table}_old`);
    db.exec(`DROP TABLE ${table}_old`);
    if (after) db.exec(after);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;'); }
}
rebuildWithout('farms', "CHECK (kind IN", `CREATE TABLE farms (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'farm', description TEXT DEFAULT '', address TEXT DEFAULT '', city TEXT DEFAULT '', lat REAL NOT NULL, lng REAL NOT NULL,
  phone TEXT DEFAULT '', pickup_enabled INTEGER NOT NULL DEFAULT 1, pickup_instructions TEXT DEFAULT '', delivery_enabled INTEGER NOT NULL DEFAULT 0,
  delivery_radius_miles REAL NOT NULL DEFAULT 0, delivery_fee_cents INTEGER NOT NULL DEFAULT 0, payment_note TEXT DEFAULT 'Pay the farmer directly at pickup or delivery.',
  currency TEXT NOT NULL DEFAULT 'USD', cover_url TEXT NOT NULL DEFAULT '', accepts_snap INTEGER NOT NULL DEFAULT 0, wholesale INTEGER NOT NULL DEFAULT 0,
  website TEXT NOT NULL DEFAULT '', hours TEXT NOT NULL DEFAULT '', place_slug TEXT NOT NULL DEFAULT '', place_label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
rebuildWithout('listings', "CHECK (category IN", `CREATE TABLE listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE, name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'vegetables', unit TEXT NOT NULL DEFAULT 'lb', price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  qty_available REAL NOT NULL CHECK (qty_available >= 0), description TEXT DEFAULT '', harvest_date TEXT, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_listings_farm ON listings(farm_id);
   UPDATE listings SET category = 'vegetables' WHERE category = 'vegetable';
   UPDATE listings SET category = 'herbs' WHERE category = 'herb';`);
db.exec("UPDATE listings SET category = 'vegetables' WHERE category = 'vegetable'; UPDATE listings SET category = 'herbs' WHERE category = 'herb';");

// ---------- CSA shares and events ----------
db.exec(`
CREATE TABLE IF NOT EXISTS csa_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  per TEXT NOT NULL DEFAULT 'week' CHECK (per IN ('week','month','season')),
  season TEXT NOT NULL DEFAULT '',
  pickup TEXT NOT NULL DEFAULT '',
  spots INTEGER NOT NULL DEFAULT 20 CHECK (spots >= 1),
  active INTEGER NOT NULL DEFAULT 1,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS csa_signups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  share_id INTEGER NOT NULL REFERENCES csa_shares(id),
  farm_id INTEGER NOT NULL REFERENCES farms(id),
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  per TEXT NOT NULL,
  contact TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','confirmed','declined','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  about TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  capacity INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE TABLE IF NOT EXISTS event_rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  farm_id INTEGER NOT NULL REFERENCES farms(id),
  people INTEGER NOT NULL DEFAULT 1 CHECK (people >= 1),
  contact TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'going' CHECK (status IN ('going','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------- group orders (neighbors order together for one drop-off) ----------
for (const [col, def] of [['group_orders', 'INTEGER NOT NULL DEFAULT 0'], ['group_min_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['group_discount_pct', 'INTEGER NOT NULL DEFAULT 0'], ['group_discount_over_cents', 'INTEGER NOT NULL DEFAULT 0'], ['group_radius_miles', 'REAL NOT NULL DEFAULT 25']]) addColumn('farms', col, def);
addColumn('orders', 'group_id', 'INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS group_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  host_id INTEGER NOT NULL REFERENCES users(id),
  host_kind TEXT NOT NULL CHECK (host_kind IN ('farm','neighbor')),
  dropoff_name TEXT NOT NULL,
  dropoff_address TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  place_label TEXT NOT NULL DEFAULT '',
  deliver_date TEXT NOT NULL,
  deadline TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','delivered','cancelled')),
  discount_pct INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_groups_farm ON group_orders(farm_id, status);
`);

// Name each listing's place after the nearest town in the built-in list (powers city pages like /celina-tx).
function setPlace(farmId) {
  const f = db.prepare('SELECT lat, lng FROM farms WHERE id = ?').get(farmId);
  const c = f && cities.nearest(f.lat, f.lng);
  if (c) db.prepare('UPDATE farms SET place_slug = ?, place_label = ? WHERE id = ?').run(c.slug, c.label, farmId);
}
for (const f of db.prepare("SELECT id FROM farms WHERE place_slug = ''").all()) setPlace(f.id);

// ---------- Demo seed (fictional farms, approximate North Texas locations) ----------
function seed() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const addUser = db.prepare(
    'INSERT INTO users (email, name, role, salt, password_hash) VALUES (?,?,?,?,?)'
  );
  const addFarm = db.prepare(`INSERT INTO farms
    (owner_id,name,kind,description,address,city,lat,lng,phone,pickup_enabled,pickup_instructions,
     delivery_enabled,delivery_radius_miles,delivery_fee_cents,payment_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const addListing = db.prepare(`INSERT INTO listings
    (farm_id,name,category,unit,price_cents,qty_available,description,harvest_date)
    VALUES (?,?,?,?,?,?,?,date('now', ?))`);

  const pw = hashPassword('farmdemo123');
  const farms = [
    {
      owner: ['bluebonnet@demo.farm', 'Maria Alvarez'],
      farm: ['Bluebonnet Row Farm', 'farm', 'Family-run vegetable farm, no-spray practices. Honor-system farm stand open daily.', '1200 County Rd 123', 'Celina', 33.3246, -96.7845, '972-555-0101', 1, 'Farm stand by the red barn. Text on arrival.', 1, 10, 500, 'Cash or Venmo to the farmer at pickup.'],
      items: [
        ['Heirloom Tomatoes', 'vegetables', 'lb', 450, 40, 'Mixed heirloom varieties, vine-ripened.', '-1 day'],
        ['Collard Greens', 'vegetables', 'bunch', 300, 25, 'Cool-season collards, cut this morning.', '0 day'],
        ['Sweet Potatoes', 'vegetables', 'lb', 200, 120, 'Cured and ready to store.', '-4 day'],
        ['Radishes', 'vegetables', 'bunch', 250, 30, '', '-1 day'],
      ],
    },
    {
      owner: ['pecan@demo.farm', 'Tom Whitfield'],
      farm: ['Whitfield Pecan & Orchard', 'orchard', 'Third-generation orchard: pecans, persimmons and late-season citrus.', '8800 FM 455', 'Anna', 33.3489, -96.5486, '469-555-0142', 1, 'Orchard barn, gate on the left. Weekends 9-5.', 0, 0, 0, 'Cash, check or Venmo at pickup.'],
      items: [
        ['Pecans (shelled)', 'nuts', 'lb', 1400, 60, 'Fresh-crop papershell pecans.', '-6 day'],
        ['Fuyu Persimmons', 'fruit', 'lb', 350, 45, 'Firm, sweet, ready to eat.', '-2 day'],
        ['Satsuma Mandarins', 'fruit', 'lb', 300, 80, '', '-3 day'],
      ],
    },
    {
      owner: ['prosper@demo.farm', 'Dana Reyes'],
      farm: ['Prosper Hollow Garden', 'garden', 'Small market garden growing salad greens, herbs and root veg year-round.', '450 Hollow Creek Ln', 'Prosper', 33.2362, -96.8011, '214-555-0178', 1, 'Pick up from the cooler on the porch.', 1, 8, 400, 'Venmo or cash on delivery or pickup.'],
      items: [
        ['Salad Mix', 'vegetables', 'bag', 600, 20, 'Lettuce, arugula, baby kale.', '0 day'],
        ['Basil', 'herbs', 'bunch', 300, 15, '', '0 day'],
        ['Carrots', 'vegetables', 'bunch', 350, 30, 'Rainbow carrots with tops.', '-1 day'],
        ['Turnips', 'vegetables', 'lb', 250, 25, '', '-1 day'],
      ],
    },
    {
      owner: ['mckinney@demo.farm', 'Luis Ortega'],
      farm: ['Ortega Family Ranch & Barn', 'ranch', 'Barn market with produce from our fields and neighbors within 15 miles.', '2500 Wilson Creek Rd', 'McKinney', 33.1972, -96.6398, '972-555-0190', 1, 'Barn store, open Wed-Sun.', 1, 15, 700, 'Pay at the barn or on delivery.'],
      items: [
        ['Butternut Squash', 'vegetables', 'lb', 150, 90, '', '-5 day'],
        ['Green Cabbage', 'vegetables', 'each', 275, 40, '', '-2 day'],
        ['Kale', 'vegetables', 'bunch', 300, 35, '', '-1 day'],
        ['Apples', 'fruit', 'lb', 250, 70, 'Fall apples from a partner orchard.', '-3 day'],
      ],
    },
    {
      owner: ['melissa@demo.farm', 'Kayla Brooks'],
      farm: ['Brooks Berry & Veg', 'farm', 'Pick-your-own berries in season; winter greens and broccoli now.', '77 Brooks Ln', 'Melissa', 33.2876, -96.5731, '469-555-0123', 1, 'Self-serve cooler at the gate.', 0, 0, 0, 'Venmo or cash in the lockbox.'],
      items: [
        ['Broccoli', 'vegetables', 'lb', 300, 50, '', '-1 day'],
        ['Cauliflower', 'vegetables', 'each', 400, 25, '', '-1 day'],
        ['Spinach', 'vegetables', 'bag', 450, 18, '', '0 day'],
      ],
    },
    {
      owner: ['frisco@demo.farm', 'Priya Natarajan'],
      farm: ['Frisco Urban Acre', 'garden', 'Hydroponic and in-ground produce from an urban acre.', '9100 Research Rd', 'Frisco', 33.1507, -96.8236, '214-555-0166', 1, 'Pickup window 4-7pm Tue/Thu/Sat.', 1, 12, 600, 'Pay by Venmo or cash on pickup.'],
      items: [
        ['Cherry Tomatoes', 'vegetables', 'pint', 400, 40, '', '0 day'],
        ['Hydro Lettuce', 'vegetables', 'each', 300, 40, '', '0 day'],
        ['Mint', 'herbs', 'bunch', 250, 20, '', '0 day'],
      ],
    },
  ];

  db.exec('BEGIN');
  try {
    for (const f of farms) {
      const u = addUser.run(f.owner[0], f.owner[1], 'farmer', pw.salt, pw.hash);
      const farmRes = addFarm.run(u.lastInsertRowid, ...f.farm);
      for (const it of f.items) addListing.run(farmRes.lastInsertRowid, ...it);
    }
    const addExp = db.prepare(`INSERT INTO experiences (farm_id,type,title,about,price_cents,per,duration,max_people,schedule,min_age,bring)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    addExp.run(1, 'learn', 'Learn to grow your own vegetables', 'Plant, weed and harvest alongside the farmer and take home seedlings.', 3500, 'person', '3 hours', 10, 'Saturdays, 9am to noon', 10, 'Closed-toe shoes and a water bottle');
    addExp.run(1, 'day', 'Spend a day on the farm', 'Feed the chickens, collect eggs, work the fields and share a farm lunch.', 6000, 'person', 'Full day', 6, 'Fridays and Sundays', 0, '');
    addExp.run(2, 'pick', 'Pick your own persimmons', 'Baskets provided. Pay for what you pick.', 500, 'person', '1 to 2 hours', 30, 'Weekends in season', 0, '');
    addExp.run(4, 'horse', 'Trail ride on our quarter horses', 'A guided ride along the creek. Beginners welcome; we start with a short lesson.', 4500, 'person', '1 hour', 4, 'Daily, 8am and 4pm', 8, 'Long pants and closed-toe shoes');
    addExp.run(4, 'tour', 'Barn tour and feed the animals', 'Meet the horses, goats and chickens and help at feeding time.', 1500, 'person', '45 minutes', 12, 'Wednesday to Sunday', 0, '');
    addUser.run('buyer@demo.farm', 'Demo Buyer', 'buyer', pw.salt, pw.hash);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  for (const f of db.prepare("SELECT id FROM farms WHERE place_slug = ''").all()) setPlace(f.id);
}

// Extra demo listings (market, farm stand, restaurant, grocery, CSA, events). Added once, also to databases seeded by older versions.
function seedExtras() {
  const demo = db.prepare("SELECT id FROM users WHERE email = 'bluebonnet@demo.farm'").get();
  if (!demo || db.prepare("SELECT 1 FROM users WHERE email = 'market@demo.farm'").get()) return;
  const pw = hashPassword('farmdemo123');
  const farmOf = (email) => db.prepare('SELECT f.id FROM farms f JOIN users u ON u.id = f.owner_id WHERE u.email = ?').get(email)?.id;
  const addUser = db.prepare('INSERT INTO users (email, name, role, salt, password_hash) VALUES (?,?,?,?,?)');
  const addFarm = db.prepare(`INSERT INTO farms (owner_id,name,kind,description,address,city,lat,lng,phone,pickup_enabled,pickup_instructions,
    delivery_enabled,delivery_radius_miles,delivery_fee_cents,payment_note,accepts_snap,wholesale,website,hours) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const addListing = db.prepare(`INSERT INTO listings (farm_id,name,category,unit,price_cents,qty_available,description,harvest_date) VALUES (?,?,?,?,?,?,?,date('now', ?))`);
  const addEvent = db.prepare(`INSERT INTO events (farm_id,title,about,date,start_time,end_time,location,price_cents,capacity) VALUES (?,?,?,date('now', ?),?,?,?,?,?)`);
  const addShare = db.prepare('INSERT INTO csa_shares (farm_id,name,about,price_cents,per,season,pickup,spots) VALUES (?,?,?,?,?,?,?,?)');
  const nextSat = `+${((6 - new Date().getDay() + 7) % 7) || 7} day`;
  db.exec('BEGIN');
  try {
    const mk = (email, owner, farm) => { const u = addUser.run(email, owner, 'farmer', pw.salt, pw.hash); return Number(addFarm.run(u.lastInsertRowid, ...farm).lastInsertRowid); };
    const market = mk('market@demo.farm', 'Frisco Market Team', ['Frisco Saturday Farmers Market', 'market', 'Thirty local growers, bakers and ranchers every Saturday morning, rain or shine.', '6101 Frisco Square Blvd', 'Frisco', 33.1517, -96.8299, '214-555-0111', 0, '', 0, 0, 0, 'Each vendor takes their own payment.', 1, 0, '', 'Saturdays 8am to noon']);
    const stand = mk('stand@demo.farm', 'Ray Collins', ['Highway 289 Farm Stand', 'farmstand', 'Roadside stand with eggs, honey, pumpkins and whatever is fresh this week.', '4400 N Preston Rd', 'Celina', 33.3402, -96.7859, '469-555-0177', 1, 'Honor box at the stand. Open dawn to dusk.', 0, 0, 0, 'Cash or Venmo in the honor box.', 0, 0, '', 'Daily, dawn to dusk']);
    const rest = mk('kitchen@demo.farm', 'Ana Gomez', ['Harvest Table Kitchen', 'restaurant', 'Farm-to-table cafe cooking with produce from farms within 30 miles.', '210 E Virginia St', 'McKinney', 33.1976, -96.6153, '972-555-0133', 0, '', 0, 0, 0, 'Pay at the restaurant.', 0, 0, '', 'Tue to Sun, 11am to 9pm']);
    const groc = mk('coop@demo.farm', 'Co-op Staff', ['Collin County Food Co-op', 'grocery', 'Member-owned grocery stocking local produce, eggs, dairy and meat.', '1201 W Bethany Dr', 'Allen', 33.1032, -96.6855, '972-555-0155', 0, '', 0, 0, 0, 'Pay at the register.', 1, 0, '', 'Daily 8am to 8pm']);
    addListing.run(stand, 'Farm eggs', 'eggs', 'dozen', 600, 30, 'Pasture-raised, mixed colors.', '0 day');
    addListing.run(stand, 'Wildflower honey', 'honey', 'jar', 1200, 24, '1 lb jar, raw.', '-10 day');
    addListing.run(stand, 'Pie pumpkins', 'vegetables', 'each', 400, 40, '', '-3 day');
    addListing.run(groc, 'Local whole milk', 'dairy', 'half gallon', 550, 20, 'From a dairy in Sulphur Springs.', '-1 day');
    addListing.run(groc, 'Sourdough loaf', 'bakery', 'each', 800, 15, '', '0 day');
    const blue = farmOf('bluebonnet@demo.farm'), ranch = farmOf('mckinney@demo.farm'), orchard = farmOf('pecan@demo.farm');
    if (blue) {
      addListing.run(blue, 'Pasture eggs', 'eggs', 'dozen', 650, 20, '', '0 day');
      addShare.run(blue, 'Full vegetable share', 'A box of 8 to 10 seasonal vegetables each week, enough for a family of four.', 2500, 'week', 'March to November', 'Saturday mornings at the farm stand, or Frisco market', 30);
      addShare.run(blue, 'Half share', 'A smaller weekly box for one or two people.', 1500, 'week', 'March to November', 'Saturday mornings at the farm stand', 20);
      addEvent.run(blue, 'Fall harvest festival', 'Hayrides, a pumpkin patch, live music and a farm lunch.', '+14 day', '10:00', '16:00', 'Bluebonnet Row Farm', 500, 200);
      db.prepare('UPDATE farms SET accepts_snap = 1 WHERE id = ?').run(blue);
    }
    if (ranch) {
      addListing.run(ranch, 'Grass-fed ground beef', 'meat', 'lb', 900, 50, '', '-7 day');
      addListing.run(ranch, 'Ranch honey', 'honey', 'jar', 1100, 20, '', '-20 day');
      addEvent.run(ranch, 'Horse care workshop for kids', 'Grooming, feeding and safety basics with our gentle horses. Ages 7 and up.', '+10 day', '09:00', '11:00', 'Ortega Family Ranch & Barn', 2000, 12);
      db.prepare('UPDATE farms SET wholesale = 1 WHERE id = ?').run(ranch);
    }
    if (orchard) db.prepare("UPDATE listings SET category = 'nuts' WHERE farm_id = ? AND name LIKE 'Pecan%'").run(orchard);
    addEvent.run(market, 'Saturday farmers market', 'Thirty local vendors: produce, eggs, meat, bread, honey and flowers.', nextSat, '08:00', '12:00', 'Frisco Square', 0, 0);
    addEvent.run(market, 'Holiday makers market', 'Local crafts, baked goods and gifts alongside the regular market.', '+28 day', '09:00', '14:00', 'Frisco Square', 0, 0);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  for (const f of db.prepare("SELECT id FROM farms WHERE place_slug = ''").all()) setPlace(f.id);
}

// Demo group orders (added once).
function seedGroups() {
  if (db.prepare('SELECT 1 FROM group_orders').get()) return;
  const farm = (email) => db.prepare('SELECT f.id, f.owner_id FROM farms f JOIN users u ON u.id = f.owner_id WHERE u.email = ?').get(email);
  const blue = farm('bluebonnet@demo.farm'), ranch = farm('mckinney@demo.farm');
  const buyer = db.prepare("SELECT id FROM users WHERE email = 'buyer@demo.farm'").get();
  if (!blue || !ranch || !buyer) return;
  db.prepare('UPDATE farms SET group_orders = 1, group_min_cents = 15000, group_discount_pct = 10, group_discount_over_cents = 30000, group_radius_miles = 25 WHERE id IN (?, ?)').run(blue.id, ranch.id);
  const add = db.prepare(`INSERT INTO group_orders (farm_id,host_id,host_kind,dropoff_name,dropoff_address,lat,lng,place_label,deliver_date,deadline,note)
    VALUES (?,?,?,?,?,?,?,?,date('now', ?),date('now', ?),?)`);
  add.run(blue.id, blue.owner_id, 'farm', 'Celina Public Library parking lot', '142 N Ohio St, Celina', 33.3245, -96.7843, 'Celina, TX', '+6 day', '+4 day', 'Weekly drop-off. Look for the green truck, 5 to 6pm.');
  add.run(ranch.id, buyer.id, 'neighbor', 'Wilson Creek neighborhood, Maple Ct', 'Maple Ct cul-de-sac, McKinney', 33.205, -96.65, 'McKinney, TX', '+8 day', '+5 day', 'Hosted by a neighbor. Pick up from my porch the evening of delivery.');
}

module.exports = { db, seed, seedExtras, seedGroups, setPlace, KINDS, CATEGORIES };
