const test = require('node:test'); const assert = require('node:assert');
const meta = require('../src/data/meta'); const collector = require('../src/data/collector');
const sharp = require('sharp');

test('a coin picture is found through a slow gateway, shrunk, and handed to the saver; flaky gateways only delay it', async () => {
  const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#C6FF3D' } }).png().toBuffer();
  const real = global.fetch; let jsonCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/ipfs/META')) { jsonCalls += 1; if (jsonCalls < 8) return { ok: false, status: 504 }; return { ok: true, headers: new Map(), arrayBuffer: async () => Buffer.from(JSON.stringify({ image: 'ipfs://IMG', description: 'hello' })) }; }
    if (u.includes('/ipfs/IMG')) return { ok: true, headers: { get: () => null }, arrayBuffer: async () => png };
    return { ok: false, status: 404 };
  };
  const fixHeaders = (r) => r;
  const wrap = global.fetch; global.fetch = async (u) => { const r = await wrap(u); if (r.headers instanceof Map) r.headers = { get: () => null }; return fixHeaders(r); };
  try {
    meta._reset();
    meta.want('M1', 'ipfs://META');
    for (let i = 0; i < 3; i++) { meta.pump(); await new Promise((r) => setTimeout(r, 300)); }
    assert.strictEqual(meta._done.has('M1'), false, 'first round failed on purpose');
    meta._jobs.get('M1').next = 0; // skip the waiting for the test
    meta.pump(); await new Promise((r) => setTimeout(r, 400));
    assert.ok(meta._done.has('M1'), 'second round succeeds');
    const v = meta._done.get('M1');
    assert.strictEqual(v.description, 'hello'); assert.match(v.image, /^https:\/\/ipfs\.io\/ipfs\/IMG/);
    const webp = Buffer.from(v.thumb, 'base64'); const info = await sharp(webp).metadata();
    assert.strictEqual(info.format, 'webp'); assert.strictEqual(info.width, 64); assert.ok(webp.length < 8000);
  } finally { global.fetch = real; meta._reset(); }
});

test('flush writes the coin row (with numbers) and its finished picture', async () => {
  collector._reset(); meta._reset();
  collector.onMessage({ txType: 'create', mint: 'C1', name: 'Coin', symbol: 'C', uri: '', marketCapSol: 30, vSolInBondingCurve: 31, solAmount: 1 });
  collector.onMessage({ txType: 'buy', mint: 'C1', marketCapSol: 33, vSolInBondingCurve: 33, solAmount: 2 });
  meta._done.set('C1', { image: 'https://ipfs.io/ipfs/X', description: 'd', thumb: 'AAAA' });
  const saved = { charts: [], meta: [] };
  const db = { saveCharts: async (r) => saved.charts.push(...r), saveMeta: async (r) => saved.meta.push(...r) };
  assert.strictEqual(await collector.flush(db), 1);
  assert.strictEqual(saved.charts[0].created, true); assert.strictEqual(saved.charts[0].stats.buys1h, 2); assert.ok(saved.charts[0].stats.volSol1h >= 3);
  assert.deepStrictEqual(saved.meta.map((r) => [r.mint, r.has_thumb]), [['C1', true]]);
  collector._reset(); meta._reset();
});
