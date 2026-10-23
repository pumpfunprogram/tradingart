'use client';
import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, ColorType, LineStyle } from 'lightweight-charts';

type Bar = number[];
type Tr = { t: number; side: 'buy' | 'sell'; sol: number; mcapSol: number; who?: string; sig?: string };

const TF = [
  { s: 1, l: '1s' },
  { s: 5, l: '5s' },
  { s: 15, l: '15s' },
  { s: 30, l: '30s' },
  { s: 60, l: '1m' },
  { s: 300, l: '5m' },
];

const msOf = (t: number) => (t > 1e12 ? t : t * 1000);

type Candle = { time: number; open: number; high: number; low: number; close: number };

function fmtMcap(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '–';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toFixed(2);
}

/**
 * Same candle engine as the working demo.
 * Each trade lands in a timeframe bucket. Open is the previous close.
 * Live trades call series.update() so the candle body and wick move on every fill.
 */
export default function TvChart({ mint, bars = [], trades, solUsd, height = 480 }: { mint: string; bars?: Bar[]; trades: Tr[]; solUsd: number | null; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const csRef = useRef<any>(null);
  const vsRef = useRef<any>(null);
  const candles = useRef<Map<number, Candle>>(new Map());
  const vols = useRef<Map<number, number>>(new Map());
  const seen = useRef<Set<string>>(new Set());
  const follow = useRef(true);
  const [tf, setTf] = useState(5);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<Candle | null>(null);
  const [live, setLive] = useState<Candle | null>(null);
  const [vol, setVol] = useState(0);
  const k = solUsd && solUsd > 0 ? solUsd : 1;
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const kRef = useRef(k);
  kRef.current = k;

  const bucket = (sec: number) => Math.floor(sec / tfRef.current) * tfRef.current;

  function lastKey() {
    let m = -1;
    for (const x of candles.current.keys()) if (x > m) m = x;
    return m;
  }

  /** Apply one trade. live=true calls series.update() so the candle ticks. */
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
    }
    return c;
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
      // Keep a readable zoom on the recent candles. Older history is there; scroll left for it.
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
    let chart: any;
    try {
      chart = createChart(box.current, {
        width: box.current.clientWidth,
        height,
        layout: {
          background: { type: ColorType.Solid, color: '#0b0d10' },
          textColor: '#7d8794',
          fontSize: 11,
        },
        grid: { vertLines: { color: '#12171d' }, horzLines: { color: '#12171d' } },
        rightPriceScale: { borderColor: '#1e252d', scaleMargins: { top: 0.08, bottom: 0.25 } },
        timeScale: { borderColor: '#1e252d', timeVisible: true, secondsVisible: true, rightOffset: 6, barSpacing: 8 },
        crosshair: { mode: 0 },
        localization: { priceFormatter: (v: number) => fmtMcap(v) },
        handleScroll: true,
        handleScale: true,
      });
      const cs = chart.addSeries(CandlestickSeries, {
        upColor: '#22c55e',
        downColor: '#ef4444',
        borderUpColor: '#22c55e',
        borderDownColor: '#ef4444',
        wickUpColor: '#22c55e',
        wickDownColor: '#ef4444',
        borderVisible: false,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineStyle: LineStyle.Dashed,
        priceFormat: { type: 'custom', formatter: (v: number) => fmtMcap(v), minMove: 0.0000001 },
      });
      const vs = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

      chart.subscribeCrosshairMove((p: any) => {
        const d = p && p.seriesData && p.seriesData.get(cs);
        setHover(d && typeof d.open === 'number' ? { time: p.time, open: d.open, high: d.high, low: d.low, close: d.close } : null);
      });
      chart.timeScale().subscribeVisibleLogicalRangeChange((range: any) => {
        if (!range) return;
        const info = cs.barsInLogicalRange?.(range);
        follow.current = !info || (typeof info.barsAfter === 'number' && info.barsAfter < 3);
      });

      chartRef.current = chart;
      csRef.current = cs;
      vsRef.current = vs;
      const ro = new ResizeObserver(() => {
        if (box.current && chartRef.current) chartRef.current.applyOptions({ width: box.current.clientWidth });
      });
      ro.observe(box.current);
      (chart as any)._ro = ro;
      setReady(true);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message || 'Chart failed');
    }
    return () => {
      setReady(false);
      try { (chart as any)?._ro?.disconnect(); } catch { /* ignore */ }
      try { chart?.remove(); } catch { /* ignore */ }
      chartRef.current = null;
      csRef.current = null;
      vsRef.current = null;
    };
  }, [height]);

  // Rebuild when timeframe or scale changes
  useEffect(() => {
    if (!ready) return;
    rebuild(trades, bars);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf, k, ready]);

  // Tick: apply only the new trades, same as the demo's onTrade
  useEffect(() => {
    if (!ready || !csRef.current) return;
    const fresh: Tr[] = [];
    for (const t of trades) {
      const key = t.sig || `t:${Math.floor(msOf(t.t) / 1000)}:${t.sol}:${t.side}`;
      if (seen.current.has(key)) continue;
      const p = (t.mcapSol || 0) * kRef.current;
      const sec = Math.floor(msOf(t.t) / 1000);
      if (sec > 0 && p > 0) fresh.push(t);
    }
    if (!fresh.length) return;
    fresh.sort((a, b) => msOf(a.t) - msOf(b.t));
    // Older history arrived after the chart was already built. Rebuilding keeps candle opens correct.
    const oldestKnown = lastKey();
    if (oldestKnown > 0 && fresh.some((t) => Math.floor(msOf(t.t) / 1000) < oldestKnown)) {
      rebuild(trades, bars);
      return;
    }
    let last: Candle | null = null;
    for (const t of fresh) {
      const key = t.sig || `t:${Math.floor(msOf(t.t) / 1000)}:${t.sol}:${t.side}`;
      const p = (t.mcapSol || 0) * kRef.current;
      const sec = Math.floor(msOf(t.t) / 1000);
      last = applyTrade(sec, p, t.sol || 0, true);
      seen.current.add(key);
    }
    if (last) setLive(last);
    setVol([...vols.current.values()].reduce((a, x) => a + x, 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, ready]);

  // Live stream, same path as the demo: each trade calls series.update() immediately.
  useEffect(() => {
    if (!ready || !mint) return;
    let ws: WebSocket | null = null, closed = false, retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      if (closed) return;
      try {
        ws = new WebSocket('wss://pumpportal.fun/api/data');
        ws.onopen = () => { try { ws!.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] })); } catch { /* ignore */ } };
        ws.onmessage = (e) => {
          try {
            const m = JSON.parse(String(e.data));
            if (!m || m.mint !== mint) return;
            const tx = m.txType;
            if (tx !== 'buy' && tx !== 'sell' && tx !== 'create') return;
            let p = Number(m.marketCapSol);
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

  const shown = hover || live;
  const up = shown ? shown.close >= shown.open : true;
  const change = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : 0;
  const chgAbs = shown ? Math.abs(shown.close - shown.open) : 0;

  return (
    <div className="tvwidget" aria-label="TradingView chart">
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
            <button key={t.s} role="tab" aria-selected={tf === t.s} className={tf === t.s ? 'on' : ''} onClick={() => setTf(t.s)}>
              {t.l}
            </button>
          ))}
        </div>
      </div>
      <div ref={box} style={{ height }} />
      {err && <div className="hint warn" style={{ padding: '0 10px 8px' }}>{err}</div>}
      {!trades.length && !bars.length && !err && (
        <div className="hint" style={{ padding: '0 10px 8px' }}>Waiting for the first trade. The candle will move as each fill lands.</div>
      )}
    </div>
  );
}
