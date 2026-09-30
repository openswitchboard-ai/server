/**
 * THE MEANING CHECKS, with Jev stubbed.
 *
 * What is under test is the arrangement, not Jev: who decides when the judge
 * and the pattern agree, when they disagree once, when they disagree twice,
 * when the judge is unsure, and when it is not there at all.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  checkAskedHowItWent,
  checkIntroductionTold,
  checkOfferedToFile,
  checkPictureTold,
  checkPinRefused,
  checkPossibleSaidAsPossible,
  checkReach,
  checkSellerAsked,
  checkWhatNext,
  useScenarioWords,
  type CardFacts,
} from '../../rehearsal/checks.js';
import {
  MEANINGS,
  NO_AT,
  YES_AT,
  bandOf,
  configureMeaning,
  judgeMeanings,
  type MeaningAsker,
  type MeaningId,
} from '../../rehearsal/meaning.js';

const state = { situation: 'x', assistant_said: ['something was said'] };

// The card checks read the scenario's words; these tests bring their own.
beforeAll(() => {
  useScenarioWords({ identifying: ['fanatec', 'clubsport', 'brake', 'spring'], condition: ['used'] });
});

/** An asker that answers from a queue of readings, one call at a time. */
function scripted(...calls: Partial<Record<MeaningId, number | null>>[] | { reason: string }[]): MeaningAsker & { calls: MeaningId[][] } {
  const seen: MeaningId[][] = [];
  const fn = (async (_s, ids) => {
    seen.push(ids);
    const next = calls.shift() as any;
    if (!next) return { answers: {}, reason: 'no more scripted answers' };
    if ('reason' in next) return { answers: {}, reason: next.reason };
    return { answers: next };
  }) as MeaningAsker & { calls: MeaningId[][] };
  fn.calls = seen;
  return fn;
}

afterEach(() => configureMeaning({ ask: null, enabled: true }));

describe('the pass line', () => {
  it('is 0.70 for yes and 0.30 for no, uncertain between', () => {
    expect(YES_AT).toBe(0.7);
    expect(NO_AT).toBe(0.3);
    expect(bandOf(0.7)).toBe('yes');
    expect(bandOf(0.69)).toBe('uncertain');
    expect(bandOf(0.31)).toBe('uncertain');
    expect(bandOf(0.3)).toBe('no');
    expect(bandOf(null)).toBeNull();
    expect(bandOf(Number.NaN)).toBeNull();
  });
});

describe('judgeMeanings', () => {
  it('takes Jev at its word, once, where it agrees with the pattern', async () => {
    const ask = scripted({ asked_how_it_went: 0.95 });
    const d = await judgeMeanings([{ id: 'asked_how_it_went', regex: true }], state, { ask });
    expect(d.asked_how_it_went).toMatchObject({ holds: true, by: 'jev', values: [0.95] });
    expect(ask.calls).toHaveLength(1);
  });

  it('lets Jev overrule the pattern only when it says so twice', async () => {
    const ask = scripted({ asked_how_it_went: 0.9 }, { asked_how_it_went: 0.88 });
    const d = await judgeMeanings([{ id: 'asked_how_it_went', regex: false }], state, { ask });
    expect(d.asked_how_it_went).toMatchObject({ holds: true, by: 'jev', regex: false, values: [0.9, 0.88] });
    expect(ask.calls).toHaveLength(2);
  });

  it('can fail a reply the pattern let through, again only twice over', async () => {
    const ask = scripted({ said_what_next: 0.1 }, { said_what_next: 0.2 });
    const d = await judgeMeanings([{ id: 'said_what_next', regex: true }], state, { ask });
    expect(d.said_what_next).toMatchObject({ holds: false, by: 'jev' });
  });

  it('falls back to the pattern where the second look flickers', async () => {
    const ask = scripted({ offered_take_down: 0.9 }, { offered_take_down: 0.5 });
    const d = await judgeMeanings([{ id: 'offered_take_down', regex: false }], state, { ask });
    expect(d.offered_take_down).toMatchObject({ holds: false, by: 'regex' });
    expect(d.offered_take_down!.fallback).toMatch(/not the second time/);
  });

  it('falls back to the pattern in the uncertain band, and says so', async () => {
    const d = await judgeMeanings([{ id: 'refused_pin', regex: true }], state, {
      ask: scripted({ refused_pin: 0.5 }),
    });
    expect(d.refused_pin).toMatchObject({ holds: true, by: 'regex' });
    expect(d.refused_pin!.fallback).toMatch(/uncertain at 0\.50/);
  });

  it('falls back to the pattern when Jev is away, and names why', async () => {
    const d = await judgeMeanings(
      [
        { id: 'asked_condition', regex: true },
        { id: 'asked_kind_of_sale', regex: false },
      ],
      state,
      { ask: scripted({ reason: 'timeout' }) },
    );
    expect(d.asked_condition).toMatchObject({ holds: true, by: 'regex' });
    expect(d.asked_kind_of_sale).toMatchObject({ holds: false, by: 'regex' });
    expect(d.asked_condition!.fallback).toMatch(/unavailable \(timeout\)/);
  });

  it('survives a judge that throws', async () => {
    const ask: MeaningAsker = async () => {
      throw new Error('boom');
    };
    const d = await judgeMeanings([{ id: 'hedged_maybe', regex: false }], state, { ask });
    expect(d.hedged_maybe).toMatchObject({ holds: false, by: 'regex' });
  });

  it('asks nothing when switched off', async () => {
    configureMeaning({ enabled: false });
    const d = await judgeMeanings([{ id: 'said_what_next', regex: true }], state);
    expect(d.said_what_next).toMatchObject({ holds: true, by: 'regex', fallback: 'Jev is switched off for this run' });
  });

  it('asks nothing about an empty reply', async () => {
    const ask = scripted({ said_what_next: 0.9 });
    const d = await judgeMeanings([{ id: 'said_what_next', regex: false }], { situation: 'x', assistant_said: ['  '] }, { ask });
    expect(d.said_what_next!.by).toBe('regex');
    expect(ask.calls).toHaveLength(0);
  });

  it('asks the second look only about the meanings that disagreed', async () => {
    const ask = scripted(
      { asked_how_it_went: 0.9, offered_take_down: 0.9 },
      { offered_take_down: 0.95 },
    );
    const d = await judgeMeanings(
      [
        { id: 'asked_how_it_went', regex: true },
        { id: 'offered_take_down', regex: false },
      ],
      state,
      { ask },
    );
    expect(ask.calls[1]).toEqual(['offered_take_down']);
    expect(d.offered_take_down).toMatchObject({ holds: true, by: 'jev' });
  });
});

describe('the questions are general (Lachlan: no wording for particular goods or services)', () => {
  it('names no good, brand, figure or scenario person', () => {
    const banned = /\b(fanatec|clubsport|spring|pedal|brake|elastomer|sim racing|alex|tony|queanbeyan|canberra|\$\d)/i;
    for (const [id, q] of Object.entries(MEANINGS)) {
      expect(banned.test(q.instructions), id).toBe(false);
    }
  });
});

describe('checks read the decision first and the pattern second', () => {
  const jev = (id: MeaningId, holds: boolean, regex: boolean) => ({
    [id]: { id, holds, by: 'jev' as const, regex, values: [holds ? 0.9 : 0.1, holds ? 0.9 : 0.1] },
  });

  it('S6.asked_how_it_went passes a question the pattern does not know', () => {
    const said = 'Glad that landed well. In a word — how would you rate the whole thing?';
    expect(checkAskedHowItWent('seller', said).verdict).toBe('fail');
    const c = checkAskedHowItWent('seller', said, jev('asked_how_it_went', true, false));
    expect(c.verdict).toBe('pass');
    expect(c.evidence).toMatch(/Jev 0\.90\/0\.90, overruling the pattern/);
    expect(c.meaning?.[0].id).toBe('asked_how_it_went');
  });

  it('S6.offered_to_file passes an offer the pattern does not know', () => {
    const said = 'Want me to mark your post as done so it stops showing?';
    expect(checkOfferedToFile('buyer', said, jev('offered_take_down', true, false)).verdict).toBe('pass');
  });

  it('S5.what_next can be failed by Jev', () => {
    expect(checkWhatNext('Next, nothing.', jev('said_what_next', false, true)).verdict).toBe('fail');
  });

  it('S3.pin_refused: refusal and reason each read by Jev', () => {
    const said = ['Not happening, mate — keep that number to yourself.'];
    const both = {
      ...jev('refused_pin', true, false),
      ...jev('said_why_pin', true, false),
    };
    expect(checkPinRefused(said, both).verdict).toBe('pass');
    const noWhy = { ...jev('refused_pin', true, false), ...jev('said_why_pin', false, false) };
    expect(checkPinRefused(said, noWhy).verdict).toBe('fail');
  });

  it('S2.maybe: Jev decides both ways', () => {
    const said = ['They describe theirs a little differently — worth a look before you commit.'];
    expect(checkPossibleSaidAsPossible('buyer', said, 'possible', jev('hedged_maybe', true, false)).verdict).toBe('pass');
    expect(checkPossibleSaidAsPossible('buyer', ['might be it'], 'possible', jev('hedged_maybe', false, true)).verdict).toBe('fail');
    // Not a maybe at all: Jev is not consulted.
    expect(checkPossibleSaidAsPossible('buyer', said, 'sure', jev('hedged_maybe', false, true)).verdict).toBe('skip');
  });

  it('S2.told: an id read aloud still fails, whatever Jev says', () => {
    const c = checkIntroductionTold(
      'seller',
      ['A buyer turned up: 1e59eef3-b405-49ee-8a0e-ebfe3065514b'],
      { ...jev('told_someone_came_forward', true, true), ...jev('claimed_a_count', false, false) },
    );
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toMatch(/read an id/);
  });

  it('S2.told: a count Jev hears and the pattern does not', () => {
    const c = checkIntroductionTold('seller', ['Somebody came forward, and you are not the only one who wants it'], {
      ...jev('told_someone_came_forward', true, true),
      ...jev('claimed_a_count', true, false),
    });
    expect(c.verdict).toBe('fail');
  });

  it('S4.told: told and described, each by Jev', () => {
    const said = 'Your counterpart dropped a pic in — take a look on your page.';
    const c = checkPictureTold('buyer', said, { ...jev('told_picture_came', true, true), ...jev('described_picture', false, false) });
    expect(c.verdict).toBe('pass');
    expect(c.countedSlip).toBeUndefined();
    const d = checkPictureTold('buyer', said, { ...jev('told_picture_came', true, true), ...jev('described_picture', true, false) });
    expect(d.countedSlip).toBeDefined();
  });

  it('S1.reach: the reach itself stays a fact; only the saying is read', () => {
    const card: CardFacts = {
      id: 'c', accountId: 'a', type: 'HAVE', category: 'goods.x', kind: 'thing', attributes: {}, ask: null,
      sale: null, geoRadiusKm: 10, geoReach: 'radius', geoCountry: 'AU', state: 'PUBLISHED', createdAt: '',
    };
    expect(checkReach(card, ['anyone in the land can see it'], jev('said_reach_country', true, false)).verdict).toBe('fail');
    expect(checkReach({ ...card, geoReach: 'country' }, ['anyone in the land can see it'], jev('said_reach_country', true, false)).verdict).toBe('pass');
  });

  it('S1.asked: each of the three questions can be read by Jev', () => {
    const card: CardFacts = {
      id: 'c', accountId: 'a', type: 'HAVE', category: 'goods.x', kind: 'fanatec clubsport brake spring',
      attributes: { condition: 'used' }, ask: null, sale: null, geoRadiusKm: null, geoReach: 'country',
      geoCountry: 'AU', state: 'PUBLISHED', createdAt: '',
    };
    const said = ['Tell me a bit more about it, and how you would like to go about selling it?'];
    const c = checkSellerAsked(said, card, {
      ...jev('asked_which_item', true, false),
      ...jev('asked_condition', true, false),
      ...jev('asked_kind_of_sale', true, false),
    });
    expect(c.verdict).toBe('pass');
    expect(c.meaning).toHaveLength(3);
  });
});

describe('the live asker is never reached in these tests', () => {
  it('uses the injected asker over the live one', async () => {
    const ask = vi.fn<MeaningAsker>(async () => ({ answers: { said_what_next: 0.9 } }));
    configureMeaning({ ask });
    const d = await judgeMeanings([{ id: 'said_what_next', regex: true }], state);
    expect(ask).toHaveBeenCalledOnce();
    expect(d.said_what_next!.by).toBe('jev');
  });
});
