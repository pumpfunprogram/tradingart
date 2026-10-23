require('dotenv').config();

const num = (name, fb) => {
  const v = process.env[name];
  if (v == null || v === '') return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};
const bool = (name, fb) => {
  const v = process.env[name];
  if (v == null || v === '') return fb;
  return !/^(false|0|no|off)$/i.test(String(v).trim());
};
const list = (name) =>
  String(process.env[name] || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const DEFAULT_RPC_URLS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];
const rpcFromEnv = list('RPC_URLS').concat(list('RPC_URL'));

module.exports = {
  VERSION: '4.6.2-land',

  SUPABASE_URL: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
  VAULT_SEAL_SECRET: process.env.VAULT_SEAL_SECRET || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || null,

  LIVE_TRADING_ENABLED: bool('LIVE_TRADING_ENABLED', false),

  RPC_URLS: rpcFromEnv.length ? rpcFromEnv : DEFAULT_RPC_URLS,
  PUMPPORTAL_TRADE_URL:
    process.env.PUMPPORTAL_TRADE_URL || 'https://pumpportal.fun/api/trade-local',
  SOL_MINT: 'So11111111111111111111111111111111111111112',

  CAP_MAX_POSITION_SOL: num('CAP_MAX_POSITION_SOL', 0),
  CAP_MAX_SIZE_USD: num('CAP_MAX_SIZE_USD', 0),
  CAP_MAX_DAILY_LOSS_PCT: num('CAP_MAX_DAILY_LOSS_PCT', 100),
  CAP_MAX_CONCURRENT: num('CAP_MAX_CONCURRENT', 20),

  MIN_VAULT_SOL: num('MIN_VAULT_SOL', 0.02),
  MIN_POSITION_SOL: num('MIN_POSITION_SOL', 0.008),
  SOL_FEE_RESERVE: num('SOL_FEE_RESERVE', 0.02),
  FORCE_SIZE_SOL: num('FORCE_SIZE_SOL', 0.015),

  BUY_SLIPPAGE_PCT: num('BUY_SLIPPAGE_PCT', 30),
  BUY_SLIPPAGE_STEP_PCT: num('BUY_SLIPPAGE_STEP_PCT', 10),
  BUY_SLIPPAGE_MAX_PCT: num('BUY_SLIPPAGE_MAX_PCT', 70),
  BUY_ATTEMPTS: num('BUY_ATTEMPTS', 4),
  BUY_PRIORITY_FEE_SOL: num('BUY_PRIORITY_FEE_SOL', 0.005),
  SELL_SLIPPAGE_PCT: num('SELL_SLIPPAGE_PCT', 40),
  SELL_SLIPPAGE_STEP_PCT: num('SELL_SLIPPAGE_STEP_PCT', 10),
  SELL_SLIPPAGE_MAX_PCT: num('SELL_SLIPPAGE_MAX_PCT', 80),
  SELL_PRIORITY_FEE_SOL: num('SELL_PRIORITY_FEE_SOL', 0.001),
  SELL_RETRIES: num('SELL_RETRIES', 8),
  STUCK_RETRY_MS: num('STUCK_RETRY_MS', 45000),
  BUY_CONFIRM_TIMEOUT_MS: num('BUY_CONFIRM_TIMEOUT_MS', 45000),
  SELL_CONFIRM_TIMEOUT_MS: num('SELL_CONFIRM_TIMEOUT_MS', 30000),
  REBROADCAST_MS: num('REBROADCAST_MS', 350),

  MIN_LIQUIDITY_USD: num('MIN_LIQUIDITY_USD', 0),
  REQUIRE_NO_AUTHORITIES: bool('REQUIRE_NO_AUTHORITIES', false),
  EXIT_COST_PCT: num('EXIT_COST_PCT', 2),
  IGNORE_MINTS: list('IGNORE_MINTS'),

  PAPER_BALANCE_SOL: num('PAPER_BALANCE_SOL', 1),
  PAPER_FRICTION_PCT: num('PAPER_FRICTION_PCT', 2),

  MAX_POOL_SHARE_PCT: num('MAX_POOL_SHARE_PCT', 100),
  STREAM_ENABLED: bool('STREAM_ENABLED', true),
  STREAM_URL: process.env.STREAM_URL || 'wss://pumpportal.fun/api/data',

  PRICE_POLL_MS: num('PRICE_POLL_MS', 6000),
  SYNC_MS: num('SYNC_MS', 15000),
  WITHDRAW_POLL_MS: num('WITHDRAW_POLL_MS', 4000),
};
