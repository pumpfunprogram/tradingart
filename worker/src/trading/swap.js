const { VersionedTransaction } = require('@solana/web3.js');
const config = require('../config');
const { rpc, broadcast, signatureOf } = require('../solana/rpc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildTx(wallet, body) {
  const payload = {
    publicKey: wallet.publicKey.toBase58(),
    ...body,
    pool: body.pool || 'pump',
    amount: typeof body.amount === 'number' ? Number(body.amount.toFixed(6)) : body.amount,
    slippage: Number(body.slippage),
    priorityFee: Number(body.priorityFee),
  };
  console.log('[swap] pumpportal request:', JSON.stringify({ ...payload, publicKey: payload.publicKey.slice(0, 8) + '…' }));
  const res = await fetch(config.PUMPPORTAL_TRADE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  });
  if (res.status !== 200) {
    const text = (await res.text()).slice(0, 300);
    console.error('[swap] pumpportal error', res.status, text);
    throw new Error(`pumpportal ${res.status}: ${text}`);
  }
  return VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
}

async function statusOf(signature) {
  const res = await rpc((c) => c.getSignatureStatuses([signature], { searchTransactionHistory: true }));
  const st = res.value[0];
  if (!st) return null;
  if (st.err) return { ok: false, onchain: true, err: st.err };
  if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' || st.confirmationStatus === 'processed') return { ok: true };
  return null;
}

function explainSim(err, logs) {
  const text = (logs || []).join(' ');
  const code = err && err.InstructionError && err.InstructionError[1] && err.InstructionError[1].Custom;
  if (code === 6063 || /BondingCurveComplete|bonding curve is complete/i.test(text + JSON.stringify(err))) {
    return { fatal: true, why: 'bonding curve already complete (token graduated)' };
  }
  if (/insufficient lamports|insufficient funds|InsufficientFunds/i.test(text + JSON.stringify(err))) {
    return { fatal: true, why: 'vault does not have enough SOL for this buy + fees + rent' };
  }
  if (err === 'InsufficientFundsForRent' || (err && err.InsufficientFundsForRent)) {
    return { fatal: true, why: 'vault would drop below Solana rent-exempt minimum' };
  }
  if (code === 6002 || code === 6003 || /TooMuchSolRequired|TooLittleSolReceived|slippage/i.test(text)) {
    return { fatal: false, why: 'price moved past allowed slippage' };
  }
  if (code === 6005) return { fatal: true, why: 'coin just left bonding curve for a regular pool' };
  const tail = (logs || []).filter((l) => /fail|error|insufficient/i.test(l)).slice(-1)[0] || '';
  return { fatal: false, why: `rejected by network: ${JSON.stringify(err)} ${tail}`.slice(0, 220) };
}

async function preflight(tx) {
  let res;
  try {
    res = await rpc((c) => c.simulateTransaction(tx, { sigVerify: false, commitment: 'processed', replaceRecentBlockhash: true }));
  } catch (e) {
    console.log(`[swap] preflight rpc error (still sending): ${e.message}`);
    return null;
  }
  const v = res && res.value;
  if (!v || !v.err) return null;
  if (v.err === 'BlockhashNotFound') return null;
  return explainSim(v.err, v.logs);
}

async function landTx(tx, wallet, timeoutMs, opts = {}) {
  tx.sign([wallet]);
  const raw = tx.serialize();
  const signature = signatureOf(tx);
  if (opts.preflight) {
    const bad = await preflight(tx);
    if (bad) {
      const err = new Error(`buy rejected before sending: ${bad.why}`);
      err.notSent = true;
      err.fatal = bad.fatal;
      throw err;
    }
  }
  try {
    await broadcast(raw);
  } catch (e) {
    const err = new Error(`send failed: ${e.message}`);
    err.signature = signature;
    err.notSent = true;
    throw err;
  }
  const started = Date.now();
  let lastSend = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(400);
    try {
      const st = await statusOf(signature);
      if (st && st.ok) return signature;
      if (st && !st.ok) {
        const err = new Error(`tx failed on-chain: ${JSON.stringify(st.err)} (${signature})`);
        err.signature = signature;
        err.onchainError = true;
        throw err;
      }
    } catch (e) {
      if (e.onchainError) throw e;
    }
    if (Date.now() - lastSend >= config.REBROADCAST_MS) {
      lastSend = Date.now();
      broadcast(raw).catch((err) => console.log(`[swap] rebroadcast: ${err.message}`));
    }
  }
  const err = new Error(`not confirmed within ${Math.round(timeoutMs / 1000)}s (${signature})`);
  err.signature = signature;
  err.timedOut = true;
  throw err;
}

async function waitForSignature(signature, maxMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    try {
      const st = await statusOf(signature);
      if (st && st.ok) return { ok: true };
      if (st && !st.ok) return { ok: false, reason: `failed on-chain ${JSON.stringify(st.err)}` };
    } catch (_) {}
    await sleep(1000);
  }
  return { ok: false, reason: 'never landed (tx expired)' };
}

const solAmount = (sol) => Number(Number(sol).toFixed(6));

function buyParams(attempt = 1) {
  return {
    slippage: Math.min(config.BUY_SLIPPAGE_PCT + config.BUY_SLIPPAGE_STEP_PCT * (attempt - 1), config.BUY_SLIPPAGE_MAX_PCT),
    priorityFee: Number((config.BUY_PRIORITY_FEE_SOL * Math.pow(1.4, attempt - 1)).toFixed(6)),
  };
}

async function buy(wallet, mint, sol, attempt = 1) {
  const p = buyParams(attempt);
  const pool = String(mint).endsWith('pump') ? 'pump' : 'auto';
  console.log(`[swap] buy ${mint.slice(0, 6)} ${sol} SOL pool=${pool} fee=${p.priorityFee} slip=${p.slippage}`);
  const tx = await buildTx(wallet, {
    action: 'buy',
    mint,
    amount: solAmount(sol),
    denominatedInSol: 'true',
    slippage: p.slippage,
    priorityFee: p.priorityFee,
    pool,
  });
  return landTx(tx, wallet, config.BUY_CONFIRM_TIMEOUT_MS, { preflight: true });
}

function sellParams(attempt = 1) {
  return {
    slippage: Math.min(config.SELL_SLIPPAGE_PCT + config.SELL_SLIPPAGE_STEP_PCT * (attempt - 1), config.SELL_SLIPPAGE_MAX_PCT),
    priorityFee: Number((config.SELL_PRIORITY_FEE_SOL * Math.pow(1.3, attempt - 1)).toFixed(6)),
  };
}

async function sellAll(wallet, mint, attempt = 1) {
  const p = sellParams(attempt);
  const pool = String(mint).endsWith('pump') ? 'pump' : 'auto';
  const tx = await buildTx(wallet, {
    action: 'sell',
    mint,
    amount: '100%',
    denominatedInSol: 'false',
    slippage: p.slippage,
    priorityFee: p.priorityFee,
    pool,
  });
  return landTx(tx, wallet, config.SELL_CONFIRM_TIMEOUT_MS);
}

module.exports = { buildTx, landTx, waitForSignature, statusOf, buy, buyParams, preflight, explainSim, sellAll, sellParams };
