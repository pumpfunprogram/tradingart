'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType, LineStyle } from 'lightweight-charts';
import { runIndicator, indLabel, IND_DEFS, type IndKind, type Candle } from './indicators';
import { loadPrefs, savePrefs, addInd, removeInd, TF, type Prefs } from './prefs';

type Bar = number[];
type Tr = { t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who?: string; sig?: string };

const msOf = (t: number) => (t > 1e12 ? t : t * 1000);

function fmtMcap(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '–';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

/**
 * Pro chart: demo candle engine + indicator overlays + prefs.
 * Each trade lands in a timeframe bucket. Open is the previous close.
 * Live trades call series.update() so the candle ticks.
 */
export default function ProChart({ mint, bars = [], trades, solUsd, height = 520 }: { mint: string; bars?: Bar[]; trades: Tr[]; solUsd: number | null; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const csRef = useRef<any>(null);
  const vsRef = useRef<any>(null);
  const indSeries = useRef<Map<string, any>>(new Map());
  const candles = useRef<Map<number, Candle>>(new Map());
  const vols = useRef<Map<number, number>>(new Map());
  const seen = useRef<Set<string>>(new Set());
  const follow = useRef(true);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_SAFE);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<Candle | null>(null);
  const [live, setLive] = useState<Candle | null>(null);
  const [vol, setVol] = useState(0);
  const [showInd, setShowInd] = useState(false);
  const k = solUsd && solUsd > 0 ? solUsd : 1;
  const tfRef = useRef(prefs.tf);
  tfRef.current = prefs.tf;
  const kRef = useRef(k);
  kRef.current = k;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => { setPrefs(loadPrefs()); }, []);

  const bucket = (sec: number) => Math.floor(sec / tfRef.current) * tfRef.current;

  function lastKey() {
    let m = -1;
    for (const x of candles.current.keys()) if (x > m) m = x;
    return m;
  }

  function applyTrade(sec: number, price: number, size: number, liveFlag: boolean) {
    const b = bucket(sec);
    let c = candles.current.get(b);
    if (!c) {
      const prev = candles.current.size ? candles.current.get(lastKey())!.close : price;
      c = { time: b, open: prev, high: Math.max(prev, price), low: Math.min(prev, price), close: price };
      vols.current.set(b, 0);
    } else {
      c.high = Math.max(c.high, price);
      c.low = Math.min(c.low, price);
      c.close = price;
    }
    candles.current.set(b, c);
    vols.current.set(b, (vols.current.get(b) || 0) + size);
    if (liveFlag && csRef.current && vsRef.current) {
      csRef.current.update(c);
      vsRef.current.update({
        time: b,
        value: vols.current.get(b),
        color: c.close >= c.open ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)',
      });
      if (follow.current) chartRef.current?.timeScale().scrollToRealTime?.();
      paintInds(true);
    }
    return c;
  }

  function paintInds(liveOnly = false) {
    const keys = [...candles.current.keys()].sort((a, b) => a - b);
    if (!keys.length || !chartRef.current) return;
    const cs: Candle[] = keys.map((kk) => candles.current.get(kk)!);
    const vs = keys.map((kk) => vols.current.get(kk) || 0);
    const active = prefsRef.current.inds;
    const keep = new Set(active.map((i) => i.id));
    for (const [id, s] of indSeries.current) {
      if (!keep.has(id)) { try { chartRef.current.removeSeries(s); } catch { /* ignore */ } indSeries.current.delete(id); }
    }
    for (const ind of active) {
      if (IND_DEFS[ind.kind].pane !== 'price') continue;
      let s = indSeries.current.get(ind.id);
      if (!s) {
        s = chartRef.current.addSeries(LineSeries, { color: IND_DEFS[ind.kind].outs[0].color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
        indSeries.current.set(ind.id, s);
      }
      const r = runIndicator(ind.kind, cs, vs, ind.params);
      const pts = r.values[0].map((v, i) => ({ time: keys[i], value: v })).filter((p) => Number.isFinite(p.value));
      if (liveOnly && pts.length) s.update(pts[pts.length - 1]);
      else s.setData(pts);
    }
  }

  function rebuild(all: Tr[], barList: Bar[]) {
    candles.current.clear();
    vols.current.clear();
    seen.current.clear();
    const points: { sec: number; p: number; sol: number; key: string }[] = [];
    for (const b of barList) {
      const sec = Math.floor(Number(b[0]));
      const p = Number(b[4]) * kRef.current;
      if (sec > 0 && p > 0) points.push({ sec, p, sol: Number(b[5]) || 0, key: `b:${sec}` });
    }
    for (const t of all) {
      const p = (t.mcapSol || 0) * kRef.current;
      const sec = Math.floor(msOf(t.t) / 1000);
      if (sec > 0 && p > 0) points.push({ sec, p, sol: t.sol || 0, key: t.sig || `t:${sec}:${t.sol}:${t.side}` });
    }
    points.sort((a, b) => a.sec - b.sec);
    for (const r of points) {
      applyTrade(r.sec, r.p, r.sol, false);
      seen.current.add(r.key);
    }
    const keys = [...candles.current.keys()].sort((a, b) => a - b);
    if (csRef.current && vsRef.current) {
      csRef.current.setData(keys.map((kk) => candles.current.get(kk)));
      vsRef.current.setData(keys.map((kk) => {
        const c = candles.current.get(kk)!;
        return { time: kk, value: vols.current.get(kk) || 0, color: c.close >= c.open ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.45)' };
      }));
      paintInds(false);
      const n = keys.length;
      if (n > 0) {
        const visible = Math.min(n, 120);
        chartRef.current?.timeScale().setVisibleLogicalRange?.({ from: n - visible, to: n + 4 });
      } else {
        chartRef.current?.timeScale().fitContent();
      }
    }
    const last = keys.length ? candles.current.get(keys[keys.length - 1])! : null;
    setLive(last);
    setVol([...vols.current.values()].reduce((a, x) => a + x, 0));
  }

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      width: box.current.clientWidth,
      height,
      layout: { background: { type: ColorType.Solid, color: '#0e1621' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      crosshair: { mode: 0, vertLine: { color: '#758696', style: LineStyle.Dashed }, horzLine: { color: '#758696', style: LineStyle.Dashed } },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: true, barSpacing: 8 },
      localization: { priceFormatter: (p: number) => fmtMcap(p) },
    });
    chartRef.current = chart;
    const cs = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444',
    });
    csRef.current = cs;
    const vs = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    vs.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    vsRef.current = vs;
    chart.subscribeCrosshairMove((param: any) => {
      if (!param.time) { setHover(null); return; }
      const d = param.seriesData?.get?.(cs);
      if (d && d.open != null) setHover(d);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((r: any) => {
      if (r) follow.current = r.to > (chart.timeScale().getVisibleLogicalRange?.()?.to ?? r.to) - 2;
    });
    const ro = new ResizeObserver(() => { if (box.current) chart.applyOptions({ width: box.current.clientWidth }); });
    ro.observe(box.current);
    setReady(true);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; csRef.current = null; vsRef.current = null; indSeries.current.clear(); setReady(false); };
  }, [height]);

  useEffect(() => {
    if (!ready) return;
    rebuild(trades, bars);
  }, [ready, trades, bars, prefs.tf, k]);

  useEffect(() => {
    if (!ready || !mint) return;
    let closed = false, retry: any = null, ws: WebSocket | null = null;
    const open = () => {
      if (closed) return;
      try {
        ws = new WebSocket('wss://pumpportal.fun/api/data');
        ws.onopen = () => { try { ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] })); } catch { /* ignore */ } };
        ws.onmessage = (ev) => {
          try {
            const m = JSON.parse(ev.data);
            if (m.mint !== mint || m.txType === 'create') return;
            const tx = m.txType === 'buy' ? 'buy' : m.txType === 'sell' ? 'sell' : null;
            if (!tx) return;
            let p = Number(m.marketCapSol) || 0;
            if (!(p > 0)) { const sol = Number(m.solAmount), tok = Number(m.tokenAmount); p = sol > 0 && tok > 0 ? (sol / tok) * 1e9 : NaN; }
            if (!(p > 0)) return;
            const sec = Math.floor(Date.now() / 1000);
            const price = p * kRef.current;
            const size = Number(m.solAmount) || 0;
            const key = m.signature || `live:${sec}:${size}:${tx}`;
            if (seen.current.has(key)) return;
            seen.current.add(key);
            const c = applyTrade(sec, price, size, true);
            if (c) setLive(c);
            setVol([...vols.current.values()].reduce((a, x) => a + x, 0));
          } catch { /* ignore */ }
        };
        ws.onclose = () => { if (!closed) retry = setTimeout(open, 1500); };
        ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
      } catch { retry = setTimeout(open, 3000); }
    };
    open();
    return () => { closed = true; if (retry) clearTimeout(retry); try { ws?.close(); } catch { /* ignore */ } };
  }, [ready, mint]);

  const setTf = useCallback((tf: number) => {
    const next = { ...prefsRef.current, tf };
    setPrefs(next); savePrefs(next);
  }, []);

  const toggleInd = useCallback((kind: IndKind) => {
    const cur = prefsRef.current;
    const has = cur.inds.find((i) => i.kind === kind);
    const next = has ? removeInd(cur, has.id) : addInd(cur, kind);
    setPrefs(next); savePrefs(next);
  }, []);

  const shown = hover || live;
  const up = shown ? shown.close >= shown.open : true;
  const change = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : 0;
  const chgAbs = shown ? Math.abs(shown.close - shown.open) : 0;

  return (
    <div className="tvwidget" aria-label="Pro chart">
      <div className="tvhead">
        <div className="tvtitle">
          <b>{solUsd ? 'Market Cap · USD' : 'Market Cap · SOL'}</b>
          {shown && (
            <span className="ohlc" style={{ color: up ? '#22c55e' : '#ef4444' }}>
              O{fmtMcap(shown.open)} H{fmtMcap(shown.high)} L{fmtMcap(shown.low)} C{fmtMcap(shown.close)} {fmtMcap(chgAbs)} ({change >= 0 ? '+' : ''}{change.toFixed(2)}%)
            </span>
          )}
          <span className="volabel">Volume {vol >= 1000 ? (vol / 1000).toFixed(2) + 'K' : vol.toFixed(1)} SOL</span>
        </div>
        <div className="tfs" role="tablist">
          {TF.map((t) => (
            <button key={t.s} role="tab" aria-selected={prefs.tf === t.s} className={prefs.tf === t.s ? 'on' : ''} onClick={() => setTf(t.s)}>
              {t.l}
            </button>
          ))}
          <button className={showInd ? 'on' : ''} onClick={() => setShowInd((v) => !v)} title="Indicators">Ind</button>
        </div>
      </div>
      {showInd && (
        <div className="indbar">
          {(Object.keys(IND_DEFS) as IndKind[]).map((knd) => {
            const on = prefs.inds.some((i) => i.kind === knd);
            return (
              <button key={knd} className={on ? 'on' : ''} onClick={() => toggleInd(knd)}>
                {indLabel({ id: '', kind: knd, params: {} })}
              </button>
            );
          })}
        </div>
      )}
      <div ref={box} style={{ height }} />
      {err && <div className="hint warn" style={{ padding: '0 10px 8px' }}>{err}</div>}
      {!trades.length && !bars.length && !err && (
        <div className="hint" style={{ padding: '0 10px 8px' }}>Waiting for the first trade. The candle will move as each fill lands.</div>
      )}
    </div>
  );
}

const DEFAULT_SAFE: Prefs = { type: 'candle', tf: 5, scale: 'normal', markers: true, markerMinSol: 0.1, inds: [] };
