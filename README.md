# FarmDirect

A farm-to-buyer marketplace that works anywhere in the world. Farmers post what they harvested, locals find nearby farms and barns on a map, reserve produce, and pay the farmer directly. No middlemen and no platform cut. Each farm sets its own currency, and buyers find farms by typing any town, address or Google Maps link, or by sharing their location.

## What's on the site

- **Town pages** like `/celina-tx` or `/hyderabad-in` for any of ~24,600 towns: featured farms, farmers' markets, local products by category, what's in season, a photo gallery, upcoming events, CSA shares and farm days, plus a map.
- **Directory** with a type filter (farms, farmers' markets, u-pick, farm stands, CSA, farm days, wholesale, restaurants, groceries, accepts SNAP), product filter, search and distance, as a list and a map. Addresses like `/celina-tx/markets` or `/celina-tx/products/eggs`.
- **Listing pages** (`/farm/12`) with about, products to reserve, CSA sign-up, farm days to book, events to RSVP, photo updates, map, hours, directions and SNAP/wholesale badges.
- **Farm visits** (`/celina-tx/experiences/horse`, `/day`, `/learn`, `/tour`, `/pick`): horseback riding, spending a day on a farm, farming classes, farm and barn tours and u-pick, plus a **Barns and ranches** section with their produce.
- **Group orders** (`/celina-tx/group-orders`, `/group/12`): neighbors pool orders so a farm makes one delivery to one drop-off spot (see below).
- **One account does both.** A **Visitor / Farm owner** switch in the header moves between buying (My orders) and running a listing (the dashboard). A **mi / km** switch changes every distance on the site.
- **For buyers:** My orders shows produce and group orders, group orders you host, CSA memberships, farm visit bookings and events.
- **For farms, markets and stands:** a dashboard with tabs for orders, group orders, bookings, CSA members and shares, events and RSVPs, products, farm visits, photos and updates, and listing details.

## Group orders

Everyone on a street, at an office or a school orders from one farm by a deadline, and the farm brings it all in one trip.

- **Two ways to start one.** The farm adds its own drop-off points (a library lot, a church), or, if the farm allows it, any neighbor starts one for their street within the farm's delivery radius.
- **The farm sets the terms:** a minimum per group, an optional bulk discount (for example 10% off once the group passes $300) and how far it will deliver.
- Each household adds its own order through the group's link. Stock is held right away.
- The farm sees a **picking list** (everything added up) and a **per-household breakdown**, then **confirms** (orders close, the discount is locked in and everyone is emailed), **marks it delivered**, or **cancels** (stock goes back on sale). A neighbor host can cancel before the farm confirms.
- Each household still pays the farm directly at the drop-off.

## Email notifications

With `RESEND_API_KEY` set, the app emails farms about new orders, group orders, booking requests, CSA sign-ups and RSVPs, and emails buyers when their order is ready, a booking or CSA spot is confirmed or declined, or a group order is confirmed, delivered or cancelled. Without a key it only logs what it would send.

1. Sign up at [resend.com](https://resend.com) and create an API key.
2. Verify your domain there so mail comes from your own address.
3. Set `RESEND_API_KEY`, `EMAIL_FROM` (for example `FarmDirect <hello@yourdomain.com>`) and `SITE_URL` (your site's address, used for links in emails).

## Run it

Requires Node 22.5 or newer (uses the built-in `node:sqlite`).

```bash
npm install
npm start          # http://localhost:3000
```

On first start the app creates `farmdirect.db` and seeds six **fictional demo farms** in North Texas so you can try it. Remove them before launch (see below).

Demo logins (password `farmdemo123`):

| Role | Email |
| --- | --- |
| Buyer | `buyer@demo.farm` |
| Farmer | `bluebonnet@demo.farm` (also `pecan@`, `prosper@`, `mckinney@`, `melissa@`, `frisco@`) |

For a real launch set `SEED_DEMO=false`, and remove the demo-login hint in `public/app.js` (search for "Demo accounts").

## What it does

**Buyers**
- Browse a map and list of farms sorted by distance, filter by produce type, pickup or delivery, and radius
- Search by produce, farm, or town
- Reserve an order for pickup or delivery from one farm at a time
- See order status and cancel (stock goes back on sale)

**Farmers**
- Create a farm profile and drop a pin on the map
- Choose pickup, delivery, or both (delivery radius and fee)
- Post harvest with price, unit, quantity and harvest date; edit or remove it
- Receive reservations, mark them ready, completed or cancelled

Reserving decrements stock inside a database transaction, so two buyers cannot oversell the same produce.

## Farm experiences

Owners can choose to offer visits as well as food: **spend a day on the farm, learn farming, horseback riding, farm or barn tours, pick-your-own**, or anything else. For each one they set the price (per person, per group or per hour, or free), how long it lasts, the most people they can host in a day, when they offer it, a minimum age and what to bring.

- Guests pick a date and group size and send a **booking request**. The app refuses a request once that day is full.
- The owner **confirms or declines** each request, then marks it completed. Guests can cancel.
- Owners can pause an experience to hide it without deleting it.
- Like produce, guests pay the farm directly; the app never takes payment.
- The Home page has a **Looking for** filter: fresh produce, any experience, or one kind such as horseback riding.

Liability waivers, insurance and safety rules for activities like riding are the farm's responsibility. A farm offering rides should state its own requirements in the experience description.

## Photos, videos and farm updates

Farm owners can add a **farm photo** and share **updates**: a short post with up to 6 photos or videos. Updates show on the farm's page and in **Farm updates**, a feed buyers can filter to farms near them.

- Photos are shrunk in the browser to about 1800 pixels before upload, so phone photos upload quickly.
- Videos can be MP4, MOV or WebM, up to 50 MB each (change with `MAX_UPLOAD_MB`).
- Files are saved in the `uploads/` folder (change with `UPLOAD_DIR`). Put it on a persistent disk next to the database, and back up both.
- The server checks each file's first bytes, so a web page or script can't be uploaded disguised as a photo, and serves uploads with headers that stop browsers from running them.
- Deleting an update or replacing the farm photo deletes the old files.

## Google Maps

The app uses the real Google Maps when you give it a key, and falls back to free OpenStreetMap maps when you don't.

1. Go to [Google Cloud Console](https://console.cloud.google.com/), create a project and turn on billing (Google gives a monthly free allowance for maps, which a pilot this size stays well within).
2. Under **APIs & Services → Library**, enable **Maps JavaScript API**.
3. Also enable **Geocoding API** so the "Where are you?" box and the farmer's "Find my address or town" button use Google's place search. Without it, the app uses OpenStreetMap's free search (Nominatim), which is fine for a pilot but limited to about one search per second.
4. Under **APIs & Services → Credentials**, create an **API key**. Under its restrictions, choose **Websites** and add your domain (for example `https://farmdirect.example.com/*`, plus `http://localhost:3000/*` while testing), and limit the key to the Maps JavaScript API and Geocoding API.
5. Start the app with the key:

```bash
GOOGLE_MAPS_API_KEY=your-key npm start
```

With a key, the browse map, farm pins and the farmer's "place your farm" map all use Google Maps. With or without a key, every farm has **Open in Google Maps** and **Get directions** buttons, buyers get **Directions to the farm** on pickup orders, farmers get **Directions to buyer** on delivery orders, and farmers can paste a Google Maps link to set their farm's location.

The key is sent to the browser, which is normal for Google Maps. The website restriction in step 4 is what stops others from using it.

## Payments

By design the app never touches money. Each farm sets a "how buyers pay" note (cash, Venmo, check) and the buyer pays the farmer at pickup or delivery. Adding Stripe Connect later would let farmers receive card payments directly, but you would then take on fees, refunds and compliance.

## Layout

```
server/
  index.js   Express API and static hosting
  db.js      SQLite schema and demo seed
  auth.js    scrypt password hashing and signed session tokens
public/
  index.html, styles.css, app.js   Vanilla JS front end with Leaflet and OpenStreetMap
```

## API summary

| Method and path | Who | Purpose |
| --- | --- | --- |
| `POST /api/auth/register`, `/api/auth/login`, `GET /api/me` | anyone | Accounts |
| `GET /api/farms?lat&lng&radius&q&category&fulfillment` | anyone | Search farms with in-stock items |
| `GET /api/farms/:id` | anyone | Farm and its listings |
| `POST /api/farms`, `PUT /api/farms/:id`, `GET /api/my/farms` | farmer | Manage farm |
| `POST /api/farms/:id/listings`, `PUT` / `DELETE /api/listings/:id` | farmer | Post and edit harvest |
| `POST /api/orders`, `GET /api/orders/mine` | buyer | Reserve and list orders |
| `GET /api/farm-orders` | farmer | Incoming orders |
| `PATCH /api/orders/:id/status` | farmer, buyer | `ready`, `completed`, `cancelled` (buyers can only cancel) |

## Deploying

The app ships with a `Dockerfile`, `railway.json` and `render.yaml`. It runs as one small server; the SQLite database and uploaded photos live in `/data`, which **must be a persistent volume** or everything is lost on each deploy.

### Railway (recommended: volumes on every plan)
1. Push this folder to a GitHub repository.
2. On railway.com: **New Project → Deploy from GitHub repo** → pick the repo. Railway reads `railway.json` and builds the Dockerfile.
3. In the service: **Settings → Volumes → Add volume**, mount path `/data`.
4. **Variables:** `SESSION_SECRET` (a long random string), optionally `GOOGLE_MAPS_API_KEY`, and `SEED_DEMO=false` once real farms join.
5. **Settings → Networking → Generate domain** for a public `https://….up.railway.app` address, or add your own domain.

### Render
1. Push to GitHub, then on render.com: **New → Blueprint** → pick the repo. `render.yaml` creates the service, a 5 GB disk at `/data` and a random `SESSION_SECRET`.
2. A disk needs the paid Starter plan. The free plan works for a quick look, but its data is wiped on every deploy.

### Any other host or your own server
`docker build -t farmdirect . && docker run -p 3000:3000 -v farmdirect-data:/data -e SESSION_SECRET=… farmdirect`

Environment variables:

- `SESSION_SECRET`: a long random string. Without it everyone is signed out on each restart.
- `PORT`: defaults to 3000 (hosts usually set it).
- `DB_PATH`, `UPLOAD_DIR`: default to `/data/farmdirect.db` and `/data/uploads` in the Docker image.
- `GOOGLE_MAPS_API_KEY`: optional, turns on Google Maps.
- `MAX_UPLOAD_MB`: largest photo or video allowed, default 50.
- `RESEND_API_KEY`, `EMAIL_FROM`, `SITE_URL`: turn on email notifications.
- `SEED_DEMO`: `true` adds six example farms on first start so the site isn't empty; set `false` for a real launch.

`/healthz` answers `{"ok":true}` for uptime checks. The app always runs one copy (SQLite); move to Postgres before running several.

## Known limits and next steps

- A farmer account manages one farm in the UI (the API supports several).
- Delivery radius is only enforced when the buyer shared their location; otherwise the farmer confirms the address.
- No SMS notifications; email needs a Resend key (see above).
- No password reset, email verification or rate limiting yet.
- Videos are stored as uploaded. For many large videos, move uploads to a storage service such as S3 or Cloudflare R2.
- Farm addresses are shown publicly. Farmers who use a home address may prefer to enter only a town and a pickup note; the pin is exact, so ask them to place it near, not on, their house if they want privacy.
- Distances are stored in miles and shown in miles or kilometres.
- Seeding real farms: start where you are. In the US, the USDA Local Food Directory and LocalHarvest list farms you can invite directly.
