import { PublicKey } from '@solana/web3.js';
import { env } from './env';

/**
 * Public on-chain trade history for a pump.fun coin, read straight from the Solana network (our own RPC connection, no
 * chart service). Every buy and sell of a coin on its bonding curve touches one account, the curve. So the curve's
 * transaction list IS the coin's trade list: for each one we read how much SOL moved in or out of the curve and how many
 * tokens went the other way. That gives side, size, price (market cap) and the trader.
 */
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export type ChainTrade = { sig: string; t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who: string };

export function curveOf(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), new PublicKey(mint).toBytes()], new PublicKey(PUMP_PROGRAM))[0].toBase58();
}

const ui = (b: any): number => { const x = b?.uiTokenAmount; if (!x) return 0; if (typeof x.uiAmount === 'number') return x.uiAmount; return Number(x.amount || 0) / 10 ** (x.decimals ?? 6); };

/** One transaction (from getTransaction, any encoding) -> a trade, or null if it was not a buy/sell on this curve. Pure, tested. */
export function parseTrade(tx: any, mint: string, curve: string, sig?: string): ChainTrade | null {
  try {
    if (!tx || !tx.meta || tx.meta.err) return null;
    const msg = tx.transaction?.message || {};
    const keys: string[] = [...(msg.accountKeys || []).map((k: any) => (typeof k === 'string' ? k : k.pubkey)), ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])];
    const ci = keys.indexOf(curve); if (ci < 0) return null;
    const dSol = ((tx.meta.postBalances?.[ci] ?? 0) - (tx.meta.preBalances?.[ci] ?? 0)) / 1e9;
    const sum = (arr: any[]) => (arr || []).filter((b) => b.mint === mint && b.owner === curve).reduce((a, b) => a + ui(b), 0);
    const dTok = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances); // tokens gained by the curve (negative = a buy)
    if (!dSol || !dTok || Math.sign(dSol) === Math.sign(dTok)) return null; // a trade moves SOL and tokens in opposite directions
    const buy = dSol > 0;
    const mcapSol = (Math.abs(dSol) / Math.abs(dTok)) * 1e9; // SOL per token x 1,000,000,000 supply
    if (!(mcapSol > 0) || !Number.isFinite(mcapSol)) return null;
    const who = typeof keys[0] === 'string' ? keys[0] : '';
    return { sig: sig || tx.transaction?.signatures?.[0] || '', t: (tx.blockTime || 0) * 1000, side: buy ? 'buy' : 'sell', sol: Math.abs(dSol), mcapSol, who };
  } catch { return null; }
}

async function call(body: unknown) {
  const res = await fetch(env.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(8000), body: JSON.stringify(body) });
  return res.json();
}

/** The `limit` newest trades before `before` (a signature), newest first, plus the cursor for the next page. */
export async function fetchTrades(mint: string, opts: { before?: string; limit?: number } = {}): Promise<{ trades: ChainTrade[]; next: string | null; scanned: number }> {
  const curve = curveOf(mint), limit = Math.min(200, Math.max(5, opts.limit || 100));
  const s = await call({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [curve, { limit, ...(opts.before ? { before: opts.before } : {}), commitment: 'confirmed' }] });
  if (s.error) throw new Error(s.error.message || 'rpc error');
  const sigs: { signature: string; err: any }[] = (s.result || []).filter((x: any) => !x.err);
  const all = (s.result || []) as { signature: string }[];
  const out: ChainTrade[] = [];
  for (let i = 0; i < sigs.length; i += 20) { // batches of 20 requests in one HTTP call
    const part = sigs.slice(i, i + 20);
    const r = await call(part.map((x, j) => ({ jsonrpc: '2.0', id: j, method: 'getTransaction', params: [x.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] })));
    if (!Array.isArray(r)) throw new Error(r?.error?.message || 'the node refused batch reads');
    for (const item of r) { const sg = part[item.id]?.signature; const t = parseTrade(item.result, mint, curve, sg); if (t) out.push(t); }
  }
  out.sort((a, b) => b.t - a.t);
  return { trades: out, next: all.length >= limit ? all[all.length - 1].signature : null, scanned: all.length };
}
