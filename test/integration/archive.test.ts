/**
 * Archiving a finished connection against a LIVE deployment. Run with:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * Two registered accounts are driven all the way to a talking, stage-4 match
 * — publish, match, mutual interest, both opt in, channel open, a message
 * sent — the state a real pair is in when they have taken things off-platform.
 * Then one side's agent archives the connection, and this suite proves against
 * the real service, DB and KMS:
 *
 *  - respond(archive) sets the match to state 'archived' and records the actor
 *    (archived_by / archived_at / archived_via) on the row;
 *  - only a party can archive — a stranger's token cannot;
 *  - it is idempotent — a second archive reports already_archived;
 *  - the live channel is torn down — channel_send and channel_receive on the
 *    archived match are refused with STAGE_LOCKED;
 *  - RETRIEVABILITY (the whole point): check_matches still returns the match,
 *    now with state 'archived', the category, the archive date, and the
 *    disclosed mutual first name + area, to each side;
 *  - an archived match is not offered as an actionable signal (no `next`, no
 *    stage-1 `signal`);
 *  - archiving the connection leaves the underlying CARD untouched (still
 *    PUBLISHED) — the card's fate is a separate human decision.
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
  registerActor,
  sendOp,
  setSharedProfile,
  waitForCardState,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

let ana: TestActor; // WANT side, the archiver
let beppe: TestActor; // HAVE side
let stranger: TestActor; // a party to nothing
let matchId: string;
let anaCardId: string;

const matchState = async (id: string): Promise<string> =>
  String(
    (
      await dbExec(`SELECT state FROM matches WHERE id = :m::uuid`, [{ name: 'm', value: id }])
    )[0][0],
  );

const archivedBy = async (id: string): Promise<string | null> => {
  const r = await dbExec(
    `SELECT archived_by::text, archived_via, archived_at IS NOT NULL
     FROM matches WHERE id = :m::uuid`,
    [{ name: 'm', value: id }],
  );
  return r[0][0] as string | null;
};

d('archiving a finished connection', () => {
  beforeAll(async () => {
    [ana, beppe, stranger] = await Promise.all([
      registerActor(),
      registerActor(),
      registerActor(),
    ]);

    const w = await mcpCall(ana.accessToken, 'publish_intent', {
      listing: minimalWant({ attributes: { condition: 'good' } }),
    });
    const h = await mcpCall(beppe.accessToken, 'publish_intent', {
      listing: minimalHave({ attributes: { condition: 'good' } }),
    });
    anaCardId = w.result.intent_id;
    await waitForCardState(ana.accessToken, w.result.intent_id, ['PUBLISHED']);
    await waitForCardState(beppe.accessToken, h.result.intent_id, ['PUBLISHED']);

    await sendOp({
      op: 'create-match',
      card_want: w.result.intent_id,
      card_have: h.result.intent_id,
      score: 0.88,
    });
    matchId = await poll(async () => {
      const r = await mcpCall(ana.accessToken, 'check_matches', { intent_id: w.result.intent_id });
      return r.result.matches?.[0]?.match_id as string | undefined;
    }, 'match to appear');

    // Both interested, both opted in (with a first name + area filled), channel
    // open, a message across it — a real pair mid-connection.
    await mcpCall(ana.accessToken, 'respond', { match_id: matchId, action: 'express_interest' });
    await mcpCall(beppe.accessToken, 'respond', { match_id: matchId, action: 'express_interest' });
    await setSharedProfile(ana.jar, 'Ana', 'Fremantle');
    await setSharedProfile(beppe.jar, 'Beppe', 'Trastevere');
    await approveDisclosure(ana.jar, matchId, ana.pin);
    await approveDisclosure(beppe.jar, matchId, beppe.pin);
    const opened = await mcpCall(ana.accessToken, 'open_conversation', { match_id: matchId });
    expect(opened.isError).toBe(false);
    await mcpCall(ana.accessToken, 'send_message', {
      match_id: matchId,
      text: 'Lovely — let us swap numbers and take it from here.',
    });
  }, 300_000);

  it('a stranger cannot archive a match they are not party to', async () => {
    const r = await mcpCall(stranger.accessToken, 'respond', {
      match_id: matchId,
      action: 'archive',
    });
    expect(r.isError).toBe(true);
    expect(await matchState(matchId)).toBe('open');
  });

  it('respond(archive) files it away and records who did it', async () => {
    const r = await mcpCall(ana.accessToken, 'respond', { match_id: matchId, action: 'archive' });
    expect(r.isError).toBe(false);
    expect(r.result.state).toBe('archived');
    expect(r.result.already_archived).toBe(false);
    expect(await matchState(matchId)).toBe('archived');
    expect(await archivedBy(matchId)).toBe(ana.accountId);
  });

  it('is idempotent — a second archive reports it already filed', async () => {
    const again = await mcpCall(beppe.accessToken, 'respond', {
      match_id: matchId,
      action: 'archive',
    });
    expect(again.isError).toBe(false);
    expect(again.result.already_archived).toBe(true);
    expect(await matchState(matchId)).toBe('archived');
  });

  it('tears down the live channel — send and receive are refused', async () => {
    const send = await mcpCall(ana.accessToken, 'send_message', {
      match_id: matchId,
      text: 'anyone still there?',
    });
    expect(send.isError).toBe(true);
    expect(send.result.code).toBe('STAGE_LOCKED');
    const recv = await mcpCall(beppe.accessToken, 'collect_messages', { match_id: matchId });
    expect(recv.isError).toBe(true);
    expect(recv.result.code).toBe('STAGE_LOCKED');
  });

  it('stays retrievable: check_matches returns it archived, with the disclosed details', async () => {
    const all = await mcpCall(ana.accessToken, 'check_matches', {});
    const entry = all.result.matches.find((m: any) => m.match_id === matchId);
    expect(entry).toBeTruthy();
    expect(entry.state).toBe('archived');
    expect(typeof entry.category).toBe('string');
    expect(typeof entry.archived_at).toBe('string');
    // The whole point: "you connected with Beppe in Trastevere" survives.
    expect(entry.mutual.counterparty).toEqual({ first_name: 'Beppe', locality: 'Trastevere' });
    // And it is never an actionable/new signal.
    expect(entry.next).toBeUndefined();
    expect(entry.signal).toBeUndefined();
  });

  it('the counterparty can look it up too', async () => {
    const all = await mcpCall(beppe.accessToken, 'check_matches', {});
    const entry = all.result.matches.find((m: any) => m.match_id === matchId);
    expect(entry.state).toBe('archived');
    expect(entry.mutual.counterparty).toEqual({ first_name: 'Ana', locality: 'Fremantle' });
  });

  it('leaves the underlying card untouched — its fate is a separate decision', async () => {
    // Archiving the connection did not withdraw the card behind it.
    await waitForCardState(ana.accessToken, anaCardId, ['PUBLISHED']);
  });
});
