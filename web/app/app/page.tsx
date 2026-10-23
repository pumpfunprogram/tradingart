'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton, useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { useSign } from '@/components/useSign';
import { api, short, Sheet, type Me } from './shared';
import TokensTab from './Tokens';
import TradesTab from './Trades';
import RobotTab from './Robot';
import LeadersTab from './Leaders';

type SheetKind = null | 'fund' | 'withdraw' | 'perm';

export default function Dashboard() {
  const { publicKey, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const { sendTransaction } = useWallet();
  const sign = useSign();
  const [tab, setTab] = useState<'tokens' | 'trades' | 'leaders' | 'robot'>('tokens');
  const [me, setMe] = useState<Me | null>(null);
  const [auth, setAuth] = useState<'checking' | 'out' | 'in'>('checking');
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [menu, setMenu] = useState(false);
  const wallet58 = publicKey?.toBase58() || null;

  const say = (kind: 'ok' | 'err', text: string) => setFlash({ kind, text });
  useEffect(() => {
    const h = (e: Event) => {
      const m = String((e as CustomEvent).detail || '');
      const flagged = /blocked|malicious|unverified|new domain|origin|not allowed/i.test(m);
      setFlash({ kind: 'err', text: flagged ? `Your wallet blocked this site (${m}). New domains are flagged by wallets for a few days. You can choose “Proceed anyway” in the wallet warning, or try another wallet.` : `Wallet: ${m}` });
    };
    window.addEventListener('art:wallet-error', h);
    return () => window.removeEventListener('art:wallet-error', h);
  }, []);
  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setFlash(null);
    try { await fn(); } catch (e: any) { say('err', e?.message || 'Something went wrong'); } finally { setBusy(null); }
  };

  const refresh = useCallback(async () => {
    try { const m = await api<Me>('/api/me'); setMe(m); setAuth('in'); return m; } catch (e: any) { if (e.status === 401) { setMe(null); setAuth('out'); } return null; }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (auth !== 'in') return; const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [auth, refresh]);
  useEffect(() => { if (!menu) return; const k = () => setMenu(false); window.addEventListener('click', k); return () => window.removeEventListener('click', k); }, [menu]);

  const signedWallet = me?.wallet || null;
  const mismatch = auth === 'in' && connected && wallet58 && signedWallet && wallet58 !== signedWallet;

  const signIn = () => run('signin', async () => {
    if (!wallet58) throw new Error('Connect a wallet first');
    const { message } = await api<{ message: string }>(`/api/auth/nonce?wallet=${wallet58}`);
    const proof = await sign(message);
    await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ wallet: wallet58, message, proof }) });
    await refresh(); setTab('robot');
  });
  const signOut = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); setMe(null); setAuth('out'); setMenu(false); };

  /* ───── deposit / withdraw ───── */
  const [fundAmt, setFundAmt] = useState('0.1');
  const [wAmt, setWAmt] = useState('');
  const [wTo, setWTo] = useState('');
  const [wPreview, setWPreview] = useState<{ message: string } | null>(null);
  const [walletBal, setWalletBal] = useState<number | null>(null);
  const [fundNote, setFundNote] = useState<{ kind: 'wait' | 'ok' | 'err'; text: string } | null>(null);
  useEffect(() => {
    if (sheet !== 'fund' || !publicKey) return;
    let dead = false;
    connection.getBalance(publicKey, 'confirmed').then((l) => { if (!dead) setWalletBal(l / 1e9); }).catch(() => { if (!dead) setWalletBal(null); });
    return () => { dead = true; };
  }, [sheet, publicKey, connection]);
  const fund = () => run('fund', async () => {
    if (!publicKey || !me?.vault) throw new Error('No vault');
    const amount = Number(fundAmt);
    if (!(amount > 0)) throw new Error('Enter an amount in SOL');
    if (walletBal != null && amount > walletBal - 0.001) throw new Error(`Your connected wallet holds ${walletBal.toFixed(4)} SOL. Enter ${Math.max(0, walletBal - 0.003).toFixed(3)} or less, which leaves a little for the network fee.`);
    const before = me.vault.balanceSol ?? 0;
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(me.vault.address), lamports: Math.round(amount * 1e9) }));
    const sig = await sendTransaction(tx, connection);
    setFundNote({ kind: 'wait', text: `Sent (${sig.slice(0, 8)}…). Waiting for the network to confirm it…` });
    // watch the vault in the background until the money shows up (usually 5 to 30 seconds); the buttons stay usable meanwhile
    void (async () => {
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const m = await refresh();
        const now = m?.vault?.balanceSol ?? 0;
        if (now >= before + amount * 0.9) { setFundNote({ kind: 'ok', text: `✅ Received. Your vault now holds ${now.toFixed(4)} SOL.` }); return; }
      }
      setFundNote({ kind: 'err', text: `Sent, but not visible in the vault yet. Check the transaction: https://solscan.io/tx/${sig}` });
    })();
  });
  const reviewWithdraw = () => run('wreview', async () => {
    if (!me) return;
    const amt = wAmt.trim() === '' ? 'ALL' : wAmt.trim();
    const to = wTo.trim() || me.wallet;
    setWPreview(await api<{ message: string }>(`/api/withdraw/challenge?amount=${encodeURIComponent(amt)}&to=${encodeURIComponent(to)}`));
  });
  const signWithdraw = () => run('withdraw', async () => {
    if (!wPreview) return;
    const proof = await sign(wPreview.message);
    await api('/api/withdraw', { method: 'POST', body: JSON.stringify({ message: wPreview.message, proof }) });
    setWPreview(null); setWAmt(''); setWTo(''); setSheet(null); await refresh(); say('ok', 'Withdrawal requested. The worker sends it shortly.');
  });

  const running = !!me && !!me.vault && !!me.consent && !me.settings.paused;
  const hasVault = !!me?.vault;
  const closeSheet = useRef(() => { setSheet(null); setWPreview(null); });

  return (
    <div className="art">
      <div className="wrap">
        <div className="top">
          <a className="brand" href="/"><span className="mark" />ART</a>
          <nav className="navtabs" aria-label="Sections">
            <button className={tab === 'tokens' ? 'on' : ''} onClick={() => setTab('tokens')}>Tokens</button>
            <button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>Trades</button>
            <button className={tab === 'leaders' ? 'on' : ''} onClick={() => setTab('leaders')}>Leaders</button>
            <button className={tab === 'robot' ? 'on' : ''} onClick={() => setTab('robot')}>Robot</button>
          </nav>
          <span className="grow" />
          {auth === 'in' && <button className={`rstat ${running ? 'on' : 'off'}`} onClick={() => setTab('robot')} aria-label={running ? 'Robot is trading' : 'Robot is off'}><i />{running ? 'Trading' : 'Off'}</button>}
          {auth === 'in' && me ? (
            <div className="menuwrap" onClick={(e) => e.stopPropagation()}>
              <button className="chip" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>{short(me.wallet)} ▾</button>
              {menu && (
                <div className="menu" role="menu">
                  <button role="menuitem" disabled={!hasVault} onClick={() => { setSheet('fund'); setMenu(false); }}>＋ Deposit</button>
                  <button role="menuitem" disabled={!hasVault} onClick={() => { setSheet('withdraw'); setMenu(false); }}>↗ Withdraw</button>
                  <button role="menuitem" onClick={() => { setSheet('perm'); setMenu(false); }}>ⓘ Permissions</button>
                  <hr />
                  <button role="menuitem" onClick={signOut}>Sign out</button>
                </div>
              )}
            </div>
          ) : <WalletMultiButton />}
        </div>

        {flash && <div className={`note ${flash.kind === 'err' ? 'err' : 'ok'}`} role="status">{flash.text}</div>}
        {mismatch && (
          <div className="note err">You are signed in as <span className="mono">{short(signedWallet!)}</span> but your wallet switched to <span className="mono">{short(wallet58!)}</span>.{' '}
            <button className="btn btn-ghost sm" onClick={signOut}>Sign out and switch</button></div>
        )}

        {tab === 'tokens' && <TokensTab me={me} onSaved={refresh} goRobot={() => setTab('robot')} />}
        {tab === 'trades' && <TradesTab onOpen={(m) => { setTab('tokens'); }} />}
        {tab === 'leaders' && <LeadersTab signedIn={auth === 'in'} me={me} refresh={refresh} say={say} goRobot={() => setTab('robot')} />}

        {tab === 'robot' && (
          <>
            {auth === 'checking' && <div className="hero"><span className="eyebrow">Loading…</span></div>}
            {auth === 'out' && (
              <div className="hero">
                <span className="eyebrow">African Robot Trader · Solana</span>
                <h1>Your robot,<br />your limits.</h1>
                {!connected ? <button className="btn btn-gold" aria-label="Connect wallet" onClick={() => setVisible(true)}>Connect wallet</button>
                  : <button className="btn btn-gold" aria-label="Sign in" disabled={!!busy} onClick={signIn}>{busy === 'signin' ? 'Check your wallet…' : `Sign in ${wallet58 ? short(wallet58) : ''}`}</button>}
                <p style={{ marginTop: 14 }}>
                  {!connected ? 'Connect any Solana wallet. Connecting only shares your public address.'
                    : <>Sign one message to prove this wallet is yours. <b>It does not move funds and gives ART no permission to spend anything.</b></>}
                </p>
                <details><summary>Wallet says “new domain” or won&apos;t connect?</summary>
                  <p style={{ marginTop: 10 }}>Wallets such as Phantom show a warning for any newly registered website until it has been seen for a few days. It is the wallet being careful about a young domain, not a problem with your wallet. Choose “Proceed anyway” (connecting only shares your public address), or try Solflare / Backpack. If a wallet app on your phone refuses to connect, open this page inside the wallet app&apos;s own browser.</p>
                </details>
                <details><summary>Which wallets work?</summary>
                  <p style={{ marginTop: 10 }}>Anything that follows the Solana Wallet Standard is detected automatically: Phantom, Solflare, Backpack, Coinbase, Trust, Ledger and more. On Android, wallet apps connect through Mobile Wallet Adapter. On iPhone, open this page inside your wallet app&apos;s browser. Wallets that only support other chains (EVM-only) cannot sign for Solana.</p>
                </details>
              </div>
            )}
            {auth === 'in' && me && !mismatch && <RobotTab me={me} refresh={refresh} run={run} busy={busy} say={say} sign={sign} openSheet={(k) => setSheet(k)} />}
          </>
        )}

        <footer>Trading digital assets carries a high risk of loss. ART does not promise profit. The vault is a wallet that ART&apos;s trading service controls so it can trade while you are away; it is not a bank account and is not insured. Only fund what you can afford to lose. Token listings are live market data, not recommendations.</footer>
      </div>

      {sheet === 'fund' && me?.vault && (
        <Sheet title="Deposit to your vault" onClose={() => { setFundNote(null); closeSheet.current(); }}>
          <p>Pick an amount and approve one transfer in your wallet. After that the robot trades with the vault balance and never asks you to approve a trade. Leave a little SOL for network fees.</p>
          <div className="depstats">
            <div><span>Your wallet</span><b>{walletBal == null ? '…' : `${walletBal.toFixed(4)} SOL`}</b></div>
            <div><span>Vault now</span><b>{(me.vault.balanceSol ?? 0).toFixed(4)} SOL</b></div>
          </div>
          <span className="lbl">Amount in SOL</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, margin: '4px 0 8px' }}>
            {['0.05', '0.1', '0.25', '0.5', '1'].map((v) => <button key={v} className={`btn sm ${fundAmt === v ? 'btn-gold' : ''}`} onClick={() => setFundAmt(v)}>{v}</button>)}
            {walletBal != null && walletBal > 0.01 && <button className="btn sm" onClick={() => setFundAmt(String(Math.max(0, Math.floor((walletBal - 0.005) * 1000) / 1000)))}>Max</button>}
          </div>
          <div className="row">
            <input className="field" style={{ maxWidth: 180 }} inputMode="decimal" value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} aria-label="Amount in SOL" />
            <button className="btn btn-gold" disabled={!!busy} onClick={fund}>{busy === 'fund' ? 'Check your wallet…' : 'Deposit from my wallet'}</button>
          </div>
          {fundNote && <div className={`note ${fundNote.kind === 'ok' ? 'ok' : fundNote.kind === 'err' ? 'err' : ''}`} role="status">{fundNote.text}</div>}
          <p className="hint" style={{ marginTop: 14 }}>Other ways: send SOL to this address from an exchange or another wallet (it appears here within seconds), or open your wallet app with the amount filled in.</p>
          <div className="addr"><span style={{ flex: 1 }}>{me.vault.address}</span><button className="btn btn-ghost sm" onClick={() => navigator.clipboard?.writeText(me.vault!.address)}>Copy</button></div>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <a className="btn btn-ghost sm" href={`solana:${me.vault.address}?amount=${Number(fundAmt) > 0 ? Number(fundAmt) : ''}&label=ART%20vault`}>Open in my wallet app</a>
            <a className="btn btn-ghost sm" href={`https://solscan.io/account/${me.vault.address}`} target="_blank" rel="noreferrer">See vault on Solscan</a>
          </div>
        </Sheet>
      )}

      {sheet === 'withdraw' && me && (
        <Sheet title="Withdraw" onClose={closeSheet.current}>
          <p>Send funds from your vault to your connected wallet (<span className="mono">{short(me.wallet)}</span>) or to any Solana address you paste. You sign the exact destination, so nothing can change it afterwards. If you have open live trades, press “Stop and sell all” first.</p>
          {!me.worker?.online && <p className="hint warn">The robot service is not reporting in right now, so a withdrawal will wait until it is back. Nothing is lost.</p>}
          {!wPreview ? (
            <>
              <span className="lbl">Send to</span>
              <input className="field" placeholder={`My wallet (${short(me.wallet)}) or paste another Solana address`} value={wTo} onChange={(e) => setWTo(e.target.value)} aria-label="Destination address" />
              {wTo.trim() !== '' && wTo.trim() !== me.wallet && <p className="hint warn">Check every character. Transfers on Solana cannot be reversed.</p>}
              <span className="lbl" style={{ marginTop: 10 }}>Amount</span>
              <div className="row"><input className="field" style={{ maxWidth: 220 }} placeholder="Amount in SOL, blank = all" inputMode="decimal" value={wAmt} onChange={(e) => setWAmt(e.target.value)} />
                <button className="btn btn-ghost" disabled={!!busy} onClick={reviewWithdraw}>Review withdrawal</button></div>
              <p className="hint">Leave the amount blank to withdraw everything. Open live trades must be closed first (Robot tab, “Stop and sell all”).</p>
            </>
          ) : (
            <>
              <span className="lbl">Your wallet will ask you to sign this</span>
              <div className="msg">{wPreview.message}</div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn btn-gold" disabled={!!busy} onClick={signWithdraw}>{busy === 'withdraw' ? 'Waiting for your wallet…' : 'Sign and withdraw'}</button>
                <button className="btn btn-ghost" onClick={() => setWPreview(null)}>Cancel</button>
              </div>
            </>
          )}
          {(() => {
            const last = me.withdrawals[0];
            if (!last || !['pending', 'processing'].includes(last.status)) return null;
            const age = (Date.now() - Date.parse(last.created_at)) / 1000;
            const ver = String(me.worker?.version || '0.0').split('.').map(Number);
            if (!me.worker?.online) return <p className="hint warn">Your last withdrawal is waiting because the robot service is offline. Nothing is lost: it will go through when the service is back.</p>;
            if (ver[0] < 4 || (ver[0] === 4 && ver[1] < 2)) return <p className="hint warn">The robot service is running an old version ({me.worker.version}). Redeploy the worker so withdrawals are processed.</p>;
            if (age > 90) return <p className="hint warn">Still processing after {Math.round(age)} seconds. The network can be slow; the robot keeps retrying the same transfer and never sends it twice.</p>;
            return <p className="hint">Processing your withdrawal. This usually takes under a minute.</p>;
          })()}
          {me.withdrawals.slice(0, 6).map((w) => (
            <div className="feed" key={w.id}>
              <div><b>{w.amount_lamports ? `${(Number(w.amount_lamports) / 1e9).toFixed(4)} SOL` : 'All'}</b><span>{new Date(w.created_at).toLocaleString()}{w.error ? ` · ${w.error}` : ''}{w.tx_sig ? <> · <a href={`https://solscan.io/tx/${w.tx_sig}`} target="_blank" rel="noreferrer">view</a></> : null}</span></div>
              <strong className={w.status === 'done' ? 'up' : w.status === 'failed' || w.status === 'rejected' ? 'dn' : ''}>{w.status}</strong>
            </div>
          ))}
        </Sheet>
      )}

      {sheet === 'perm' && (
        <Sheet title="What you sign, and what it can do" onClose={closeSheet.current}>
          <div className="perm"><i>1</i><div><b>Connect</b><span>Shares your public address. Cannot move funds.</span></div></div>
          <div className="perm"><i>2</i><div><b>Sign in</b><span>A message that proves you own the wallet. Moves nothing, grants nothing.</span></div></div>
          <div className="perm"><i>3</i><div><b>Sign your limits</b><span>A message that sets the most the robot may risk. It lets ART&apos;s service trade <u>from your vault only</u>, never from your own wallet.</span></div></div>
          <div className="perm"><i>4</i><div><b>Fund the vault</b><span>A normal transfer you approve in your wallet. The only time your own wallet sends SOL.</span></div></div>
          <div className="perm"><i>5</i><div><b>Withdraw</b><span>A message you sign. The vault then sends funds to the address you signed (your wallet or one you paste), and nowhere else.</span></div></div>
          <p style={{ marginTop: 12 }}>Solana has no “unlimited spending approval” on your main wallet, and ART never asks for one. To end ART&apos;s access completely: Stop and sell all, withdraw everything, sign out.</p>
        </Sheet>
      )}
    </div>
  );
}
