/**
 * Stage-3 disclosure against a LIVE deployment, driven by actors who arrive
 * the way real people do — through the registration pages, with nothing
 * injected through the ops queue. Run with:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * A registered account starts with no first name and no area on file, which
 * is the state that used to let both humans opt in and then fail the stage-3
 * payload's outbound validation. What this suite proves against the real
 * service, DB and KMS:
 *
 *  - respond(opt_in) on an empty profile is refused with CONSENT_REQUIRED,
 *    the human sentence and that human's own approval link, and records
 *    nothing;
 *  - the approval page asks for the two fields at the consent moment, stores
 *    them under the account's envelope key, and then records the opt-in;
 *  - the same two fields can be viewed and changed any time on the profile
 *    page, with a signed-in session alone;
 *  - once both sides have them, the stage-3 fetch returns a conformant
 *    match.mutual carrying exactly those values.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  TestActor,
  approveDisclosure,
  dbExec,
  mcpCall,
  minimalHave,
  minimalWant,
  poll,
  readSharedProfilePage,
  registerActor,
  sendOp,
  setSharedProfile,
  waitForCardState,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

let ana: TestActor; // WANT side
let beppe: TestActor; // HAVE side
let matchId: string;

const optinCount = async (id: string): Promise<number> =>
  Number(
    (
      await dbExec(
        `SELECT count(DISTINCT account_id) FROM consent_tokens
         WHERE match_id = :m::uuid AND kind = 'stage3-optin'`,
        [{ name: 'm', value: id }],
      )
    )[0][0],
  );

d('stage-3 disclosure for accounts that came through registration', () => {
  beforeAll(async () => {
    [ana, beppe] = await Promise.all([registerActor(), registerActor()]);

    const w = await mcpCall(ana.accessToken, 'publish_intent', {
      card: minimalWant({ attributes: { condition: 'good' } }),
    });
    expect(w.isError).toBe(false);
    const h = await mcpCall(beppe.accessToken, 'publish_intent', {
      card: minimalHave({ attributes: { condition: 'good' } }),
    });
    expect(h.isError).toBe(false);
    await waitForCardState(ana.accessToken, w.result.intent_id, ['PUBLISHED']);
    await waitForCardState(beppe.accessToken, h.result.intent_id, ['PUBLISHED']);

    await sendOp({
      op: 'create-match',
      card_want: w.result.intent_id,
      card_have: h.result.intent_id,
      score: 0.86,
    });
    matchId = await poll(async () => {
      const r = await mcpCall(ana.accessToken, 'check_matches', { intent_id: w.result.intent_id });
      return r.result.matches?.[0]?.match_id as string | undefined;
    }, 'match to appear');

    await mcpCall(ana.accessToken, 'respond', { match_id: matchId, action: 'express_interest' });
    await mcpCall(beppe.accessToken, 'respond', { match_id: matchId, action: 'express_interest' });
  }, 300_000);

  it('a registered account starts with nothing on file', async () => {
    expect(await readSharedProfilePage(ana.jar)).toEqual({ firstName: '', locality: '' });
    expect(await readSharedProfilePage(beppe.jar)).toEqual({ firstName: '', locality: '' });
  });

  it('respond(opt_in) is refused with CONSENT_REQUIRED, the sentence and the link', async () => {
    const r = await mcpCall(ana.accessToken, 'respond', { match_id: matchId, action: 'opt_in' });
    expect(r.isError).toBe(true);
    expect(r.result.code).toBe('CONSENT_REQUIRED');
    expect(r.result.human_action).toContain(
      "Add the first name and area you'd share, on your approval page",
    );
    expect(r.result.human_action).toMatch(/https:\/\/[^\s]+\/counter\/a\//);
    expect(r.result.docs_url).toContain('CONSENT_REQUIRED');
  });

  it('and records nothing: no opt-in token is written by the refused call', async () => {
    expect(await optinCount(matchId)).toBe(0);
  });

  it('an agent cannot supply the name itself — there is no tool argument for it', async () => {
    const r = await mcpCall(ana.accessToken, 'respond', {
      match_id: matchId,
      action: 'opt_in',
      first_name: 'NotAna',
    } as any);
    expect(r.isError).toBe(true);
    expect(await optinCount(matchId)).toBe(0);
  });

  it('the approval page asks for both fields and records the opt-in once given', async () => {
    const r = await approveDisclosure(ana.jar, matchId, ana.pin, {
      firstName: 'Ana',
      locality: 'Fremantle',
    });
    expect(r.asked, 'the approval page should ask for the two fields').toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toContain('Approved');
    expect(await optinCount(matchId)).toBe(1);
    expect(await readSharedProfilePage(ana.jar)).toEqual({
      firstName: 'Ana',
      locality: 'Fremantle',
    });
  });

  it('a filled profile stops the approval page asking again', async () => {
    const page = await approveDisclosure(ana.jar, matchId, ana.pin);
    expect(page.asked).toBe(false);
  });

  it('the profile page changes them any time, with a signed-in session alone', async () => {
    const res = await setSharedProfile(ana.jar, 'Ana', 'North Fremantle');
    expect(res.status).toBe(200);
    expect(await readSharedProfilePage(ana.jar)).toEqual({
      firstName: 'Ana',
      locality: 'North Fremantle',
    });
    await setSharedProfile(ana.jar, 'Ana', 'Fremantle');
  });

  it('the profile page turns away anything shaped like a contact detail', async () => {
    for (const [firstName, locality] of [
      ['ana@example.com', 'Fremantle'],
      ['Ana', '+61 400 000 000'],
      ['Ana', 'https://example.com/ana'],
    ]) {
      const res = await setSharedProfile(ana.jar, firstName, locality);
      expect(res.status, `${firstName} / ${locality}`).toBe(400);
    }
    // The good values are still what is on file.
    expect(await readSharedProfilePage(ana.jar)).toEqual({
      firstName: 'Ana',
      locality: 'Fremantle',
    });
  });

  it('stage 3 stays locked while only one side has opted in', async () => {
    const locked = await mcpCall(ana.accessToken, 'check_matches', { match_id: matchId, stage: 3 });
    expect(locked.isError).toBe(true);
    expect(locked.result.code).toBe('STAGE_LOCKED');
  });

  it('the second human fills their page, and their agent may then opt in', async () => {
    const refused = await mcpCall(beppe.accessToken, 'respond', {
      match_id: matchId,
      action: 'opt_in',
    });
    expect(refused.isError).toBe(true);
    expect(refused.result.code).toBe('CONSENT_REQUIRED');

    expect((await setSharedProfile(beppe.jar, 'Beppe', 'Trastevere')).status).toBe(200);

    const ok = await mcpCall(beppe.accessToken, 'respond', { match_id: matchId, action: 'opt_in' });
    expect(ok.isError).toBe(false);
    expect(ok.result.both_recorded).toBe(true);
    expect(await optinCount(matchId)).toBe(2);
  });

  it('the stage-3 fetch now returns a conformant match.mutual to each side', async () => {
    const toAna = await mcpCall(ana.accessToken, 'check_matches', { match_id: matchId, stage: 3 });
    expect(toAna.isError).toBe(false);
    expect(toAna.result.kind).toBe('match.mutual');
    expect(toAna.result.counterparty).toEqual({ first_name: 'Beppe', locality: 'Trastevere' });
    expect(toAna.result.optin.both_recorded).toBe(true);

    const toBeppe = await mcpCall(beppe.accessToken, 'check_matches', {
      match_id: matchId,
      stage: 3,
    });
    expect(toBeppe.isError).toBe(false);
    expect(toBeppe.result.counterparty).toEqual({ first_name: 'Ana', locality: 'Fremantle' });
  });

  it('the sweep carries the mutual payload too, and flags nothing as blocked', async () => {
    const all = await mcpCall(ana.accessToken, 'check_matches', {});
    const entry = all.result.matches.find((m: any) => m.match_id === matchId);
    expect(entry.mutual.counterparty.first_name).toBe('Beppe');
    expect(entry.mutual_blocked).toBeUndefined();
  });

  it('the profile pages stay human-only: an agent bearer token is refused', async () => {
    const { COUNTER_URL } = await import('./helpers.js');
    for (const [method, path] of [
      ['GET', '/counter/profile'],
      ['POST', '/counter/profile'],
    ] as const) {
      const res = await fetch(`${COUNTER_URL}${path}`, {
        method,
        headers: { authorization: `Bearer ${ana.accessToken}` },
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await res.json()).error).toBe('agent_credentials_rejected');
    }
  });
});
