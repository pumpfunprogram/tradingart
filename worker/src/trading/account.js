const config = require('../config');
const logger = require('../utils/logger');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toSol = (lamports) => Number(lamports) / 1e9;
const short = (mint) => `${mint.slice(0, 6)}…${mint.slice(-4)}`;
const scanUrl = (sig) => (sig ? `https://solscan.io/tx/${sig}` : '');

class Book {
  constructor(acct) {
    this.acct = acct;
    this.open = new Map();
    this.entering = false;
    this.monitoring = false;
    this.daily = { day: null, startSol: 0, realizedSol: 0, tradesToday: 0 };
    this.history = [];
    this.loaded = false;
  }

  get d() { return this.acct.deps; }
  key(name) { return `live:${name}`; }
  save(name, value) {
    return this.d.db.setState(this.acct.userId, this.key(name), value)
      .catch((e) => logger.error(`[${this.acct.tag}] save ${name}:`, e.message));
  }
  persistPositions() { return this.save('positions', [...this.open.values()].map((p) => ({ ...p }))); }
  persistDaily() { return this.save('daily', { ...this.daily }); }
  persistHistory() { return this.save('history', this.history.slice(0, 50)); }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const { db, chain } = this.d;
    let saved = [];
    try {
      const s = await db.getState(this.acct.userId, this.key('positions'));
      saved = Array.isArray(s) ? s : [];
    } catch (e) {
      this.acct.notify(`Could not load saved positions: ${e.message}`);
    }
    try {
      const x = await db.getState(this.acct.userId, this.key('daily'));
      if (x && typeof x === 'object') this.daily = { ...this.daily, ...x };
    } catch (_) {}
    try {
      const h = await db.getState(this.acct.userId, this.key('history'));
      if (Array.isArray(h)) this.history = h;
    } catch (_) {}
    for (const p of saved) {
      if (!p || !p.mint) continue;
      try {
        if ((await chain.getTokenBalance(this.acct.vaultAddress, p.mint)).raw <= 0n) continue;
      } catch (_) {}
      this.open.set(p.mint, { ...p, status: p.status === 'selling' ? 'open' : p.status || 'open', priceMisses: 0 });
    }
  }

  async currentBalanceSol() {
    return this.d.chain.getSolBalance(this.acct.vaultAddress);
  }

  async rollDay() {
    const day = new Date().toISOString().slice(0, 10);
    if (this.daily.day === day) return;
    this.daily.day = day;
    this.daily.realizedSol = 0;
    this.daily.tradesToday = 0;
    this.daily.startSol = await this.currentBalanceSol();
    this.persistDaily();
  }

  async sizeSol(overrideSol) {
    const bal = await this.currentBalanceSol();
    const usable = Math.max(0, bal - config.SOL_FEE_RESERVE);
    let sol = overrideSol > 0 ? overrideSol : (config.FORCE_SIZE_SOL || 0.015);
    sol = Math.min(sol, usable * 0.9);
    if (sol < 0.008) sol = 0;
    return Math.floor(sol * 1e6) / 1e6;
  }

  async liveBuy(mint, sol) {
    const { chain, swap, fills } = this.d;
    const signer = await this.acct.getSigner();
    const owner = this.acct.vaultAddress;
    const solBefore = await chain.getSolLamports(owner);
    let sig;
    const attempts = Math.max(1, config.BUY_ATTEMPTS || 1);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        sig = await swap.buy(signer, mint, sol, attempt);
        break;
      } catch (e) {
        const msg = String(e.message || '');
        if (/insufficient|rent|graduated|bonding curve/i.test(msg)) {
          e.fatal = true;
          throw e;
        }
        let retryable = !!(e.notSent || e.onchainError || !e.signature);
        if (e.signature && !e.onchainError && !e.notSent) {
        const verdict = await swap.waitForSignature(e.signature, 20000);
          if (verdict.ok) { sig = e.signature; break; }
          let held = { raw: 0n };
          try { held = await chain.getTokenBalance(owner, mint); } catch (_) {}
          if (held.raw > 0n) { sig = e.signature; break; }
          retryable = true;
          e = new Error(`buy did not land: ${verdict.reason} (${e.signature})`);
        }
        if (e.fatal || !retryable || attempt >= attempts) throw e;
        logger.info(`[${this.acct.tag}] buy attempt ${attempt} failed (${msg.slice(0, 90)}); retrying`);
        await sleep(300 * attempt);
      }
    }

    const fill = await fills.readFill(sig, owner, mint);
    if (fill && !fill.failed && fill.tokenDeltaRaw > 0n && fill.solDeltaLamports != null && fill.solDeltaLamports < 0n) {
      return { tokenRaw: fill.tokenDeltaRaw, decimals: fill.decimals, costLamports: -fill.solDeltaLamports, signature: sig, source: 'tx' };
    }
    let bal = { raw: 0n, decimals: null };
    for (let i = 0; i < 10 && bal.raw <= 0n; i++) {
      try { bal = await chain.getTokenBalance(owner, mint); } catch (_) {}
      if (bal.raw <= 0n) await sleep(500);
    }
    if (bal.raw <= 0n) throw new Error(`buy confirmed but no tokens in vault: ${scanUrl(sig)}`);
    const spent = solBefore - (await chain.getSolLamports(owner));
    return {
      tokenRaw: bal.raw,
      decimals: bal.decimals,
      costLamports: spent > 0n ? spent : BigInt(Math.round(sol * 1e9)),
      signature: sig,
      source: spent > 0n ? 'balance' : 'requested-amount',
    };
  }

  async tryEnter(mint, reason, opts = {}) {
    if (this.open.has(mint)) return { ok: false, why: 'already hold this coin' };
    if (this.entering) return { ok: false, why: 'busy' };
    await this.load();
    await this.rollDay();
    this.entering = true;
    try {
      const mkt = await this.d.market.getTokenMarket(mint).catch(() => null);
      const open = this.acct.plan && !this.acct.plan.minAgeSec && !this.acct.plan.minLiqUsd && !this.acct.plan.minVol1hUsd && !this.acct.plan.minBuys1h && !this.acct.plan.requireRising;
      if (!mkt && !open) return { ok: false, why: 'no market data' };

      const bal = await this.currentBalanceSol();
      const sol = await this.sizeSol(opts.sizeSol);
      logger.info(`[${this.acct.tag}] vault=${bal.toFixed(4)} SOL size=${sol} SOL`);
      if (sol < 0.008 && !open) {
        return { ok: false, why: `vault ${bal.toFixed(4)} SOL too small for a ${sol || 0} SOL buy plus fees. Deposit at least 0.04 SOL.` };
      }
      if (!mkt || sol < 0.008) {
        const paperSol = sol >= 0.008 ? sol : 0.01;
        const pos = {
          mint, openedAt: Date.now(), dryRun: true, status: 'open',
          costLamports: String(Math.round(paperSol * 1e9)), tokenRaw: '1000000', decimals: 6,
          sizeSol: paperSol, sizeUsd: this.acct.plan.sizeUsd,
          entryPriceNative: 0.00001, fillSource: 'paper', buySig: null, reason,
          mode: this.acct.plan.riskProfile || 'easy',
          takeProfitPct: opts.tp > 0 ? opts.tp : (this.acct.plan.takeProfitPct || 15),
          stopLossPct: opts.sl > 0 ? opts.sl : (this.acct.plan.stopLossPct || 10),
          maxHoldMin: opts.holdMin > 0 ? opts.holdMin : (this.acct.plan.maxHoldMin || 10),
          lastPnl: null, lastPrice: null, priceMisses: 0, stuckRounds: 0,
        };
        this.open.set(mint, pos);
        this.daily.tradesToday = (this.daily.tradesToday || 0) + 1;
        this.persistPositions(); this.persistDaily();
        this.d.db.insertTrade({
          user_id: this.acct.userId, paper: true, mode: pos.mode, mint,
          side: 'buy', sol: paperSol, size_sol: paperSol, realized_sol: 0,
          created_at: new Date().toISOString(), exit_reason: 'open',
        }).catch(() => {});
        logger.info(`[${this.acct.tag}] PAPER ENTER ${short(mint)} ${paperSol} SOL (${reason})`);
        return { ok: true, pos };
      }

      logger.info(`[${this.acct.tag}] FORCE ENTER ${short(mint)} ${sol} SOL (${reason}) [LIVE]`);
      const fill = await this.liveBuy(mint, sol);
      const costSol = toSol(fill.costLamports);
      const tokensUi = Number(fill.tokenRaw) / 10 ** fill.decimals;
      const pos = {
        mint, openedAt: Date.now(), dryRun: false, status: 'open',
        costLamports: String(fill.costLamports), tokenRaw: String(fill.tokenRaw), decimals: fill.decimals,
        sizeSol: costSol, sizeUsd: this.acct.plan.sizeUsd,
        entryPriceNative: tokensUi > 0 ? costSol / tokensUi : 0,
        fillSource: fill.source, buySig: fill.signature, reason,
        mode: this.acct.plan.riskProfile || 'force',
        takeProfitPct: opts.tp > 0 ? opts.tp : (this.acct.plan.takeProfitPct || 40),
        stopLossPct: opts.sl > 0 ? opts.sl : (this.acct.plan.stopLossPct || 25),
        maxHoldMin: opts.holdMin > 0 ? opts.holdMin : (this.acct.plan.maxHoldMin || 5),
        lastPnl: null, lastPrice: null, priceMisses: 0, stuckRounds: 0,
      };
      this.open.set(mint, pos);
      this.daily.tradesToday = (this.daily.tradesToday || 0) + 1;
      this.persistPositions();
      this.persistDaily();
      return { ok: true, pos };
    } catch (err) {
      logger.error(`[${this.acct.tag}] buy failed:`, err.message);
      return { ok: false, why: err.message };
    } finally {
      this.entering = false;
    }
  }

  markPnl(pos, priceNative) {
    const tokensUi = Number(pos.tokenRaw) / 10 ** pos.decimals;
    const value = tokensUi * priceNative * (1 - config.EXIT_COST_PCT / 100);
    const cost = Number(pos.costLamports) / 1e9;
    if (!(cost > 0)) return 0;
    return ((value - cost) / cost) * 100;
  }

  async checkPosition(pos) {
    const tp = Number(pos.takeProfitPct) || 40;
    const sl = -Math.abs(Number(pos.stopLossPct) || 25);
    const maxHoldMs = (Number(pos.maxHoldMin) || 5) * 60 * 1000;
    let pnl = null;
    try {
      const mkt = await this.d.market.getTokenMarket(pos.mint);
      if (mkt) {
        pnl = this.markPnl(pos, mkt.priceNative);
        pos.lastPrice = mkt.priceNative;
        pos.lastPnl = pnl;
        pos.priceMisses = 0;
      } else pos.priceMisses += 1;
    } catch (_) { pos.priceMisses += 1; }
    let reason = null;
    if (pnl != null && pnl >= tp) reason = 'take_profit';
    else if (pnl != null && pnl <= sl) reason = 'stop_loss';
    else if (Date.now() - pos.openedAt >= maxHoldMs) reason = 'max_hold';
    if (reason) this.exit(pos, reason).catch(() => {});
  }

  async monitorTick() {
    if (this.monitoring) return;
    this.monitoring = true;
    try {
      for (const pos of [...this.open.values()]) {
        if (pos.status === 'selling') continue;
        if (pos.status === 'stuck') {
          if (Date.now() >= (pos.retryAt || 0)) this.exit(pos, pos.exitReason || 'retry').catch(() => {});
          continue;
        }
        await this.checkPosition(pos);
      }
      if (this.open.size && Date.now() - (this.lastPersist || 0) >= 3000) {
        this.lastPersist = Date.now();
        this.persistPositions();
      }
    } finally { this.monitoring = false; }
  }

  async liveSell(pos) {
    const { chain, swap, fills } = this.d;
    const signer = await this.acct.getSigner();
    const owner = this.acct.vaultAddress;
    const flat = async () => (await chain.getTokenBalance(owner, pos.mint)).raw <= 0n;
    const solBefore = await chain.getSolLamports(owner).catch(() => null);
    try { if (await flat()) return { proceedsLamports: null, sig: null, source: 'already-flat' }; } catch (_) {}
    let lastErr = null;
    for (let attempt = 1; attempt <= config.SELL_RETRIES; attempt++) {
      let sig = null;
      try { sig = await swap.sellAll(signer, pos.mint, attempt); }
      catch (e) {
        lastErr = e;
        if (e.signature && e.timedOut) {
          const v = await swap.waitForSignature(e.signature, 70000);
          if (v.ok) sig = e.signature;
        }
        if (!sig) {
          try { if (await flat()) return { proceedsLamports: null, sig: null, source: 'already-flat' }; } catch (_) {}
          await sleep(400);
          continue;
        }
      }
      let remaining = null;
      for (let i = 0; i < 5; i++) {
        try { remaining = (await chain.getTokenBalance(owner, pos.mint)).raw; } catch (_) {}
        if (remaining === 0n) break;
        await sleep(400);
      }
      if (remaining === 0n) {
        const fill = await fills.readFill(sig, owner, pos.mint);
        if (fill && !fill.failed && fill.solDeltaLamports != null) return { proceedsLamports: fill.solDeltaLamports, sig, source: 'tx' };
        const solAfter = await chain.getSolLamports(owner).catch(() => null);
        if (solBefore != null && solAfter != null) return { proceedsLamports: solAfter - solBefore, sig, source: 'balance' };
        return { proceedsLamports: null, sig, source: 'unknown' };
      }
    }
    throw new Error(`sell failed after retries: ${lastErr ? lastErr.message : 'still holding'}`);
  }

  async finalizeClose(pos, reason, result) {
    const costSol = toSol(BigInt(pos.costLamports));
    let proceedsSol = null, realizedSol = null;
    if (result.proceedsLamports != null) {
      proceedsSol = toSol(result.proceedsLamports);
      realizedSol = proceedsSol - costSol;
      this.daily.realizedSol += realizedSol;
    }
    this.open.delete(pos.mint);
    const closedAt = Date.now();
    const pct = realizedSol != null && costSol > 0 ? (realizedSol / costSol) * 100 : null;
    this.history.unshift({
      mint: pos.mint, openedAt: pos.openedAt, closedAt, reason,
      costSol, proceedsSol, realizedSol, pct,
      buySig: pos.buySig, sellSig: result.sig, paper: false, mode: pos.mode,
    });
    this.history = this.history.slice(0, 50);
    this.persistPositions(); this.persistDaily(); this.persistHistory();
    this.d.db.insertTrade({
      user_id: this.acct.userId, paper: false, mode: pos.mode, mint: pos.mint,
      entry_reason: pos.reason, exit_reason: reason,
      cost_sol: costSol, proceeds_sol: proceedsSol, realized_sol: realizedSol, pct,
      hold_sec: pos.openedAt ? Math.round((closedAt - pos.openedAt) / 1000) : null,
      buy_sig: pos.buySig, sell_sig: result.sig, features: {},
    }).catch(() => {});
    const head = realizedSol == null ? 'white' : realizedSol >= 0 ? 'win' : 'loss';
    const money = realizedSol == null ? 'result unknown' : `${realizedSol >= 0 ? '+' : ''}${realizedSol.toFixed(4)} SOL`;
    this.acct.notify(`${head} EXIT ${short(pos.mint)} ${reason} ${money}${result.sig ? ` ${scanUrl(result.sig)}` : ''}`);
  }

  async exit(pos, reason) {
    if (pos.status === 'selling') return;
    pos.status = 'selling';
    pos.exitReason = reason;
    try {
      const result = await this.liveSell(pos);
      await this.finalizeClose(pos, reason, result);
    } catch (err) {
      pos.status = 'stuck';
      pos.stuckRounds = (pos.stuckRounds || 0) + 1;
      pos.retryAt = Date.now() + config.STUCK_RETRY_MS;
      this.persistPositions();
      if (pos.stuckRounds === 1 || pos.stuckRounds % 4 === 0) {
        this.acct.notify(`SELL FAILED ${short(pos.mint)} ${err.message.slice(0, 140)}`);
      }
    }
  }

  exitAll(reason) {
    let n = 0;
    for (const pos of [...this.open.values()]) {
      if (pos.status !== 'selling') { this.exit(pos, reason).catch(() => {}); n++; }
    }
    return n;
  }
}

class Account {
  constructor(o) {
    this.userId = o.userId;
    this.wallet = o.wallet;
    this.vaultAddress = o.vaultAddress || null;
    this.sealed = o.sealed || null;
    this.deps = o.deps;
    this.unseal = o.unseal;
    this._notify = o.notify || (() => {});
    this.tag = String(o.wallet).slice(0, 4) + '…' + String(o.wallet).slice(-3);
    this.book = new Book(this);
    this._signer = null;
    this.lastPanicAt = o.settings && o.settings.panic_at ? new Date(o.settings.panic_at).getTime() : 0;
    this.update(o.settings, o.consent, { vaultAddress: o.vaultAddress, sealed: o.sealed });
  }

  notify(text) { try { this._notify(text); } catch (_) {} }

  update(settings, consent, vault) {
    this.settings = settings;
    this.consent = consent || null;
    if (vault && vault.vaultAddress && vault.vaultAddress !== this.vaultAddress) {
      this.vaultAddress = vault.vaultAddress;
      this.sealed = vault.sealed;
      this._signer = null;
    }
    const { effectivePlan } = require('../plans');
    this.plan = effectivePlan(settings, this.consent);
    this.liveAllowed = !!this.vaultAddress;
  }

  liveBlock() { return this.vaultAddress ? null : 'no vault'; }

  noteScan(info) {
    this.lastScan = { at: Date.now(), book: 'live', plan: this.plan?.name || 'force', ...info, note: this.liveBlock() };
    const db = this.deps && this.deps.db;
    if (db && db.setState) db.setState(this.userId, 'status', this.lastScan).catch(() => {});
  }

  get paused() { return !!this.settings?.paused; }
  entryBook() { return this.book; }
  hasOpen() { return this.book.open.size > 0; }
  openCount() { return this.book.open.size; }

  async getSigner() {
    if (this._signer) return this._signer;
    if (!this.sealed || !this.vaultAddress) throw new Error('no vault');
    const { Keypair } = require('@solana/web3.js');
    const secret = this.unseal(this.sealed);
    const kp = Keypair.fromSecretKey(secret);
    secret.fill(0);
    if (kp.publicKey.toBase58() !== this.vaultAddress) throw new Error('vault key mismatch');
    this._signer = kp;
    return kp;
  }

  async load() { await this.book.load(); }

  async offer(mint, reason) {
    if (this.paused) return { ok: false, why: 'paused' };
    if (!this.liveAllowed) return { ok: false, why: this.liveBlock() || 'no vault' };
    await this.load();
    return this.book.tryEnter(mint, reason);
  }

  async manualBuy(mint, o = {}) {
    if (!this.liveAllowed) return { ok: false, why: this.liveBlock() || 'no vault', paper: false };
    await this.load();
    const res = await this.book.tryEnter(mint, 'manual', { manual: true, sizeSol: o.sizeSol, tp: o.tp, sl: o.sl, holdMin: o.holdMin });
    return { ...res, paper: false };
  }

  async monitorTick() { await this.book.monitorTick(); }

  handlePanic(panicAtMs) {
    if (!panicAtMs || panicAtMs <= this.lastPanicAt) return 0;
    this.lastPanicAt = panicAtMs;
    return this.book.exitAll('panic');
  }

  exitAll(reason) { return this.book.exitAll(reason); }
  positions() { return [...this.book.open.values()]; }
  dispose() { this._signer = null; }
}

module.exports = { Account, Book };
