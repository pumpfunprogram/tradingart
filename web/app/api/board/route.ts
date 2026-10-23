import { NextRequest } from 'next/server';
import { json, fail, rateLimited, ipOf } from '@/lib/api';
import { db } from '@/lib/db';
import { solUsd } from '@/lib/price';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The Tokens lists, straight from the robot's own records: every coin it sees launch is here, with its numbers and a
 * chart already recorded. New / Final stretch / Migrated, kept on the server so they are the same on every device and
 * after every refresh.
 */
const COLS = 'mint,name,symbol,uri,created,first_seen,mcap_sol,v_sol,migrated,migrated_at,stats,image,description,has_thumb,updated_at';
const DAY = 3 * 24 * 3600e3;
const STRETCH = 0.5; // past half way up the bonding curve
const V_STRETCH = 30 + 85 * STRETCH;

export async function GET(req: NextRequest) {
  if (rateLimited(`board:${ipOf(req)}`, 60, 60_000)) return fail('slow down', 429);
  const sb = db(); const since = new Date(Date.now() - DAY).toISOString();
  const [fresh, stretch, mig, hot, top] = await Promise.all([
    sb.from('art_charts').select(COLS).eq('migrated', false).eq('created', true).gte('first_seen', since).order('first_seen', { ascending: false }).limit(80),
    sb.from('art_charts').select(COLS).eq('migrated', false).eq('created', true).gte('v_sol', V_STRETCH).gte('updated_at', since).order('v_sol', { ascending: false }).limit(40),
    sb.from('art_charts').select(COLS).eq('migrated', true).gte('updated_at', since).order('migrated_at', { ascending: false, nullsFirst: false }).limit(40),
    sb.from('art_charts').select(COLS).eq('migrated', false).gte('updated_at', new Date(Date.now() - 15 * 60e3).toISOString()).order('updated_at', { ascending: false }).limit(200),
    sb.from('art_charts').select('v_sol').eq('migrated', false).eq('created', true).gte('updated_at', since).order('v_sol', { ascending: false }).limit(1),
  ]);
  const err = fresh.error || stretch.error || mig.error;
  if (err) return fail('The robot has not recorded coins yet (run the latest supabase_art.sql, then wait a minute).', 503);
  const row = (r: any) => ({ mint: r.mint, name: r.name, symbol: r.symbol, uri: r.uri, createdAt: Date.parse(r.first_seen) || null, mcapSol: r.mcap_sol, vSol: r.v_sol, migrated: r.migrated, migratedAt: r.migrated_at ? Date.parse(r.migrated_at) : null, stats: r.stats || null, image: r.image, description: r.description, thumb: !!r.has_thumb, updatedAt: Date.parse(r.updated_at) || null });
  // trending = busiest in the last hour (SOL traded, then number of trades) among coins that traded in the last 15 minutes
  const heat = (r: any) => (r.stats?.volSol1h || 0) + ((r.stats?.buys1h || 0) + (r.stats?.sells1h || 0)) * 0.02;
  const trending = (hot.data || []).filter((r: any) => (r.stats?.buys1h || 0) + (r.stats?.sells1h || 0) >= 3).sort((a: any, b: any) => heat(b) - heat(a)).slice(0, 15);
  const surge = (hot.data || []).filter((r: any) => (r.stats?.buys1h || 0) + (r.stats?.sells1h || 0) >= 5 && (r.stats?.c5 || 0) > 0).sort((a: any, b: any) => (b.stats?.c5 || 0) - (a.stats?.c5 || 0)).slice(0, 15);
  const topV = top.data?.[0]?.v_sol ?? null;
  return json({ trending: trending.map(row), surge: surge.map(row), topProgress: topV == null ? null : Math.max(0, Math.min(1, (topV - 30) / 85)), tracked: (fresh.data || []).length, new: (fresh.data || []).map(row), stretch: (stretch.data || []).map(row), migrated: (mig.data || []).map(row), solUsd: await solUsd().catch(() => null) });
}
