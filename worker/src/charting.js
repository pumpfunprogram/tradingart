/**
 * Our own charting and pattern engine. Pure functions, no imports, so the website and the worker share this file
 * byte for byte (a test enforces that).
 *
 * A bar is [t, open, high, low, close, volumeSol, buys, sells]; t = start of the bucket in epoch seconds.
 * Prices are whatever unit the caller feeds in (we use market cap in SOL, so shapes do not depend on supply).
 */
const BASE = 5; // seconds per stored bar
const TFS = [5, 15, 60, 300];

/** Add one trade to a bar list (mutates). Out-of-order trades only touch the bar they belong to. */
function addTrade(bars, tr, base = BASE, max = 8640) {
  const p = Number(tr.p), v = Number(tr.v) || 0;
  if (!(p > 0) || !Number.isFinite(p)) return bars;
  const b = Math.floor(Number(tr.t) / base) * base;
  const buy = tr.side === 'buy' ? 1 : 0, sell = tr.side === 'sell' ? 1 : 0;
  const last = bars[bars.length - 1];
  if (last && last[0] === b) {
    if (p > last[2]) last[2] = p; if (p < last[3]) last[3] = p;
    last[4] = p; last[5] += v; last[6] += buy; last[7] += sell;
  } else if (last && last[0] > b) {
    for (let i = bars.length - 2; i >= 0; i--) {
      if (bars[i][0] === b) { const x = bars[i]; if (p > x[2]) x[2] = p; if (p < x[3]) x[3] = p; x[5] += v; x[6] += buy; x[7] += sell; break; }
      if (bars[i][0] < b) break;
    }
  } else {
    const o = last ? last[4] : p;
    bars.push([b, o, Math.max(o, p), Math.min(o, p), p, v, buy, sell]);
    if (bars.length > max) bars.splice(0, bars.length - max);
  }
  return bars;
}

/** Combine bars into a longer timeframe (tf in seconds, a multiple of the base). */
function resample(bars, tf) {
  if (!(tf > BASE)) return bars.map((b) => b.slice());
  const out = [];
  for (const b of bars) {
    const t = Math.floor(b[0] / tf) * tf;
    const x = out[out.length - 1];
    if (x && x[0] === t) { if (b[2] > x[2]) x[2] = b[2]; if (b[3] < x[3]) x[3] = b[3]; x[4] = b[4]; x[5] += b[5]; x[6] += b[6]; x[7] += b[7]; }
    else out.push([t, b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
  }
  return out;
}

/** Merge two histories of the same token (older server bars + newer live bars). Newer data wins per bucket. */
function mergeBars(a, b) {
  const m = new Map();
  for (const x of a || []) m.set(x[0], x);
  for (const x of b || []) m.set(x[0], x);
  return [...m.values()].sort((p, q) => p[0] - q[0]);
}

/** Pivot lows/highs: a bar whose low (high) is the extreme of the k bars on each side. */
function pivots(bars, k = 2) {
  const lows = [], highs = [];
  for (let i = k; i < bars.length - k; i++) {
    let isLow = true, isHigh = true;
    for (let j = 1; j <= k; j++) {
      if (bars[i][3] > bars[i - j][3] || bars[i][3] > bars[i + j][3]) isLow = false;
      if (bars[i][2] < bars[i - j][2] || bars[i][2] < bars[i + j][2]) isHigh = false;
    }
    if (isLow) lows.push(i);
    if (isHigh) highs.push(i);
  }
  return { lows, highs };
}

const pct = (a, b) => (b ? ((a - b) / b) * 100 : 0);
const no = (reason) => ({ match: false, reason });

/** Two similar lows with a bounce between them, then price turning up again. */
function doubleBottom(all, o = {}) {
  const tol = o.tolerancePct ?? 6, minDrop = o.minDropPct ?? 25, bounce = o.bouncePct ?? 8, confirm = o.confirmPct ?? 2;
  const trig = o.trigger === 'neckline' ? 'neckline' : 'confirm', look = o.lookbackBars ?? 120, k = o.pivotDepth ?? 2, minSep = o.minSepBars ?? 4;
  const off = Math.max(0, all.length - look), w = all.slice(off), n = w.length;
  if (n < 2 * k + minSep + 3) return no('not enough candles yet');
  const { lows } = pivots(w, k);
  if (lows.length < 2) return no('no two clear lows yet');
  let found = null;
  for (let j = lows.length - 1; j >= 1 && !found; j--) {
    for (let i = j - 1; i >= 0; i--) {
      const a = lows[i], b = lows[j];
      if (b - a < minSep) continue;
      const L1 = w[a][3], L2 = w[b][3];
      if (Math.abs(pct(L2, L1)) > tol) continue;
      let neck = 0; for (let x = a; x <= b; x++) neck = Math.max(neck, w[x][2]);
      if (pct(neck, Math.max(L1, L2)) < bounce) continue;
      let prior = 0; for (let x = 0; x <= a; x++) prior = Math.max(prior, w[x][2]);
      if (pct(prior, L1) * (L1 / prior) < minDrop) continue; // drop measured from the earlier high down to the first low
      found = { a, b, L1, L2, neck, prior }; break;
    }
  }
  if (!found) return no('lows are not alike enough, or no bounce / prior drop');
  const { a, b, L1, L2, neck, prior } = found;
  let after = Infinity; for (let x = b; x < n; x++) after = Math.min(after, w[x][3]);
  if (after < Math.min(L1, L2) * (1 - tol / 100)) return no('price broke below the second low');
  const last = w[n - 1][4];
  if (trig === 'confirm') {
    if (last < L2 * (1 + confirm / 100)) return no('second low not confirmed yet');
    if (last > neck * 1.02) return no('already above the neckline');
  } else if (!(last > neck && last <= neck * 1.1)) return no('waiting for a break above the neckline');
  return { match: true, reason: `double bottom: lows ${L1.toFixed(2)} / ${L2.toFixed(2)}, neckline ${neck.toFixed(2)}`, levels: { low1: L1, low2: L2, neckline: neck, priorHigh: prior }, idx: [a + off, b + off], last };
}

/** Close above the recent high, on bigger-than-usual volume. */
function breakout(all, o = {}) {
  const look = o.lookbackBars ?? 40, confirm = o.confirmPct ?? 2, mult = o.volMult ?? 3;
  if (all.length < 8) return no('not enough candles yet');
  const w = all.slice(-(look + 1)), cur = w[w.length - 1], prev = w.slice(0, -1);
  let hi = 0, vs = 0; for (const b of prev) { hi = Math.max(hi, b[2]); vs += b[5]; }
  const avg = vs / prev.length;
  if (!(cur[4] > hi * (1 + confirm / 100))) return no('no close above the recent high');
  if (mult > 0 && avg > 0 && cur[5] < avg * mult) return no('breakout without a volume surge');
  return { match: true, reason: `breakout above ${hi.toFixed(2)}`, levels: { resistance: hi }, idx: [all.length - 1], last: cur[4] };
}

/** A sharp drop from a recent peak, then the first green recovery candle. */
function dipBuy(all, o = {}) {
  const look = o.lookbackBars ?? 60, minDrop = o.minDropPct ?? 25, confirm = o.confirmPct ?? 2;
  if (all.length < 8) return no('not enough candles yet');
  const w = all.slice(-look); let peak = 0, low = Infinity;
  for (const b of w) { peak = Math.max(peak, b[2]); }
  const pi = w.findIndex((b) => b[2] === peak); for (let i = pi; i < w.length; i++) low = Math.min(low, w[i][3]);
  const cur = w[w.length - 1], prev = w[w.length - 2];
  if (pct(peak, low) * (low / peak) < minDrop) return no('no big enough drop from the peak');
  if (!(cur[4] > cur[1] && cur[4] > prev[4])) return no('waiting for a green recovery candle');
  if (cur[4] < low * (1 + confirm / 100)) return no('bounce too small');
  return { match: true, reason: `dip buy: down ${pct(low, peak).toFixed(0)}% from the peak, bouncing`, levels: { peak, low }, idx: [all.length - 1], last: cur[4] };
}

/** Last candle's volume far above the recent norm, price up. */
function volumeSpike(all, o = {}) {
  const look = o.lookbackBars ?? 30, mult = o.volMult ?? 4;
  if (all.length < 8) return no('not enough candles yet');
  const w = all.slice(-(look + 1)), cur = w[w.length - 1], prev = w.slice(0, -1).map((b) => b[5]).sort((x, y) => x - y);
  const med = prev[Math.floor(prev.length / 2)] || 0;
  if (!(cur[4] > cur[1])) return no('last candle is not green');
  if (!(med > 0 ? cur[5] >= med * mult : cur[5] > 0)) return no('no volume spike');
  return { match: true, reason: `volume spike x${med > 0 ? (cur[5] / med).toFixed(1) : '∞'}`, levels: {}, idx: [all.length - 1], last: cur[4] };
}

/**
 * Momentum: the coin is starting to climb, or is climbing, but is not already a runaway. Looks at the last few candles:
 * price is up at least confirmPct over them (and not more than maxRisePct, so we do not buy the very top), the lows are
 * getting higher, buyers clearly outnumber sellers, and the last candle is not red.
 */
function momentum(all, o = {}) {
  const n = all.length, k = 4, min = o.confirmPct ?? 3, max = o.maxRisePct ?? 60;
  if (n < 2 * k + 1) return no('not enough candles yet');
  const recent = all.slice(-k), before = all.slice(-2 * k, -k), ref = all[n - k - 1][4], last = all[n - 1];
  const rise = pct(last[4], ref);
  if (rise < min) return no(`not rising yet (${rise.toFixed(1)}%)`);
  if (rise > max) return no(`already up ${rise.toFixed(0)}%, too late`);
  const lowNow = Math.min(...recent.map((b) => b[3])), lowThen = Math.min(...before.map((b) => b[3]));
  if (lowNow < lowThen * 0.98) return no('lows are not rising');
  let buys = 0, sells = 0; for (const b of recent) { buys += b[6]; sells += b[7]; }
  if (buys + sells < 3) return no('too few trades');
  if (buys < sells * 1.2) return no('sellers are keeping up with buyers');
  if (last[4] < last[1] * 0.995) return no('last candle is red');
  return { match: true, reason: `momentum: up ${rise.toFixed(1)}% with ${buys} buys to ${sells} sells`, levels: { from: ref }, idx: [n - 1], last: last[4] };
}

const PATTERNS = { double_bottom: doubleBottom, breakout, dip_buy: dipBuy, volume_spike: volumeSpike, momentum };
const PATTERN_LABELS = { double_bottom: 'Double bottom', breakout: 'Breakout', dip_buy: 'Dip buy', volume_spike: 'Volume spike', momentum: 'Momentum (rising now)' };

/** Run one pattern on bars already at the timeframe you want. */
function detect(type, bars, opts) { const f = PATTERNS[type]; return f ? f(bars, opts || {}) : no('unknown pattern'); }

module.exports = { BASE, TFS, addTrade, resample, mergeBars, pivots, detect, doubleBottom, breakout, dipBuy, volumeSpike, momentum, PATTERNS, PATTERN_LABELS };
