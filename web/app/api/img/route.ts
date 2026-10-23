import { NextRequest } from 'next/server';
import sharp from 'sharp';
import { fail, rateLimited, ipOf } from '@/lib/api';
import { fetchFirst, candidates } from '@/lib/ipfs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

/**
 * Tiny token thumbnails. Token art is often a multi-megabyte image on IPFS; the list only needs a 64px square.
 * We fetch it once, shrink it to ~2 KB WebP and let the CDN / browser keep it for a week.
 * Only known image hosts are allowed so this can never be used as an open proxy.
 */
const MAX_BYTES = 6 * 1024 * 1024;

export async function GET(req: NextRequest) {
  if (rateLimited(`img:${ipOf(req)}`, 400, 60_000)) return fail('slow down', 429);
  const raw = req.nextUrl.searchParams.get('u') || '';
  const w = Math.min(96, Math.max(24, Number(req.nextUrl.searchParams.get('w')) || 48));
  if (!candidates(raw).length) return fail('host not allowed', 403);
  try {
    const got = await fetchFirst(raw, { accept: 'image/*', maxBytes: MAX_BYTES });
    if (!got) return fail('image unavailable', 404);
    const buf = got.buf;
    const out = await sharp(buf, { limitInputPixels: 16e6, animated: false }).resize(w, w, { fit: 'cover' }).webp({ quality: 40, effort: 1 }).toBuffer();
    return new Response(new Uint8Array(out), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800, s-maxage=604800, immutable', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return fail('image unavailable', 404);
  }
}
