/**
 * Token scanner. Candidates come from a shared pool (DexScreener feeds + the live new-token stream); each
 * account then applies ITS plan: age window (in seconds), liquidity/volume/buy bars, momentum rule.
 */
const logger = require('../utils/logger');
const market = require('../analysis/dexscreener');
const stream = require('./stream');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
const seenBy = new Map(); // key (user) -> Map(mint -> ts)

let solPrice = { v: 180, ts: 0 };
async function fetchSolPriceUsd() {
  if (Date.now() - solPrice.ts < 60000) return solPrice.v;
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const pair = (data.pairs || []).find((p) => p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT');
      const px = Number(pair?.priceUsd || 0);
      if (px > 10) solPrice = { v: px, ts: Date.now() };
    }
  } catch (_) {}
  return solPrice.v;
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch (e) {
    logger.warn(`fetch ${url.slice(0, 60)} failed: ${e.message}`);
    return null;
  }
}

let poolCache = { at: 0, mints: [] };
async function feedCandidates() {
  if (Date.now() - poolCache.at < 25000) return poolCache.mints;
  const mints = new Set();
  for (const url of ['https://api.dexscreener.com/token-boosts/latest/v1', 'https://api.dexscreener.com/token-profiles/latest/v1']) {
    const arr = await getJson(url);
    for (const it of Array.isArray(arr) ? arr : []) if (it.chainId === 'solana' && it.tokenAddress) mints.add(it.tokenAddress);
  }
  const s = await getJson('https://api.dexscreener.com/latest/dex/search?q=solana');
  for (const p of (s && s.pairs) || []) if (p.chainId === 'solana' && p.baseToken?.address) mints.add(p.baseToken.address);
  poolCache = { at: Date.now(), mints: [...mints].slice(0, 50) };
  return poolCache.mints;
}

/** Score one market snapshot against ONE plan. -Infinity = does not qualify. */
function scoreChart(mkt, plan) {
  if (!mkt || !(mkt.priceNative > 0)) return -Infinity;
  const open = !plan.minAgeSec && !plan.minLiqUsd && !plan.minVol1hUsd && !plan.minBuys1h && !plan.requireRising;
  const ageSec = mkt.ageSec != null ? mkt.ageSec : (mkt.ageDays || 0) * 86400;
  if (!open && !(mkt.pairCreatedAt > 0 || ageSec > 0)) return -Infinity;
  if (ageSec < plan.minAgeSec) return -Infinity;
  if (plan.maxAgeSec != null && ageSec > plan.maxAgeSec) return -Infinity;
  const liq = mkt.liquidityUsd || 0, vol1h = mkt.volume1h || 0, vol6h = mkt.volume6h || 0;
  const ch5 = mkt.priceChange5m || 0, ch1h = mkt.priceChange1h || 0, ch6h = mkt.priceChange6h || 0, ch24h = mkt.priceChange24h || 0;
  const buys1h = mkt.buys1h || 0, sells1h = mkt.sells1h || 0;
  if (plan.requireRising && !(ch1h > 0 || ch6h > 2)) return -Infinity;
  if (!open && (ch5 < -12 || ch24h < -40)) return -Infinity;
  if (liq < plan.minLiqUsd) return -Infinity;
  if (vol1h < plan.minVol1hUsd && vol6h < plan.minVol1hUsd * 3) return -Infinity;
  if (buys1h < plan.minBuys1h) return -Infinity;
  const buyPressure = sells1h > 0 ? buys1h / sells1h : buys1h > 0 ? 2 : 0;
  if (!open && buyPressure < 0.7) return -Infinity;
  let score = 0;
  score += Math.min(ch5, 25) * 1.5; score += Math.min(ch1h, 40) * 2; score += Math.min(ch6h, 60);
  score += Math.log10(Math.max(liq, 1)) * 10; score += Math.log10(Math.max(vol1h, 1)) * 6;
  score += Math.min(buyPressure, 3) * 8; score += Math.min(ageSec / 86400, 60) * 0.3;
  return score;
}

async function pickOne(plan, key = 'default', stats = {}) {
  let seen = seenBy.get(key); if (!seen) { seen = new Map(); seenBy.set(key, seen); }
  const now = Date.now();
  for (const [m, ts] of seen) if (now - ts > SEEN_TTL_MS) seen.delete(m);
  // young coins first (they are only in the window briefly), then the general feeds
  const mints = new Set(stream.recent(plan.minAgeSec, plan.maxAgeSec, 40));
  for (const m of await feedCandidates()) mints.add(m);
  const candidates = [...mints];
  stats.candidates = candidates.length;
  if (!candidates.length) { logger.info(`scanner[${plan.name}]: no candidates this cycle`); return null; }
  const scored = [];
  for (const mint of candidates) {
    if (seen.has(mint) || config.IGNORE_MINTS.includes(mint)) continue;
    try {
      const mkt = await market.getTokenMarket(mint);
      if (!mkt) continue;
      const sc = scoreChart(mkt, plan);
      if (sc > -Infinity) scored.push({ mint, mkt, score: sc });
    } catch (_) {}
    await sleep(60);
  }
  stats.matched = scored.length;
  scored.sort((a, b) => b.score - a.score);
  const open = !plan.minAgeSec && !plan.minLiqUsd && !plan.minVol1hUsd && !plan.minBuys1h && !plan.requireRising;
  if (!scored.length && open && candidates.length) {
    const mint = candidates.find((m) => !seen.has(m) && !config.IGNORE_MINTS.includes(m));
    if (mint) {
      seen.set(mint, Date.now());
      logger.info(`scanner[${plan.name}] easy pick ${mint.slice(0, 8)}… (no market data, entering anyway)`);
      return { mint, mkt: { priceNative: 1, liquidityUsd: 0, ageSec: 1 }, score: 1 };
    }
  }
  if (!scored.length) { logger.info(`scanner[${plan.name}]: ${candidates.length} candidates, none passed (age ${fmtAge(plan.minAgeSec)}–${plan.maxAgeSec == null ? 'any' : fmtAge(plan.maxAgeSec)}${plan.requireRising ? ', rising' : ''})`); return null; }
  const top = scored.slice(0, 5);
  const pick = top[Math.floor(Math.random() * top.length)];
  seen.set(pick.mint, Date.now());
  logger.info(`scanner[${plan.name}] pick ${pick.mint.slice(0, 8)}… score=${pick.score.toFixed(1)} liq=$${Math.round(pick.mkt.liquidityUsd)}`);
  return pick;
}

function fmtAge(sec) {
  if (sec >= 86400) return `${+(sec / 86400).toFixed(1)}d`;
  if (sec >= 3600) return `${+(sec / 3600).toFixed(1)}h`;
  if (sec >= 60) return `${+(sec / 60).toFixed(1)}m`;
  return `${sec}s`;
}

module.exports = { pickOne, scoreChart, fetchSolPriceUsd, fmtAge };
