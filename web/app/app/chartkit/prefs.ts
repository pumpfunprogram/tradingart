/**
 * Chart preferences, saved per browser.
 */

import { IND_DEFS, type IndKind, type ActiveInd } from './indicators';

export type ChartType = 'candle' | 'line' | 'area';
export type ScaleMode = 'normal' | 'log';

export type Prefs = {
  type: ChartType;
  tf: number;
  scale: ScaleMode;
  markers: boolean;
  markerMinSol: number;
  inds: ActiveInd[];
};

export const TF = [
  { s: 1, l: '1s' },
  { s: 5, l: '5s' },
  { s: 15, l: '15s' },
  { s: 30, l: '30s' },
  { s: 60, l: '1m' },
  { s: 300, l: '5m' },
];

export const DEFAULT_PREFS: Prefs = {
  type: 'candle',
  tf: 5,
  scale: 'normal',
  markers: true,
  markerMinSol: 0.1,
  inds: [],
};

const KEY = 'ta.chart.prefs';

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const j = JSON.parse(raw);
    return {
      type: j.type === 'line' || j.type === 'area' ? j.type : 'candle',
      tf: Number.isFinite(j.tf) ? j.tf : 5,
      scale: j.scale === 'log' ? 'log' : 'normal',
      markers: j.markers !== false,
      markerMinSol: Number.isFinite(j.markerMinSol) ? j.markerMinSol : 0.1,
      inds: Array.isArray(j.inds) ? j.inds.filter((x: any) => x && IND_DEFS[x.kind as IndKind]) : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: Prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export function addInd(p: Prefs, kind: IndKind): Prefs {
  const def = IND_DEFS[kind];
  const params: Record<string, number> = {};
  for (const x of def.params) params[x.name] = x.def;
  return { ...p, inds: [...p.inds, { id: Math.random().toString(36).slice(2, 8), kind, params }] };
}

export function removeInd(p: Prefs, id: string): Prefs {
  return { ...p, inds: p.inds.filter((i) => i.id !== id) };
}
