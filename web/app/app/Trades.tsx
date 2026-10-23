'use client';
import { useEffect, useState } from 'react';
import { getTape, useLiveTokens, STREAM, type Tok } from '@/lib/liveTokens';
import { api } from './shared';

type Row = { id: string; mint: string; side: 'buy' | 'sell'; sol: number; name?: string; t: number };

export default function TradesTab({ onOpen }: { onOpen: (mint: string) => void }) {
  const feed = useLiveTokens();
  const [rows, setRows] = useState<Row[]>([]);
  const [mine, setMine] = useState<any[]>([]);

  useEffect(() => {
    const pull = () => {
      const tape = (getTape() as any[]).slice(-200).reverse();
      setRows(tape.map((r: any) => ({ id: r.id || r.sig || String(r.t), mint: r.mint, side: r.side, sol: r.sol || 0, name: r.name || r.symbol, t: r.t || Date.now() })));
    };
    pull();
    const id = setInterval(pull, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    api<{ trades: any[] }>('/api/trades').then((r) => setMine(r.trades || [])).catch(() => {});
  }, []);

  return (
    <div className="trades-tab">
      <section className="tape wide" aria-label="All trades">
        <div className="tapehead"><b>All trades</b><small>{rows.length} recent</small></div>
        {rows.length === 0 ? <div className="hint">Waiting for trades…</div> : rows.map((r) => (
          <button key={r.id} className={`taperow ${r.side}`} onClick={() => onOpen(r.mint)}>
            <span className="side">{r.side === 'buy' ? 'BUY' : 'SELL'}</span>
            <span className="name">{r.name || r.mint.slice(0, 6)}</span>
            <span className="sol">{r.sol.toFixed(3)} SOL</span>
            <span className="time">{new Date(r.t).toLocaleTimeString([], { hour12: false })}</span>
          </button>
        ))}
      </section>
      {mine.length > 0 && (
        <section className="mine">
          <div className="tapehead"><b>Your trades</b></div>
          {mine.slice(0, 50).map((t: any, i: number) => (
            <div key={t.id || i} className={`taperow ${t.side || 'buy'}`}>
              <span className="side">{t.side === 'sell' ? 'SELL' : 'BUY'}</span>
              <span className="name">{t.symbol || t.mint?.slice(0, 6) || '—'}</span>
              <span className="sol">{Number(t.sol || t.size_sol || 0).toFixed(3)} SOL</span>
              <span className="time">{t.created_at ? new Date(t.created_at).toLocaleTimeString([], { hour12: false }) : ''}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
