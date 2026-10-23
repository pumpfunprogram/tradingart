import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { env } from './env';

export const COOKIE = 'art_session';
const TTL_SEC = 30 * 24 * 60 * 60;
const key = () => new TextEncoder().encode(env.sessionSecret);

export type Session = { userId: string; wallet: string };

export async function createSession(s: Session): Promise<string> {
  return new SignJWT({ w: s.wallet }).setProtectedHeader({ alg: 'HS256' }).setSubject(s.userId).setIssuedAt().setExpirationTime(`${TTL_SEC}s`).sign(key());
}
export async function readSession(): Promise<Session | null> {
  const tok = cookies().get(COOKIE)?.value;
  if (!tok) return null;
  try {
    const { payload } = await jwtVerify(tok, key(), { algorithms: ['HS256'] });
    if (!payload.sub || typeof payload.w !== 'string') return null;
    return { userId: payload.sub, wallet: payload.w };
  } catch { return null; }
}
export const cookieOptions = () => ({ httpOnly: true, secure: env.isProd, sameSite: 'lax' as const, path: '/', maxAge: TTL_SEC });
