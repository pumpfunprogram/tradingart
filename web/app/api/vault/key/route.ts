import { Keypair } from '@solana/web3.js';
import { authed, fail, json } from '@/lib/api';
import { db, must } from '@/lib/db';
import { unsealSecret } from '@/lib/seal';
import { bs58 } from '@/lib/verify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Logged-in user can copy their vault private key any time. Unsealed on the server, never stored in plaintext. */
export const GET = authed({ limit: [8, 60_000] }, async ({ session }) => {
  const secret = process.env.VAULT_SEAL_SECRET || '';
  if (!secret) return fail('Set VAULT_SEAL_SECRET on the website (the same value as the worker) so vault keys can be shown.', 503);
  const row = must(await db().from('art_vaults').select('address,sealed').eq('user_id', session.userId).maybeSingle(), 'vault lookup');
  if (!row) return fail('No vault yet. Create one first.', 404);
  let raw: Uint8Array;
  try { raw = unsealSecret(row.sealed, secret); }
  catch (e: any) { return fail(e?.message || 'Could not open the vault key. VAULT_SEAL_SECRET does not match the key used when this vault was created.', 500); }
  const kp = Keypair.fromSecretKey(raw);
  raw.fill(0);
  const address = kp.publicKey.toBase58();
  if (address !== row.address) return fail('Vault key does not match the stored address.', 500);
  return json({ address, privateKey: bs58.encode(kp.secretKey) });
});
