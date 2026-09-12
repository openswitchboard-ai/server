/**
 * The standing arrangement against a LIVE deployment.
 *
 * The claim under test is the whole reason the arrangement lives on the
 * network rather than in an agent's own memory: what one agent agrees with a
 * human is handed to the NEXT agent, on a connection that shares nothing with
 * the first but the account behind it. So the harness sets an arrangement over
 * one access token, mints a second token through a fresh OAuth flow, and reads
 * the arrangement back off that connection's first check_in sweep.
 *
 * Also proved here against the real service: the validator refuses contact
 * details, a checking cadence is refused unless the agent has said it runs
 * between conversations, saving both moves the account over to hearing its
 * news through the assistant, the human's own page shows the arrangement in
 * plain words and can clear it, and an agent bearer token is turned away from
 * that page.
 *
 * The sweep carries more beside the arrangement than it used to (how this
 * human hears, whether this agent runs on its own, their clock, and a sentence
 * for each), so nothing here pins the exact set of keys check_in returns; the
 * fields this file is about are read one by one.
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

// A cadence is only accepted from an agent that has said it runs between
// conversations, so the arrangement this suite saves says both.
const ARRANGEMENT = {
  runs_on_its_own: true,
  check_every_minutes: 720,
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
    const sweep = await mcpCall(ada.accessToken, 'check_in', {});
    expect(sweep.result.arrangement).toEqual({});
    expect(sweep.result.arrangement_note.text).toMatch(/has not saved any standing preferences/i);
    // Where a fresh account starts: nobody has said an agent runs between
    // conversations, so the switchboard is the one that emails this human.
    expect(sweep.result.runs_on_its_own).toBe(false);
    expect(sweep.result.hears_via).toBe('email');
  });

  it('sets and reads back the whole object, and the agent becomes the messenger', async () => {
    const set = await mcpCall(ada.accessToken, 'standing_arrangement', {
      action: 'set',
      arrangement: ARRANGEMENT,
    });
    expect(set.isError).toBe(false);
    expect(set.result.arrangement).toEqual(ARRANGEMENT);
    // Runs on its own AND keeps a cadence, so this account now hears its news
    // through the agent, and the saving says so.
    expect(set.result.note.text).toContain('you are the one who brings them the news');
    const got = await mcpCall(ada.accessToken, 'standing_arrangement', { action: 'get' });
    expect(got.result.arrangement).toEqual(ARRANGEMENT);
  });

  it('THE GUARANTEE: a second connection on a fresh token is handed it by check_in', async () => {
    // A brand-new OAuth client, a brand-new token: nothing carries over from
    // the connection that saved the arrangement.
    const secondToken = await oauthFlow(ada.jar);
    expect(secondToken).not.toBe(ada.accessToken);
    const sweep = await mcpCall(secondToken, 'check_in', {});
    expect(sweep.isError).toBe(false);
    expect(sweep.result.arrangement).toEqual(ARRANGEMENT);
    expect(sweep.result.arrangement_note.provenance).toBe('switchboard-system');
    expect(sweep.result.arrangement_note.text).toContain('every 12 hours');
    // The rest of what the first connection settled travels with it: this
    // agent runs on its own, and this human hears through it.
    expect(sweep.result.runs_on_its_own).toBe(true);
    expect(sweep.result.hears_via).toBe('assistant');
    expect(sweep.result.runs_on_its_own_note.provenance).toBe('switchboard-system');
    expect(sweep.result.hears_via_note.provenance).toBe('switchboard-system');
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
    const res = await counterFetch(ada.jar, '/arrangement');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('How your agents behave');
    expect(body).toContain('It runs on its own and brings you the news.');
    expect(body).toContain('every 12 hours');
    expect(body).toContain('anything waiting on my approval page');
  });

  it('an agent bearer token is turned away from that page', async () => {
    const res = await fetch(`${COUNTER_URL}/arrangement`, {
      headers: { authorization: `Bearer ${ada.accessToken}` },
    });
    expect(res.status).toBe(403);
  });

  it('the human can change it, and the agent sees the change on its next sweep', async () => {
    const res = await counterFetch(
      ada.jar,
      '/arrangement',
      form({
        // The tick box on the page is the same fact as runs_on_its_own on the
        // wire, and the cadence box needs it here too.
        runs_on_its_own: 'on',
        check_every_minutes: '10080',
        interrupt_for: 'a new match',
        summarize: '',
        quiet_hours: '',
        suggestion_appetite: 'never',
        notes: '',
      }),
    );
    expect(res.status).toBe(200);
    const sweep = await mcpCall(ada.accessToken, 'check_in', {});
    expect(sweep.result.arrangement).toEqual({
      runs_on_its_own: true,
      check_every_minutes: 10080,
      interrupt_for: ['a new match'],
      suggestion_appetite: 'never',
    });
  });

  it('a cadence from an agent that does not run on its own is refused, on both surfaces', async () => {
    const said = 'A checking cadence is for an agent that runs between conversations.';
    const bad = await mcpCall(ada.accessToken, 'standing_arrangement', {
      action: 'set',
      arrangement: { check_every_minutes: 720, interrupt_for: ['a new match'] },
    });
    expect(bad.isError).toBe(true);
    expect(bad.result.message).toContain(said);
    // It is a thing to say to a person, so it comes back as one.
    expect(bad.result.human_action).toContain(said);
    const res = await counterFetch(
      ada.jar,
      '/arrangement',
      form({
        check_every_minutes: '720',
        interrupt_for: '',
        summarize: '',
        quiet_hours: '',
        suggestion_appetite: '',
        notes: '',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(said);
  });

  it('a cadence oftener than every 30 minutes is refused, and the floor is named', async () => {
    const bad = await mcpCall(ada.accessToken, 'standing_arrangement', {
      action: 'set',
      arrangement: { ...ARRANGEMENT, check_every_minutes: 5 },
    });
    expect(bad.isError).toBe(true);
    expect(bad.result.message).toContain('No more often than every 30 minutes');
  });

  it('the page refuses it too, in the same sentence', async () => {
    const res = await counterFetch(
      ada.jar,
      '/arrangement',
      form({
        runs_on_its_own: 'on',
        check_every_minutes: '5',
        interrupt_for: '',
        summarize: '',
        quiet_hours: '',
        suggestion_appetite: '',
        notes: '',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('No more often than every 30 minutes');
  });

  it('the human can clear it, and the agent is told to ask again', async () => {
    const res = await counterFetch(ada.jar, '/arrangement/clear', form({}));
    expect(res.status).toBe(200);
    const sweep = await mcpCall(ada.accessToken, 'check_in', {});
    expect(sweep.result.arrangement).toEqual({});
    expect(sweep.result.arrangement_note.text).toMatch(/has not saved any standing preferences/i);
    expect(sweep.result.runs_on_its_own).toBe(false);
    // Clearing the arrangement does not put this human back on email. Which
    // way they hear is their own call, on their own page.
    expect(sweep.result.hears_via).toBe('assistant');
  });
});
