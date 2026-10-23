'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, short, sol, signed, ago, Slider, Spark, type Me, type Plan, type Trades, type Agent, AGENT_DEFAULT } from './shared';
import type { Proof } from '@/components/useSign';

type RunFn = (k: string, f: () => Promise<void>) => Promise<void>;
const UNITS = [{ k: 's', label: 'sec', m: 1 }, { k: 'm', label: 'min', m: 60 }, { k: 'h', label: 'hours', m: 3600 }, { k: 'd', label: 'days', m: 86400 }] as const;

/** A time written as number + unit, stored in seconds. Empty = no limit (when allowed). */
function TimeField({ label, sec, onChange, emptyOk, ariaLabel }: { label: string; sec: number | null; onChange: (s: number | null) => void; emptyOk?: boolean; ariaLabel: string }) {
  const pick = (s: number | null) => (s == null ? 'm' : s === 0 ? 's' : s % 86400 === 0 ? 'd' : s % 3600 === 0 ? 'h' : s % 60 === 0 ? 'm' : 's');
  const [unit, setUnit] = useState<'s' | 'm' | 'h' | 'd'>(pick(sec));
  const m = UNITS.find((u) => u.k === unit)!.m;
  const [text, setText] = useState(sec == null ? '' : String(+(sec / m).toFixed(4)));
  const push = (t: string, u: typeof unit) => {
    const mult = UNITS.find((x) => x.k === u)!.m;
    if (t.trim() === '') { onChange(emptyOk ? null : 0); return; }
    const n = Number(t); if (Number.isFinite(n) && n >= 0) onChange(Math.round(n * mult));
  };
  return (
    <div>
      <span className="lbl">{label}</span>
      <div className="ageins">
        <input className="field" inputMode="decimal" placeholder={emptyOk ? 'no limit' : '0'} value={text} aria-label={`${ariaLabel} value`} onChange={(e) => { setText(e.target.value); push(e.target.value, unit); }} />
        <select className="field" value={unit} aria-label={`${ariaLabel} unit`} onChange={(e) => { const u = e.target.value as typeof unit; setUnit(u); push(text, u); }}>
          {UNITS.map((u) => <option key={u.k} value={u.k}>{u.label}</option>)}
        </select>
      </div>
    </div>
  );
}

const NumField = ({ label, value, onChange, step, suffix, aria }: { label: string; value: number; onChange: (n: number) => void; step?: number; suffix?: string; aria: string }) => (
  <div>
    <span className="lbl">{label}{suffix ? ` (${suffix})` : ''}</span>
    <input className="field" type="number" inputMode="decimal" step={step ?? 1} min={0} value={Number.isFinite(value) ? value : ''} aria-label={aria} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
  </div>
);


const win = (p: Plan) => {
  const f = (s: number) => (s >= 86400 ? `${+(s / 86400).toFixed(2)}d` : s >= 3600 ? `${+(s / 3600).toFixed(2)}h` : s >= 60 ? `${+(s / 60).toFixed(2)}m` : `${s}s`);
  return `${f(p.minAgeSec)} to ${p.maxAgeSec == null ? 'any age' : f(p.maxAgeSec)}`;
};

export default function RobotTab({ me, refresh, run, busy, say, sign, openSheet }: {
  me: Me; refresh: () => Promise<Me | null>; run: RunFn; busy: string | null;
  say: (k: 'ok' | 'err', t: string) => void; sign: (t: string) => Promise<Proof>; openSheet: (s: 'fund' | 'withdraw') => void;
}) {
  const s = me.settings, lim = me.limits;
  const settingsRef = useRef<HTMLDivElement>(null);
  const plans = s.plans?.length ? s.plans : [];
  const activeId = s.active_plan && plans.some((p) => p.id === s.active_plan) ? s.active_plan : plans[0]?.id;
  const active = plans.find((p) => p.id === activeId);

  const hasVault = !!me.vault, hasConsent = !!me.consent;
  const bal = me.vault?.balanceSol ?? null;
  const funded = (bal ?? 0) >= lim.minVaultSolForLive;
  const liveReady = me.liveEnabled && hasVault && hasConsent && funded;
  const isLive = s.live && me.liveEnabled;
  const running = hasVault && hasConsent && !s.paused;

  /* ───── plan editor (local draft, saved explicitly) ───── */
  const [draft, setDraft] = useState<Plan | null>(active || null);
  const [dirty, setDirty] = useState(false);
  const [handle, setHandle] = useState(s.handle || '');
  const draftId = useRef<string | undefined>(active?.id);
  useEffect(() => {
    if (!active) return;
    if (draftId.current !== active.id || !dirty) { draftId.current = active.id; setDraft(active); setDirty(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, JSON.stringify(active)]);
  const edit = (patch: Partial<Plan>) => { setDraft((d) => (d ? { ...d, ...patch } : d)); setDirty(true); };
  const draftOk = !!draft && draft.name.trim().length > 0 && Number.isFinite(draft.sizeUsd) && draft.sizeUsd >= lim.minSizeUsd && Number.isFinite(draft.takeProfitPct) && Number.isFinite(draft.stopLossPct) && Number.isFinite(draft.maxHoldMin) && Number.isFinite(draft.scanEverySec) && Number.isFinite(draft.maxTradesDay) && Number.isFinite(draft.minLiqUsd) && Number.isFinite(draft.minVol1hUsd) && Number.isFinite(draft.minBuys1h) && (draft.maxAgeSec == null || draft.maxAgeSec > draft.minAgeSec);

  const savePlans = (list: Plan[], activePlan: string, ok: string) => run('plans', async () => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ plans: list, activePlan }) }); setDirty(false); await refresh(); say('ok', ok); });
  const savePlan = () => { if (!draft) return; savePlans(plans.map((p) => (p.id === draft.id ? draft : p)), draft.id, `Plan “${draft.name}” saved.`); };
  const ag = draft?.agent;
  const editAgent = (patch: Partial<Agent>) => edit({ agent: { ...(draft?.agent || AGENT_DEFAULT), ...patch } });
  const newHunter = () => {
    if (plans.length >= 10) return;
    const id = `p${Date.now().toString(36)}`;
    const hunter: Plan = { id, name: 'Bottom Hunter', sizeUsd: draft?.sizeUsd ?? 7, minAgeSec: 120, maxAgeSec: 6 * 3600, takeProfitPct: 40, stopLossPct: 20, maxHoldMin: 20, scanEverySec: 10, maxTradesDay: 20, minLiqUsd: 0, minVol1hUsd: 0, minBuys1h: 0, requireRising: false, agent: { ...AGENT_DEFAULT } };
    savePlans([...plans, hunter], id, 'Chart agent plan created. Set your range and save.');
  };
  const newPlan = () => {
    if (plans.length >= 10 || !draft) return;
    const id = `p${Date.now().toString(36)}`;
    const copy: Plan = { ...draft, id, name: `Plan ${plans.length + 1}` };
    savePlans([...plans, copy], id, 'New plan created. Adjust it and save.');
  };
  const removePlan = () => { if (!draft || plans.length <= 1) return; const rest = plans.filter((p) => p.id !== draft.id); savePlans(rest, rest[0].id, 'Plan deleted.'); };
  const switchPlan = (id: string) => { if (id === activeId) return; run('plan', async () => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ activePlan: id }) }); setDirty(false); await refresh(); }); };

  /* ───── safety limits (signed) ───── */
  const c = me.consent?.limits;
  const [form, setForm] = useState({ maxPositionSol: s.max_position_sol, maxDailyLossPct: s.max_daily_loss_pct, maxConcurrent: s.max_concurrent });
  const [preview, setPreview] = useState<string | null>(null);
  const seeded = useRef(false);
  useEffect(() => { if (!seeded.current && c) { seeded.current = true; setForm({ maxPositionSol: c.maxPositionSol, maxDailyLossPct: c.maxDailyLossPct, maxConcurrent: c.maxConcurrent }); } }, [c]);
  const price = me.solUsd ?? null;
  const needSol = price && active ? active.sizeUsd / price : null;
  const suggested = needSol != null ? Math.max(lim.maxPositionSol.min, Math.ceil((needSol * 1.15) / 0.005) * 0.005) : null;
  const seededPos = useRef(false);
  useEffect(() => { if (seededPos.current || hasConsent || suggested == null) return; seededPos.current = true; setForm((f) => ({ ...f, maxPositionSol: Number(suggested.toFixed(3)) })); }, [suggested, hasConsent]);
  const needsSignature = !hasConsent || (c != null && (form.maxPositionSol > c.maxPositionSol || form.maxDailyLossPct > c.maxDailyLossPct || form.maxConcurrent > c.maxConcurrent));
  const limitsDirty = hasConsent && !needsSignature && (form.maxPositionSol !== s.max_position_sol || form.maxDailyLossPct !== s.max_daily_loss_pct || form.maxConcurrent !== s.max_concurrent);
  const capSol = c ? c.maxPositionSol : form.maxPositionSol;
  const tooSmallCap = needSol != null && capSol + 1e-9 < needSol;
  const touch = () => setPreview(null);
  const patch = (key: string, body: object, okText?: string) => run(key, async () => { await api('/api/settings', { method: 'PATCH', body: JSON.stringify(body) }); await refresh(); if (okText) say('ok', okText); });
  const q = useMemo(() => new URLSearchParams({ mode: 'custom', maxPositionSol: String(form.maxPositionSol), maxDailyLossPct: String(form.maxDailyLossPct), maxConcurrent: String(form.maxConcurrent) }).toString(), [form]);
  const reviewConsent = () => run('review', async () => { const r = await api<{ message: string }>(`/api/consent?${q}`); setPreview(r.message); });
  const signConsent = () => run('consent', async () => {
    if (!preview) return;
    const proof = await sign(preview);
    await api('/api/consent', { method: 'POST', body: JSON.stringify({ message: preview, proof }) });
    setPreview(null); await refresh(); say('ok', 'Consent signed and saved.');
  });
  const [vaultKey, setVaultKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const createVault = () => run('vault', async () => {
    const r = await api<{ created?: boolean; privateKey?: string }>('/api/vault', { method: 'POST' });
    await refresh();
    if (r.privateKey) { setVaultKey(r.privateKey); say('ok', 'Vault created. Copy the private key below. You can open it again any time from this page.'); }
    else say('ok', 'Vault already exists. Use “Show vault private key” to copy it.');
  });
  const revealKey = () => run('key', async () => {
    const r = await api<{ privateKey: string }>('/api/vault/key');
    setVaultKey(r.privateKey);
  });
  const panic = () => run('panic', async () => { await api('/api/panic', { method: 'POST' }); await refresh(); say('ok', 'Paused. Closing all open trades.'); });

  /* ───── activity ───── */
  const [trades, setTrades] = useState<Trades | null>(null);
  const [tab, setTab] = useState<'open' | 'history'>('open');
  const loadTrades = useCallback(async () => { try { setTrades(await api<Trades>('/api/trades')); } catch { /* next poll */ } }, []);
  useEffect(() => { loadTrades(); const t = setInterval(loadTrades, 4000); return () => clearInterval(t); }, [loadTrades]);
  const openList = trades ? (isLive ? trades.live.open : trades.paper.open) : [];
  const history = (trades?.trades || []).filter((t) => !!t.paper === !isLive);
  const liveOpen = trades?.live.open.length || 0; void liveOpen;
  const today = useMemo(() => { const d0 = new Date(); d0.setHours(0, 0, 0, 0); return history.filter((t) => new Date(t.created_at) >= d0).reduce((a, t) => a + (Number(t.realized_sol) || 0), 0); }, [history]);

  const phase = !hasVault ? 'vault' : !hasConsent ? 'limits' : s.paused ? 'ready' : 'running';
  const goLimits = () => settingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  return (
    <div className="robot">
      <div className="stack">
        {/* service status: says plainly why trades or withdrawals may be waiting */}
        {!me.workerUnknown && (!me.worker || !me.worker.online) && (
          <div className="note err">Robot offline.{me.worker ? ` Last seen ${Math.round(me.worker.ageSec / 60)}m ago.` : ''}</div>
        )}
        {me.worker?.online && s.live && !me.worker.liveEnabled && (
          <div className="note err">Live mode is off on the server.</div>
        )}
        

        {/* compact robot control: red = off, green = trading */}
        {phase === 'vault' && (
          <div className="rbar setup"><div className="rtxt"><b>Step 1 · Vault</b><span>Create the wallet the robot trades from.</span></div>
            <button className="btn btn-gold sm" aria-label="Create my vault" disabled={!!busy} onClick={createVault}>{busy === 'vault' ? 'Creating…' : 'Create vault'}</button></div>
        )}
        {phase === 'limits' && (
          <div className="rbar setup"><div className="rtxt"><b>Step 2 · Safety limits</b><span>Sign the most the robot may risk.</span></div>
            <button className="btn btn-gold sm" aria-label="Set my limits" onClick={goLimits}>Set limits</button></div>
        )}
        {(phase === 'ready' || phase === 'running') && (
          <div className={`rbar ${running ? 'on' : 'off'}`}>
            <div className="rtxt">
              <b>{running ? 'Robot trading' : 'Robot off'}{running && <span className="scan dots"><u /><u /><u /></span>}</b>
              <span>{running ? `Scanning with “${active?.name}” · ${active ? win(active) : ''}` : `Not trading. Plan: “${active?.name}”. Flip the switch to start.`}</span>
            </div>
            <span className={`pill ${isLive ? 'live' : 'paper'}`}>{isLive ? 'Live' : 'Paper'}</span>
            <button className={`pwr ${running ? 'on' : 'off'}`} role="switch" aria-checked={running} aria-label={running ? 'Pause robot' : 'Start robot'} disabled={!!busy}
              onClick={() => patch('toggle', { paused: running }, running ? 'Robot paused. Open trades still follow their exits.' : 'Robot started.')}><i /></button>
          </div>
        )}

        

        {(phase === 'running' || phase === 'ready') && trades?.status && (
          <div className="scanline" aria-live="polite">
            <b>{running ? 'Last scan' : 'Last scan (before pause)'} {ago(Date.now() - trades.status.at)} ago</b>
            <span>{trades.status.candidates} coin{trades.status.candidates === 1 ? '' : 's'} checked · {trades.status.outcome}{trades.status.book === 'paper' ? ' · paper' : ' · live'}</span>
            {trades.status.note && <em>{trades.status.note}</em>}
          </div>
        )}
        {hasVault && me.solUsd && bal != null && s.live && bal * me.solUsd < active!.sizeUsd + 1 && (
          <p className="hint warn">Your vault holds about ${(bal * me.solUsd).toFixed(2)} and the plan trades ${active!.sizeUsd}. The robot shrinks each trade to fit what is available (it keeps a small amount for network fees), so lower the trade size in the plan if you want it fixed.</p>
        )}

        <div className="kpis">
          <div className="kpi"><span>Vault</span><b>{sol(bal)}<em>SOL</em></b>
            <div className="links2"><button disabled={!hasVault} onClick={() => openSheet('fund')}>Deposit</button><button disabled={!hasVault} onClick={() => openSheet('withdraw')}>Withdraw</button></div></div>
          <div className="kpi"><span>Today</span><b className={today >= 0 ? 'up' : 'dn'}>{signed(today)}<em>SOL</em></b></div>
          <div className="kpi"><span>Open</span><b>{openList.length}<em>/ {s.max_concurrent}</em></b></div>
        </div>

        {/* plans */}
        <div className="panel">
          <div className="panel-head"><h2>Trading plan</h2>{dirty && <span className="tag">unsaved</span>}</div>
          <div className="plans" role="radiogroup" aria-label="Plans">
            {plans.map((p) => (
              <button key={p.id} role="radio" aria-checked={p.id === activeId} className={`plan ${p.id === activeId ? 'on' : ''}`} disabled={!!busy || (running && p.id !== activeId)} onClick={() => switchPlan(p.id)}>{p.name}</button>
            ))}
            <button className="plan add" disabled={!!busy || plans.length >= 10 || !draft} onClick={newPlan} aria-label="New plan">+ New plan</button>
            <button className="plan add" disabled={!!busy || plans.length >= 10} onClick={newHunter} aria-label="New chart agent plan">+ Chart agent</button>
          </div>
          
          {draft && (
            <>
              <div className="fgrid">
                <div className="span2"><span className="lbl">Plan name</span><input className="field" maxLength={24} value={draft.name} aria-label="Plan name" onChange={(e) => edit({ name: e.target.value })} /></div>
                <NumField label="Trade size" suffix={`USD, min $${lim.minSizeUsd}, no max`} value={draft.sizeUsd} step={1} aria="Trade size in dollars" onChange={(n) => edit({ sizeUsd: n })} />
                <div><span className="lbl">≈ in SOL</span><div className="field mono" style={{ opacity: .8 }}>{price && Number.isFinite(draft.sizeUsd) ? `${(draft.sizeUsd / price).toFixed(3)} SOL` : '–'}</div></div>
                <TimeField key={`min-${draft.id}`} label="Coin age at least" sec={draft.minAgeSec} onChange={(v) => edit({ minAgeSec: v ?? 0 })} ariaLabel="Minimum coin age" />
                <TimeField key={`max-${draft.id}`} label="Coin age at most" sec={draft.maxAgeSec} emptyOk onChange={(v) => edit({ maxAgeSec: v })} ariaLabel="Maximum coin age" />
                <NumField label="Take profit" suffix="%" value={draft.takeProfitPct} aria="Take profit percent" onChange={(n) => edit({ takeProfitPct: n })} />
                <NumField label="Stop loss" suffix="%" value={draft.stopLossPct} aria="Stop loss percent" onChange={(n) => edit({ stopLossPct: n })} />
                <NumField label="Sell after at most" suffix="minutes" step={0.5} value={draft.maxHoldMin} aria="Max hold minutes" onChange={(n) => edit({ maxHoldMin: n })} />
                <NumField label="Look for coins every" suffix="seconds" value={draft.scanEverySec} aria="Scan interval seconds" onChange={(n) => edit({ scanEverySec: n })} />
              </div>
              {draft.maxAgeSec != null && draft.maxAgeSec <= draft.minAgeSec && <p className="hint warn">The maximum age must be larger than the minimum, or leave it empty for no maximum.</p>}
              <div className="agentbox">
                <label className="check"><input type="checkbox" aria-label="Chart agent" checked={!!ag?.enabled} onChange={(e) => editAgent({ enabled: e.target.checked })} /><b>Chart agent</b> — watch the live candles and enter on a pattern, even while I am away</label>
                {ag?.enabled && (
                  <>
                    
                    <div className="fgrid">
                      <div><span className="lbl">Pattern</span>
                        <select className="field" aria-label="Pattern" value={ag.pattern} onChange={(e) => editAgent({ pattern: e.target.value as Agent['pattern'] })}>
                          <option value="double_bottom">Double bottom</option><option value="breakout">Breakout</option><option value="dip_buy">Dip then bounce</option><option value="volume_spike">Volume spike</option><option value="momentum">Rising now (momentum)</option>
                        </select></div>
                      {ag.pattern === 'momentum' && !ag.onlyMint && <div><span className="lbl">Coins to watch</span><select className="field" aria-label="Coin group" value={ag.source || 'any'} onChange={(e) => editAgent({ source: e.target.value as Agent['source'] })}><option value="any">Migrated + Final stretch + Trending</option><option value="migrated">Migrated only</option><option value="stretch">Final stretch only</option><option value="trending">Trending only</option></select></div>}
                      {ag.pattern === 'momentum' && <NumField label="Skip if already up more than" suffix="%" value={ag.maxRisePct ?? 60} aria="Maximum rise percent" onChange={(n) => editAgent({ maxRisePct: n })} />}
                      <div><span className="lbl">Candle size</span>
                        <select className="field" aria-label="Candle size" value={ag.tfSec} onChange={(e) => editAgent({ tfSec: Number(e.target.value) })}>
                          <option value={5}>5 seconds</option><option value={15}>15 seconds</option><option value={60}>1 minute</option><option value={300}>5 minutes</option>
                        </select></div>
                      <NumField label="Market cap from" suffix="USD" value={ag.mcapMinUsd} aria="Market cap minimum" onChange={(n) => editAgent({ mcapMinUsd: n })} />
                      <NumField label="Market cap up to" suffix="USD" value={ag.mcapMaxUsd ?? NaN} aria="Market cap maximum" onChange={(n) => editAgent({ mcapMaxUsd: Number.isFinite(n) ? n : null })} />
                      {(ag.pattern === 'double_bottom' || ag.pattern === 'dip_buy') && <NumField label="Drop before the bottom" suffix="% at least" value={ag.minDropPct} aria="Minimum drop percent" onChange={(n) => editAgent({ minDropPct: n })} />}
                      {ag.pattern === 'double_bottom' && <NumField label="Two bottoms within" suffix="% of each other" value={ag.tolerancePct} aria="Bottom tolerance percent" onChange={(n) => editAgent({ tolerancePct: n })} />}
                      {(ag.pattern === 'double_bottom' || ag.pattern === 'dip_buy') && <NumField label="Bounce between" suffix="% at least" value={ag.bouncePct} aria="Bounce percent" onChange={(n) => editAgent({ bouncePct: n })} />}
                      {ag.pattern === 'volume_spike' && <NumField label="Volume at least" suffix="× normal" value={ag.volMult} aria="Volume multiple" onChange={(n) => editAgent({ volMult: n })} />}
                      {ag.pattern === 'double_bottom' && (
                        <div className="span2"><span className="lbl">Enter when</span>
                          <select className="field" aria-label="Entry trigger" value={ag.trigger} onChange={(e) => editAgent({ trigger: e.target.value as Agent['trigger'] })}>
                            <option value="confirm">price turns up from the second bottom (earlier, riskier)</option><option value="neckline">price breaks the middle peak (later, safer)</option>
                          </select></div>
                      )}
                    </div>
                  </>
                )}
              </div>
              <details className="adv">
                <summary>Advanced filters</summary>
                <div className="fgrid">
                  <NumField label="Max trades per day" value={draft.maxTradesDay} aria="Max trades per day" onChange={(n) => edit({ maxTradesDay: n })} />
                  <NumField label="Min liquidity" suffix="USD" value={draft.minLiqUsd} aria="Minimum liquidity" onChange={(n) => edit({ minLiqUsd: n })} />
                  <NumField label="Min volume, last hour" suffix="USD" value={draft.minVol1hUsd} aria="Minimum hourly volume" onChange={(n) => edit({ minVol1hUsd: n })} />
                  <NumField label="Min buys, last hour" value={draft.minBuys1h} aria="Minimum buys" onChange={(n) => edit({ minBuys1h: n })} />
                  <label className="check span2"><input type="checkbox" checked={draft.requireRising} onChange={(e) => edit({ requireRising: e.target.checked })} />Only coins that are already rising</label>
                </div>
                <p className="hint">Liquidity below $3,000 is always skipped, and an order is skipped if it would be more than 5% of the pool.</p>
              </details>
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn btn-gold" disabled={!!busy || !dirty || !draftOk} onClick={savePlan}>{busy === 'plans' ? 'Saving…' : 'Save plan'}</button>
                {dirty && <button className="btn btn-ghost" onClick={() => { setDraft(active || null); setDirty(false); }}>Undo</button>}
                <button className="btn btn-ghost" disabled={!!busy || plans.length <= 1} onClick={removePlan}>Delete plan</button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="stack">
        <div className="panel" ref={settingsRef}>
          <div className="panel-head"><h2>Safety limits, signed</h2>{hasConsent && <span className="tag">signed ✓</span>}</div>
          {!hasVault && <p className="hint">Create your vault first, then sign your limits here.</p>}
          <div className="slider">
            <div><span>Max SOL per trade</span><b>{form.maxPositionSol} SOL</b></div>
            <input className="field" type="number" step={0.01} min={lim.maxPositionSol.min} max={lim.maxPositionSol.max} value={Number.isFinite(form.maxPositionSol) ? form.maxPositionSol : ''} disabled={!hasVault} aria-label="Max per trade in SOL"
              onChange={(e) => { setForm({ ...form, maxPositionSol: e.target.value === '' ? NaN : Number(e.target.value) }); touch(); }} />
          </div>
          <Slider label="Stop for the day at" value={`−${form.maxDailyLossPct}%`} min={lim.maxDailyLossPct.min} max={lim.maxDailyLossPct.max} step={1} v={form.maxDailyLossPct} disabled={!hasVault} onChange={(n) => { setForm({ ...form, maxDailyLossPct: n }); touch(); }} />
          <Slider label="Max open trades" value={`${form.maxConcurrent}`} min={lim.maxConcurrent.min} max={lim.maxConcurrent.max} step={1} v={form.maxConcurrent} disabled={!hasVault} onChange={(n) => { setForm({ ...form, maxConcurrent: n }); touch(); }} />
          {hasVault && tooSmallCap && <p className="hint warn">Your signed max per trade ({capSol} SOL) is below the plan&apos;s trade size{needSol != null ? ` (≈ ${needSol.toFixed(3)} SOL)` : ''}. Trades will shrink to {capSol} SOL. Raise it and sign again to trade the full size.</p>}
          {hasVault && !preview && (
            <div className="row" style={{ marginTop: 12 }}>
              {limitsDirty ? (
                <button className="btn btn-gold" disabled={!!busy} onClick={() => patch('limits', { maxPositionSol: form.maxPositionSol, maxDailyLossPct: form.maxDailyLossPct, maxConcurrent: form.maxConcurrent }, 'Limits tightened.')}>Save lower limits</button>
              ) : (
                <button className="btn btn-gold" disabled={!!busy || (hasConsent && !needsSignature) || !Number.isFinite(form.maxPositionSol)} onClick={reviewConsent}>{hasConsent ? 'Review new consent' : 'Review what I will sign'}</button>
              )}
              {hasConsent && !needsSignature && !limitsDirty && <span className="hint">Lowering limits needs no signature. Raising them does.</span>}
            </div>
          )}
          {preview && (
            <>
              <span className="lbl" style={{ marginTop: 12 }}>This is exactly what your wallet will ask you to sign</span>
              <div className="msg">{preview}</div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-gold" disabled={!!busy} onClick={signConsent}>{busy === 'consent' ? 'Waiting for your wallet…' : 'Sign with my wallet'}</button>
                <button className="btn btn-ghost" onClick={() => setPreview(null)}>Cancel</button>
              </div>
            </>
          )}
          <div className="switch-row">
            <div>
              <b>Live trading</b>
              <span>{me.liveEnabled ? (liveReady || s.live ? 'Uses real funds from your vault.' : `${!hasVault ? 'Create a vault' : !hasConsent ? 'Sign your limits' : `Fund at least ${lim.minVaultSolForLive} SOL`} first.`) : 'Not open on this site yet. Everything runs on paper.'}</span>
            </div>
            <button className={`toggle ${isLive ? 'on' : ''}`} role="switch" aria-checked={isLive} aria-label="Live trading"
              disabled={!!busy || !me.liveEnabled || (!s.live && !liveReady)}
              onClick={() => patch('live', { live: !s.live }, s.live ? 'Back to paper mode.' : 'Live trading on. Real funds from your vault are in play.')}><i /></button>
          </div>
          {hasConsent && <button className="btn btn-danger wide" disabled={!!busy} onClick={panic}>Stop and sell all</button>}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Leaderboard profile</h2>{s.public_profile && <span className="tag">public</span>}</div>
          
          <div className="row2">
            <div><span className="lbl">Handle</span><input className="field" aria-label="Leaderboard handle" maxLength={20} placeholder="e.g. coach_mishael" value={handle} onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} /></div>
            <button className={`btn ${s.public_profile ? 'btn-ghost' : 'btn-gold'} sm`} aria-label={s.public_profile ? 'Hide me from the leaderboard' : 'Show me on the leaderboard'} disabled={!!busy}
              onClick={() => patch('profile', { handle, publicProfile: !s.public_profile }, s.public_profile ? 'You are hidden from the leaderboard.' : 'You are on the leaderboard.')}>{s.public_profile ? 'Hide me' : 'Show me'}</button>
          </div>
          {s.follow_user_id && <p className="hint">Auto-copy is on: your active plan follows the trader you copied. <button className="linkbtn" onClick={() => run('stopcopy', async () => { await api('/api/copy', { method: 'POST', body: JSON.stringify({ stop: true }) }); await refresh(); say('ok', 'Auto-copy stopped. The plan stays in your list.'); })}>Stop auto-copy</button></p>}
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Activity</h2>
            <div className="tabs">
              <button className={tab === 'open' ? 'on' : ''} onClick={() => setTab('open')}>Open {openList.length > 0 && <u>{openList.length}</u>}</button>
              <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>History</button>
            </div>
          </div>
          {!trades ? <p className="hint">Loading…</p> : tab === 'open' ? (
            openList.length === 0 ? (
              <div className="empty">{running ? 'Scanning. Trades appear here when the robot enters one.' : 'No open trades. Turn the robot on to look for entries.'}</div>
            ) : openList.map((p) => (
              <div className="feed" key={p.mint}>
                <div><b>{short(p.mint)}</b><span>{sol(p.sizeSol)} SOL · exits +{p.takeProfitPct}% / −{p.stopLossPct}% · {ago(Date.now() - p.openedAt)}</span></div>
                <Spark values={(p.trail || []).map((x) => x[1])} w={64} h={26} zero label={`Progress of ${short(p.mint)}`} />
                <strong className={p.lastPnl == null ? '' : p.lastPnl >= 0 ? 'up' : 'dn'}>{p.lastPnl == null ? '…' : `${p.lastPnl >= 0 ? '+' : ''}${p.lastPnl.toFixed(1)}%`}</strong>
              </div>
            ))
          ) : history.length === 0 ? (
            <div className="empty">No closed trades yet in {isLive ? 'live' : 'paper'} mode.</div>
          ) : history.slice(0, 12).map((t) => (
            <div className="feed" key={t.id}>
              <div><b>{short(t.mint)}</b><span>{t.exit_reason || 'closed'}{t.mode ? ` · ${t.mode}` : ''} · {new Date(t.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></div>
              <strong className={t.realized_sol == null ? '' : t.realized_sol >= 0 ? 'up' : 'dn'}>{t.realized_sol == null ? '?' : `${signed(t.realized_sol)} SOL`}</strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
