/**
 * The patch-through transport against a LIVE deployment, with two actors who
 * arrive the way real people do. Run with:
 *   AWS_PROFILE=openswitchboard npm run test:integration
 *
 * The whole path in one go: post -> match -> interest both ways -> profiles
 * and opt-ins both ways -> open_channel -> a message each way -> both sides
 * collect -> the rows are gone. What this proves against the real service, the
 * real database and real KMS, rather than against a stand-in:
 *
 *  - a channel opens only for its two parties, and a third account is told
 *    nothing beyond "not found";
 *  - a message really is stored encrypted, and the stored bytes contain
 *    nothing of what was said;
 *  - collecting a message DELETES it: the row count for the channel goes to
 *    zero, a second collection comes back empty, and nobody can read it twice;
 *  - what comes back is a conformant channel.message labelled as the other
 *    side's words;
 *  - check_matches says how many messages are waiting without handing any of
 *    them over;
 *  - the size cap holds.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { validatePayload } from '../../src/protocol.js';
import {
  TestActor,
  approveDisclosure,
  dbExec,
  mcpCall,
  mcpRpc,
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

let ana: TestActor; // WANT side
let beppe: TestActor; // HAVE side
let onlooker: TestActor; // a party to nothing
let matchId: string;
let channelId: string;

const rowsOnChannel = async (): Promise<number> =>
  Number(
    (
      await dbExec(
        'SELECT count(*) FROM channel_messages WHERE channel_id = :c',
        [{ name: 'c', value: channelId }],
      )
    )[0][0],
  );

d('a conversation carried across an open channel', () => {
  beforeAll(async () => {
    [ana, beppe, onlooker] = await Promise.all([
      registerActor(),
      registerActor(),
      registerActor(),
    ]);

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
      score: 0.88,
    });
    matchId = await poll(async () => {
      const r = await mcpCall(ana.accessToken, 'check_matches', { intent_id: w.result.intent_id });
      return r.result.matches?.[0]?.match_id as string | undefined;
    }, 'match to appear');

    await mcpCall(ana.accessToken, 'respond', { match_id: matchId, action: 'express_interest' });
    await mcpCall(beppe.accessToken, 'respond', { match_id: matchId, action: 'express_interest' });

    // Each human puts their first name and area on their own page, then their
    // agent may record the opt-in.
    expect((await setSharedProfile(ana.jar, 'Ana', 'Fremantle')).status).toBe(200);
    expect((await setSharedProfile(beppe.jar, 'Beppe', 'Trastevere')).status).toBe(200);
    await approveDisclosure(ana.jar, matchId, ana.pin);
    const optin = await mcpCall(beppe.accessToken, 'respond', {
      match_id: matchId,
      action: 'opt_in',
    });
    expect(optin.isError).toBe(false);
    expect(optin.result.both_recorded).toBe(true);
  }, 300_000);

  it('opens the channel for each side, on the same channel id', async () => {
    const forAna = await mcpCall(ana.accessToken, 'open_conversation', { match_id: matchId });
    expect(forAna.isError).toBe(false);
    expect(forAna.result.kind).toBe('conversation.open');
    channelId = forAna.result.conversation.conversation_id;

    const forBeppe = await mcpCall(beppe.accessToken, 'open_conversation', { match_id: matchId });
    expect(forBeppe.result.conversation.conversation_id).toBe(channelId);
  });

  // The waiting-message nudge closes the conversational deadlock: a message
  // that lands is otherwise carried in silence, and a passive recipient never
  // learns it is there. channel_send enqueues one nudge for the recipient's
  // human through the ops queue, which the ops worker turns into one email —
  // and the throttle holds a rapid second message to no further nudge.
  const channelWaitingSends = async (): Promise<any[][]> =>
    dbExec(
      `SELECT dedupe_key, status FROM email_sends
       WHERE account_id = :a::uuid AND template = 'channel-waiting'
       ORDER BY created_at`,
      [{ name: 'a', value: beppe.accountId }],
    );

  it('nudges the waiting side once, and holds the throttle on a rapid second message', async () => {
    // First message to beppe on an empty inbox: exactly one nudge is enqueued
    // and the ops worker sends it (a simulator address, so SES accepts it).
    const first = await mcpCall(ana.accessToken, 'send_message', {
      match_id: matchId,
      text: 'Are you about this week?',
    });
    expect(first.isError).toBe(false);
    const sends = await poll(
      async () => {
        const rows = await channelWaitingSends();
        return rows.length >= 1 ? rows : undefined;
      },
      'the waiting-message nudge to be sent to the recipient',
    );
    expect(sends).toHaveLength(1);
    expect(['sent', 'sandbox-rejected']).toContain(sends[0][1]);

    // A rapid second message, still unread by beppe: the throttle suppresses a
    // second nudge at send time, so no further ops job and no second email.
    const second = await mcpCall(ana.accessToken, 'send_message', {
      match_id: matchId,
      text: 'No rush at all.',
    });
    expect(second.isError).toBe(false);
    await new Promise((r) => setTimeout(r, 4000)); // give the ops worker a beat
    expect(await channelWaitingSends()).toHaveLength(1);

    // Leave the channel as we found it, so the later collection tests start
    // from an empty channel.
    await mcpCall(beppe.accessToken, 'collect_messages', { match_id: matchId });
    expect(await rowsOnChannel()).toBe(0);
  });

  it('gives the channel a key of its own the moment it opens', async () => {
    const rows = await dbExec(
      'SELECT channel_key_enc IS NOT NULL FROM matches WHERE id = :m::uuid',
      [{ name: 'm', value: matchId }],
    );
    expect(rows[0][0]).toBe(true);
  });

  it('turns away an account that is not one of the two', async () => {
    const send = await mcpCall(onlooker.accessToken, 'send_message', {
      match_id: matchId,
      text: 'hello?',
    });
    expect(send.isError).toBe(true);
    expect(JSON.stringify(send.result)).toContain('not found');
    const receive = await mcpCall(onlooker.accessToken, 'collect_messages', { match_id: matchId });
    expect(receive.isError).toBe(true);
    expect(await rowsOnChannel()).toBe(0);
  });

  it('carries a message from each side', async () => {
    const fromAna = await mcpCall(ana.accessToken, 'send_message', {
      match_id: matchId,
      text: 'Is Saturday morning any good? I can come to you.',
    });
    expect(fromAna.isError).toBe(false);
    expect(fromAna.result.conversation_id).toBe(channelId);
    expect(fromAna.result.message_id).toMatch(/^[0-9a-f-]{36}$/);

    const fromBeppe = await mcpCall(beppe.accessToken, 'send_message', {
      match_id: matchId,
      text: 'Saturday works. I am near the markets, anywhere around there is fine.',
    });
    expect(fromBeppe.isError).toBe(false);
    expect(await rowsOnChannel()).toBe(2);
  });

  it('stores what it holds encrypted, with nothing of the words in the row', async () => {
    const rows = await dbExec(
      `SELECT encode(body_enc, 'escape') FROM channel_messages WHERE channel_id = :c`,
      [{ name: 'c', value: channelId }],
    );
    expect(rows).toHaveLength(2);
    for (const [stored] of rows) {
      expect(String(stored)).not.toContain('Saturday');
      expect(String(stored)).not.toContain('markets');
    }
  });

  it('says how many messages are waiting without handing any over', async () => {
    const r = await mcpCall(ana.accessToken, 'check_matches', {});
    const entry = r.result.matches.find((m: any) => m.match_id === matchId);
    // The channel is open, so the action word is ready_to_talk — no stage int.
    expect(entry.stage_unlocked).toBeUndefined();
    expect(entry.next).toBe('ready_to_talk');
    expect(entry.conversation.conversation_id).toBe(channelId);
    expect(entry.conversation.messages_waiting).toBe(1);
    expect(entry.conversation.note.provenance).toBe('switchboard-system');
    expect(await rowsOnChannel()).toBe(2);
  });

  it('hands each side the other side words, labelled as such', async () => {
    const toAna = await mcpCall(ana.accessToken, 'collect_messages', { match_id: matchId });
    expect(toAna.isError).toBe(false);
    expect(toAna.result.messages).toHaveLength(1);
    const msg = toAna.result.messages[0];
    expect(msg.kind).toBe('conversation.message');
    expect(msg.conversation_id).toBe(channelId);
    expect(msg.body.text).toContain('markets');
    expect(msg.body.provenance).toBe('counterparty-untrusted');
    expect(validatePayload('conversation.message', msg).reasons.join('; ')).toBe('');
    expect(toAna.result.more_waiting).toBe(false);

    const toBeppe = await mcpCall(beppe.accessToken, 'collect_messages', { match_id: matchId });
    expect(toBeppe.result.messages[0].body.text).toContain('Saturday morning');
  });

  it('has nothing left once both sides have collected', async () => {
    expect(await rowsOnChannel()).toBe(0);
  });

  it('cannot hand the same message over twice', async () => {
    const again = await mcpCall(ana.accessToken, 'collect_messages', { match_id: matchId });
    expect(again.isError).toBe(false);
    expect(again.result.messages).toEqual([]);
    expect(again.result.more_waiting).toBe(false);

    const summary = await mcpCall(ana.accessToken, 'check_matches', {});
    const entry = summary.result.matches.find((m: any) => m.match_id === matchId);
    expect(entry.conversation.messages_waiting).toBe(0);
    expect(entry.conversation.note).toBeUndefined();
  });

  it('carries a message at the ceiling and refuses one past it', async () => {
    const atCap = await mcpCall(ana.accessToken, 'send_message', {
      match_id: matchId,
      text: 'x'.repeat(4000),
    });
    expect(atCap.isError).toBe(false);
    const past = await mcpCall(ana.accessToken, 'send_message', {
      match_id: matchId,
      text: 'x'.repeat(4001),
    });
    expect(past.isError).toBe(true);
    // Exactly one row landed: the one at the ceiling.
    expect(await rowsOnChannel()).toBe(1);
    await mcpCall(beppe.accessToken, 'collect_messages', { match_id: matchId });
    expect(await rowsOnChannel()).toBe(0);
  });

  it('offers both channel tools on the live surface, and tells an agent what they cost', async () => {
    const r = await mcpRpc(ana.accessToken, 'tools/list', {});
    const tools: any[] = r.result.tools;
    const send = tools.find((t) => t.name === 'send_message');
    const receive = tools.find((t) => t.name === 'collect_messages');
    expect(send).toBeTruthy();
    expect(receive.description).toMatch(/DELETES IT/);
    expect(receive.description).toMatch(/counterparty-untrusted/);
  });
});
