/**
 * Token pictures and descriptions, resolved by the worker (a normal server with open internet) instead of by every
 * visitor's phone. A launch event only carries a link to a small JSON file on IPFS. We read it through several public
 * gateways at once, retry with growing pauses until it works, then shrink the picture to a 64px WebP thumbnail that the
 * website serves from our own database. Gateways being slow or rate-limited only delays a picture; it does not lose it.
 */
const logger = require('../utils/logger');

const GATEWAYS = ['https://ipfs.io', 'https://cf-ipfs.com', 'https://dweb.link', 'https://w3s.link', 'https://nftstorage.link', 'https://gateway.pinata.cloud', 'https://4everland.io'];
const RETRY_MS = [4000, 15000, 45000, 120000, 300000, 900000, 1800000]; // 7 tries over ~50 minutes
const MAX_JSON = 200_000, MAX_IMG = 6 * 1024 * 1024, CONCURRENCY = 6, TIMEOUT = 9000;

let sharp = null; try { sharp = require('sharp'); } catch (_) { logger.warn('sharp not installed: thumbnails are skipped, pictures fall back to links'); }
const jobs = new Map(); // mint -> { uri, tries, next, running }
const done = new Map(); // mint -> { image, description, thumb } (kept for the life of the process, bounded)
let running = 0;

/** "/ipfs/<cid>/<path>" for ipfs:// links, gateway links and subdomain gateways; else null. */
function ipfsPath(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.startsWith('ipfs://')) return '/ipfs/' + raw.slice(7).replace(/^ipfs\//, '');
  let u; try { u = new URL(raw); } catch (_) { return null; }
  const m = u.pathname.match(/^\/ipfs\/(.+)$/); if (m) return `/ipfs/${m[1]}`;
  const sub = u.hostname.match(/^([a-z0-9]{46,}|baf[a-z0-9]{40,})\.ipfs\./i); if (sub) return `/ipfs/${sub[1]}${u.pathname === '/' ? '' : u.pathname}`;
  return null;
}
function candidates(raw) {
  const out = []; const p = ipfsPath(raw);
  if (/^https:\/\//.test(raw)) out.push(raw);
  if (p) for (const g of GATEWAYS) { const u = g + p; if (!out.includes(u)) out.push(u); }
  return out;
}

async function one(url, maxBytes, signal) {
  try {
    const r = await fetch(url, { signal, redirect: 'follow' });
    if (!r.ok) return null;
    if (Number(r.headers.get('content-length') || 0) > maxBytes) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length && buf.length <= maxBytes ? buf : null;
  } catch (_) { return null; }
}
/** Ask every candidate at once; the first good answer wins, the rest are cancelled. */
async function race(raw, maxBytes, accept) {
  const list = candidates(raw); if (!list.length) return null;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    return await new Promise((resolve) => {
      let left = list.length;
      for (const u of list) one(u, maxBytes, ctl.signal).then((b) => { if (b && (!accept || accept(b))) resolve(b); else if (--left === 0) resolve(null); });
    });
  } finally { clearTimeout(timer); ctl.abort(); }
}
const looksJson = (b) => { const s = b.subarray(0, 20).toString('utf8').trimStart(); return s.startsWith('{'); };
const looksImage = (b) => !looksJson(b) && b.length > 100;
const norm = (img) => { const p = ipfsPath(img); return p ? `https://ipfs.io${p}` : (typeof img === 'string' && /^https:\/\//.test(img) ? img : null); };

async function resolveOne(mint, job) {
  let meta = job.meta;
  if (!meta) {
    const buf = await race(job.uri, MAX_JSON, looksJson); if (!buf) return false;
    let j; try { j = JSON.parse(buf.toString('utf8')); } catch (_) { return false; }
    meta = job.meta = { image: norm(j.image), description: typeof j.description === 'string' ? j.description.slice(0, 280) : null };
  }
  let thumb = null;
  if (meta.image && sharp) {
    const img = await race(meta.image, MAX_IMG, looksImage); if (!img) return false;
    try { thumb = (await sharp(img, { limitInputPixels: 16e6, animated: false }).resize(64, 64, { fit: "cover" }).webp({ quality: 40, effort: 1 }).toBuffer()).toString('base64'); }
    catch (_) { thumb = null; } // not a picture we can read: keep the link, stop trying for a thumbnail
  }
  done.set(mint, { image: meta.image, description: meta.description, thumb });
  return true;
}

function pump() {
  const now = Date.now();
  for (const [mint, job] of jobs) {
    if (running >= CONCURRENCY) break;
    if (job.running || job.next > now) continue;
    job.running = true; running += 1;
    resolveOne(mint, job).then((ok) => {
      if (ok || job.tries >= RETRY_MS.length) { jobs.delete(mint); if (!ok) done.set(mint, { image: null, description: null, thumb: null }); }
      else { job.next = Date.now() + RETRY_MS[job.tries]; job.tries += 1; job.running = false; }
    }).catch(() => { job.running = false; job.next = Date.now() + 30000; }).finally(() => { running -= 1; });
  }
}

/** Ask for a coin's picture and description (idempotent). */
function want(mint, uri) {
  if (!mint || !uri || done.has(mint) || jobs.has(mint) || !candidates(uri).length) return;
  if (jobs.size > 600) return;
  jobs.set(mint, { uri, tries: 0, next: 0, running: false, meta: null });
}
/** Pictures that finished since the last call (each returned once), for the saver to write. */
const ready = new Set();
function take(max = 30) {
  const out = [];
  for (const [mint, v] of done) { if (ready.has(mint)) continue; out.push([mint, v]); ready.add(mint); if (out.length >= max) break; }
  if (done.size > 3000) for (const k of done.keys()) { done.delete(k); ready.delete(k); if (done.size < 2000) break; }
  return out;
}
/** A save failed: hand the result out again next time. */
const requeue = (m) => ready.delete(m);
const timer = setInterval(pump, 1000); timer.unref();
module.exports = { requeue, want, take, pump, ipfsPath, candidates, _done: done, _jobs: jobs, _reset: () => { done.clear(); jobs.clear(); ready.clear(); } };
