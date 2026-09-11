/**
 * How a person hears about their own switchboard, and what the switchboard
 * sends because of it.
 *
 * The defect this suite exists to hold shut, from the 2026-09-09 rehearsal:
 * two humans got as far as a price and neither of them was told anything. The
 * buyer typed $415 on their approval page and the seller heard nothing. The
 * seller accepted it and the buyer heard nothing. Both sides had an assistant
 * that only wakes when it is spoken to, which is the ordinary case and the one
 * the switchboard was quietest for.
 *
 * The rule underneath: an account says how its human hears about all this.
 * 'email' means their assistant only acts when spoken to, so every match,
 * reply, figure and acceptance has to reach them by mail. 'assistant' means an
 * always-on agent brings the news and the conversational nudges stay quiet.
 * It is set from the standing arrangement (an agent that says it runs between
 * conversations AND keeps a cadence) and by the person on their own page.
 *
 * What is asserted here:
 *  - the accessor defaults to 'email' and every change is consent-logged;
 *  - a cadence is refused unless the agent has said it runs on its own, in the
 *    plain words the human hears, and saving both moves the account to
 *    'assistant'; saving runs_on_its_own on its own moves nothing;
 *  - the waiting-message nudge is skipped entirely for 'assistant' and sent on
 *    the unread gate for 'email', inside a three-minute coalescing window;
 *  - a figure a human types on their page emails the other human when that is
 *    how they hear, and stays quiet when their agent brings it;
 *  - an acceptance emails the person whose figure it was, however they hear;
 *  - the templates say the category as a person says it, and say what to do
 *    in the words Lachlan asked for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  encryptField: vi.fn(async (_a: string, _k: Buffer, plaintext: string) =>
    Buffer.from(`enc:${plaintext}`),
  ),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

// The two new sends are spied rather than rendered: what matters on this path
// is WHO is told and WHEN, and the copy itself is proved in the render suite.
vi.mock('../../src/counter/email.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendApprovalEmail: vi.fn(async () => ({ status: 'sent' })),
  sendOfferOnTheTableEmail: vi.fn(async () => ({ status: 'sent' })),
  sendDealAgreedEmail: vi.fn(async () => ({ status: 'sent' })),
}));

import { writeConsentEvent } from '../../src/crypto.js';
import { sendDealAgreedEmail, sendOfferOnTheTableEmail } from '../../src/counter/email.js';
import * as db from '../../src/db.js';
import * as accounts from '../../src/domain/accounts.js';
import * as arrangement from '../../src/domain/arrangement.js';
import * as offers from '../../src/domain/offers.js';
import {
  NUDGE_COALESCE_MINUTES,
  notifyChannelMessageWaiting,
} from '../../src/domain/channelNotify.js';
import { sqs } from '../../src/aws.js';
import { TOOLS, dispatchTool } from '../../src/mcp/tools.js';
import {
  categoryPhrase,
  offerAmountInWords,
  renderChannelWaiting,
  renderDealAgreed,
  renderOfferOnTheTable,
  renderYourMove,
  type FooterLinks,
} from '../../src/email/templates.js';
import { lintEmailCopy } from '../../src/email/lint.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  opsQueueUrl: 'https://ops.test/queue',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side (buyer)
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side (seller)
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
const CHANNEL = 'ch_11111111-2222-4333-8444-555555555555';
const OFFER = '0f0f0f0f-0000-4000-8000-000000000001';

interface World {
  hearsVia: Record<string, accounts.HearsVia>;
  arrangementStored: Record<string, unknown> | null;
  freqMatches: string;
  offers: any[];
  notify: Map<string, { last_notified_at: Date; unread_notified: boolean }>;
  clockSkewMs: number;
}
let world: World;

const nowMs = () => Date.now() + world.clockSkewMs;

const theMatch = () => ({
  id: MATCH,
  card_want: CARD_W,
  card_have: CARD_H,
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: 4,
  interest_want: true,
  interest_have: true,
  state: 'open',
  channel_id: CHANNEL,
  opened_at: new Date('2026-09-09T00:00:00Z'),
});

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });

      if (/SELECT hears_via FROM accounts/.test(sql)) {
        return rows([{ hears_via: world.hearsVia[params[0]] ?? 'email' }]);
      }
      if (/UPDATE accounts SET hears_via/.test(sql)) {
        world.hearsVia[params[0]] = params[1];
        return rows([]);
      }
      if (/SELECT arrangement FROM accounts/.test(sql)) {
        return rows([{ arrangement: world.arrangementStored }]);
      }
      if (/UPDATE accounts SET arrangement/.test(sql)) {
        world.arrangementStored = JSON.parse(params[1]);
        return rows([]);
      }
      if (/SELECT email_freq_matches, email_freq_digests FROM accounts/.test(sql)) {
        return rows([{ email_freq_matches: world.freqMatches, email_freq_digests: 'weekly' }]);
      }
      if (/UPDATE accounts SET email_freq_matches/.test(sql)) {
        world.freqMatches = 'off';
        return rows([]);
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            status: 'active',
            data_key_enc: Buffer.from('wrapped'),
            email_enc: Buffer.from(`enc:${params[0]}@example.test`),
            hears_via: world.hearsVia[params[0]] ?? 'email',
          },
        ]);
      }
      if (/FROM matches/.test(sql) && /^\s*SELECT (\*|m\.\*)/.test(sql)) return rows([theMatch()]);
      if (/SELECT account_id, type, negotiation_mode, mandate_enc FROM cards/.test(sql)) {
        return rows([
          {
            account_id: params[0] === CARD_W ? ANA : BEPPE,
            type: params[0] === CARD_W ? 'WANT' : 'HAVE',
            negotiation_mode: 'relay',
            mandate_enc: null,
          },
        ]);
      }
      // Quotas: never near a ceiling in this world.
      if (/SELECT count\(\*\)::int AS n FROM (offers|cards|publish_events)/.test(sql)) {
        return rows([{ n: 0 }]);
      }
      if (/SELECT count\(\*\)::int AS n,\s*min\(created_at\)/.test(sql)) {
        return rows([{ n: 0, oldest: new Date() }]);
      }
      if (/SELECT amount FROM offers/.test(sql)) return rows([]);
      if (/INSERT INTO cards/.test(sql)) return rows([{ id: CARD_H }]);
      if (/INSERT INTO offers/.test(sql)) {
        const row = {
          id: OFFER,
          match_id: params[0],
          proposer_account: params[1],
          amount: String(params[2]),
          ccy: params[3],
          expiry: new Date(params[4]),
          state: 'proposed',
          message: params[5] ? JSON.parse(params[5]) : null,
          authored_by: params[6],
          created_at: new Date(),
        };
        world.offers.push(row);
        return rows([row]);
      }
      if (/SELECT \* FROM offers WHERE id/.test(sql)) {
        return rows(world.offers.filter((o) => o.id === params[0]));
      }
      if (/UPDATE offers SET state='accepted-by-human'/.test(sql)) {
        const o = world.offers.find((x) => x.id === params[0]);
        if (o) o.state = 'accepted-by-human';
        return rows(o ? [o] : []);
      }
      if (/FROM cards\s*$|SELECT \* FROM cards WHERE id/.test(sql)) {
        return rows([{ id: params[0], account_id: ANA, collect_until: null }]);
      }
      // No open collection window on anybody's listing here.
      if (/collect_until > now\(\)/.test(sql)) return rows([]);
      // The waiting-message throttle: the two gates, as the real upsert runs.
      if (/INSERT INTO channel_notify/.test(sql)) {
        const key = `${params[0]}|${params[1]}`;
        const windowMs = Number(params[2]) * 60_000;
        const existing = world.notify.get(key);
        const now = new Date(nowMs());
        if (!existing) {
          world.notify.set(key, { last_notified_at: now, unread_notified: true });
          return rows([{ last_notified_at: now }]);
        }
        if (!existing.unread_notified && existing.last_notified_at.getTime() <= nowMs() - windowMs) {
          existing.last_notified_at = now;
          existing.unread_notified = true;
          return rows([{ last_notified_at: now }]);
        }
        return rows([]);
      }
      if (/read_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = {
    hearsVia: {},
    arrangementStored: null,
    freqMatches: 'immediate',
    offers: [],
    notify: new Map(),
    clockSkewMs: 0,
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
  vi.spyOn(sqs, 'send').mockReset().mockResolvedValue({} as any);
  vi.mocked(writeConsentEvent).mockClear();
  vi.mocked(sendOfferOnTheTableEmail).mockClear();
  vi.mocked(sendDealAgreedEmail).mockClear();
});

/** The channel-nudge ops messages enqueued so far. */
const nudges = () =>
  vi
    .mocked(sqs.send)
    .mock.calls.map((c: any[]) => {
      try {
        return JSON.parse(c[0].input.MessageBody);
      } catch {
        return {};
      }
    })
    .filter((b: any) => b.op === 'channel-nudge');

// ---------------------------------------------------------------------------
describe('the account says how its human hears', () => {
  it('defaults to email, which is the answer that tells somebody rather than nobody', async () => {
    expect(await accounts.getHearsVia(ANA)).toBe('email');
  });

  it('reads back what was set', async () => {
    await accounts.setHearsVia(ANA, 'assistant', 'counter');
    expect(await accounts.getHearsVia(ANA)).toBe('assistant');
    await accounts.setHearsVia(ANA, 'email', 'counter');
    expect(await accounts.getHearsVia(ANA)).toBe('email');
  });

  it('writes a consent event before the change, naming the new value', async () => {
    await accounts.setHearsVia(ANA, 'assistant', 'counter');
    const event: any = vi
      .mocked(writeConsentEvent)
      .mock.calls.map((c) => c[0] as any)
      .find((e) => e.event === 'hears-via-changed');
    expect(event).toMatchObject({
      event: 'hears-via-changed',
      account_id: ANA,
      hears_via: 'assistant',
      recorded_via: 'counter',
    });
  });

  it('refuses a value that is not one of the two', async () => {
    await expect(accounts.setHearsVia(ANA, 'carrier-pigeon' as any)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('a cadence belongs to an agent that runs between conversations', () => {
  it('refuses a cadence on its own, in the words the human hears', () => {
    const r = arrangement.validateArrangement({ check_every_minutes: 720 });
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) {
      expect(r.error).toBe(arrangement.CADENCE_NEEDS_RUNS_ON_ITS_OWN);
      expect(r.human_action).toBe(arrangement.CADENCE_NEEDS_RUNS_ON_ITS_OWN);
      expect(r.error).toContain('runs between conversations');
      expect(r.error).toContain('the switchboard will email them instead');
    }
  });

  it('refuses it just as firmly when the agent says it does NOT run on its own', () => {
    expect(
      arrangement.validateArrangement({ runs_on_its_own: false, check_every_minutes: 720 }),
    ).toMatchObject({ ok: false });
  });

  it('takes the pair', () => {
    expect(
      arrangement.validateArrangement({ runs_on_its_own: true, check_every_minutes: 720 }),
    ).toEqual({ ok: true, value: { runs_on_its_own: true, check_every_minutes: 720 } });
  });

  it('takes runs_on_its_own with no cadence at all', () => {
    expect(arrangement.validateArrangement({ runs_on_its_own: true })).toEqual({
      ok: true,
      value: { runs_on_its_own: true },
    });
  });

  it('treats false, absent and empty as the same answer, and stores none of them', () => {
    for (const value of [false, '', 'false', 'off', undefined]) {
      const r = arrangement.validateArrangement({ runs_on_its_own: value });
      expect(r, String(value)).toEqual({ ok: true, value: {} });
    }
  });

  it('the refusal reaches the agent as a human_action it can relay', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'standing_arrangement', {
      action: 'set',
      arrangement: { check_every_minutes: 720 },
    });
    expect(r.isError).toBe(true);
    const said = JSON.parse(r.content[0].text);
    expect(said.human_action).toBe(arrangement.CADENCE_NEEDS_RUNS_ON_ITS_OWN);
    // Nothing was written on a refusal.
    expect(world.arrangementStored).toBeNull();
  });

  it('the tool schema offers the field and ties the cadence to it', () => {
    const t = TOOLS.find((x) => x.name === 'standing_arrangement')!;
    const props = t.inputSchema.properties.arrangement.properties;
    expect(props.runs_on_its_own.type).toBe('boolean');
    expect(props.check_every_minutes.description).toMatch(/runs_on_its_own/);
    expect(t.description).toMatch(/runs_on_its_own/);
  });

  it('the manual says which sort of agent to say you are', () => {
    expect(SERVER_INSTRUCTIONS).toContain('runs_on_its_own');
    expect(SERVER_INSTRUCTIONS).toMatch(/refused, because a schedule nobody keeps/i);
  });
});

// ---------------------------------------------------------------------------
describe('saving the arrangement moves how they hear', () => {
  it('an agent that runs on its own and checks on a schedule becomes the messenger', async () => {
    const saved = await arrangement.saveArrangement(
      ANA,
      { runs_on_its_own: true, check_every_minutes: 720 },
      'agent-attested',
    );
    expect(saved.hearsViaAssistant).toBe(true);
    expect(await accounts.getHearsVia(ANA)).toBe('assistant');
    // The existing behaviour is kept: the match emails go quiet too.
    expect(saved.matchEmailsTurnedOff).toBe(true);
    expect(world.freqMatches).toBe('off');
  });

  it('runs_on_its_own without a cadence touches nothing', async () => {
    const saved = await arrangement.saveArrangement(ANA, { runs_on_its_own: true }, 'counter');
    expect(saved.hearsViaAssistant).toBe(false);
    expect(await accounts.getHearsVia(ANA)).toBe('email');
    expect(world.freqMatches).toBe('immediate');
  });

  it('saving anything else leaves an assistant-hearing account where it is', async () => {
    world.hearsVia[ANA] = 'assistant';
    await arrangement.saveArrangement(ANA, { quiet_hours: 'after 9pm' }, 'counter');
    expect(await accounts.getHearsVia(ANA)).toBe('assistant');
  });

  it('the agent is told it is the messenger now', async () => {
    const r: any = await dispatchTool(cfg, ANA, 'standing_arrangement', {
      action: 'set',
      arrangement: { runs_on_its_own: true, check_every_minutes: 720 },
    });
    expect(r.structuredContent.note.text).toMatch(/you are the one who brings them the news/i);
  });
});

// ---------------------------------------------------------------------------
describe('the waiting-message nudge follows how they hear', () => {
  const nudge = () =>
    notifyChannelMessageWaiting(cfg, {
      channelId: CHANNEL,
      matchId: MATCH,
      recipientAccount: BEPPE,
    });

  it('nudges a human whose assistant only wakes when they speak to it', async () => {
    await nudge();
    expect(nudges()).toHaveLength(1);
  });

  it('sends nothing at all when their agent brings them the news', async () => {
    world.hearsVia[BEPPE] = 'assistant';
    await nudge();
    expect(nudges()).toHaveLength(0);
    // The throttle row is never even touched, so switching back to email
    // leaves the next arrival eligible rather than serving out a throttle.
    expect(world.notify.size).toBe(0);
  });

  it('coalesces a burst into one, and lets the next one through three minutes later', async () => {
    await nudge();
    await nudge();
    expect(nudges()).toHaveLength(1);
    // The recipient collects; the row re-arms but the window still holds.
    world.notify.get(`${CHANNEL}|${BEPPE}`)!.unread_notified = false;
    await nudge();
    expect(nudges()).toHaveLength(1);
    world.notify.get(`${CHANNEL}|${BEPPE}`)!.unread_notified = false;
    world.clockSkewMs = (NUDGE_COALESCE_MINUTES + 1) * 60_000;
    await nudge();
    expect(nudges()).toHaveLength(2);
  });

  it('the window is three minutes, and no longer an hour', () => {
    expect(NUDGE_COALESCE_MINUTES).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('a figure a human types on their page reaches the other human', () => {
  const propose = (author: 'human' | 'agent') =>
    offers.proposeOffer(
      cfg,
      ANA,
      {
        match_id: MATCH,
        amount: 415,
        ccy: 'AUD',
        expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        message: 'can collect Saturday',
      },
      { author },
    );

  it('emails the other human when email is how they hear', async () => {
    await propose('human');
    expect(vi.mocked(sendOfferOnTheTableEmail)).toHaveBeenCalledTimes(1);
    const [, to, accountId, input] = vi.mocked(sendOfferOnTheTableEmail).mock.calls[0] as any[];
    expect(accountId).toBe(BEPPE); // the other side, never the person who typed it
    expect(to).toContain(BEPPE);
    expect(input).toMatchObject({ amount: 415, ccy: 'AUD', matchId: MATCH });
  });

  it('stays quiet when the other side has an agent that brings it', async () => {
    world.hearsVia[BEPPE] = 'assistant';
    await propose('human');
    expect(vi.mocked(sendOfferOnTheTableEmail)).not.toHaveBeenCalled();
  });

  it('says nothing extra for a figure an agent sent inside a mandate', async () => {
    // The park-for-the-human path already mails; this one must not double up.
    await propose('agent').catch(() => {});
    expect(vi.mocked(sendOfferOnTheTableEmail)).not.toHaveBeenCalled();
  });

  it('a send that fails leaves the offer standing', async () => {
    vi.mocked(sendOfferOnTheTableEmail).mockRejectedValueOnce(new Error('SES down'));
    const o: any = await propose('human');
    expect(o.amount).toBe(415);
    expect(world.offers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('an acceptance reaches the person whose figure it was', () => {
  beforeEach(async () => {
    await offers.proposeOffer(
      cfg,
      ANA,
      {
        match_id: MATCH,
        amount: 415,
        ccy: 'AUD',
        expiry: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
      { author: 'human' },
    );
    vi.mocked(sendDealAgreedEmail).mockClear();
  });

  // The call site tells the pipeline to send whichever way they hear; the
  // pipeline itself holds a notice back when their assistant brings the news
  // (see noticeGate.test.ts). This asserts the call site.
  it('always tells the proposer, whichever way they hear about all this', async () => {
    for (const how of ['email', 'assistant'] as const) {
      vi.mocked(sendDealAgreedEmail).mockClear();
      world.hearsVia[ANA] = how;
      world.offers[0].state = 'proposed';
      await offers.acceptOfferByHuman(OFFER, BEPPE, 'counter', cfg);
      expect(vi.mocked(sendDealAgreedEmail), how).toHaveBeenCalledTimes(1);
      const [, , accountId, input] = vi.mocked(sendDealAgreedEmail).mock.calls[0] as any[];
      expect(accountId).toBe(ANA);
      expect(input).toMatchObject({ amount: 415, ccy: 'AUD', matchId: MATCH });
    }
  });

  it('records the acceptance even when the mail fails', async () => {
    vi.mocked(sendDealAgreedEmail).mockRejectedValueOnce(new Error('SES down'));
    const o: any = await offers.acceptOfferByHuman(OFFER, BEPPE, 'counter', cfg);
    expect(o.state).toBe('accepted-by-human');
  });

  it('sends nothing when the caller has no config to send with', async () => {
    await offers.acceptOfferByHuman(OFFER, BEPPE, 'internal-ops');
    expect(vi.mocked(sendDealAgreedEmail)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('what the emails say', () => {
  const links: FooterLinks = { settingsUrl: 'https://my.test/settings' };

  it('says a category the way a person says it mid-sentence', () => {
    expect(categoryPhrase('Mountain bikes')).toBe('mountain bike');
    expect(categoryPhrase('Garden tools')).toBe('garden tool');
    expect(categoryPhrase('Fridges & freezers')).toBe('fridge');
    expect(categoryPhrase('Kettles, toasters & benchtop appliances')).toBe('kettle');
    expect(categoryPhrase('Language exchange')).toBe('language exchange');
    expect(categoryPhrase('Batteries')).toBe('battery');
    expect(categoryPhrase('Glasses')).toBe('glasses');
    expect(categoryPhrase(undefined)).toBe('');
  });

  it('says a figure the way a person writes it', () => {
    expect(offerAmountInWords(415, 'AUD')).toBe('$415 AUD');
    expect(offerAmountInWords(415.5, 'aud')).toBe('$415.50 AUD');
  });

  it('a message waiting sends them to their assistant and nowhere else', () => {
    const c = renderChannelWaiting({ categoryLabel: 'Mountain bikes', blind: false }, links);
    expect(c.text).toContain('about your mountain bike');
    expect(c.text).toContain('Ask your assistant and it will read it to you.');
    expect(c.text).not.toContain('Mountain bikes');
  });

  it('your move says the same thing in its own words', () => {
    const c = renderYourMove({ categoryLabel: 'Mountain bikes', blind: false }, links);
    expect(c.text).toContain('about your mountain bike');
    expect(c.text).toContain('Ask your assistant.');
    expect(c.text).not.toContain('Open your assistant to take the next step');
  });

  it('a number on the table names the figure, and sends them to their assistant', () => {
    const c = renderOfferOnTheTable(
      { amount: 415, ccy: 'AUD', categoryLabel: 'Mountain bikes', blind: false },
      links,
    );
    expect(c.text).toContain('$415 AUD');
    expect(c.text).toContain('for your mountain bike');
    // A notice: answering it is a word to their assistant, which hands them
    // the one-question page when it comes to that.
    expect(c.text).not.toContain('https://my.test/matches/m-1');
    expect(c.text).toContain('Ask your assistant.');
    expect(lintEmailCopy(c.text + c.html + c.subject)).toEqual([]);
  });

  it('a deal says the deal, and hands the handover back to the two people', () => {
    const c = renderDealAgreed(
      { amount: 415, ccy: 'AUD', categoryLabel: 'Mountain bikes', blind: false },
      links,
    );
    expect(c.text).toContain(
      'Deal: $415 AUD agreed for your mountain bike. Where and when to hand it over is for the two of you.',
    );
    expect(lintEmailCopy(c.text + c.html + c.subject)).toEqual([]);
  });

  it('blind mode keeps the figure and the thing out of both new emails', () => {
    const offer = renderOfferOnTheTable(
      {
        amount: 415,
        ccy: 'AUD',
        categoryLabel: 'Mountain bikes',
        blind: true,
      },
      links,
    );
    const deal = renderDealAgreed(
      { amount: 415, ccy: 'AUD', categoryLabel: 'Mountain bikes', blind: true },
      links,
    );
    for (const c of [offer, deal]) {
      const all = c.subject + c.text + c.html;
      expect(all).not.toContain('415');
      expect(all).not.toContain('bike');
      expect(all).not.toContain('/matches/m-1');
    }
  });
});

// ---------------------------------------------------------------------------
describe('what an agent is told right after posting', () => {
  const publish = () =>
    dispatchTool(cfg, ANA, 'publish_intent', {
      listing: {
        schema_version: '0.12.0',
        type: 'offering',
        category: 'goods.bicycle.mountain',
        geo: { place: 'Canberra' },
        urgency: 'days',
        visibility: 'anonymous-until-introduced',
        status: 'active',
        ttl_days: 30,
      },
    });

  it('tells an email-hearing human to ask again in a minute, and that mail will come', async () => {
    const r: any = await publish();
    expect(r.isError, JSON.stringify(r.content?.[0]?.text)).toBeUndefined();
    expect(r.structuredContent.note.text).toBe(
      'It takes a minute or two to be matched. Ask me again then, or I will email you.',
    );
  });

  it('tells an always-on agent to look again itself', async () => {
    world.hearsVia[ANA] = 'assistant';
    const r: any = await publish();
    expect(r.isError, JSON.stringify(r.content?.[0]?.text)).toBeUndefined();
    expect(r.structuredContent.note.text).toBe(
      'It takes a minute or two to be matched; look again after that.',
    );
  });
});
