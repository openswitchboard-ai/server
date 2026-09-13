/**
 * THE LEAD SENTENCE IS THE NEWEST THING THAT NEEDS THIS HUMAN.
 *
 * Run 8 (13 September 2026), the third of this shape in a day: a human asked
 * their assistant "anything back on the bike?" and was told the two of them had
 * only just been put in touch and nothing had come back — while a figure
 * proposed nine minutes earlier sat on the table, with an email about it
 * already gone out to that same human. The figure was in the sweep, in its own
 * sentence; the sweep's lead sentence was the one for the state, and the
 * assistant read that one out.
 *
 * The rule held shut here is the same for every state the sweep writes a
 * sentence for: something taken down beats a figure waiting, and a figure
 * waiting beats the sentence for where the two of them have got to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import { checkMatches } from '../../src/domain/matches.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  counterOrigin: 'https://my.test',
  publicOrigin: 'https://mcp.test',
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'; // the want side
const BEPPE = 'cccccccc-3333-4333-8333-cccccccccccc'; // the have side
const CARD_W = 'dddddddd-4444-4444-8444-dddddddddddd';
const CARD_H = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';

/** The words no sentence written for a human may ever carry. */
const BANNED = ['card', 'channel', 'match', 'stage', 'WANT', 'HAVE', 'connection', 'score'];

interface OfferRow {
  id: string;
  proposer_account: string;
  amount: string;
  ccy: string;
  state: string;
  message: unknown;
  authored_by: string;
  created_at: Date;
}

interface World {
  /** 4 = already talking; 2 = details open, nobody has pressed; 1 = one side keen. */
  stage: 1 | 2 | 4;
  /** This chair's own press on the names link, for the stage-2 words. */
  myOptin: boolean;
  /** Whether the want side is keen (stage 1 lives off this). */
  interestWant: boolean;
  offers: OfferRow[];
  /** Which listing has come down, by the chair that reads it. */
  withdrawnCard: string | null;
}
let world: World;

const offer = (over: Partial<OfferRow> & { at: number }): OfferRow => ({
  id: `0f0f0f0f-0000-4000-8000-${String(over.at).padStart(12, '0')}`,
  proposer_account: ANA,
  amount: '400',
  ccy: 'AUD',
  state: 'proposed',
  message: null,
  authored_by: 'human',
  created_at: new Date(Date.UTC(2026, 8, 13, 10, over.at)),
  ...over,
});

function fakePool() {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
      const theMatch = () => ({
        id: MATCH,
        card_want: CARD_W,
        card_have: CARD_H,
        account_want: ANA,
        account_have: BEPPE,
        score: 0.8,
        category: 'goods.bicycle.mountain',
        stage: world.stage,
        interest_want: world.interestWant,
        interest_have: true,
        state: 'open',
        channel_id: world.stage === 4 ? 'ch_1' : null,
        opened_at: world.stage === 4 ? new Date('2026-09-13T00:00:00Z') : null,
        my_optin: world.myOptin,
      });
      if (/read_calls/.test(sql)) return rows([{ n: 0, oldest: null }]);
      if (/SELECT arrangement FROM accounts/.test(sql)) return rows([{ arrangement: null }]);
      if (/SELECT hears_via FROM accounts/.test(sql)) return rows([{ hears_via: 'email' }]);
      if (/SELECT timezone FROM accounts/.test(sql)) return rows([{ timezone: 'Australia/Perth' }]);
      if (/^\s*SELECT m\.\*/.test(sql) && /FROM matches m/.test(sql)) return rows([theMatch()]);
      if (/^\s*SELECT \* FROM matches WHERE id/.test(sql)) return rows([theMatch()]);
      if (/count\(\*\)::int AS n FROM matches m/.test(sql)) return rows([{ n: 0 }]);
      if (/count\(DISTINCT account_id\)/.test(sql)) return rows([{ n: 0 }]);
      if (/collect_until > now\(\)/.test(sql)) return rows([]);
      if (/FROM cards c/.test(sql)) return rows([]);
      if (/^\s*SELECT \* FROM cards WHERE id/.test(sql)) {
        const id = params[0] as string;
        return rows([
          {
            id,
            account_id: id === CARD_W ? ANA : BEPPE,
            type: id === CARD_W ? 'WANT' : 'HAVE',
            category: 'goods.bicycle.mountain',
            attributes: { frame: 'medium' },
            ask: null,
            lifecycle_state: world.withdrawnCard === id ? 'WITHDRAWN' : 'PUBLISHED',
          },
        ]);
      }
      if (/SELECT amount, ccy, message FROM offers/.test(sql)) {
        const live = world.offers
          .filter(
            (o) =>
              o.proposer_account !== params[1] &&
              ['proposed', 'awaiting-human'].includes(o.state),
          )
          .sort((a, b) => +b.created_at - +a.created_at);
        return rows(live.slice(0, 1));
      }
      if (/SELECT id, proposer_account, amount, ccy, state, message, authored_by/.test(sql)) {
        return rows(
          world.offers
            .filter((o) => ['proposed', 'awaiting-human', 'accepted-by-human'].includes(o.state))
            .sort((a, b) => +b.created_at - +a.created_at),
        );
      }
      if (/^\s*SELECT \* FROM accounts WHERE id/.test(sql)) {
        return rows([
          {
            id: params[0],
            status: 'active',
            data_key_enc: Buffer.from('wrapped'),
            first_name_enc: Buffer.from(params[0] === ANA ? 'enc:Ana' : 'enc:Beppe'),
            locality_enc: Buffer.from(params[0] === ANA ? 'enc:Fremantle' : 'enc:Trastevere'),
          },
        ]);
      }
      return rows([]);
    },
  } as any;
}

beforeEach(() => {
  world = {
    stage: 4,
    myOptin: false,
    interestWant: true,
    offers: [],
    withdrawnCard: null,
  };
  vi.spyOn(db, 'getPool').mockReturnValue(fakePool());
});

/** The one introduction, as the given chair's sweep hands it back. */
async function sweep(who: string = ANA): Promise<any> {
  const [entry] = (await checkMatches(cfg, who)) as any[];
  return entry;
}

/** A figure this chair's own human put out, still waiting on the other side. */
const myFigureOut = (who: string) => [offer({ at: 9, proposer_account: who, amount: '400' })];

// ---------------------------------------------------------------------------
describe('the two of them are talking and a figure is waiting', () => {
  it('leads with the figure, not with how long they have been in touch', async () => {
    world.offers = myFigureOut(ANA);
    const entry = await sweep(ANA);
    expect(entry.next).toBe('ready_to_talk');
    expect(entry.note.text).toContain('400 AUD');
    expect(entry.note.text.startsWith('You are connected now')).toBe(false);
    // The figure's own sentence still leads the note it wrote.
    expect(entry.note.text.startsWith(entry.offer_note.text)).toBe(true);
  });

  it('still tells them the two of them can talk, in one short sentence', async () => {
    world.offers = myFigureOut(ANA);
    const entry = await sweep(ANA);
    expect(entry.note.text).toContain('You can message each other through me whenever you like.');
  });

  it('says it the same way from the other chair', async () => {
    world.offers = myFigureOut(BEPPE);
    const entry = await sweep(BEPPE);
    expect(entry.next).toBe('ready_to_talk');
    expect(entry.note.text).toContain('400 AUD');
    expect(entry.note.text).toContain('You can message each other through me whenever you like.');
  });

  it('is the plain sentence when there is no figure at all', async () => {
    for (const who of [ANA, BEPPE]) {
      const entry = await sweep(who);
      expect(entry.next).toBe('ready_to_talk');
      expect(entry.note.text).toBe(
        'You are connected now — you can message each other through me whenever you like.',
      );
    }
  });

  it('a listing that has come down beats a figure and the plain sentence both', async () => {
    world.offers = myFigureOut(ANA);
    world.withdrawnCard = CARD_W;
    const mine = await sweep(ANA);
    expect(mine.note.text).toMatch(/what your human put up has been taken down/i);
    expect(mine.note.text).not.toContain('400 AUD');
    const theirs = await sweep(BEPPE);
    expect(theirs.note.text).toMatch(/what they put up has been taken down/i);
    expect(theirs.note.text).not.toContain('400 AUD');
  });
});

// ---------------------------------------------------------------------------
describe('every other state the sweep writes a sentence for', () => {
  it('leads with a waiting figure where the details have just opened', async () => {
    world.stage = 2;
    world.offers = myFigureOut(ANA);
    const entry = await sweep(ANA);
    expect(entry.next).toBe('details_unlocked');
    expect(entry.note).toEqual(entry.offer_note);
    expect(entry.note.text).toContain('400 AUD');
  });

  it('leads with a waiting figure while their own press waits on the other side', async () => {
    world.stage = 2;
    world.myOptin = true;
    world.offers = myFigureOut(ANA);
    const entry = await sweep(ANA);
    expect(entry.next).toBe('awaiting_their_go_ahead');
    expect(entry.note).toEqual(entry.offer_note);
  });

  // A row made before 13 September 2026 and never moved up: the interest words
  // are unreachable now, and the ordering rule still has to hold over them.
  it('leads with a waiting figure while the other side has yet to answer at all', async () => {
    world.stage = 1;
    world.interestWant = false;
    world.offers = myFigureOut(BEPPE);
    const entry = await sweep(BEPPE);
    expect(entry.next).toBe('awaiting_other_side');
    expect(entry.note).toEqual(entry.offer_note);
  });

  it('keeps the plain sentence for each of those when no figure is out', async () => {
    world.stage = 2;
    // Where a new introduction starts: what they have, and the go-ahead next.
    expect((await sweep(ANA)).note.text).toMatch(/Here is what they have/);
    world.myOptin = true;
    expect((await sweep(ANA)).note.text.length).toBeGreaterThan(20);
    world.myOptin = false;
    world.stage = 1;
    world.interestWant = false;
    expect((await sweep(BEPPE)).note.text).toMatch(/the next move is theirs/);
  });

  it('a figure the other side put up still owns the sentence when it waits on this human', async () => {
    world.offers = [offer({ at: 9, proposer_account: BEPPE, amount: '400' })];
    const entry = await sweep(ANA);
    expect(entry.next).toBe('awaiting_your_human');
    expect(entry.note).toEqual(entry.offer_note);
    expect(entry.note.text).toContain('400 AUD');
  });

  it('and a listing that has come down beats it there too', async () => {
    world.offers = [offer({ at: 9, proposer_account: BEPPE, amount: '400' })];
    world.withdrawnCard = CARD_H;
    const entry = await sweep(ANA);
    expect(entry.next).toBe('awaiting_your_human');
    expect(entry.note.text).toMatch(/what they put up has been taken down/i);
    expect(entry.taken_down).toBe('theirs');
  });
});

// ---------------------------------------------------------------------------
describe('the words themselves', () => {
  it('carry none of the machinery and pass the copy rules', async () => {
    const worlds: (() => void)[] = [
      () => {},
      () => {
        world.offers = myFigureOut(ANA);
      },
      () => {
        world.offers = myFigureOut(ANA);
        world.withdrawnCard = CARD_W;
      },
      () => {
        world.stage = 2;
        world.offers = myFigureOut(ANA);
      },
    ];
    for (const set of worlds) {
      world = { stage: 4, myOptin: false, interestWant: true, offers: [], withdrawnCard: null };
      set();
      for (const who of [ANA, BEPPE]) {
        const text = (await sweep(who)).note.text as string;
        expect(lintHumanCopy(text), text).toEqual([]);
        for (const word of BANNED) expect(text, word).not.toContain(word);
      }
    }
  });
});
