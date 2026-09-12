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
 *  - respond(opt_in) is refused with CONSENT_REQUIRED, the human sentence and
 *    that human's own single-use link, and records nothing — every time, with
 *    a first name and area on file or without (Lachlan, 2026-09-12: sharing
 *    them is one of the three that go to the human every time);
 *  - pressing that link is what records the opt-in, and the page asks for the
 *    two fields at the consent moment where there are none on file, storing
 *    them under the account's envelope key;
 *  - the approval page is the second road to the same question;
 *  - the same two fields can be viewed and changed any time on the profile
 *    page, with a signed-in session alone;
 *  - once both sides have them, the stage-3 fetch returns a conformant
 *    match.mutual carrying exactly those values.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  TestActor,
  approveDisclosure,
  counterFetch,
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

/** A form post, the way a browser sends one. */
const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

/**
 * The names step the way a person does it: the link out of the refusal their
 * agent was handed, read once, then pressed with the PIN. Where nothing is on
 * file the same page asks for the first name and area, so the two fields ride
 * along with the press.
 */
const pressNamesLink = async (
  actor: TestActor,
  humanAction: string,
  shared?: { firstName: string; locality: string },
): Promise<{ status: number; body: string; asked: boolean }> => {
  const link = String(humanAction).match(/https?:\/\/\S+\/a\/\S+/)?.[0];
  expect(link, humanAction).toBeTruthy();
  const ask = await counterFetch(actor.jar, link!);
  const askBody = await ask.text();
  expect(ask.status).toBe(200);
  expect(askBody).toContain('Share your first name and area');
  const pressed = await counterFetch(
    actor.jar,
    link!,
    form({
      decision: 'yes',
      pin: actor.pin,
      ...(shared ? { first_name: shared.firstName, locality: shared.locality } : {}),
    }),
  );
  return {
    status: pressed.status,
    body: await pressed.text(),
    asked: askBody.includes('name="first_name"'),
  };
};

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
      listing: minimalWant({ attributes: { condition: 'good' } }),
    });
    expect(w.isError).toBe(false);
    const h = await mcpCall(beppe.accessToken, 'publish_intent', {
      listing: minimalHave({ attributes: { condition: 'good' } }),
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
      const r = await mcpCall(ana.accessToken, 'check_in', { intent_id: w.result.intent_id });
      return r.result.introductions?.[0]?.intro_id as string | undefined;
    }, 'match to appear');

    await mcpCall(ana.accessToken, 'respond', { intro_id: matchId, action: 'express_interest' });
    await mcpCall(beppe.accessToken, 'respond', { intro_id: matchId, action: 'express_interest' });
  }, 300_000);

  it('a registered account starts with nothing on file', async () => {
    expect(await readSharedProfilePage(ana.jar)).toEqual({ firstName: '', locality: '' });
    expect(await readSharedProfilePage(beppe.jar)).toEqual({ firstName: '', locality: '' });
  });

  it('respond(opt_in) is refused with CONSENT_REQUIRED, the sentence and the link', async () => {
    const r = await mcpCall(ana.accessToken, 'respond', { intro_id: matchId, action: 'opt_in' });
    expect(r.isError).toBe(true);
    expect(r.result.code).toBe('CONSENT_REQUIRED');
    expect(r.result.human_action).toContain(
      'Sharing their first name and area is theirs to press. Hand them this link',
    );
    expect(r.result.human_action).toMatch(/https:\/\/[^\s]+\/a\//);
    expect(r.result.docs_url).toContain('CONSENT_REQUIRED');
  });

  it('and records nothing: no opt-in token is written by the refused call', async () => {
    expect(await optinCount(matchId)).toBe(0);
  });

  it('an agent cannot supply the name itself — there is no tool argument for it', async () => {
    const r = await mcpCall(ana.accessToken, 'respond', {
      intro_id: matchId,
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

  it('and stops nothing else: the agent is refused the same way, with both on file', async () => {
    const before = await optinCount(matchId);
    const r = await mcpCall(ana.accessToken, 'respond', { intro_id: matchId, action: 'opt_in' });
    expect(r.isError).toBe(true);
    expect(r.result.code).toBe('CONSENT_REQUIRED');
    expect(r.result.human_action).toContain(
      'Sharing their first name and area is theirs to press. Hand them this link',
    );
    expect(r.result.human_action).toMatch(/https:\/\/[^\s]+\/a\//);
    expect(await optinCount(matchId)).toBe(before);
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
    const locked = await mcpCall(ana.accessToken, 'check_in', { intro_id: matchId, step: 'names' });
    expect(locked.isError).toBe(true);
    expect(locked.result.code).toBe('NOT_UNLOCKED_YET');
  });

  it('the second human presses the link their agent was handed, and both are in', async () => {
    const refused = await mcpCall(beppe.accessToken, 'respond', {
      intro_id: matchId,
      action: 'opt_in',
    });
    expect(refused.isError).toBe(true);
    expect(refused.result.code).toBe('CONSENT_REQUIRED');
    expect(await optinCount(matchId)).toBe(1); // the refusal wrote nothing

    // Nothing is on file for Beppe, so the same page asks for the two fields
    // and they ride along with the press.
    const pressed = await pressNamesLink(beppe, refused.result.human_action, {
      firstName: 'Beppe',
      locality: 'Trastevere',
    });
    expect(pressed.asked, 'the page should ask for the two fields').toBe(true);
    expect(pressed.status).toBe(200);
    expect(pressed.body).toContain('Both of you have said yes');
    expect(await optinCount(matchId)).toBe(2);
    expect(await readSharedProfilePage(beppe.jar)).toEqual({
      firstName: 'Beppe',
      locality: 'Trastevere',
    });

    // The press is what the agent hears about, on its next look.
    const sweep = await mcpCall(beppe.accessToken, 'check_in', { intro_id: matchId, step: 'names' });
    expect(sweep.isError).toBe(false);
    expect(sweep.result.optin.both_recorded).toBe(true);
  });

  it('the press is recorded as the human\'s own, never as the agent\'s word', async () => {
    const via = await dbExec(
      `SELECT DISTINCT recorded_via FROM consent_tokens
       WHERE match_id = :m::uuid AND kind = 'stage3-optin'`,
      [{ name: 'm', value: matchId }],
    );
    expect(via.map((r: any[]) => r[0])).toEqual(['counter']);
  });

  it('the stage-3 fetch now returns a conformant match.mutual to each side', async () => {
    const toAna = await mcpCall(ana.accessToken, 'check_in', { intro_id: matchId, step: 'names' });
    expect(toAna.isError).toBe(false);
    expect(toAna.result.kind).toBe('intro.mutual');
    expect(toAna.result.counterparty).toEqual({ first_name: 'Beppe', locality: 'Trastevere' });
    expect(toAna.result.optin.both_recorded).toBe(true);

    const toBeppe = await mcpCall(beppe.accessToken, 'check_in', {
      intro_id: matchId,
      step: 'names',
    });
    expect(toBeppe.isError).toBe(false);
    expect(toBeppe.result.counterparty).toEqual({ first_name: 'Ana', locality: 'Fremantle' });
  });

  it('the sweep carries the mutual payload too, and flags nothing as blocked', async () => {
    const all = await mcpCall(ana.accessToken, 'check_in', {});
    const entry = all.result.introductions.find((m: any) => m.intro_id === matchId);
    expect(entry.mutual.counterparty.first_name).toBe('Beppe');
    expect(entry.mutual_blocked).toBeUndefined();
    // The entry speaks in the action word, never a stage integer.
    expect(entry.stage_unlocked).toBeUndefined();
    expect(entry.next).toBe('ready_to_talk');
  });

  it('the profile pages stay human-only: an agent bearer token is refused', async () => {
    const { COUNTER_URL } = await import('./helpers.js');
    for (const [method, path] of [
      ['GET', '/profile'],
      ['POST', '/profile'],
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
