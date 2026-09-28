/**
 * WHAT CROSSES IS WHAT WAS SCREENED (migration 055, domain/screenedContent.ts).
 *
 * Two findings from the 28 September review, and the sweep that closes a third:
 *
 *  - An amend or a refine put new words on a card that was already introduced
 *    to somebody, and those words reached that person on their next sweep
 *    before any screen had read them. Everything a counterparty is shown now
 *    comes off the screened snapshot, never off the live row, and a card that
 *    was never screened through shows nothing.
 *  - A verdict on old words could publish new ones. The verdict now lands only
 *    on the content_version it read, and the snapshot it writes is made from
 *    the row it screened rather than from a fresh read.
 *  - A posting the model could never give a verdict on stayed pending for
 *    ever. rejectStuckScreening refuses it with a plain reason after six hours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sqsSend = vi.fn(async () => ({}));
vi.mock('../../src/aws.js', () => ({
  sesv2: { send: vi.fn(async () => ({})) },
  sqs: { send: (...a: unknown[]) => sqsSend(...(a as [])) },
  bedrock: { send: vi.fn(async () => { throw new Error('no network in the suite'); }) },
}));
const embedText = vi.fn(async () => [0.25, 0.5]);
vi.mock('../../src/domain/embeddings.js', () => ({
  embedText: (...a: unknown[]) => embedText(...(a as [])),
  vectorLiteral: (v: number[]) => `[${v.join(',')}]`,
}));

import * as db from '../../src/db.js';
import { screenedContentOf, snapshotOf } from '../../src/domain/screenedContent.js';
import {
  COULD_NOT_SCREEN,
  STUCK_SCREENING_HOURS,
  applyVerdict,
  rejectStuckScreening,
  rejectionInPlainWords,
  screeningReasonInPlainWords,
} from '../../src/domain/screening.js';
import { buildAttributes } from '../../src/domain/matches.js';
import { nearMissesForCards } from '../../src/domain/nearMisses.js';
import { OsbError } from '../../src/protocol.js';
import { lintHumanCopy } from '../../src/email/lint.js';

const cfg: any = { bedrockModelId: 'unused', matchingQueueUrl: 'matching-queue' };

const ANA = '11111111-1111-4111-8111-111111111111';
const BEPPE = '22222222-2222-4222-8222-222222222222';
const WANT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const HAVE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const MATCH = 'cccccccc-3333-4333-8333-cccccccccccc';

interface Seen {
  sql: string;
  params: any[];
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
describe('the snapshot itself', () => {
  it('is exactly the words it was handed, with the version they were', () => {
    const snap = snapshotOf(
      {
        kind: 'mountain bike',
        also_called: ['MTB', 42 as any],
        not_these: ['road bike'],
        attributes: { frame: 'medium' },
        ask: { amount: 400, ccy: 'AUD' },
        content_version: 3,
      },
      '2026-09-28T01:00:00.000Z',
    );
    expect(snap).toEqual({
      version: 3,
      at: '2026-09-28T01:00:00.000Z',
      kind: 'mountain bike',
      also_called: ['MTB'],
      not_these: ['road bike'],
      attributes: { frame: 'medium' },
      ask: { amount: 400, ccy: 'AUD' },
    });
  });

  it('reads as nothing where there is none, or where it is not a snapshot', () => {
    expect(screenedContentOf({})).toBeUndefined();
    expect(screenedContentOf({ screened_content: null })).toBeUndefined();
    expect(screenedContentOf({ screened_content: 'words' })).toBeUndefined();
    expect(screenedContentOf({ screened_content: [1] })).toBeUndefined();
    expect(screenedContentOf(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('a verdict lands only on the words it read', () => {
  let seen: Seen[];
  const pool = (rowCount: number) => {
    seen = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[] = []) => {
        seen.push({ sql, params });
        return { rows: [], rowCount };
      },
    } as any);
  };

  const screened = {
    id: HAVE,
    category: 'goods.bicycle.mountain',
    kind: 'mountain bike',
    also_called: ['MTB'],
    not_these: [],
    attributes: { frame: 'medium' },
    ask: { amount: 400, ccy: 'AUD' },
    content_version: 2,
  };

  beforeEach(() => {
    sqsSend.mockClear();
    embedText.mockClear();
  });

  it('publishes, embeds and snapshots in one statement guarded by the version', async () => {
    pool(1);
    const r = await applyVerdict(cfg, screened, { pass: true, model_id: 'm' });
    expect(r.applied).toBe(true);
    // No fresh read: what is written is what the worker screened.
    expect(seen.some((s) => /SELECT/.test(s.sql))).toBe(false);
    expect(seen).toHaveLength(1);
    const [update] = seen;
    expect(update.sql).toContain("lifecycle_state='PUBLISHED'");
    expect(update.sql).toContain("AND lifecycle_state='PENDING_SCREENING'");
    expect(update.sql).toContain('AND content_version=$3');
    expect(update.sql).toContain('screened_content=$4');
    expect(update.sql).toContain('embedding=$5');
    expect(update.params[2]).toBe(2);
    expect(JSON.parse(update.params[3])).toEqual({
      version: 2,
      at: r.screening.at,
      kind: 'mountain bike',
      also_called: ['MTB'],
      not_these: [],
      attributes: { frame: 'medium' },
      ask: { amount: 400, ccy: 'AUD' },
    });
    expect(update.params[4]).toBe('[0.25,0.5]');
    // The embedding is of those same words.
    expect(String((embedText.mock.calls[0] as any[])[1])).toContain('mtb');
    // And the matcher hears about a card this verdict actually published.
    expect(sqsSend).toHaveBeenCalledTimes(1);
    expect(JSON.parse((sqsSend.mock.calls[0] as any[])[0].input.MessageBody)).toEqual({
      kind: 'card-published',
      card_id: HAVE,
    });
  });

  it('changes nothing, and wakes no matcher, where the words moved on', async () => {
    pool(0);
    const r = await applyVerdict(cfg, screened, { pass: true });
    expect(r.applied).toBe(false);
    expect(sqsSend).not.toHaveBeenCalled();
  });

  it('a refusal is guarded the same way and never touches the screened copy', async () => {
    pool(1);
    const r = await applyVerdict(cfg, screened, { pass: false, reason_code: 'pii-in-card' });
    expect(r.applied).toBe(true);
    const [update] = seen;
    expect(update.sql).toContain("lifecycle_state='SCREENING_REJECTED'");
    expect(update.sql).toContain('AND content_version=$3');
    expect(update.sql).not.toContain('screened_content');
    expect(update.params[2]).toBe(2);
    expect(embedText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('a posting the screen never answers on', () => {
  it('is refused after six hours, with the reason it carries', async () => {
    const seen: Seen[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[] = []) => {
        seen.push({ sql, params });
        return { rows: [{ id: WANT }, { id: HAVE }], rowCount: 2 };
      },
    } as any);
    expect(await rejectStuckScreening()).toBe(2);
    const [update] = seen;
    expect(update.sql).toContain("SET lifecycle_state='SCREENING_REJECTED'");
    expect(update.sql).toContain("WHERE lifecycle_state='PENDING_SCREENING'");
    expect(update.sql).toContain('updated_at < now() - make_interval(hours => $2::int)');
    expect(update.params[1]).toBe(STUCK_SCREENING_HOURS);
    expect(STUCK_SCREENING_HOURS).toBe(6);
    const stored = JSON.parse(update.params[0]);
    expect(stored).toMatchObject({ pass: false, reason_code: COULD_NOT_SCREEN });
    // And the owner reads it in plain words, the same way as any refusal.
    expect(rejectionInPlainWords(stored)).toMatchObject({
      reasonCode: 'could-not-screen',
      plain: 'This could not be checked, so it did not go on the board. Post it again.',
    });
  });

  it('says so plainly, in the house register', () => {
    const plain = screeningReasonInPlainWords('could-not-screen');
    expect(plain).toMatch(/could not be checked/);
    expect(plain).toMatch(/Post it again/);
    expect(lintHumanCopy(plain)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('what an introduced person is shown of the other posting', () => {
  const match: any = {
    id: MATCH,
    state: 'open',
    stage: 2,
    score: 0.9,
    category: 'goods.bicycle.mountain',
    kind: 'mountain bike',
    account_want: ANA,
    account_have: BEPPE,
    card_want: WANT,
    card_have: HAVE,
    certainty: 'sure',
  };

  /** The have as it stands after an amend and a refine nobody has screened. */
  const amended = (over: Record<string, unknown> = {}) => ({
    id: HAVE,
    account_id: BEPPE,
    type: 'HAVE',
    category: 'goods.bicycle.mountain',
    kind: 'mountain bike',
    also_called: ['call me on the number in the ad'],
    not_these: [],
    attributes: { frame: 'medium', condition: 'text me before you come' },
    ask: { amount: 999, ccy: 'AUD' },
    lifecycle_state: 'PENDING_SCREENING',
    content_version: 3,
    screened_content: {
      version: 2,
      at: '2026-09-27T00:00:00.000Z',
      kind: 'mountain bike',
      also_called: ['MTB'],
      not_these: [],
      attributes: { frame: 'medium' },
      ask: { amount: 400, ccy: 'AUD' },
    },
    ...over,
  });

  const useCard = (card: Record<string, unknown>) =>
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string) =>
        /SELECT \* FROM cards WHERE id/.test(sql)
          ? { rows: [card], rowCount: 1 }
          : { rows: [], rowCount: 0 },
    } as any);

  it('is the last words that passed, never the ones waiting on the screen', async () => {
    useCard(amended());
    const p: any = await buildAttributes(match, ANA);
    expect(p.attributes).toEqual({ frame: 'medium' });
    expect(p.ask).toEqual({ amount: 400, ccy: 'AUD' });
    const theirs = p.notes.filter((n: any) => n.provenance === 'counterparty-untrusted').map((n: any) => n.text);
    expect(theirs).toEqual(['mountain bike', 'MTB']);
    const text = JSON.stringify(p);
    expect(text).not.toContain('text me');
    expect(text).not.toContain('call me');
    expect(text).not.toContain('999');
  });

  it('and stays those words once the screen refuses the new ones', async () => {
    useCard(amended({ lifecycle_state: 'SCREENING_REJECTED' }));
    const p: any = await buildAttributes(match, ANA);
    expect(p.attributes).toEqual({ frame: 'medium' });
    expect(JSON.stringify(p)).not.toContain('text me');
  });

  it('is nothing at all from a card that was never screened through', async () => {
    useCard(amended({ screened_content: null }));
    const err = await buildAttributes(match, ANA).catch((e) => e);
    expect(err).toBeInstanceOf(OsbError);
    expect(err.payload.code).toBe('NOT_UNLOCKED_YET');
  });

  it('and on the sweep keeps its shape while carrying none of their words', async () => {
    useCard(amended({ screened_content: null }));
    const p: any = await buildAttributes(match, ANA, { unscreened: 'empty' });
    expect(p.kind).toBe('intro.attributes');
    expect(p.attributes).toEqual({});
    expect(p.ask).toBeUndefined();
    expect(p.notes.every((n: any) => n.provenance === 'switchboard-system')).toBe(true);
    expect(JSON.stringify(p)).not.toContain('text me');
  });
});

// ---------------------------------------------------------------------------
describe('a near miss names the other posting from its screened words', () => {
  it('reads the screened kind and quotes it inside the sentence', async () => {
    const seen: Seen[] = [];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (sql: string, params: any[] = []) => {
        seen.push({ sql, params });
        return {
          rows: [
            {
              card_id: WANT,
              other_id: HAVE,
              other_type: 'HAVE',
              other_category: 'goods.bicycle.mountain',
              other_kind: 'gravel bike',
              created_at: new Date('2026-09-27T00:00:00Z'),
            },
          ],
          rowCount: 1,
        };
      },
    } as any);
    const found = await nearMissesForCards(ANA, [WANT]);
    expect(seen[0].sql).toContain("o.screened_content->>'kind' AS other_kind");
    expect(seen[0].sql).not.toMatch(/o\.kind\b/);
    const [item] = found.get(WANT)!.items;
    expect(item.their_words).toEqual({ text: 'gravel bike', provenance: 'counterparty-untrusted' });
    expect(item.note.text).toContain('someone has “gravel bike”.');
  });
});
