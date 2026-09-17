/**
 * Signing in takes a NEW session.
 *
 * Anyone who can set a cookie on this host — a shared machine, an extension,
 * a link that planted one — can hand somebody an identifier and then wait for
 * them to sign in on it. Attaching the account to that row would turn the
 * planted identifier into a live credential for whoever signed in. So the row
 * is replaced and the old one deleted, and the only thing carried across is
 * the pending authorization request that sent them to sign in.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../../src/db.js';
import {
  COUNTER_COOKIE,
  LEGACY_COUNTER_COOKIE,
  createSession,
  destroySession,
  loadSession,
  rotateSession,
} from '../../src/counter/session.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const ACCOUNT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface Row {
  id: string;
  sid_hash: string;
  account_id: string | null;
  oauth_ctx: any;
  pin_ok_until: Date | null;
}

let rows: Row[];
let seq: number;

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const out = (r: any[]) => ({ rows: r, rowCount: r.length });
      if (/INSERT INTO counter_sessions/.test(sql)) {
        const id = `sess-${++seq}`;
        rows.push({
          id,
          sid_hash: params[0],
          account_id: params[1],
          oauth_ctx: params[2] ? JSON.parse(params[2]) : null,
          pin_ok_until: null,
        });
        return out([{ id }]);
      }
      if (/SELECT id, account_id/.test(sql)) {
        const r = rows.find((x) => x.sid_hash === params[0]);
        return out(r ? [r] : []);
      }
      if (/DELETE FROM counter_sessions WHERE id/.test(sql)) {
        rows = rows.filter((x) => x.id !== params[0]);
        return out([]);
      }
      if (/DELETE FROM counter_sessions WHERE sid_hash/.test(sql)) {
        rows = rows.filter((x) => x.sid_hash !== params[0]);
        return out([]);
      }
      return out([]);
    },
  } as any;
}

/** A reply that just remembers what it was told to set. */
function fakeReply() {
  const headers: Record<string, any> = {};
  return {
    header: (k: string, v: any) => {
      headers[k] = v;
      return undefined;
    },
    headers,
  } as unknown as FastifyReply & { headers: Record<string, any> };
}

const withCookie = (raw: string) =>
  ({ headers: { cookie: raw } }) as unknown as FastifyRequest;

/** The value of the cookie a set-cookie header hands the browser. */
const setValue = (header: string | string[], name: string): string | undefined => {
  for (const line of Array.isArray(header) ? header : [header]) {
    const m = line.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return m[1];
  }
  return undefined;
};

beforeEach(() => {
  rows = [];
  seq = 0;
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

describe('the cookie', () => {
  it('is set under the __Host- name, with everything that prefix requires', async () => {
    const reply = fakeReply();
    await createSession(reply, ACCOUNT);
    const line = String(reply.headers['set-cookie']);
    expect(line.startsWith('__Host-osb_counter=')).toBe(true);
    expect(line).toContain('Path=/');
    expect(line).toContain('Secure');
    expect(line).toContain('HttpOnly');
    expect(line).toContain('SameSite=Lax');
    // __Host- is refused by the browser if a Domain is named.
    expect(line).not.toMatch(/Domain=/i);
  });

  it('is still read under the old name, so last week sign-in survives', async () => {
    const reply = fakeReply();
    await createSession(reply, ACCOUNT);
    const sid = setValue(reply.headers['set-cookie'], COUNTER_COOKIE)!;
    const asOld = await loadSession(withCookie(`${LEGACY_COUNTER_COOKIE}=${sid}`));
    expect(asOld?.accountId).toBe(ACCOUNT);
    const asNew = await loadSession(withCookie(`${COUNTER_COOKIE}=${sid}`));
    expect(asNew?.accountId).toBe(ACCOUNT);
  });

  it('prefers the new name when a browser is holding both', async () => {
    const stale = fakeReply();
    const old = await createSession(stale, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
    const oldSid = setValue(stale.headers['set-cookie'], COUNTER_COOKIE)!;
    const fresh = fakeReply();
    const live = await createSession(fresh, ACCOUNT);
    const newSid = setValue(fresh.headers['set-cookie'], COUNTER_COOKIE)!;

    const s = await loadSession(
      withCookie(`${LEGACY_COUNTER_COOKIE}=${oldSid}; ${COUNTER_COOKIE}=${newSid}`),
    );
    expect(s?.id).toBe(live.id);
    expect(s?.id).not.toBe(old.id);
    expect(sha256hex(newSid)).toBe(rows.find((r) => r.id === live.id)!.sid_hash);
  });

  it('is cleared under both names on sign-out', async () => {
    const reply = fakeReply();
    await createSession(reply, ACCOUNT);
    const sid = setValue(reply.headers['set-cookie'], COUNTER_COOKIE)!;
    const out = fakeReply();
    await destroySession(withCookie(`${COUNTER_COOKIE}=${sid}`), out);
    const lines = out.headers['set-cookie'] as string[];
    expect(lines.some((l) => l.startsWith(`${COUNTER_COOKIE}=;`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`${LEGACY_COUNTER_COOKIE}=;`))).toBe(true);
    expect(rows).toHaveLength(0);
  });
});

describe('rotation on sign-in', () => {
  it('mints a new identifier and deletes the row the browser arrived on', async () => {
    const before = fakeReply();
    const anon = await createSession(before, null);
    const planted = setValue(before.headers['set-cookie'], COUNTER_COOKIE)!;

    const after = fakeReply();
    const live = await rotateSession(after, anon, ACCOUNT);
    const issued = setValue(after.headers['set-cookie'], COUNTER_COOKIE)!;

    expect(issued).not.toBe(planted);
    expect(live.id).not.toBe(anon.id);
    expect(live.accountId).toBe(ACCOUNT);
    // The planted identifier is worth nothing now.
    expect(await loadSession(withCookie(`${COUNTER_COOKIE}=${planted}`))).toBeUndefined();
    expect(await loadSession(withCookie(`${COUNTER_COOKIE}=${issued}`))).toMatchObject({
      accountId: ACCOUNT,
    });
    expect(rows).toHaveLength(1);
  });

  it('carries the pending authorization request across, because it is theirs', async () => {
    const before = fakeReply();
    const anon = await createSession(before, null, { client_id: 'c-1', state: 'xyz' });
    const after = fakeReply();
    const live = await rotateSession(after, anon, ACCOUNT);
    expect(live.oauthCtx).toEqual({ client_id: 'c-1', state: 'xyz' });
  });

  it('carries no elevation across: the new session has confirmed nothing', async () => {
    const before = fakeReply();
    const anon = await createSession(before, null);
    const after = fakeReply();
    const live = await rotateSession(after, anon, ACCOUNT);
    expect(live.pinOkUntil).toBeNull();
  });

  it('works with no previous session at all', async () => {
    const reply = fakeReply();
    const live = await rotateSession(reply, undefined, ACCOUNT);
    expect(live.accountId).toBe(ACCOUNT);
    expect(rows).toHaveLength(1);
  });
});
