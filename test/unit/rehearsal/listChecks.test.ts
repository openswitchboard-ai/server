import { describe, expect, it } from 'vitest';
import {
  assignRows,
  checkBuyerIdentifier,
  checkListFigureReadBack,
  checkListFigures,
  checkListIdentifiers,
  checkListResultsRead,
  checkListUsed,
  checkMeetsOnItem,
  countsSaid,
  identifierForms,
  sameIdentifier,
  type CardFacts,
} from '../../rehearsal/checks.js';
import type { ListRowSpec } from '../../rehearsal/data.js';

// General rows: two things with one name told apart by their printed code, and
// one thing in two states sharing a code.
const ROWS: ListRowSpec[] = [
  { name: 'Lamp shade', identifier: 'AB-0012/3', condition: 'Good' },
  { name: 'Lamp shade', identifier: 'AB-0099/3', condition: 'Good' },
  { name: 'Teapot', identifier: '00451', condition: 'Near new', quantity: 2 },
  { name: 'Teapot', identifier: '00451', condition: 'Worn' },
];

function item(id: string, kind: string, value: string | undefined, attrs: Record<string, unknown>, ask?: number): CardFacts {
  return {
    id,
    accountId: 'a',
    type: 'HAVE',
    category: 'goods.home',
    kind,
    attributes: attrs,
    ask: ask === undefined ? null : { amount: ask, ccy: 'AUD' },
    sale: 'straight',
    geoRadiusKm: null,
    geoCountry: 'AU',
    state: 'PENDING_SCREENING',
    createdAt: '',
    identifiers: value ? [{ kind: 'printed code', value }] : [],
    listId: 'L',
  };
}

describe('identifiers compared as the switchboard compares them', () => {
  it('folds case and punctuation and drops leading zeros in each run of digits', () => {
    expect(identifierForms('025/165')).toEqual(['025165', '25165']);
    expect(sameIdentifier('025/165', '25 / 165')).toBe(true);
    expect(sameIdentifier('125', '125/197')).toBe(false);
  });
});

describe('rows and items', () => {
  const cards = [
    item('c1', 'Lamp shade', 'AB-0099/3', { condition: 'good' }),
    item('c2', 'Lamp shade', 'ab00123', { condition: 'good' }),
    item('c3', 'Teapot', '451', { condition: 'worn' }),
    item('c4', 'Teapot', '00451', { condition: 'near new', quantity: 2 }),
  ];
  it('tells two same-named things apart by code, and one code in two states apart by state', () => {
    const a = assignRows(cards, ROWS);
    expect(a.map((x) => x.card?.id)).toEqual(['c2', 'c1', 'c4', 'c3']);
    expect(checkListIdentifiers(cards, ROWS, a).verdict).toBe('pass');
  });
  it('fails an item with no code and a number that belongs to one object', () => {
    const bad = [...cards.slice(0, 3), item('c4', 'Teapot', undefined, { condition: 'near new', quantity: 2, note: 'serial 99887766' })];
    const a = assignRows(bad, ROWS);
    const c = checkListIdentifiers(bad, ROWS, a, ['99887766']);
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toMatch(/no identifier/);
    expect(c.evidence).toMatch(/belongs to one object/);
  });
  it('a list, not single postings', () => {
    expect(checkListUsed(cards).verdict).toBe('pass');
    expect(checkListUsed([{ ...cards[0], listId: null }]).verdict).toBe('fail');
  });
});

describe('figures on a list', () => {
  const cards = [
    item('c1', 'Lamp shade', 'AB-0012/3', { condition: 'good' }, 40),
    item('c2', 'Lamp shade', 'AB-0099/3', { condition: 'good' }),
    item('c3', 'Teapot', '00451', { condition: 'near new', quantity: 2 }, 14.8),
    item('c4', 'Teapot', '00451', { condition: 'worn' }),
  ];
  it('fails a price the human never gave, on an item they did not price', () => {
    const a = assignRows(cards, ROWS);
    const c = checkListFigures(ROWS, a, { 0: 40 }, [40]);
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toMatch(/never priced/);
  });
  it('passes the human figures on the right items', () => {
    const fine = [cards[0], cards[1], { ...cards[2], ask: null }, cards[3]];
    expect(checkListFigures(ROWS, assignRows(fine, ROWS), { 0: 40 }, [40]).verdict).toBe('pass');
  });
  it('wants the summary said before the list went up', () => {
    expect(checkListFigureReadBack(['Two items carry a price, from $40 to $90. Are those yours?'], [40, 90]).verdict).toBe('pass');
    expect(checkListFigureReadBack(['All done.'], [40, 90]).verdict).toBe('fail');
    expect(checkListFigureReadBack([], []).verdict).toBe('skip');
  });
});

describe('reading the results back', () => {
  it('reads a count said beside the things that went up', () => {
    expect(countsSaid('All 29 cards are up and live.')).toContain(29);
    expect(countsSaid('27 of your items went up; two did not.')).toContain(27);
  });
  it('fails a wrong count and a missing item never mentioned', () => {
    const c = checkListResultsRead(['30 items are up.'], 28, [ROWS[2]]);
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toMatch(/said 30/);
    expect(c.evidence).toMatch(/never mentioned Teapot/);
  });
});

describe('the buyer and the introduction', () => {
  it('a partial code is not the code', () => {
    const want = { ...item('w', 'Lamp shade', '0012', {}), type: 'WANT', listId: null };
    expect(checkBuyerIdentifier(want, ROWS[0]).verdict).toBe('fail');
    expect(checkBuyerIdentifier({ ...want, identifiers: [{ kind: 'code', value: 'ab 12/3' }] }, ROWS[0]).verdict).toBe('pass');
  });
  it('the introduction must be on the item asked for, and sure', () => {
    const d = (id: string) => id;
    expect(checkMeetsOnItem([{ id: 'm1', cardWant: 'w', cardHave: 'c1', certainty: 'sure', score: 0.9 }], 'c1', 'w', d).verdict).toBe('pass');
    expect(checkMeetsOnItem([{ id: 'm1', cardWant: 'w', cardHave: 'c2', certainty: 'sure', score: 0.9 }], 'c1', 'w', d).verdict).toBe('fail');
    expect(checkMeetsOnItem([{ id: 'm1', cardWant: 'w', cardHave: 'c1', certainty: 'possible', score: 0.6 }], 'c1', 'w', d).verdict).toBe('fail');
  });
});
