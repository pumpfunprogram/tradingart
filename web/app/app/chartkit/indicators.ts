/**
 * Indicator math for the token chart.
 * Every indicator takes the candle close array and returns aligned series.
 */

export type Candle = { time: number; open: number; high: number; low: number; close: number };
export type Arr = number[];

const nan = (n: number): Arr => Array(n).fill(NaN);
const lead = (v: Arr) => { let i = 0; while (i < v.length && Number.isNaN(v[i])) i++; return i; };

/** Run f on the part of v that has values, pad the front with NaN. */
function withLead(v: Arr, f: (x: Arr) => Arr): Arr {
  const s = lead(v);
  if (s >= v.length) return nan(v.length);
  const out = nan(s);
  const r = f(v.slice(s));
  for (let i = 0; i < r.length; i++) out.push(r[i]);
  return out;
}

export function sma(closes: Arr, period: number): Arr {
  const out = nan(closes.length);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(closes: Arr, period: number): Arr {
  const out = nan(closes.length);
  if (closes.length < period) return out;
  const k = 2 / (period + 1);
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function wma(closes: Arr, period: number): Arr {
  const out = nan(closes.length);
  const den = (period * (period + 1)) / 2;
  for (let i = period - 1; i < closes.length; i++) {
    let num = 0;
    for (let j = 0; j < period; j++) num += closes[i - j] * (period - j);
    out[i] = num / den;
  }
  return out;
}

/** Wilder RSI. */
export function rsi(closes: Arr, period = 14): Arr {
  const out = nan(closes.length);
  if (closes.length <= period) return out;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function vwap(candles: Candle[], volumes: Arr): Arr {
  const out = nan(candles.length);
  let pv = 0, vv = 0;
  for (let i = 0; i < candles.length; i++) {
    const tp = (candles[i].high + candles[i].low + candles[i].close) / 3;
    const vol = volumes[i] || 0;
    pv += tp * vol; vv += vol;
    if (vv > 0) out[i] = pv / vv;
  }
  return out;
}

/** Supertrend. Returns { line, dir } where dir is 1 (up) or -1 (down). */
export function supertrend(candles: Candle[], period = 10, mult = 3): { line: Arr; dir: Arr } {
  const n = candles.length;
  const line = nan(n), dir = nan(n);
  if (n < period) return { line, dir };
  const atr = nan(n);
  let trSum = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trSum += tr;
    if (i >= period) {
      atr[i] = i === period ? trSum / period : (atr[i - 1] * (period - 1) + tr) / period;
    }
  }
  let prevUpper = 0, prevLower = 0, prevDir = 1;
  for (let i = period; i < n; i++) {
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const upper = hl2 + mult * atr[i];
    const lower = hl2 - mult * atr[i];
    const finalUpper = upper < prevUpper || candles[i - 1].close > prevUpper ? upper : prevUpper;
    const finalLower = lower > prevLower || candles[i - 1].close < prevLower ? lower : prevLower;
    let d = prevDir;
    if (prevDir === -1 && candles[i].close > prevUpper) d = 1;
    else if (prevDir === 1 && candles[i].close < prevLower) d = -1;
    line[i] = d === 1 ? finalLower : finalUpper;
    dir[i] = d;
    prevUpper = finalUpper; prevLower = finalLower; prevDir = d;
  }
  return { line, dir };
}

export type IndKind = 'sma' | 'ema' | 'wma' | 'rsi' | 'vwap' | 'supertrend';

export type IndDef = {
  kind: IndKind;
  params: { name: string; def: number }[];
  outs: { label: string; color: string }[];
  pane: 'price' | 'sub';
};

export const IND_DEFS: Record<IndKind, IndDef> = {
  sma: { kind: 'sma', params: [{ name: 'period', def: 20 }], outs: [{ label: 'SMA', color: '#f59e0b' }], pane: 'price' },
  ema: { kind: 'ema', params: [{ name: 'period', def: 9 }], outs: [{ label: 'EMA', color: '#3b82f6' }], pane: 'price' },
  wma: { kind: 'wma', params: [{ name: 'period', def: 20 }], outs: [{ label: 'WMA', color: '#a855f7' }], pane: 'price' },
  rsi: { kind: 'rsi', params: [{ name: 'period', def: 14 }], outs: [{ label: 'RSI', color: '#ec4899' }], pane: 'sub' },
  vwap: { kind: 'vwap', params: [], outs: [{ label: 'VWAP', color: '#06b6d4' }], pane: 'price' },
  supertrend: { kind: 'supertrend', params: [{ name: 'period', def: 10 }, { name: 'mult', def: 3 }], outs: [{ label: 'ST', color: '#22c55e' }], pane: 'price' },
};

export type ActiveInd = { id: string; kind: IndKind; params: Record<string, number> };

const SHORT: Record<IndKind, string> = { sma: 'SMA', ema: 'EMA', wma: 'WMA', rsi: 'RSI', vwap: 'VWAP', supertrend: 'ST' };

export function indLabel(i: ActiveInd): string {
  const d = IND_DEFS[i.kind];
  if (i.kind === 'vwap') return 'VWAP';
  const ps = d.params.map((p) => i.params[p.name] ?? p.def);
  return ps.length ? `${SHORT[i.kind]}(${ps.join(',')})` : SHORT[i.kind];
}

export function cleanParams(kind: IndKind, raw: Record<string, number>): Record<string, number> {
  const d = IND_DEFS[kind];
  const out: Record<string, number> = {};
  for (const p of d.params) out[p.name] = Number.isFinite(raw[p.name]) ? raw[p.name] : p.def;
  return out;
}

export function runIndicator(kind: IndKind, candles: Candle[], volumes: Arr, params: Record<string, number>): { values: Arr[]; colors: string[] } {
  const closes = candles.map((c) => c.close);
  const p = cleanParams(kind, params);
  switch (kind) {
    case 'sma': return { values: [sma(closes, p.period)], colors: [IND_DEFS.sma.outs[0].color] };
    case 'ema': return { values: [ema(closes, p.period)], colors: [IND_DEFS.ema.outs[0].color] };
    case 'wma': return { values: [wma(closes, p.period)], colors: [IND_DEFS.wma.outs[0].color] };
    case 'rsi': return { values: [rsi(closes, p.period)], colors: [IND_DEFS.rsi.outs[0].color] };
    case 'vwap': return { values: [vwap(candles, volumes)], colors: [IND_DEFS.vwap.outs[0].color] };
    case 'supertrend': {
      const st = supertrend(candles, p.period, p.mult);
      return { values: [st.line], colors: [IND_DEFS.supertrend.outs[0].color] };
    }
  }
}
