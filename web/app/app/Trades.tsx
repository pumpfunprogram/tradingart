'use client';
import { useEffect, useState } from 'react';
import { api } from './shared';

export default function TradesTab({ onOpen }: { onOpen: (mint: string) => void }) {
  const [mine, setMine] = useState<any[] | null>(null);

  useEffect(() => {
    const load = () => api<{ trades: any[] }>('/api/trades').then((r) => setMine(r.trades || [])).catch(() => setMine([]));
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  if (!mine) return <p className="hint">Loading…</p>;
  if (!mine.length) return <p className="hint">No trades yet.</p>;

  return (
    <div className="trades-tab">
      {mine.slice(0, 100).map((t: any, i: number) => (
        <button key={t.id || i} className={`taperow ${t.side || 'buy'}`} onClick={() => t.mint && onOpen(t.mint)}>
          <span className="side">{t.side === 'sell' ? 'SELL' : 'BUY'}</span>
          <span className="name">{t.symbol || t.mint?.slice(0, 8) || '—'}</span>
          <span className="sol">{Number(t.sol || t.size_sol || 0).toFixed(3)} SOL</span>
          <span className="time">{t.created_at ? new Date(t.created_at).toLocaleString([], { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span>
        </button>
      ))}
    </div>
  );
}
