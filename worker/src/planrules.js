/**
 * Pure plan rules: defaults and sanitising. No imports, so the web app and the worker can share this
 * file byte for byte (a test enforces that).
 */
const DAY = 86400;
const STEADY = { name: 'Steady', sizeUsd: 7, minAgeSec: 10 * DAY, maxAgeSec: null, takeProfitPct: 60, stopLossPct: 30, maxHoldMin: 5, scanEverySec: 60, maxTradesDay: 15, minLiqUsd: 8000, minVol1hUsd: 1500, minBuys1h: 5, requireRising: true };
const SNIPER = { name: 'Sniper', sizeUsd: 7, minAgeSec: 30, maxAgeSec: 30 * 60, takeProfitPct: 50, stopLossPct: 25, maxHoldMin: 3, scanEverySec: 20, maxTradesDay: 20, minLiqUsd: 4000, minVol1hUsd: 500, minBuys1h: 5, requireRising: false };

const MAX_PLANS = 10;

/** The chart-watching agent a plan can carry. When enabled, the robot watches the live candles of young coins and
 *  enters only when the chosen pattern shows up inside the market-cap range. Everything else in the plan (size, exits) still applies. */
const PATTERNS = ['double_bottom', 'breakout', 'dip_buy', 'volume_spike', 'momentum'];
/** Which coins an agent looks at: any of the three hot groups, or just one group. */
const SOURCES = ['any', 'migrated', 'stretch', 'trending'];
const AGENT_TFS = [5, 15, 60, 300];
const AGENT_OFF = { enabled: false, pattern: 'double_bottom', tfSec: 15, mcapMinUsd: 0, mcapMaxUsd: null, tolerancePct: 6, minDropPct: 25, bouncePct: 8, confirmPct: 2, trigger: 'confirm', lookbackBars: 120, volMult: 4, maxRisePct: 60, source: 'any', onlyMint: null };
/** Default plan: chase coins that are rising right now among migrated, final-stretch and trending coins, and take profit fast. */
const RIDER = { name: 'Rider', sizeUsd: 7, minAgeSec: 0, maxAgeSec: null, takeProfitPct: 20, stopLossPct: 12, maxHoldMin: 6, scanEverySec: 10, maxTradesDay: 40, minLiqUsd: 0, minVol1hUsd: 0, minBuys1h: 0, requireRising: false,
  agent: { ...AGENT_OFF, enabled: true, pattern: 'momentum', tfSec: 15, confirmPct: 3, maxRisePct: 60, source: 'any' } };
const EASY = { name: 'Easy', sizeUsd: 5, minAgeSec: 0, maxAgeSec: null, takeProfitPct: 15, stopLossPct: 10, maxHoldMin: 10, scanEverySec: 10, maxTradesDay: 50, minLiqUsd: 0, minVol1hUsd: 0, minBuys1h: 0, requireRising: false };
const HUNTER = { name: 'Bottom Hunter', sizeUsd: 7, minAgeSec: 120, maxAgeSec: 6 * 3600, takeProfitPct: 40, stopLossPct: 20, maxHoldMin: 20, scanEverySec: 10, maxTradesDay: 20, minLiqUsd: 0, minVol1hUsd: 0, minBuys1h: 0, requireRising: false,
  agent: { ...AGENT_OFF, enabled: true, mcapMinUsd: 8000, mcapMaxUsd: 100000 } };
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function sanitizeAgent(a, base = AGENT_OFF) {
  a = a && typeof a === 'object' ? a : {};
  const mcapMin = clamp(num(a.mcapMinUsd, base.mcapMinUsd), 0, 1e12);
  let mcapMax = a.mcapMaxUsd === undefined ? base.mcapMaxUsd : a.mcapMaxUsd;
  mcapMax = mcapMax == null || mcapMax === '' ? null : clamp(num(mcapMax, 0), 0, 1e12);
  if (mcapMax !== null && mcapMax <= mcapMin) mcapMax = null;
  const tf = Math.round(num(a.tfSec, base.tfSec));
  return {
    enabled: a.enabled === undefined ? !!base.enabled : !!a.enabled,
    pattern: PATTERNS.includes(a.pattern) ? a.pattern : base.pattern,
    tfSec: AGENT_TFS.includes(tf) ? tf : base.tfSec,
    mcapMinUsd: mcapMin, mcapMaxUsd: mcapMax,
    tolerancePct: clamp(num(a.tolerancePct, base.tolerancePct), 0.5, 25),
    minDropPct: clamp(num(a.minDropPct, base.minDropPct), 5, 95),
    bouncePct: clamp(num(a.bouncePct, base.bouncePct), 2, 300),
    confirmPct: clamp(num(a.confirmPct, base.confirmPct), 0, 50),
    trigger: a.trigger === 'neckline' ? 'neckline' : a.trigger === 'confirm' ? 'confirm' : base.trigger,
    lookbackBars: clamp(Math.round(num(a.lookbackBars, base.lookbackBars)), 20, 400),
    volMult: clamp(num(a.volMult, base.volMult), 1.5, 50),
    maxRisePct: clamp(num(a.maxRisePct, base.maxRisePct), 5, 500),
    source: SOURCES.includes(a.source) ? a.source : base.source,
    // watch ONE coin only (its contract address); null = every young coin inside the market-cap range
    onlyMint: a.onlyMint === undefined ? (base.onlyMint || null) : (typeof a.onlyMint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.onlyMint.trim()) ? a.onlyMint.trim() : null),
  };
}

/** Make any input a safe plan. Out-of-range numbers are pulled into range, never trusted. */
function sanitizePlan(p = {}, base = STEADY) {
  const minAgeSec = clamp(Math.round(num(p.minAgeSec, base.minAgeSec)), 0, 3650 * DAY);
  let maxAgeSec = p.maxAgeSec === undefined ? base.maxAgeSec : p.maxAgeSec;
  maxAgeSec = maxAgeSec == null || maxAgeSec === '' ? null : clamp(Math.round(num(maxAgeSec, 0)), 0, 3650 * DAY);
  if (maxAgeSec !== null && maxAgeSec <= minAgeSec) maxAgeSec = null;
  return {
    id: String(p.id || '').slice(0, 40) || undefined,
    name: String(p.name == null ? base.name : p.name).trim().slice(0, 24) || base.name,
    sizeUsd: clamp(Math.round(num(p.sizeUsd, base.sizeUsd) * 100) / 100, 1, 1e6),
    minAgeSec, maxAgeSec,
    takeProfitPct: clamp(num(p.takeProfitPct, base.takeProfitPct), 1, 10000),
    stopLossPct: clamp(num(p.stopLossPct, base.stopLossPct), 1, 95),
    maxHoldMin: clamp(num(p.maxHoldMin, base.maxHoldMin), 0.5, 1440),
    scanEverySec: clamp(Math.round(num(p.scanEverySec, base.scanEverySec)), 10, 3600),
    maxTradesDay: clamp(Math.round(num(p.maxTradesDay, base.maxTradesDay)), 1, 500),
    minLiqUsd: clamp(num(p.minLiqUsd, base.minLiqUsd), 0, 1e9),
    minVol1hUsd: clamp(num(p.minVol1hUsd, base.minVol1hUsd), 0, 1e9),
    minBuys1h: clamp(Math.round(num(p.minBuys1h, base.minBuys1h)), 0, 1e6),
    requireRising: p.requireRising === undefined ? !!base.requireRising : !!p.requireRising,
    agent: sanitizeAgent(p.agent, base.agent || AGENT_OFF),
  };
}

function defaultPlans() { return [{ id: 'easy', ...EASY }, { id: 'rider', ...RIDER }, { id: 'steady', ...STEADY }, { id: 'sniper', ...SNIPER }]; }

module.exports = { sanitizePlan, sanitizeAgent, defaultPlans, MAX_PLANS, STEADY, SNIPER, RIDER, HUNTER, EASY, SOURCES, AGENT_OFF, PATTERNS, AGENT_TFS };
