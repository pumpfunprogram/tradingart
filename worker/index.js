require('dotenv').config();
const config = require('./src/config');
const logger = require('./src/utils/logger');
const { connect, createDb } = require('./src/db/db');
const { unsealSecret } = require('./src/vault/seal');
const { Engine } = require('./src/engine');
const telegram = require('./src/telegram/bot');

console.log(`=== ART worker v${config.VERSION} ===`);
console.log(config.LIVE_TRADING_ENABLED ? 'LIVE trading ENABLED: users who chose live (and signed consent) trade real funds from their vaults' : 'LIVE trading DISABLED: every user is paper-trading');

const missing = ['VAULT_SEAL_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error('MISSING ENV: ' + missing.join(', '));
  console.error('Set these on the Render service, then redeploy. The worker cannot start without them.');
  process.exit(1);
}
console.log('env ok: seal, supabase url, supabase key present');

const http = require('http');
const healthPort = Number(process.env.PORT) || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, v: config.VERSION, live: !!config.LIVE_TRADING_ENABLED, t: Date.now() }));
}).listen(healthPort, () => console.log('health on :' + healthPort));

async function main() {
  if (!config.VAULT_SEAL_SECRET) throw new Error('VAULT_SEAL_SECRET is required (npm run gen-seal-key)');
  const db = createDb(connect());
  const deps = {
    db,
    market: require('./src/analysis/market'),
    chain: require('./src/solana/chain'),
    swap: require('./src/trading/swap'),
    fills: require('./src/solana/fills'),
    scanner: require('./src/scanner/scanner'),
  };
  require('./src/scanner/stream').start();
  const collector = require('./src/data/collector');
  const scanner = require('./src/scanner/scanner');
  // own market data: refresh the SOL price, save fresh candles for the website, tidy old rows
  const refreshSol = () => scanner.fetchSolPriceUsd().then((v) => collector.setSolUsd(v)).catch(() => {});
  refreshSol(); setInterval(refreshSol, 60000).unref();
  setInterval(() => collector.flush(db).catch(() => {}), 10000).unref();
  setInterval(() => db.pruneCharts && db.pruneCharts().catch(() => {}), 3600000).unref();
  const engine = new Engine({ db, deps, unsealSecret: (sealed) => unsealSecret(sealed, config.VAULT_SEAL_SECRET) });
  const tg = telegram.start(engine);
  engine.send = tg.send; engine.adminNotify = tg.adminNotify;
  await engine.start();
  tg.adminNotify(`ART worker v${config.VERSION} started · live ${config.LIVE_TRADING_ENABLED ? 'ON' : 'off (paper only)'} · ${engine.accounts.size} active account(s)`);

  const stop = async (sig) => { logger.info(`${sig}: stopping`); require('./src/scanner/stream').stop(); await engine.stop(); if (tg.stop) tg.stop(); process.exit(0); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
process.on('unhandledRejection', (e) => logger.error('unhandledRejection:', (e && e.message) || e));
process.on('uncaughtException', (e) => logger.error('uncaughtException:', (e && e.message) || e));
main().catch((e) => { logger.error('fatal:', e.message || e); process.exit(1); });
