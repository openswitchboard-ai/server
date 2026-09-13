/**
 * When the details open, and who is told.
 *
 * THE CHANGE THIS SUITE NOW HOLDS (13 September 2026): the posting is the
 * statement of interest. Two things are put together and the details — what
 * the other person has, and a seller's asking price — are open to BOTH sides
 * at that moment. There is no second asking, so there is no later moment at
 * which the details "become" open and nothing left for a separate notice to
 * announce. The summons that says somebody has come forward says it instead,
 * in its own second sentence.
 *
 * The defect the old shape existed for is worth keeping in view, because this
 * change is what finally closes it: in the 2026-09-12 rehearsal one human said
 * they were keen and then heard nothing for days, because the other side had
 * not said it back yet. Nobody waits on anybody now.
 *
 * What is asserted here:
 *  - express_interest enqueues NOTHING, from either chair and twice over, and
 *    moves nothing backwards;
 *  - a 'details' your-move job — one that may still be sitting on the queue
 *    from before the deploy — is dropped rather than sent;
 *  - the names notice is untouched, on both sides, and keeps its dedupe key;
 *  - the summons now tells the human their assistant can already see what the
 *    other person has, on their own side of it, with nothing to press.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sesSend = vi.fn(async () => ({ MessageId: 'ses-1' }));
const sqsSend = vi.fn(async () => ({}));
vi.mock('../../src/aws.js', () => ({
  sesv2: { send: (...a: unknown[]) => sesSend(...(a as [])) },
  sqs: { send: (...a: unknown[]) => sqsSend(...(a as [])) },
}));

vi.mock('../../src/crypto.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  decryptFields: vi.fn(async (_a: string, _k: Buffer, fields: Record<string, Buffer>) =>
    Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, v.toString('utf8').replace(/^enc:/, '')]),
    ),
  ),
  writeConsentEvent: vi.fn(async () => 'consent-events/x'),
  writeDecryptAudit: vi.fn(async () => 'decrypt-audit/x'),
}));

import * as db from '../../src/db.js';
import { initCounterKeys } from '../../src/counter/keys.js';
import { expressInterest, nextAction } from '../../src/domain/matches.js';
import { notifyYourMove } from '../../src/email/digestEngine.js';
import { renderSummons, renderYourMove, type FooterLinks } from '../../src/email/templates.js';
import { lintEmailCopy, noticeLinkHits } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
  opsQueueUrl: 'https://ops.test/queue',
  sesFrom: 'switchboard@test',
  sesReplyTo: 'switchboard@test',
  sesConfigurationSet: 'cs',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the WANT side
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the HAVE side

interface World {
  stage: number;
  interestWant: boolean;
  interestHave: boolean;
  hearsVia: Record<string, 'email' | 'assistant'>;
  dedupeKeys: string[];
}
let world: World;

const theMatch = () => ({
  id: MATCH,
  card_want: 'card-w',
  card_have: 'card-h',
  account_want: ANA,
  account_have: BEPPE,
  score: 0.8,
  category: 'goods.bicycle.mountain',
  stage: world.stage,
  interest_want: world.interestWant,
  interest_have: world.interestHave,
  state: 'open' as const,
  channel_id: null,
  opened_at: null,
  live: true,
});

function fakePool() {
  return {
    query: async (sql: string, params: any[] = []) => {
      const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
      // Nothing writes to matches on this path any more; if anything ever did,
      // the assertions below would see the world change under them.
      if (/UPDATE matches/.test(sql)) throw new Error(`express_interest wrote to matches: ${sql}`);
      if (/FROM consent_tokens/.test(sql)) return rows([{ n: 0, mine: 0 }]);
      if (/FROM matches/.test(sql) && /^\s*SELECT/.test(sql)) return rows([theMatch()]);
      if (/SELECT hears_via FROM accounts/.test(sql)) {
        return rows([{ hears_via: world.hearsVia[params[0]] ?? 'email' }]);
      }
      if (/SELECT blind_mode, email_freq_matches/.test(sql)) {
        return rows([
          {
            blind_mode: false,
            email_freq_matches: 'immediate',
            email_freq_digests: 'weekly',
            email_unreachable_at: null,
            email_complaint_suppressed_at: null,
          },
        ]);
      }
      if (/SELECT email_unreachable_at/.test(sql)) {
        return rows([{ email_unreachable_at: null, email_complaint_suppressed_at: null }]);
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            status: 'active',
            data_key_enc: Buffer.from('wrapped'),
            email_enc: Buffer.from(`enc:${params[0]}@example.test`),
          },
        ]);
      }
      if (/INSERT INTO email_sends/.test(sql)) {
        world.dedupeKeys.push(params[0]);
        return rows([{ id: 'send-1' }]);
      }
      return rows([]);
    },
  } as any;
}

beforeAll(async () => {
  // The send pipeline paces SES at one a second; that pacing is covered in its
  // own suite and here it would only make this one wait.
  vi.stubGlobal('setTimeout', ((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
  process.env.COUNTER_LINK_HMAC_KEY = 'a'.repeat(64);
  process.env.COUNTER_COOKIE_KEY = 'b'.repeat(64);
  await initCounterKeys(cfg);
});

beforeEach(() => {
  world = {
    // How every introduction is born now: both sides keen, details open.
    stage: 2,
    interestWant: true,
    interestHave: true,
    hearsVia: {},
    dedupeKeys: [],
  };
  sqsSend.mockReset().mockResolvedValue({} as any);
  sesSend.mockClear();
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

/** The "your move" ops messages enqueued so far. */
const notices = () =>
  sqsSend.mock.calls
    .map((c: any[]) => {
      try {
        return JSON.parse(c[0].input.MessageBody);
      } catch {
        return {};
      }
    })
    .filter((b: any) => b.op === 'your-move-notify');

// ---------------------------------------------------------------------------
describe('nobody is told the details have opened, because they open at the start', () => {
  it('enqueues nothing from either chair', async () => {
    await expressInterest(cfg, MATCH, ANA);
    await expressInterest(cfg, MATCH, BEPPE);
    expect(notices()).toHaveLength(0);
  });

  it('enqueues nothing when the same side calls it twice', async () => {
    await expressInterest(cfg, MATCH, BEPPE);
    await expressInterest(cfg, MATCH, BEPPE);
    expect(notices()).toHaveLength(0);
  });

  it('leaves the introduction exactly where it was', async () => {
    const m = await expressInterest(cfg, MATCH, BEPPE);
    expect(m.stage).toBe(2);
    expect(m.interest_want).toBe(true);
    expect(m.interest_have).toBe(true);
    expect(nextAction(m, BEPPE)).toBe('details_unlocked');
  });
});

// ---------------------------------------------------------------------------
describe('a details job left on the queue is dropped', () => {
  it('sends nothing at all for the retired step', async () => {
    await notifyYourMove(cfg, MATCH, ANA, 'details');
    expect(sesSend).not.toHaveBeenCalled();
    expect(world.dedupeKeys).toEqual([]);
  });

  it('and the names notice keeps its own key, unchanged', async () => {
    await notifyYourMove(cfg, MATCH, ANA, 'details');
    await notifyYourMove(cfg, MATCH, ANA, 'names');
    expect(world.dedupeKeys).toEqual([`your-move:${MATCH}:${ANA}`]);
  });

  it('is quiet for a human whose agent brings them the news', async () => {
    world.hearsVia[ANA] = 'assistant';
    await notifyYourMove(cfg, MATCH, ANA, 'details');
    expect(sesSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('the names notice, untouched', () => {
  const links: FooterLinks = {
    settingsUrl: 'https://my.test/settings',
    unsubUrl: 'https://my.test/email/unsub?t=x',
  } as FooterLinks;

  it('says the names step and nothing about interest', () => {
    const c = renderYourMove({ categoryLabel: 'Mountain bikes', blind: false, side: 'have' }, links);
    expect(c.subject).toBe('It is your turn');
    expect(c.text).toContain('They have said yes to swapping first names about your mountain bike.');
    expect(c.text).toContain('Your yes is the last step before the two of you can talk.');
    expect(c.text).not.toContain('take it further too');
  });

  // The names step says whose the thing is, so it takes the reader's own side.
  it('says it from the reader’s own side', () => {
    const buyer = renderYourMove(
      { categoryLabel: 'Mountain bikes', blind: false, side: 'want' },
      links,
    );
    expect(buyer.text).toContain(
      'They have said yes to swapping first names about the mountain bike you are after.',
    );
    expect(buyer.text).not.toContain('your mountain bike');
    expect(lintEmailCopy(buyer.subject + buyer.text + buyer.html)).toEqual([]);
  });

  // The sender works the side out from the pairing row at send time: Ana holds
  // the want, Beppe holds the have, and neither is ever told they own the
  // other one's thing.
  it('the sender gives each human the sentence for their own side', async () => {
    const bodyText = () =>
      (sesSend.mock.calls.at(-1)![0] as any).input.Content.Simple.Body.Text.Data as string;
    await notifyYourMove(cfg, MATCH, ANA, 'names');
    expect(bodyText()).toContain(
      'They have said yes to swapping first names about the mountain bike you are after.',
    );
    expect(bodyText()).not.toContain('your mountain bike');
    await notifyYourMove(cfg, MATCH, BEPPE, 'names');
    expect(bodyText()).toContain(
      'They have said yes to swapping first names about your mountain bike.',
    );
  });
});

// ---------------------------------------------------------------------------
// The summons is now the first notice AND the details notice at once.
// ---------------------------------------------------------------------------
describe('the summons carries the details', () => {
  const links: FooterLinks = {
    settingsUrl: 'https://my.test/settings',
    unsubUrl: 'https://my.test/email/unsub?t=x',
  } as FooterLinks;

  it('tells the seller their assistant can already see what the other person is after', () => {
    const c = renderSummons(
      { count: 1, categoryLabel: 'Mountain bikes', blind: false, side: 'have' },
      links,
    );
    expect(c.text).toContain('Someone has come forward about your mountain bike.');
    expect(c.text).toContain("Your assistant can already see what they're after.");
    expect(c.text.trimEnd()).toContain('Ask your assistant.');
  });

  it('tells the buyer their assistant can already see what they have', () => {
    const c = renderSummons(
      { count: 1, categoryLabel: 'Mountain bikes', blind: false, side: 'want' },
      links,
    );
    expect(c.text).toContain('Someone has come forward with a mountain bike.');
    expect(c.text).toContain('Your assistant can already see what they have.');
  });

  it('carries nothing to press and no marketing voice', () => {
    const c = renderSummons(
      { count: 1, categoryLabel: 'Mountain bikes', blind: false, side: 'have' },
      links,
    );
    expect(noticeLinkHits(c, ['https://my.test/settings', 'https://my.test/email/unsub'])).toEqual(
      [],
    );
    expect(lintEmailCopy(c.subject + c.text + c.html)).toEqual([]);
  });

  it('stays a bare pointer in blind mode', () => {
    const c = renderSummons({ count: 1, blind: true, side: 'have' }, links);
    expect(c.text).not.toContain('mountain bike');
    expect(c.text).not.toContain('already see');
    expect(c.text).toContain('Something is waiting for you.');
  });

  it('says nothing about one person’s details in the batched summons', () => {
    const c = renderSummons({ count: 3, blind: false }, links);
    expect(c.text).toContain('3 people have come forward.');
    expect(c.text).not.toContain('already see');
  });
});
