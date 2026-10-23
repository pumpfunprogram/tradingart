import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { isMint } from '@/lib/dex';
import { fetchTrades } from '@/lib/pumpchain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const cache = new Map<string, { at: number; v: any }>();

/** Older trades of a coin, straight from the chain. `full=1` walks back toward the first trade. */
export async function GET(req: NextRequest) {
  if (rateLimited(`hist:${ipOf(req)}`, 120, 60_000)) return fail('slow down', 429);
  const mint = (req.nextUrl.searchParams.get('mint') || '').trim();
  const before = (req.nextUrl.searchParams.get('before') || '').trim();
  const full = req.nextUrl.searchParams.get('full') === '1';
  if (!isMint(mint)) return fail('That is not a token address.');
  if (before && !/^[A-Za-z0-9]{60,100}$/.test(before)) return fail('bad cursor');
  const key = `${mint}:${before}:${full ? 'f' : 'p'}`, hit = cache.get(key); if (hit && Date.now() - hit.at < 12_000) return json(hit.v);
  try {
    if (!full) {
      const r = await fetchTrades(mint, { before: before || undefined, limit: 100 });
      cache.set(key, { at: Date.now(), v: r }); if (cache.size > 200) cache.delete(cache.keys().next().value as string);
      return json(r);
    }
    const all: any[] = [];
    let cursor: string | null = before || null;
    let next: string | null = null;
    for (let i = 0; i < 50; i++) {
      const r = await fetchTrades(mint, { before: cursor || undefined, limit: 100 });
      all.push(...r.trades);
      next = r.next;
      if (!next) break;
      cursor = next;
    }
    const v = { trades: all, next, scanned: all.length };
    cache.set(key, { at: Date.now(), v }); if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return json(v);
  } catch (e: any) { return fail(`The network node did not return the history (${String(e?.message || e).slice(0, 80)}). Add a better SOLANA_RPC_URL on Vercel if this keeps happening.`, 502); }
}
