import { authed, json } from '@/lib/api';
import { db, must } from '@/lib/db';
import { env, LIMITS } from '@/lib/env';
import { solBalance } from '@/lib/chain';
import { solUsd } from '@/lib/price';
import { defaultPlans } from '@/lib/planrules';
import { ensureHandle } from '@/lib/copy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = authed({ limit: [90, 60_000] }, async ({ session }) => {
  const sb = db();
  const [user, vault, settings, consent, withdrawals] = await Promise.all([
    sb.from('art_users').select('id,wallet,tg_chat_id,tg_username,created_at').eq('id', session.userId).single(),
    sb.from('art_vaults').select('address,created_at').eq('user_id', session.userId).maybeSingle(),
    sb.from('art_settings').select('*').eq('user_id', session.userId).single(),
    sb.from('art_consents').select('id,version,limits,created_at').eq('user_id', session.userId).is('revoked_at', null).order('created_at', { ascending: false }).limit(1),
    sb.from('art_withdrawals').select('id,amount_lamports,status,tx_sig,error,created_at').eq('user_id', session.userId).order('created_at', { ascending: false }).limit(5),
  ]);
  const v = must(vault, 'vault');
  let settingsRow: any = must(settings, 'settings');
  // first visit (or an account from before plans existed): give the user the two starter plans
  if (!Array.isArray(settingsRow.plans) || settingsRow.plans.length === 0) {
    const plans = defaultPlans();
    await sb.from('art_settings').update({ plans, active_plan: plans[0].id, updated_at: new Date().toISOString() }).eq('user_id', session.userId);
    settingsRow = { ...settingsRow, plans, active_plan: plans[0].id };
  }
  // give every account the Easy plan if they do not have it yet (paper-test template)
  if (Array.isArray(settingsRow.plans) && !settingsRow.plans.some((p: any) => p && p.id === 'easy')) {
    const easy = defaultPlans().find((p: any) => p.id === 'easy') || defaultPlans()[0];
    const plans = [easy, ...settingsRow.plans];
    await sb.from('art_settings').update({ plans, updated_at: new Date().toISOString() }).eq('user_id', session.userId);
    settingsRow = { ...settingsRow, plans };
  }
  // everyone is on the leaderboard by default, so everyone needs a public handle (never the wallet)
  if (settingsRow.public_profile !== false && !settingsRow.handle) {
    const h = await ensureHandle(sb, session.userId, session.wallet);
    if (h) settingsRow = { ...settingsRow, handle: h, public_profile: true };
  }
  // is the robot service alive, and is live trading really switched on there? (null = it has never reported in)
  let workerUnknown = false;
  let worker: { online: boolean; liveEnabled: boolean; ageSec: number; version: string | null; checks?: any } | null = null;
  try {
    let { data, error } = await sb.from('art_worker').select('beat,live_enabled,version,checks').eq('id', 'main').maybeSingle();
    if (error) ({ data, error } = await sb.from('art_worker').select('beat,live_enabled,version').eq('id', 'main').maybeSingle()); // the checks column is newer
    if (error) workerUnknown = true;
    if (data) { const age = Math.max(0, Math.round((Date.now() - Date.parse(data.beat)) / 1000)); worker = { online: age < 90, liveEnabled: !!data.live_enabled, ageSec: age, version: data.version || null, checks: (data as any).checks || null }; }
  } catch { /* table not created yet */ }
  return json({
    worker, workerUnknown,
    wallet: session.wallet,
    telegramLinked: !!must(user, 'user').tg_chat_id,
    vault: v ? { address: v.address, balanceSol: await solBalance(v.address) } : null,
    settings: settingsRow,
    consent: must(consent, 'consent')[0] || null,
    withdrawals: must(withdrawals, 'withdrawals'),
    liveEnabled: env.liveEnabled,
    solUsd: await solUsd(),
    limits: LIMITS,
  });
});
