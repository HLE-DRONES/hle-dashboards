// Company Dashboard — HLE Drones sales-ops wallboard.
//
// Serves the static wallboard from ./public and aggregates live data from
// three sources behind a single endpoint:
//
//   GET /api/data → { sales, calls, inventory, soldWeek }
//
//   - Shopify (nuWay Ag + Drone Deer Recovery): MTD revenue, 180-day daily
//     revenue series (for the 90-day chart + prior-period dashed line), and
//     sold-this-week unit counts per model (net of cancellations/refunds —
//     same counting rule as the monday-morning scorecard).
//   - Aircall: today's inbound/missed per line (OH/KS split), yesterday
//     same-time comparison, and 30-day inbound totals. Aircall's API can't
//     filter calls by number, so completed days are bucketed per-number into
//     KV (CALL_STATS) and lazily backfilled a few days per refresh.
//   - Finale: available stock (on hand − reserved) for the wallboard SKUs.
//
// The whole payload is cached (caches.default) for FRESH_MS and served
// stale-while-revalidate up to STALE_MS, so the wallboard never blocks on a
// 15-second aggregation.

// ---------- CONFIG ----------

const TZ = 'America/New_York';
const CANONICAL_HOST = 'dashboards.hle.team';

const FRESH_MS = 4 * 60 * 1000;        // serve cached as-is under 4 min
const STALE_MS = 60 * 60 * 1000;       // serve stale + background refresh under 1 h

const STORES = {
  nuway: 'nuwayag.myshopify.com',
  ddr: 'dronedeerrecovery.myshopify.com',
};

// Aircall number ids (see memory: nuway-phone-lines).
const LINES = {
  ohSales: 844035,     // OH Sales +1 234-271-2767
  ksSales: 1275175,    // KS Sales +1 316-402-2561
  ohService: 998670,   // OH Service +1 234-239-9919
  ksService: 1275283,  // KS Service +1 316-330-3607
  ddrSales: 844037,    // Drone Deer +1 234-423-4979
};

// "Calls — Inbound 30 Days" panel rows.
const CALLS_30D_ROWS = [
  { label: 'OH nuWay Ag Sales', ids: [LINES.ohSales], brand: 'nuway' },
  { label: 'KS nuWay Ag Sales', ids: [LINES.ksSales], brand: 'nuway' },
  { label: 'Drone Deer', ids: [LINES.ddrSales], brand: 'ddr' },
];

// Finale warehouse facilities — the inventory panel reports availability
// per warehouse (Ohio + Kansas). Facility ids confirmed in the monday-morning
// scorecard. available = onHand − reserved, per facility, across the SKUs.
const FINALE_FACILITIES = {
  oh: '/hledrones/api/facility/100000', // Ohio Warehouse
  ks: '/hledrones/api/facility/102661', // Kansas Warehouse
};

// "Inventory — Available" panel (Finale). Each row shows OH + KS counts.
const INVENTORY_ITEMS = [
  { label: 'T100', skus: ['DJI-AGR-DR-T100'], brand: 'nuway' },
  { label: 'Generators', skus: ['TLS-AGR-T60X-GNR'], brand: 'nuway' },
  { label: 'Matrice 4T', skus: ['DJI-ENT-DRN-M4T'], brand: 'ddr' },
  { label: 'Matrice 4TD', skus: ['DJI-ENT-DRN-M4TD', 'DJI-ENT-DRN-M4TD-DCKBNDL'], brand: 'ddr' },
  { label: 'Matrice 30T', skus: ['DJI-ENT-DRN-M30T'], brand: 'ddr' },
  { label: 'T60X', skus: ['TLS-AGR-T60X-DRN'], brand: 'nuway' },
  { label: "Mike's Loadout", skus: ['NUW-TRL-MLDT-2025', 'NUW-TRL-MLDT-2025-GSNCK', 'NUW-TRL-MEGA-MKLD'], brand: 'nuway' },
];

// "Sold — This Week" ledger. SKU rules mirror the monday-morning scorecard
// where the model overlaps; targets are weekly unit targets (edit freely).
const SOLD_ROWS = [
  { label: 'Matrice 4T', store: 'ddr', rule: { equals: 'DJI-ENT-DRN-M4T' }, target: 12, brand: 'ddr' },
  { label: 'Monitor', store: 'ddr', rule: { prefix: 'DDR-MNT-HSHC-24' }, target: 10, brand: 'ddr' },
  { label: 'T100', store: 'nuway', rule: { equals: 'DJI-AGR-DR-T100' }, target: 15, brand: 'nuway' },
  { label: 'Matrice 4TD', store: 'ddr', rule: { prefix: 'DJI-ENT-DRN-M4TD' }, target: 6, brand: 'ddr' },
  { label: 'FastPass', store: 'nuway', rule: { equals: 'NUW-CMP-P37-PT137-PP' }, target: 5, brand: 'nuway' },
  { label: 'nuWay Ag Trailer', store: 'nuway', rule: { prefixAny: ['NUW-TRL-MLDT-', 'NUW-TRL-MEGA-'] }, target: 3, brand: 'nuway' },
  { label: 'T50 Drone', store: 'nuway', rule: { equals: 'DJI-AGR-DRN-T50' }, target: 4, brand: 'nuway' },
  { label: 'Regulation Support', store: 'both', rule: { prefixAny: ['NUW-SRV-REGLIC', 'NUW-CMP-REGLIC', 'NUW-AGR-REGLIC'] }, target: 2, brand: 'nuway' },
];

// ---------- CLOUDFLARE ACCESS JWT VERIFICATION ----------
// Same pattern as faa-aircraft: requests must carry a valid Access JWT.
// ACCESS_AUD is a wrangler var, set once the Access app exists. Until then
// only localhost (wrangler dev) is served.

const ACCESS_TEAM_DOMAIN = 'hledrones.cloudflareaccess.com';
const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache = null;

async function getAccessJwks() {
  if (jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys;
  const resp = await fetch(`https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  const data = await resp.json();
  const keys = new Map();
  for (const jwk of data.keys || []) {
    if (!jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
    );
    keys.set(jwk.kid, key);
  }
  jwksCache = { keys, expires: Date.now() + JWKS_TTL_MS };
  return keys;
}

function b64urlToBytes(s) {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyAccessJwt(token, aud) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    const jwks = await getAccessJwks();
    const key = jwks.get(header.kid);
    if (!key) return null;
    const ok = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' }, key, b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`)
    );
    return ok ? payload : null;
  } catch { return null; }
}

async function requireAccess(request, aud) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return new Response(
      `Unauthorized.\n\nThis dashboard is protected by Cloudflare Access.\nVisit https://${CANONICAL_HOST} to sign in with your @hledrones.com email.\n`,
      { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }
  const claims = await verifyAccessJwt(jwt, aud);
  if (!claims) {
    return new Response(
      `Forbidden — invalid Access session. Sign in again at https://${CANONICAL_HOST}.\n`,
      { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  }
  return null;
}

// ---------- TIME HELPERS (Eastern) ----------

function tzOffsetMs(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// UTC ms for ET wall-clock y-m-d hh:00. Two-pass to survive DST boundaries.
function etToUtc(y, m, d, hh = 0) {
  let guess = Date.UTC(y, m - 1, d, hh) - tzOffsetMs(new Date(Date.UTC(y, m - 1, d, hh)));
  guess = Date.UTC(y, m - 1, d, hh) - tzOffsetMs(new Date(guess));
  return guess;
}

// "YYYY-MM-DD" in ET for a Date / ms.
function etDateStr(t) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(typeof t === 'number' ? new Date(t) : t);
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

function addDays(ymd, n) {
  const { y, m, d } = parseYmd(ymd);
  return etDateStr(Date.UTC(y, m - 1, d + n, 12)); // noon avoids DST edges
}

// Start of today / this Monday / this month, in UTC ms.
function etTodayStart(now = new Date()) {
  const { y, m, d } = parseYmd(etDateStr(now));
  return etToUtc(y, m, d);
}

function etMonthStart(now = new Date()) {
  const { y, m } = parseYmd(etDateStr(now));
  return etToUtc(y, m, 1);
}

function etWeekStart(now = new Date()) {
  const today = etDateStr(now);
  const { y, m, d } = parseYmd(today);
  // getUTCDay of ET-noon-anchored date gives the ET weekday.
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun
  const back = (dow + 6) % 7; // days since Monday
  const monday = addDays(today, -back);
  const p = parseYmd(monday);
  return etToUtc(p.y, p.m, p.d);
}

// ---------- SHOPIFY ----------

const shopifyTokens = {}; // store → { token, expires }

async function shopifyToken(env, store) {
  const c = shopifyTokens[store];
  if (c && c.expires > Date.now()) return c.token;
  const resp = await fetch(`https://${store}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${env.SHOPIFY_CLIENT_ID}&client_secret=${env.SHOPIFY_CLIENT_SECRET}`,
  });
  if (!resp.ok) throw new Error(`Shopify token mint failed for ${store}: ${resp.status}`);
  const data = await resp.json();
  shopifyTokens[store] = { token: data.access_token, expires: Date.now() + (data.expires_in - 300) * 1000 };
  return data.access_token;
}

async function shopifyGql(env, store, query, variables) {
  const token = await shopifyToken(env, store);
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(`https://${store}/admin/api/2025-01/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const data = await resp.json();
    if (data.errors?.some((e) => e.extensions?.code === 'THROTTLED')) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (data.errors) throw new Error(`Shopify GraphQL (${store}): ${JSON.stringify(data.errors).slice(0, 300)}`);
    return data.data;
  }
  throw new Error(`Shopify GraphQL (${store}): throttled after retries`);
}

// Daily net revenue buckets (ET dates) for non-cancelled orders since sinceMs.
async function shopifyDailyRevenue(env, store, sinceMs) {
  const q = `query($q: String!, $after: String) {
    orders(first: 250, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        createdAt cancelledAt
        currentTotalPriceSet { shopMoney { amount } }
      } }
    }
  }`;
  const qs = `created_at:>=${new Date(sinceMs).toISOString()} status:any`;
  const daily = {};
  let after = null;
  for (let page = 0; page < 40; page++) {
    const data = await shopifyGql(env, store, q, { q: qs, after });
    for (const e of data.orders.edges) {
      const o = e.node;
      if (o.cancelledAt) continue;
      const day = etDateStr(new Date(o.createdAt));
      daily[day] = (daily[day] || 0) + parseFloat(o.currentTotalPriceSet.shopMoney.amount);
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return daily;
}

function skuMatches(sku, rule) {
  if (!sku) return false;
  if (rule.equals) return sku === rule.equals;
  if (rule.prefix) return sku.startsWith(rule.prefix);
  if (rule.prefixAny) return rule.prefixAny.some((p) => sku.startsWith(p));
  return false;
}

// Net units sold per SOLD_ROWS rule for one store key ('nuway'|'ddr') in
// [fromMs, toMs). Counting rule matches the monday-morning scorecard:
// cancelled orders are skipped entirely; refunded quantities are subtracted.
async function shopifySoldUnits(env, storeKey, fromMs, toMs) {
  const store = STORES[storeKey];
  const q = `query($q: String!, $after: String) {
    orders(first: 100, after: $after, query: $q) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        cancelledAt
        lineItems(first: 100) { edges { node { sku quantity } } }
        refunds { refundLineItems(first: 100) { edges { node { quantity lineItem { sku } } } } }
      } }
    }
  }`;
  const qs = `created_at:>=${new Date(fromMs).toISOString()} created_at:<${new Date(toMs).toISOString()} status:any`;
  const rows = SOLD_ROWS.filter((r) => r.store === storeKey || r.store === 'both');
  const counts = Object.fromEntries(rows.map((r) => [r.label, 0]));
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await shopifyGql(env, store, q, { q: qs, after });
    for (const e of data.orders.edges) {
      const o = e.node;
      if (o.cancelledAt) continue;
      for (const li of o.lineItems.edges) {
        for (const r of rows) if (skuMatches(li.node.sku, r.rule)) counts[r.label] += li.node.quantity;
      }
      for (const ref of o.refunds || []) {
        for (const rli of ref.refundLineItems.edges) {
          const sku = rli.node.lineItem?.sku;
          for (const r of rows) if (skuMatches(sku, r.rule)) counts[r.label] -= rli.node.quantity;
        }
      }
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  return counts;
}

// ---------- AIRCALL ----------

function aircallAuth(env) {
  return 'Basic ' + btoa(`${env.AIRCALL_API_ID}:${env.AIRCALL_API_TOKEN}`);
}

// Calls in [fromSec, toSec] → [{ numberId, direction, missed, startedAt,
// talkSec, agent }]. NOTE: Aircall's /v1/calls silently ignores `direction`
// and `number_id` query params (verified 2026-06-12) — every filter must be
// applied client-side.
async function aircallCalls(env, fromSec, toSec) {
  const out = [];
  let url = `https://api.aircall.io/v1/calls?order=asc&per_page=50&from=${fromSec}&to=${toSec}`;
  for (let page = 0; page < 60 && url; page++) {
    const resp = await fetch(url, { headers: { Authorization: aircallAuth(env) } });
    if (resp.status === 429) { await new Promise((r) => setTimeout(r, 2000)); page--; continue; }
    if (!resp.ok) throw new Error(`Aircall ${resp.status}`);
    const data = await resp.json();
    for (const c of data.calls || []) {
      out.push({
        numberId: c.number?.id ?? 0,
        direction: c.direction,
        missed: !c.answered_at,
        startedAt: c.started_at,
        talkSec: c.answered_at && c.ended_at ? Math.max(0, c.ended_at - c.answered_at) : 0,
        agent: c.user?.name || null,
      });
    }
    url = data.meta?.next_page_link || null;
  }
  return out;
}

const aircallInbound = async (env, fromSec, toSec) =>
  (await aircallCalls(env, fromSec, toSec)).filter((c) => c.direction === 'inbound');

// Top agent by total talk time (answered calls, both directions).
function topTalker(calls) {
  const byAgent = {};
  for (const c of calls) {
    if (!c.agent || !c.talkSec) continue;
    byAgent[c.agent] = (byAgent[c.agent] || 0) + c.talkSec;
  }
  const top = Object.entries(byAgent).sort((a, b) => b[1] - a[1])[0];
  return top ? { name: top[0], seconds: top[1] } : null;
}

function tallyCalls(calls, ids) {
  let total = 0, missed = 0;
  for (const c of calls) {
    if (!ids.includes(c.numberId)) continue;
    total++;
    if (c.missed) missed++;
  }
  return { total, missed };
}

// Per-number {in, missed} bucket for one completed ET day.
async function aircallDayBucket(env, ymd) {
  const { y, m, d } = parseYmd(ymd);
  const from = Math.floor(etToUtc(y, m, d) / 1000);
  const to = Math.floor((etToUtc(y, m, d) + 86400 * 1000) / 1000) - 1;
  const calls = await aircallInbound(env, from, to);
  const bucket = {};
  for (const c of calls) {
    const b = (bucket[c.numberId] ||= { in: 0, missed: 0 });
    b.in++;
    if (c.missed) b.missed++;
  }
  return bucket;
}

// 30-day per-number history from KV; lazily backfills up to `maxBackfill`
// missing days in the background.
async function aircallHistory(env, ctx, todayYmd, maxBackfill = 4) {
  const days = [];
  for (let i = 1; i <= 29; i++) days.push(addDays(todayYmd, -i));
  const got = await Promise.all(days.map((d) => env.CALL_STATS.get(`calls:v2:${d}`, 'json')));
  const buckets = {};
  const missing = [];
  days.forEach((d, i) => {
    if (got[i]) buckets[d] = got[i];
    else missing.push(d);
  });
  if (missing.length && ctx) {
    ctx.waitUntil((async () => {
      for (const d of missing.slice(0, maxBackfill)) {
        try {
          const b = await aircallDayBucket(env, d);
          await env.CALL_STATS.put(`calls:v2:${d}`, JSON.stringify(b));
        } catch { break; } // rate-limited or down — next refresh retries
      }
    })());
  }
  return { buckets, missingDays: missing.length };
}

// ---------- FINALE ----------

async function finaleStock(env) {
  const allSkus = INVENTORY_ITEMS.flatMap((i) => i.skus);
  const { oh, ks } = FINALE_FACILITIES;
  const q = `query($skus: [String]) {
    productViewConnection(first: ${allSkus.length}, productId: $skus) {
      edges { node {
        productId
        onHandOH:   stockOnHand(aggregate: sum, count: totalUnits, facilityUrlList: "${oh}")
        reservedOH: stockReserved(aggregate: sum, count: totalUnits, facilityUrlList: "${oh}")
        onHandKS:   stockOnHand(aggregate: sum, count: totalUnits, facilityUrlList: "${ks}")
        reservedKS: stockReserved(aggregate: sum, count: totalUnits, facilityUrlList: "${ks}")
      } }
    }
  }`;
  const auth = 'Basic ' + btoa(`${env.FINALE_API_KEY}:${env.FINALE_API_SECRET}`);
  const resp = await fetch('https://app.finaleinventory.com/hledrones/api/graphql', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { skus: allSkus } }),
  });
  if (!resp.ok) throw new Error(`Finale ${resp.status}`);
  const data = await resp.json();
  if (!data.data) throw new Error(`Finale GraphQL: ${JSON.stringify(data).slice(0, 200)}`);
  const num = (s) => (s === null || s === undefined || s === '--' ? 0 : parseInt(String(s).replace(/,/g, ''), 10) || 0);
  const bySku = {};
  for (const e of data.data.productViewConnection.edges) {
    const n = e.node;
    bySku[n.productId] = {
      oh: num(n.onHandOH) - num(n.reservedOH),
      ks: num(n.onHandKS) - num(n.reservedKS),
    };
  }
  return INVENTORY_ITEMS.map((i) => {
    const oh = i.skus.reduce((s, sku) => s + (bySku[sku]?.oh ?? 0), 0);
    const ks = i.skus.reduce((s, sku) => s + (bySku[sku]?.ks ?? 0), 0);
    return { label: i.label, brand: i.brand, oh, ks, qty: oh + ks };
  });
}

// ---------- AGGREGATION ----------

async function buildData(env, ctx) {
  const now = new Date();
  const nowMs = now.getTime();
  const todayYmd = etDateStr(now);
  const todayStart = etTodayStart(now);
  const monthStart = etMonthStart(now);
  const weekStart = etWeekStart(now);
  const lastWeekStart = weekStart - 7 * 86400 * 1000;
  const series180Start = etToUtc(...Object.values(parseYmd(addDays(todayYmd, -179))));

  const errors = {};
  const guard = (label, p, fallback) =>
    p.catch((e) => { errors[label] = String(e?.message || e).slice(0, 200); return fallback; });

  const [
    nuwayDaily, ddrDaily,
    nuwaySoldWk, ddrSoldWk, nuwaySoldLastWk, ddrSoldLastWk,
    callsToday, callsYesterday, history, inventory,
  ] = await Promise.all([
    guard('nuwaySales', shopifyDailyRevenue(env, STORES.nuway, series180Start), {}),
    guard('ddrSales', shopifyDailyRevenue(env, STORES.ddr, series180Start), {}),
    guard('nuwaySold', shopifySoldUnits(env, 'nuway', weekStart, nowMs), {}),
    guard('ddrSold', shopifySoldUnits(env, 'ddr', weekStart, nowMs), {}),
    guard('nuwaySoldPrev', shopifySoldUnits(env, 'nuway', lastWeekStart, lastWeekStart + (nowMs - weekStart)), {}),
    guard('ddrSoldPrev', shopifySoldUnits(env, 'ddr', lastWeekStart, lastWeekStart + (nowMs - weekStart)), {}),
    guard('callsToday', aircallCalls(env, Math.floor(todayStart / 1000), Math.floor(nowMs / 1000)), []),
    guard('callsYesterday', aircallInbound(env, Math.floor(todayStart / 1000) - 86400, Math.floor(todayStart / 1000) - 1), []),
    guard('callsHistory', aircallHistory(env, ctx, todayYmd), { buckets: {}, missingDays: 29 }),
    guard('inventory', finaleStock(env), []),
  ]);

  // Persist yesterday's completed bucket (cheap, idempotent — we already
  // fetched the calls).
  const yesterdayYmd = addDays(todayYmd, -1);
  if (!errors.callsYesterday && ctx && !history.buckets[yesterdayYmd]) {
    const b = {};
    for (const c of callsYesterday) {
      const e = (b[c.numberId] ||= { in: 0, missed: 0 });
      e.in++;
      if (c.missed) e.missed++;
    }
    ctx.waitUntil(env.CALL_STATS.put(`calls:v2:${yesterdayYmd}`, JSON.stringify(b)));
    history.buckets[yesterdayYmd] = b;
    history.missingDays = Math.max(0, history.missingDays - 1);
  }

  // --- Sales: MTD + daily series ---
  const mtd = (daily) => {
    let s = 0;
    for (const [day, v] of Object.entries(daily)) {
      const { y, m, d } = parseYmd(day);
      if (etToUtc(y, m, d) >= monthStart) s += v;
    }
    return Math.round(s);
  };
  const seriesDays = [];
  for (let i = 179; i >= 0; i--) seriesDays.push(addDays(todayYmd, -i));
  const series = (daily) => seriesDays.map((d) => Math.round(daily[d] || 0));

  // --- Calls: hero boxes (inbound only; callsToday includes outbound for
  // the talk-time leaderboard) ---
  const inboundToday = callsToday.filter((c) => c.direction === 'inbound');
  const sameTimeCut = (nowMs - todayStart) / 1000; // seconds into the ET day
  const yStartSec = Math.floor(todayStart / 1000) - 86400;
  const ySameTime = callsYesterday.filter((c) => c.startedAt - yStartSec <= sameTimeCut);
  const box = (ids) => ({
    today: tallyCalls(inboundToday, ids),
    yesterdaySameTime: tallyCalls(ySameTime, ids).total,
  });

  // --- Calls: 30-day panel (29 completed days from KV + today live) ---
  const last30 = CALLS_30D_ROWS.map((row) => {
    let n = tallyCalls(inboundToday, row.ids).total;
    for (const b of Object.values(history.buckets)) {
      for (const id of row.ids) n += b[id]?.in || 0;
    }
    return { label: row.label, brand: row.brand, total: n };
  });

  // --- Sold this week ---
  const soldWeek = SOLD_ROWS.map((r) => {
    const pick = (a, b) => (a[r.label] || 0) + (b[r.label] || 0);
    const sold = r.store === 'nuway' ? (nuwaySoldWk[r.label] || 0)
      : r.store === 'ddr' ? (ddrSoldWk[r.label] || 0)
      : pick(nuwaySoldWk, ddrSoldWk);
    const prev = r.store === 'nuway' ? (nuwaySoldLastWk[r.label] || 0)
      : r.store === 'ddr' ? (ddrSoldLastWk[r.label] || 0)
      : pick(nuwaySoldLastWk, ddrSoldLastWk);
    return { label: r.label, brand: r.brand, sold, target: r.target, delta: sold - prev };
  });

  return {
    generatedAt: now.toISOString(),
    timezone: TZ,
    monthStart: etDateStr(monthStart),
    today: todayYmd,
    sales: {
      ddr: { mtd: mtd(ddrDaily), series: series(ddrDaily) },
      nuway: { mtd: mtd(nuwayDaily), series: series(nuwayDaily) },
      seriesStart: seriesDays[0],
    },
    calls: {
      nuwaySales: { oh: box([LINES.ohSales]), ks: box([LINES.ksSales]) },
      nuwayService: { oh: box([LINES.ohService]), ks: box([LINES.ksService]) },
      ddrSales: box([LINES.ddrSales]),
      last30,
      talkTime: topTalker(callsToday),
      historyMissingDays: history.missingDays,
    },
    inventory: [...inventory].sort((a, b) => b.qty - a.qty),
    soldWeek,
    errors: Object.keys(errors).length ? errors : undefined,
  };
}

// ---------- CACHING ----------

const CACHE_KEY = 'https://hle-dashboards.internal/api/data';

async function getData(env, ctx) {
  const cache = caches.default;
  const hit = await cache.match(CACHE_KEY);
  if (hit) {
    const body = await hit.json();
    const age = Date.now() - new Date(body.generatedAt).getTime();
    if (age < FRESH_MS) return body;
    if (age < STALE_MS) {
      ctx.waitUntil(refreshCache(env, ctx));
      return body;
    }
  }
  return refreshCache(env, ctx);
}

let refreshing = null; // collapse concurrent refreshes within an isolate

async function refreshCache(env, ctx) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const data = await buildData(env, ctx);
      await caches.default.put(CACHE_KEY, new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${Math.floor(STALE_MS / 1000)}` },
      }));
      return data;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ---------- ROUTES ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1';

    if (!isLocal) {
      if (host.endsWith('.workers.dev')) {
        return new Response(null, { status: 301, headers: { Location: `https://${CANONICAL_HOST}/` } });
      }
      if (!env.ACCESS_AUD) {
        return new Response('Access not configured (ACCESS_AUD unset).\n', { status: 503 });
      }
      const denied = await requireAccess(request, env.ACCESS_AUD);
      if (denied) return denied;
    }

    if (url.pathname === '/api/data') {
      try {
        const data = await getData(env, ctx);
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e?.message || e) }), {
          status: 500, headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};
