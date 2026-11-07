/**
 * Codes nobody uses stop going out (migration 071, verification.ts
 * unusedCodesHeld), against a LIVE deployment. Run with:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * Proves:
 *  - a sent code is marked sent;
 *  - after three sent and unused in a week, the sign-up door sends no fourth
 *    and says why, and the sign-in door says the same;
 *  - using a code clears the count.
 *
 * The rows are moved an hour into the past between requests, so the
 * three-a-quarter-hour pace never answers first.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Jar, counterFetch, dbExec } from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

describe.skipIf(!RUN)('unused codes', () => {
  const email = `success+unused-${randomBytes(6).toString('hex')}@simulator.amazonses.com`;

  async function ask(path = '/register'): Promise<{ status: number; body: string; id?: string }> {
    const res = await counterFetch(new Jar(), path, form({ email }));
    const body = await res.text();
    return { status: res.status, body, id: body.match(/name="verification_id" value="([^"]+)"/)?.[1] };
  }
  async function age(id: string) {
    await dbExec(
      `UPDATE email_verifications SET created_at = created_at - interval '1 hour' WHERE id = :id::uuid`,
      [{ name: 'id', value: id }],
    );
  }

  it('holds the fourth unused code, and a used one clears it', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await ask();
      expect(r.status).toBe(200);
      expect(r.id).toBeTruthy();
      ids.push(r.id!);
      const sent = await dbExec(`SELECT sent_at IS NOT NULL FROM email_verifications WHERE id = :id::uuid`, [
        { name: 'id', value: r.id! },
      ]);
      expect(sent[0]?.[0]).toBe(true);
      await age(r.id!);
    }

    const held = await ask();
    expect(held.status).toBe(429);
    expect(held.body).toMatch(/none was used/);
    expect(held.id).toBeUndefined();
    const heldAtLogin = await ask('/login');
    expect(heldAtLogin.status).toBe(429);
    expect(heldAtLogin.body).toMatch(/none was used/);

    // The person finds the last code and uses it: the count starts again.
    await dbExec(`UPDATE email_verifications SET used = true WHERE id = :id::uuid`, [{ name: 'id', value: ids[2] }]);
    const again = await ask('/login');
    expect(again.status).toBe(200);
    expect(again.id).toBeTruthy();
  }, 120_000);
});
