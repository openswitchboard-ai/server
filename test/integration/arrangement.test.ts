/**
 * The standing arrangement against a LIVE deployment.
 *
 * The claim under test is the whole reason the arrangement lives on the
 * network rather than in an agent's own memory: what one agent agrees with a
 * human is handed to the NEXT agent, on a connection that shares nothing with
 * the first but the account behind it. So the harness sets an arrangement over
 * one access token, mints a second token through a fresh OAuth flow, and reads
 * the arrangement back off that connection's first check_matches sweep.
 *
 * Also proved here against the real service: the validator refuses contact
 * details, the human's own page shows the arrangement in plain words and can
 * clear it, and an agent bearer token is turned away from that page.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  COUNTER_URL,
  TestActor,
  bootstrapActor,
  counterFetch,
  mcpCall,
  oauthFlow,
} from './helpers.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const d = RUN ? describe : describe.skip;

let ada: TestActor;

const ARRANGEMENT = {
  check_cadence: 'twice a day',
  interrupt_for: ['a new match', 'anything waiting on my approval page'],
  summarize: 'a round-up on Sunday evening',
  suggestion_appetite: 'occasional',
  quiet_hours: 'after 9pm and before 7am',
};

const form = (o: Record<string, string>) => ({
  method: 'POST' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(o).toString(),
});

d('standing arrangement against live deployment', () => {
  beforeAll(async () => {
    ada = await bootstrapActor('Ada', 'Fremantle');
  }, 300_000);

  it('starts empty, and the sweep says so', async () => {
    const got = await mcpCall(ada.accessToken, 'standing_arrangement', { action: 'get' });
    expect(got.isError).toBe(false);
    expect(got.result.arrangement).toEqual({});
    const sweep = await mcpCall(ada.accessToken, 'check_matches', {});
    expect(sweep.result.arrangement).toEqual({});
    expect(sweep.result.arrangement_note.text).toMatch(/no standing arrangement/i);
  });

  it('sets and reads back the whole object', async () => {
    const set = await mcpCall(ada.accessToken, 'standing_arrangement', {
      action: 'set',
      arrangement: ARRANGEMENT,
    });
    expect(set.isError).toBe(false);
    expect(set.result.arrangement).toEqual(ARRANGEMENT);
    const got = await mcpCall(ada.accessToken, 'standing_arrangement', { action: 'get' });
    expect(got.result.arrangement).toEqual(ARRANGEMENT);
  });

  it('THE GUARANTEE: a second connection on a fresh token is handed it by check_matches', async () => {
    // A brand-new OAuth client, a brand-new token: nothing carries over from
    // the connection that saved the arrangement.
    const secondToken = await oauthFlow(ada.jar);
    expect(secondToken).not.toBe(ada.accessToken);
    const sweep = await mcpCall(secondToken, 'check_matches', {});
    expect(sweep.isError).toBe(false);
    expect(sweep.result.arrangement).toEqual(ARRANGEMENT);
    expect(sweep.result.arrangement_note.provenance).toBe('switchboard-system');
  });

  it('refuses anything shaped like a way to reach someone', async () => {
    const bad = await mcpCall(ada.accessToken, 'standing_arrangement', {
      action: 'set',
      arrangement: { notes: 'ring me on 0412 345 678' },
    });
    expect(bad.isError).toBe(true);
    // The refused write changed nothing.
    const got = await mcpCall(ada.accessToken, 'standing_arrangement', { action: 'get' });
    expect(got.result.arrangement).toEqual(ARRANGEMENT);
  });

  it('the human sees it in plain words on their approval page', async () => {
    const res = await counterFetch(ada.jar, '/counter/arrangement');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('How your agents behave');
    expect(body).toContain('twice a day');
    expect(body).toContain('anything waiting on my approval page');
  });

  it('an agent bearer token is turned away from that page', async () => {
    const res = await fetch(`${COUNTER_URL}/counter/arrangement`, {
      headers: { authorization: `Bearer ${ada.accessToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('the human can change it, and the agent sees the change on its next sweep', async () => {
    const res = await counterFetch(
      ada.jar,
      '/counter/arrangement',
      form({
        check_cadence: 'once a week',
        interrupt_for: 'a new match',
        summarize: '',
        quiet_hours: '',
        suggestion_appetite: 'never',
        notes: '',
      }),
    );
    expect(res.status).toBe(200);
    const sweep = await mcpCall(ada.accessToken, 'check_matches', {});
    expect(sweep.result.arrangement).toEqual({
      check_cadence: 'once a week',
      interrupt_for: ['a new match'],
      suggestion_appetite: 'never',
    });
  });

  it('the human can clear it, and the agent is told to ask again', async () => {
    const res = await counterFetch(ada.jar, '/counter/arrangement/clear', form({}));
    expect(res.status).toBe(200);
    const sweep = await mcpCall(ada.accessToken, 'check_matches', {});
    expect(sweep.result.arrangement).toEqual({});
    expect(sweep.result.arrangement_note.text).toMatch(/no standing arrangement/i);
  });
});
