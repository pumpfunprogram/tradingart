/**
 * Drawing tools for the token chart.
 * Prices are in the same units as the candle series (market cap).
 * Times are epoch seconds.
 */

export type Pt = { time: number; price: number };
export type DashStyle = 'solid' | 'dashed' | 'dotted';
export type DrawKind = 'trend' | 'hline' | 'rect' | 'fib';

export type Drawing = {
  id: string;
  kind: DrawKind;
  pts: Pt[];
  color: string;
  dash: DashStyle;
  label?: string;
};

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function makeDrawing(kind: DrawKind, pts: Pt[], color = '#f59e0b'): Drawing {
  return { id: newId(), kind, pts, color, dash: 'solid' };
}

/** Project a drawing into pixel coords given a time/price mapper. */
export type Proj = {
  xOf: (time: number) => number | null;
  yOf: (price: number) => number | null;
};

export type Shape = { kind: DrawKind; segs: { x1: number; y1: number; x2: number; y2: number }[]; labels: { x: number; y: number; text: string }[] };

export function project(d: Drawing, pr: Proj): Shape {
  const segs: Shape['segs'] = [];
  const labels: Shape['labels'] = [];
  const p = d.pts;
  if (d.kind === 'hline' && p[0]) {
    const y = pr.yOf(p[0].price);
    if (y != null) {
      segs.push({ x1: 0, y1: y, x2: 10000, y2: y });
      labels.push({ x: 8, y: y - 4, text: d.label || p[0].price.toFixed(2) });
    }
  } else if (d.kind === 'trend' && p.length >= 2) {
    const x1 = pr.xOf(p[0].time), y1 = pr.yOf(p[0].price);
    const x2 = pr.xOf(p[1].time), y2 = pr.yOf(p[1].price);
    if (x1 != null && y1 != null && x2 != null && y2 != null) segs.push({ x1, y1, x2, y2 });
  } else if (d.kind === 'rect' && p.length >= 2) {
    const x1 = pr.xOf(p[0].time), y1 = pr.yOf(p[0].price);
    const x2 = pr.xOf(p[1].time), y2 = pr.yOf(p[1].price);
    if (x1 != null && y1 != null && x2 != null && y2 != null) {
      segs.push({ x1, y1, x2, y2: y1 });
      segs.push({ x1: x2, y1, x2, y2 });
      segs.push({ x1: x2, y1: y2, x2: x1, y2 });
      segs.push({ x1, y1: y2, x2: x1, y2: y1 });
    }
  } else if (d.kind === 'fib' && p.length >= 2) {
    const x1 = pr.xOf(Math.min(p[0].time, p[1].time));
    const x2 = pr.xOf(Math.max(p[0].time, p[1].time));
    const hi = Math.max(p[0].price, p[1].price);
    const lo = Math.min(p[0].price, p[1].price);
    if (x1 != null && x2 != null) {
      for (const lvl of FIB_LEVELS) {
        const price = hi - (hi - lo) * lvl;
        const y = pr.yOf(price);
        if (y == null) continue;
        segs.push({ x1, y1: y, x2, y2: y });
        labels.push({ x: x2 + 4, y: y - 2, text: `${(lvl * 100).toFixed(1)}%` });
      }
    }
  }
  return { kind: d.kind, segs, labels };
}

const KEY = (mint: string) => `ta.draw.${mint}`;

export function loadDrawings(mint: string): Drawing[] {
  try {
    const raw = localStorage.getItem(KEY(mint));
    if (!raw) return [];
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.filter((d) => d && d.kind && Array.isArray(d.pts)) : [];
  } catch {
    return [];
  }
}

export function saveDrawings(mint: string, list: Drawing[]) {
  try { localStorage.setItem(KEY(mint), JSON.stringify(list)); } catch { /* ignore */ }
}
