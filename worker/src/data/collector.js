/**
 * Our own market data. Every trade the live feed reports for the coins we follow is turned into 5-second candles
 * and kept here. The robot reads prices, volume and chart shapes from this (no third-party chart service), and the
 * website's own chart reads the saved copy (art_charts).
 *
 * Unit note: bar prices are MARKET CAP IN SOL (pump.fun coins have a fixed 1,000,000,000 supply), so patterns and
 * charts never depend on the USD price of SOL.
 */
const { addTrade, BASE } = require('../charting');
const logger = require('../utils/logger');
const meta = require('./meta');

const SUPPLY = 1e9;
const MAX_TOKENS = 2000;
const MAX_BARS = 8640; // 12 hours of 5 s bars
const SAVE_BARS = 3600; // 5 hours of 5 s bars for the website
const FRESH_MS = 60 * 1000;
const tokens = new Map(); // mint -> entry
const pinned = new Set();
let solUsd = 180;

const entry = (mint) => {
  let e = tokens.get(mint);
  if (!e) { e = { mint, bars: [], m1: [], m5: [], tape: [], mcapSol: null, vSol: null, firstSeen: Date.now(), lastAt: 0, name: null, symbol: null, uri: null, dirty: false, trades: 0, migrated: false, created: false }; tokens.set(mint, e); }
  return e;
};

function evict() {
  if (tokens.size <= MAX_TOKENS) return;
  const drop = [...tokens.values()].filter((e) => !pinned.has(e.mint)).sort((a, b) => a.lastAt - b.lastAt).slice(0, tokens.size - MAX_TOKENS);
  for (const e of drop) tokens.delete(e.mint);
}

/** One message from the live feed (create / buy / sell / migrate). */
function onMessage(m) {
  if (!m || typeof m.mint !== 'string') return;
  const tx = m.txType;
  if (tx !== 'create' && tx !== 'buy' && tx !== 'sell' && tx !== 'migrate') return;
  const e = entry(m.mint);
  if (tx === 'create') {
    if (typeof m.traderPublicKey === 'string' && m.traderPublicKey.length >= 32) e.dev = m.traderPublicKey; // the launcher, kept so the website can show whether the dev still holds
    e.created = true; e.firstSeen = Date.now(); e.name = m.name || e.name; e.symbol = m.symbol || e.symbol; e.uri = typeof m.uri === 'string' ? m.uri.slice(0, 400) : e.uri;
    if (e.uri) meta.want(e.mint, e.uri); // the picture is fetched in the background, retried until it works
  }
  if (tx === 'migrate') { e.migrated = true; e.migratedAt = Date.now(); e.dirty = true; return; }
  let mcap = Number(m.marketCapSol);
  if (!(mcap > 0)) { const s = Number(m.solAmount), t = Number(m.tokenAmount); mcap = s > 0 && t > 0 ? (s / t) * SUPPLY : NaN; }
  if (!(mcap > 0)) return;
  e.mcapSol = mcap; if (Number(m.vSolInBondingCurve) > 0) e.vSol = Number(m.vSolInBondingCurve);
  e.lastAt = Date.now(); e.trades += 1; e.dirty = true;
  const tr = { t: e.lastAt / 1000, p: mcap, v: Number(m.solAmount) || 0, side: tx === 'create' ? 'buy' : tx };
  addTrade(e.bars, tr, BASE, MAX_BARS);
  if (tx !== 'create') { e.tape.push([e.lastAt, tx === 'sell' ? 's' : 'b', +(Number(m.solAmount) || 0).toFixed(4), +mcap.toFixed(3), typeof m.traderPublicKey === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m.traderPublicKey) ? m.traderPublicKey : '', typeof m.signature === 'string' ? m.signature.slice(0, 10) : '']); if (e.tape.length > 5000) e.tape.shift(); }
  addTrade(e.m1, tr, 60, 360); // 6 hours of 1-minute candles
  addTrade(e.m5, tr, 300, 864); // 3 days of 5-minute candles, for the zoomed-out views
  if (tokens.size > MAX_TOKENS + 20) evict();
}

const setSolUsd = (v) => { if (v > 10) solUsd = v; };
const pin = (mints) => { pinned.clear(); for (const m of mints) pinned.add(m); };
const has = (mint) => tokens.has(mint);
const barsFor = (mint) => (tokens.get(mint) || {}).bars || [];
const trackedMints = () => [...tokens.keys()];

/**
 * Hot coins by group, for the chart agents: 'migrated' (moved to a regular pool), 'stretch' (past half way up the curve),
 * 'trending' (the busiest recent coins). 'any' is the union. Same rules as the website's lists.
 */
const V_STRETCH = 30 + 85 * 0.5;
function hotMints(source = 'any', now = Date.now()) {
  const out = new Set();
  const wantM = source === 'any' || source === 'migrated', wantS = source === 'any' || source === 'stretch', wantT = source === 'any' || source === 'trending';
  const busy = [];
  for (const e of tokens.values()) {
    if (!e.created || !e.mcapSol || now - e.lastAt > FRESH_MS) continue;
    if (wantM && e.migrated) out.add(e.mint);
    if (wantS && !e.migrated && (e.vSol || 0) >= V_STRETCH) out.add(e.mint);
    if (wantT && e.trades >= 3 && now - e.lastAt < 15 * 60 * 1000) { const st = statsOf(e, now); busy.push([e.mint, st.volSol1h + 0.02 * st.buys1h]); }
  }
  if (wantT) busy.sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([m]) => out.add(m));
  return [...out];
}

/** The same snapshot shape the DexScreener module returns, built from our own trades. null = we have not seen it recently. */
function marketFor(mint, now = Date.now()) {
  const e = tokens.get(mint);
  // only coins we saw being created have a trustworthy age; for anything else the caller falls back to another source
  // a coin we HOLD keeps its last known price for up to 10 minutes of silence, so a quiet coin can still be exited by stop loss / take profit
  if (!e || !e.created || !e.mcapSol || now - e.lastAt > (pinned.has(mint) ? 10 * FRESH_MS : FRESH_MS)) return null;
  const ago = (sec) => { const cut = Math.floor(now / 1000) - sec; let ref = null; for (const b of e.bars) { if (b[0] >= cut) { ref = b[1]; break; } } return ref; };
  const chg = (ref) => (ref > 0 ? ((e.mcapSol - ref) / ref) * 100 : 0);
  const hourCut = Math.floor(now / 1000) - 3600;
  let vol = 0, buys = 0, sells = 0;
  for (const b of e.bars) if (b[0] >= hourCut) { vol += b[5]; buys += b[6]; sells += b[7]; }
  const ageSec = Math.max(0, (now - e.firstSeen) / 1000);
  return {
    marketCapUsd: e.mcapSol * solUsd, liquidityUsd: (e.vSol || 0) * solUsd, priceUsd: (e.mcapSol / SUPPLY) * solUsd, priceNative: e.mcapSol / SUPPLY,
    volume24h: vol * solUsd, volume1h: vol * solUsd, volume6h: vol * solUsd,
    priceChange5m: chg(ago(300)), priceChange1h: chg(ago(3600) ?? (e.bars[0] && e.bars[0][1])), priceChange6h: chg(e.bars[0] && e.bars[0][1]), priceChange24h: 0,
    pairCreatedAt: e.firstSeen, ageSec, ageDays: ageSec / 86400, buys1h: buys, sells1h: sells, pairUrl: null, dexId: e.migrated ? 'pumpswap' : 'pumpfun', source: 'own',
  };
}

/** Numbers the Tokens list shows for a coin, from our own candles (no freshness limit, unlike marketFor). */
function statsOf(e, now = Date.now()) {
  const nowS = Math.floor(now / 1000);
  const ago = (sec) => { for (const b of e.bars) if (b[0] >= nowS - sec) return b[1]; return null; };
  const chg = (ref) => (ref > 0 && e.mcapSol ? ((e.mcapSol - ref) / ref) * 100 : 0);
  let vol = 0, buys = 0, sells = 0;
  for (const b of e.bars) if (b[0] >= nowS - 3600) { vol += b[5]; buys += b[6]; sells += b[7]; }
  return { c5: +chg(ago(300)).toFixed(2), c1h: +chg(ago(3600) ?? (e.bars[0] && e.bars[0][1])).toFixed(2), volSol1h: +vol.toFixed(3), buys1h: buys, sells1h: sells, lastAt: e.lastAt };
}

/** Save recently active coins for the website: its Tokens lists and its charts. At most `limit` rows per call, pinned and busiest first. */
async function flush(db, limit = 40) {
  if (!db || !db.saveCharts) return 0;
  // pictures that finished loading (written once, separately, so a slow chart save never delays them)
  if (db.saveMeta) {
    const done = meta.take(30);
    if (done.length) {
      try { await db.saveMeta(done.map(([mint, v]) => ({ mint, image: v.image, description: v.description, thumb: v.thumb, has_thumb: !!v.thumb }))); }
      catch (err) { logger.warn(`picture save failed (run the latest supabase_art.sql): ${err.message}`); done.forEach(([m]) => meta.requeue(m)); }
    }
  }
  const rows = [...tokens.values()].filter((e) => e.dirty && (e.bars.length || e.migrated))
    .sort((a, b) => (pinned.has(b.mint) - pinned.has(a.mint)) || (b.lastAt - a.lastAt)).slice(0, limit);
  if (!rows.length) return 0;
  rows.forEach((e) => { e.dirty = false; });
  try {
    await db.saveCharts(rows.map((e) => ({ mint: e.mint, name: e.name, symbol: e.symbol, uri: e.uri, created: e.created, dev: e.dev || null, first_seen: new Date(e.firstSeen).toISOString(), mcap_sol: e.mcapSol, v_sol: e.vSol, migrated: e.migrated, migrated_at: e.migratedAt ? new Date(e.migratedAt).toISOString() : null, stats: statsOf(e), bars: e.bars.slice(-SAVE_BARS), trades: e.tape.slice(-2000), bars_1m: e.bars.length > 12 ? e.m1 : [], bars_5m: e.bars.length > 12 ? e.m5 : [], updated_at: new Date().toISOString() })));
  } catch (err) { rows.forEach((e) => { e.dirty = true; }); logger.warn(`chart save failed (run the art_charts SQL in supabase_art.sql): ${err.message}`); return 0; }
  return rows.length;
}

function _reset() { tokens.clear(); pinned.clear(); }
module.exports = { statsOf, onMessage, marketFor, barsFor, has, trackedMints, hotMints, setSolUsd, pin, flush, _reset, MAX_TOKENS };
