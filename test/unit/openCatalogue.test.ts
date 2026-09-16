/**
 * THE CATALOGUE BECOMES A DENY LIST (docs/taxonomy-question.md, and step 3 of
 * docs/trust-and-safety.md).
 *
 * Three things had to be true at once for this to be safe, and this file is
 * each of them:
 *
 *  1. THE GATE LETS THE UNKNOWN THROUGH. A leaf nobody has written down goes
 *     up when its top level is open and nothing on its path is reserved. What
 *     still does not go up is what somebody deliberately closed.
 *  2. THE WORDS ARE CLEAN. `kind` is what an agent typed, so it is checked for
 *     shape here and for meaning at the model screen — and a figure in it is
 *     refused the way a figure in a message is.
 *  3. EVERY SENTENCE STILL READS AS ENGLISH. The catalogue used to be the
 *     vocabulary as well as the gate. For a leaf it has never heard of there
 *     is no word to lend, so the poster's own words are what the switchboard
 *     says back, article and all.
 */
import { describe, expect, it } from 'vitest';

import { categoryGate, categoryStatus, taxonomyKnows } from '../../src/denylist.js';
import { kindComplaint } from '../../src/domain/cards.js';
import {
  PROHIBITED_REASONS,
  prohibitedReason,
  type ModelFlags,
} from '../../src/intake/checks/modelScreen.js';
import {
  categoryLeafLabel,
  categoryPhrase,
  categoryPhraseWithArticle,
  kindTakesArticle,
  projectionText,
} from '../../src/domain/matchRules.js';
import { collectFreeText } from '../../src/domain/screening.js';

// ---------------------------------------------------------------------------
describe('the gate is a deny list', () => {
  it('lets an unknown leaf under an open top level through', () => {
    for (const c of [
      'goods.pushbike',
      'services.repairs.vintage-synthesiser',
      'social.bouldering-partner',
      'goods.electronics.laptop.framework-13',
    ]) {
      expect(taxonomyKnows(c), c).toBe(false);
      expect(categoryGate(c), c).toMatchObject({ ok: true, known: false });
    }
  });

  it('still says yes to the nodes it always said yes to', () => {
    for (const c of ['goods.bicycle.mountain', 'services.repairs.bicycle', 'social.language-exchange']) {
      expect(categoryGate(c), c).toEqual({ ok: true, known: true });
    }
  });

  it('refuses a reserved family, whether or not the leaf itself is written down', () => {
    // The ordering the old gate got wrong. social.dating is reserved, so
    // everything beneath it is reserved too — and an unknown child of it used
    // to come back 'unknown', which under the new rule would have let it up.
    expect(categoryStatus('social.dating.speed-dating-nights').status).toBe('unknown');
    expect(categoryGate('social.dating.speed-dating-nights')).toMatchObject({
      ok: false,
      refusal: 'reserved',
    });
    expect(categoryGate('services.trades.electrical')).toMatchObject({ refusal: 'reserved' });
    expect(categoryGate('services.trades.solar-battery-install')).toMatchObject({
      ok: false,
      refusal: 'reserved',
    });
  });

  it('refuses a reserved top level and one the taxonomy has no name for', () => {
    expect(categoryGate('work.freelance')).toMatchObject({ ok: false, refusal: 'reserved' });
    expect(categoryGate('property.rental.sharehouse')).toMatchObject({ ok: false, refusal: 'reserved' });
    expect(categoryGate('nonsense.thing')).toMatchObject({ ok: false, refusal: 'unknown' });
    expect(categoryGate('nonsense.thing').reason).toContain("top level 'nonsense'");
  });
});

// ---------------------------------------------------------------------------
describe('what the thing is, in the agent own words', () => {
  it('takes a short noun phrase', () => {
    for (const k of ['vintage synth repair', 'bouldering partner', 'sourdough starter', 'a lift to Sydney']) {
      expect(kindComplaint(k), k).toBeUndefined();
    }
  });

  it('refuses what is missing, priced, prose, or somebody contact details', () => {
    expect(kindComplaint(undefined)).toMatch(/say in a few plain words/);
    expect(kindComplaint('   ')).toMatch(/say in a few plain words/);
    expect(kindComplaint('2019 mountain bike')).toMatch(/plain words rather than numbers/);
    expect(kindComplaint('bike $400')).toMatch(/plain words rather than numbers/);
    expect(kindComplaint('bike, best price $')).toMatch(/carries no price/);
    expect(kindComplaint('ring me on sam@example.com')).toMatch(/no email address/);
    expect(kindComplaint('see www.example.com')).toMatch(/no email address/);
    expect(kindComplaint('a really rather nice old second-hand push bike')).toMatch(/6 words at most/);
    expect(kindComplaint('x'.repeat(61))).toMatch(/sixty characters/);
  });

  it('is the first thing the screen reads on a posting', () => {
    // It leads the free text, because on a card filed under an unknown leaf it
    // is the only part that says what the thing IS.
    expect(collectFreeText({ kind: 'vintage synth repair', attributes: { condition: 'good' } })).toEqual([
      'kind: vintage synth repair',
      'condition: good',
    ]);
    expect(collectFreeText({ kind: null, attributes: { condition: 'good' } })).toEqual([
      'condition: good',
    ]);
  });

  it('rides the embedding, where the sort order cannot move it', () => {
    const t = projectionText({
      category: 'services.repairs.vintage-synthesiser',
      kind: 'Vintage Synth Repair',
      attributes: { turnaround: 'two weeks' },
    });
    expect(t).toContain('kind: vintage synth repair');
    expect(t.indexOf('kind:')).toBeLessThan(t.indexOf('turnaround:'));
    // And it is simply absent where nobody gave one.
    expect(projectionText({ category: 'goods.bicycle.mountain' })).not.toContain('kind:');
  });
});

// ---------------------------------------------------------------------------
describe('prohibited by meaning', () => {
  const flags = (over: Partial<ModelFlags>): ModelFlags => ({
    prompt_injection: false,
    pii: false,
    stolen_goods_markers: false,
    recalled_goods: false,
    prohibited: false,
    note: '',
    ...over,
  });

  it('carries the four codes that describe a thing rather than a place in the tree', () => {
    for (const c of ['drugs', 'sexual-services', 'illegal-activity', 'people']) {
      expect(PROHIBITED_REASONS, c).toContain(c);
    }
    // And the path-glob codes the seed already had, so one verdict serves both.
    for (const c of ['weapons', 'prescription-medication', 'live-animals', 'wildlife-products']) {
      expect(PROHIBITED_REASONS, c).toContain(c);
    }
  });

  it('keeps a code this network knows and falls back on one it does not', () => {
    expect(prohibitedReason(flags({ prohibited: true, prohibited_reason: 'people' }))).toBe('people');
    // A refusal is still a refusal when the model names something unheard of:
    // it said the thing may not go up, and that part is not in doubt.
    expect(prohibitedReason(flags({ prohibited: true, prohibited_reason: 'gizmos' }))).toBe('prohibited');
    expect(prohibitedReason(flags({ prohibited: true }))).toBe('prohibited');
  });
});

// ---------------------------------------------------------------------------
describe('the sentences still read as English for a leaf nobody wrote down', () => {
  // Three of them, as the decision asked: a countable thing, a mass noun, and
  // one that starts with a vowel.
  const EXAMPLES = [
    { category: 'social.bouldering-partner', kind: 'bouldering partner', reads: 'a bouldering partner' },
    {
      category: 'services.repairs.vintage-synthesiser',
      kind: 'vintage synth repair',
      reads: 'vintage synth repair',
    },
    { category: 'goods.espresso-machine', kind: 'espresso machine', reads: 'an espresso machine' },
  ];

  it('says the thing the way a person would say it', () => {
    for (const e of EXAMPLES) {
      expect(categoryPhraseWithArticle(e.category, e.kind), e.kind).toBe(e.reads);
      expect(categoryPhrase(e.category, e.kind), e.kind).toBe(e.kind);
    }
  });

  it('reads inside the sentences the sweep actually writes', () => {
    for (const e of EXAMPLES) {
      const thing = categoryPhraseWithArticle(e.category, e.kind);
      const sentence = `Someone nearby has ${thing} going that could be what you're after.`;
      expect(sentence).toContain(e.reads);
      // Nothing that looks like a path, a slug or a code reaches a human: the
      // only full stop in it is the one that ends the sentence.
      expect(thing).not.toContain('.');
      expect(thing).not.toContain('-');
      expect(thing).not.toContain('_');
      expect(sentence.match(/\./g)).toHaveLength(1);
    }
  });

  it('gives a plural and a mass noun no article, and everything else one', () => {
    expect(kindTakesArticle('bouldering partner')).toBe(true);
    expect(kindTakesArticle('espresso machine')).toBe(true);
    expect(kindTakesArticle('bouldering mats')).toBe(false);
    expect(kindTakesArticle('vintage synth repair')).toBe(false);
    expect(kindTakesArticle('climbing gear')).toBe(false);
    // Already carries its own article: "a a lift to Sydney" is the one failure
    // a human would be certain about.
    expect(kindTakesArticle('a lift to Sydney')).toBe(false);
    expect(categoryPhraseWithArticle('services.lift-to-sydney', 'a lift to Sydney')).toBe(
      'a lift to sydney',
    );
    // A word that ends in s and is not a plural still takes one.
    expect(kindTakesArticle('chess set')).toBe(true);
  });

  it('never lets the poster words override a node the taxonomy does know', () => {
    // The catalogue's hand-written phrase is better than anybody free text
    // wherever there is one, so `kind` is a fallback and never an override.
    expect(categoryPhraseWithArticle('goods.bicycle.mountain', 'pushie')).toBe('a mountain bike');
    expect(categoryLeafLabel('goods.bicycle.mountain', 'pushie')).toBe('Mountain bikes');
  });

  it('gives an email the poster words instead of a slug', () => {
    expect(categoryLeafLabel('services.repairs.vintage-synthesiser', 'vintage synth repair')).toBe(
      'vintage synth repair',
    );
    // With nothing given, the honest fallback it always had.
    expect(categoryLeafLabel('services.repairs.vintage-synthesiser')).toBe('vintage-synthesiser');
  });
});

describe('a deny-listed path is refused at the door, before kind is asked for', () => {
  it('goods.weapons without kind is CATEGORY_PROHIBITED, never a kind complaint', async () => {
    const { assertCategoryOpen } = await import('../../src/domain/cards.js');
    await expect(assertCategoryOpen(undefined as any, 'goods.weapons', 'acct')).rejects.toMatchObject({
      message: 'CATEGORY_PROHIBITED',
      payload: { code: 'CATEGORY_PROHIBITED' },
    });
  });
});
