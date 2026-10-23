import nacl from 'tweetnacl';
import { authed, json } from '@/lib/api';
import { db, must } from '@/lib/db';
import { env } from '@/lib/env';
import { sealSecret } from '@/lib/seal';
import { bs58 } from '@/lib/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Create the user's ART vault (a fresh Solana wallet).
 * Secret key is sealed to the worker's public key before it touches the database.
 * The base58 private key is returned ONCE in the response when created:true so the user can copy it.
 * It is zeroed immediately after and never stored in plaintext.
 */
export const POST = authed({ write: true, limit: [10, 60_000] }, async ({ session }) => {
  const sb = db();
  const existing = must(await sb.from('art_vaults').select('address').eq('user_id', session.userId).maybeSingle(), 'vault lookup');
  if (existing) return json({ address: existing.address, created: false });

  const kp = nacl.sign.keyPair();
  const address = bs58.encode(kp.publicKey);
  const privateKey = bs58.encode(kp.secretKey); // return once only
  const sealed = sealSecret(kp.secretKey, env.sealPublic);
  kp.secretKey.fill(0);

  const ins = await sb.from('art_vaults').insert({ user_id: session.userId, address, sealed });
  if (ins.error) {
    const again = must(await sb.from('art_vaults').select('address').eq('user_id', session.userId).maybeSingle(), 'vault lookup');
    if (again) return json({ address: again.address, created: false });
    throw new Error(ins.error.message);
  }

  return json({
    address,
    created: true,
    privateKey, // shown once — user must copy and store offline. Never returned again.
    warning: 'Copy this private key now and store it offline. You will never see it again. ART cannot recover it.',
  });
});
