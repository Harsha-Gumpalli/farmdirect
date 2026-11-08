const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { hashPassword } = require('./auth');

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
  kind TEXT NOT NULL DEFAULT 'farm' CHECK (kind IN ('farm','barn','orchard','ranch','garden')),
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('vegetable','fruit','herb','other')),
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
        ['Heirloom Tomatoes', 'vegetable', 'lb', 450, 40, 'Mixed heirloom varieties, vine-ripened.', '-1 day'],
        ['Collard Greens', 'vegetable', 'bunch', 300, 25, 'Cool-season collards, cut this morning.', '0 day'],
        ['Sweet Potatoes', 'vegetable', 'lb', 200, 120, 'Cured and ready to store.', '-4 day'],
        ['Radishes', 'vegetable', 'bunch', 250, 30, '', '-1 day'],
      ],
    },
    {
      owner: ['pecan@demo.farm', 'Tom Whitfield'],
      farm: ['Whitfield Pecan & Orchard', 'orchard', 'Third-generation orchard: pecans, persimmons and late-season citrus.', '8800 FM 455', 'Anna', 33.3489, -96.5486, '469-555-0142', 1, 'Orchard barn, gate on the left. Weekends 9-5.', 0, 0, 0, 'Cash, check or Venmo at pickup.'],
      items: [
        ['Pecans (shelled)', 'other', 'lb', 1400, 60, 'Fresh-crop papershell pecans.', '-6 day'],
        ['Fuyu Persimmons', 'fruit', 'lb', 350, 45, 'Firm, sweet, ready to eat.', '-2 day'],
        ['Satsuma Mandarins', 'fruit', 'lb', 300, 80, '', '-3 day'],
      ],
    },
    {
      owner: ['prosper@demo.farm', 'Dana Reyes'],
      farm: ['Prosper Hollow Garden', 'garden', 'Small market garden growing salad greens, herbs and root veg year-round.', '450 Hollow Creek Ln', 'Prosper', 33.2362, -96.8011, '214-555-0178', 1, 'Pick up from the cooler on the porch.', 1, 8, 400, 'Venmo or cash on delivery or pickup.'],
      items: [
        ['Salad Mix', 'vegetable', 'bag', 600, 20, 'Lettuce, arugula, baby kale.', '0 day'],
        ['Basil', 'herb', 'bunch', 300, 15, '', '0 day'],
        ['Carrots', 'vegetable', 'bunch', 350, 30, 'Rainbow carrots with tops.', '-1 day'],
        ['Turnips', 'vegetable', 'lb', 250, 25, '', '-1 day'],
      ],
    },
    {
      owner: ['mckinney@demo.farm', 'Luis Ortega'],
      farm: ['Ortega Family Ranch & Barn', 'ranch', 'Barn market with produce from our fields and neighbors within 15 miles.', '2500 Wilson Creek Rd', 'McKinney', 33.1972, -96.6398, '972-555-0190', 1, 'Barn store, open Wed-Sun.', 1, 15, 700, 'Pay at the barn or on delivery.'],
      items: [
        ['Butternut Squash', 'vegetable', 'lb', 150, 90, '', '-5 day'],
        ['Green Cabbage', 'vegetable', 'each', 275, 40, '', '-2 day'],
        ['Kale', 'vegetable', 'bunch', 300, 35, '', '-1 day'],
        ['Apples', 'fruit', 'lb', 250, 70, 'Fall apples from a partner orchard.', '-3 day'],
      ],
    },
    {
      owner: ['melissa@demo.farm', 'Kayla Brooks'],
      farm: ['Brooks Berry & Veg', 'farm', 'Pick-your-own berries in season; winter greens and broccoli now.', '77 Brooks Ln', 'Melissa', 33.2876, -96.5731, '469-555-0123', 1, 'Self-serve cooler at the gate.', 0, 0, 0, 'Venmo or cash in the lockbox.'],
      items: [
        ['Broccoli', 'vegetable', 'lb', 300, 50, '', '-1 day'],
        ['Cauliflower', 'vegetable', 'each', 400, 25, '', '-1 day'],
        ['Spinach', 'vegetable', 'bag', 450, 18, '', '0 day'],
      ],
    },
    {
      owner: ['frisco@demo.farm', 'Priya Natarajan'],
      farm: ['Frisco Urban Acre', 'garden', 'Hydroponic and in-ground produce from an urban acre.', '9100 Research Rd', 'Frisco', 33.1507, -96.8236, '214-555-0166', 1, 'Pickup window 4-7pm Tue/Thu/Sat.', 1, 12, 600, 'Pay by Venmo or cash on pickup.'],
      items: [
        ['Cherry Tomatoes', 'vegetable', 'pint', 400, 40, '', '0 day'],
        ['Hydro Lettuce', 'vegetable', 'each', 300, 40, '', '0 day'],
        ['Mint', 'herb', 'bunch', 250, 20, '', '0 day'],
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
}

module.exports = { db, seed };
