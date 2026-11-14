import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignRows,
  buyerPostingFor,
  checkAlsoWantedMeets,
  checkAlsoWantedPosting,
  checkBuyerIdentifier,
  checkListDetails,
  checkListMustSay,
  checkListSplit,
  checkTradesTold,
  LIST_CALL_MAX_ITEMS,
  PART_TO_GO,
  TRADE_WORDS,
  TRADES_UNAVAILABLE,
  type CardFacts,
} from '../../rehearsal/checks.js';
import type { AlsoWanted, ListRowSpec } from '../../rehearsal/data.js';
import { MEANINGS } from '../../rehearsal/meaning.js';
import { listCallShapes, tracedCalls } from '../../rehearsal/trace.js';

// General rows: one thing in two finishes under one code, one code in two
// series, two codes that collide once their marks are gone, a graded thing,
// and one thing from outside what the rest of the list is.
const ROWS: ListRowSpec[] = [
  { name: 'Teapot', identifier: '025/165', condition: 'Good', words: ['blue range'] },
  { name: 'Teapot', identifier: '025/165', condition: 'Good', words: ['blue range', 'gold rim'], details: ['gold rim'] },
  { name: 'Lamp', identifier: '4/102', condition: 'Worn', words: ['first run'] },
  { name: 'Clock', identifier: '4/102', condition: 'Good', words: ['second run'] },
  { name: 'Kettle', identifier: '002/198', condition: 'Worn', words: ['old line'] },
  { name: 'Vase', identifier: '21/98', condition: 'Good', words: ['new line'] },
  { name: 'Platter', identifier: '215/203', condition: 'GRD 10', words: ['tall series'] },
  { name: 'Board', identifier: 'BRD-001', condition: 'Good', words: ['games'], mustSay: ['board game'] },
];

function item(id: string, kind: string, value: string | undefined, attrs: Record<string, unknown>, type = 'HAVE'): CardFacts {
  return {
    id,
    accountId: 'a',
    type,
    category: 'goods.home',
    kind,
    attributes: attrs,
    ask: null,
    sale: 'straight',
    geoRadiusKm: null,
    geoCountry: 'AU',
    state: 'PENDING_SCREENING',
    createdAt: '',
    identifiers: value ? [{ kind: 'printed code', value }] : [],
    listId: type === 'HAVE' ? 'L' : null,
  };
}

const sellerItems = (): CardFacts[] => [
  // The gold-rim twin first, so a tie broken on order alone would give it to the plain row.
  item('t-gold', 'Teapot', '025/165', { condition: 'good', range: 'blue range', finish: 'gold rim' }),
  item('t-plain', 'Teapot', '25/165', { condition: 'good', range: 'blue range' }),
  item('clock', 'Clock', '4/102', { condition: 'good', series: 'second run' }),
  item('lamp', 'Lamp', '4/102', { condition: 'worn', series: 'first run' }),
  item('kettle', 'Kettle', '002/198', { condition: 'worn', line: 'old line' }),
  item('vase', 'Vase', '21/98', { condition: 'good', line: 'new line' }),
  // Grade and company as two details, walked out as "10 GRD".
  item('platter', 'Platter', '215/203', { grade: 10, grading_company: 'GRD', series: 'tall series' }),
  item('board', 'Board game', 'BRD-001', { condition: 'good', about: 'games' }),
];

describe('telling twins apart', () => {
  it('breaks a shared-code tie on the telling words, not on order or condition', () => {
    const a = assignRows(sellerItems(), ROWS);
    expect(a.map((x) => x.card?.id)).toEqual(['t-plain', 't-gold', 'lamp', 'clock', 'kettle', 'vase', 'platter', 'board']);
  });
  it('wants the detail that tells an item from its twin on the item', () => {
    const ok = checkListDetails(ROWS, assignRows(sellerItems(), ROWS));
    expect(ok.verdict).toBe('pass');
    const bare = sellerItems().map((c) => (c.id === 't-gold' ? { ...c, attributes: { condition: 'good', range: 'blue range' } } : c));
    const c = checkListDetails(ROWS, assignRows(bare, ROWS));
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toMatch(/"gold rim" not on the item/);
  });
  it('reads a grade and its company in either order', () => {
    const a = assignRows(sellerItems(), ROWS);
    expect(checkListDetails(ROWS, a).verdict).toBe('pass');
    const together = sellerItems().map((c) => (c.id === 'platter' ? { ...c, attributes: { condition: 'GRD 10', series: 'tall series' } } : c));
    expect(checkListDetails(ROWS, assignRows(together, ROWS)).verdict).toBe('pass');
    const wrong = sellerItems().map((c) => (c.id === 'platter' ? { ...c, attributes: { grade: 9, grading_company: 'GRD' } } : c));
    expect(checkListDetails(ROWS, assignRows(wrong, ROWS)).evidence).toMatch(/condition "GRD 10" not on the item/);
  });
});

describe('the buyer\'s want and its code', () => {
  it('fails a want whose code only collides with the target once the marks are gone', () => {
    const want = item('w', 'Vase', '002/198', {}, 'WANT');
    expect(checkBuyerIdentifier(want, ROWS[5]).verdict).toBe('fail');
    expect(checkBuyerIdentifier({ ...want, identifiers: [{ kind: 'code', value: '21/98' }] }, ROWS[5]).verdict).toBe('pass');
    expect(checkBuyerIdentifier({ ...want, identifiers: [{ kind: 'code', value: 'New Line 21/98' }] }, ROWS[5]).verdict).toBe('pass');
  });
  it('picks the posting for the row by code and telling words, not the first one up', () => {
    const wants = [
      item('w-kettle', 'Kettle', '002/198', {}, 'WANT'),
      item('w-plain', 'Teapot', '025/165', { range: 'blue range' }, 'WANT'),
      item('w-gold', 'Teapot', '025/165', { range: 'blue range', finish: 'gold rim' }, 'WANT'),
      item('w-vase', 'Vase', '21/98', { line: 'new line' }, 'WANT'),
    ];
    expect(buyerPostingFor(wants, 5, ROWS)).toMatchObject({ card: { id: 'w-vase' }, fit: 'exact' });
    expect(buyerPostingFor(wants, 1, ROWS)).toMatchObject({ card: { id: 'w-gold' }, fit: 'exact' });
    // The plain row: the gold-rim want says its twin's word, so the plain want fits better.
    expect(buyerPostingFor(wants, 0, ROWS).card?.id).toBe('w-plain');
    // Nothing for the clock.
    expect(buyerPostingFor(wants, 3, ROWS).card).toBeUndefined();
    // A want with no code answers by name and every telling word.
    const byWords = [item('w-clock', 'Clock', undefined, { series: 'second run' }, 'WANT')];
    expect(buyerPostingFor(byWords, 3, ROWS)).toMatchObject({ card: { id: 'w-clock' }, fit: 'words' });
  });
});

describe('more than one thing wanted', () => {
  const ALSO: AlsoWanted[] = [
    { row: 1, notRow: 0 },
    { row: 3, notRow: 2 },
  ];
  const good = [
    item('w-gold', 'Teapot', '25/165', { range: 'blue range', finish: 'gold rim' }, 'WANT'),
    item('w-clock', 'Clock', '4/102', { series: 'second run' }, 'WANT'),
  ];
  it('wants each posting to carry the code and the words that tell it apart', () => {
    expect(checkAlsoWantedPosting(good, ROWS, ALSO).verdict).toBe('pass');
    const noFinish = [{ ...good[0], attributes: { range: 'blue range' } }, good[1]];
    const c = checkAlsoWantedPosting(noFinish, ROWS, ALSO);
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toMatch(/does not say "gold rim"/);
    const wrongSeries = [good[0], { ...good[1], attributes: { series: 'second run first run' } }];
    expect(checkAlsoWantedPosting(wrongSeries, ROWS, ALSO).evidence).toMatch(/belongs to Lamp 4\/102/);
    expect(checkAlsoWantedPosting([good[0]], ROWS, ALSO).evidence).toMatch(/no posting for Clock 4\/102/);
  });
  it('wants any introduction on the row\'s own item, and no sure one on its neighbour', () => {
    const assigned = assignRows(sellerItems(), ROWS);
    const d = (id: string) => id;
    const m = (cardWant: string, cardHave: string, certainty: string) => ({ id: `${cardWant}-${cardHave}`, cardWant, cardHave, certainty, score: 0.8 });
    expect(checkAlsoWantedMeets([], good, ROWS, ALSO, assigned, d).verdict).toBe('skip');
    expect(checkAlsoWantedMeets([m('w-gold', 't-gold', 'sure'), m('w-clock', 'clock', 'sure')], good, ROWS, ALSO, assigned, d).verdict).toBe('pass');
    // A maybe on the twin beside the right one is reported, not failed.
    expect(checkAlsoWantedMeets([m('w-gold', 't-gold', 'sure'), m('w-gold', 't-plain', 'possible')], good, ROWS, ALSO, assigned, d).verdict).toBe('pass');
    const sureOnTwin = checkAlsoWantedMeets([m('w-gold', 't-gold', 'sure'), m('w-gold', 't-plain', 'sure')], good, ROWS, ALSO, assigned, d);
    expect(sureOnTwin.verdict).toBe('fail');
    expect(sureOnTwin.evidence).toMatch(/must not be taken for/);
    expect(checkAlsoWantedMeets([m('w-clock', 'lamp', 'possible')], good, ROWS, ALSO, assigned, d).evidence).toMatch(/met only other items/);
  });
});

describe('a list bigger than one call', () => {
  const items = (n: number, list = 'L'): CardFacts[] =>
    Array.from({ length: n }, (_, i) => ({ ...item(`i${i}`, 'Thing', `T-${1000 + i}`, {}), listId: list }));
  it('holds the harness\'s limit to the switchboard\'s', () => {
    const src = readFileSync(join(__dirname, '../../../src/domain/lists.ts'), 'utf8');
    expect(Number(/export const LIST_CALL_MAX_ITEMS = (\d+);/.exec(src)?.[1])).toBe(LIST_CALL_MAX_ITEMS);
  });
  it('is not scored where the list fits in one call', () => {
    expect(checkListSplit({ rows: 29, calls: [{ items: 29 }], items: items(29) }).verdict).toBe('skip');
  });
  it('passes two calls to one list, all sent in one turn', () => {
    const c = checkListSplit({ rows: 208, calls: [{ items: 200 }, { items: 8, listId: 'L' }], items: items(208), upAtFirst: 208, firstUpSaid: 'All 208 are up.' });
    expect(c.verdict).toBe('pass');
  });
  it('passes the rest sent later where the human was told part was still to go', () => {
    const c = checkListSplit({
      rows: 208,
      calls: [{ items: 200 }, { items: 8, listId: 'L' }],
      items: items(208),
      upAtFirst: 200,
      firstUpSaid: 'The first 200 are up; a call takes 200 at most, so the other 8 go in a second batch. Shall I send them?',
    });
    expect(c.verdict).toBe('pass');
  });
  it('fails a call over the limit, a later call without the list, two lists, and silence about the rest', () => {
    expect(checkListSplit({ rows: 208, calls: [{ items: 208 }, { items: 200 }, { items: 8, listId: 'L' }], items: items(208) }).evidence).toMatch(/call 1 carried 208/);
    expect(checkListSplit({ rows: 208, calls: [{ items: 200 }, { items: 4, listId: 'L' }, { items: 4 }], items: items(208) }).evidence).toMatch(/call 3 went without/);
    expect(checkListSplit({ rows: 208, calls: [{ items: 200 }, { items: 8 }], items: [...items(200), ...items(8, 'M')] }).evidence).toMatch(/ended on 2 lists/);
    const silent = checkListSplit({ rows: 208, calls: [{ items: 200 }], items: items(200), upAtFirst: 200, firstUpSaid: 'Your cards are up.' });
    expect(silent.verdict).toBe('fail');
    expect(silent.evidence).toMatch(/8 of 208 were still to go/);
  });
  it('judges the database alone where the client keeps no record of its calls', () => {
    const c = checkListSplit({ rows: 208, calls: undefined, items: items(208), upAtFirst: 208, firstUpSaid: 'All up.' });
    expect(c.verdict).toBe('pass');
    expect(c.evidence).toMatch(/keeps no record/);
  });
  it('reads the rest-to-go a few ways', () => {
    for (const t of ['the remaining 8 are next', '8 more to go', 'I will send the rest now?', "they didn't all fit in one go", 'only 200 went up so far']) {
      expect(PART_TO_GO.test(t), t).toBe(true);
    }
    expect(PART_TO_GO.test('All of them are up and live.')).toBe(false);
  });
  it('reads the size and the list off each traced call', () => {
    const trace = [
      JSON.stringify({ type: 'tool_use', name: 'mcp__osb__publish_list', input: { items: [{}, {}], shared: {} } }),
      JSON.stringify({ type: 'tool_use', name: 'mcp__osb__publish_list', input: { items: [{}], list_id: 'abc', reference: 'r1' } }),
    ].join('\n');
    expect(listCallShapes(tracedCalls(trace, 'publish_list'))).toEqual([{ items: 2 }, { items: 1, listId: 'abc', reference: true }]);
  });
});

describe('a thing unlike the rest says what it is', () => {
  it('wants a must-say word in the item\'s own words, not the shelf', () => {
    const a = assignRows(sellerItems(), ROWS);
    expect(checkListMustSay(ROWS, a).verdict).toBe('pass');
    const plain = sellerItems().map((c) => (c.id === 'board' ? { ...c, kind: 'Board', category: 'board game' } : c));
    const c = checkListMustSay(ROWS, assignRows(plain, ROWS));
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toMatch(/without "board game"/);
    expect(checkListMustSay(ROWS.map(({ mustSay: _m, ...r }) => r), a).verdict).toBe('skip');
  });
});

describe('a human who would rather trade', () => {
  it('knows when the opening asks for a trade', () => {
    expect(TRADE_WORDS.test("I'd much rather swap them for ones I'm missing")).toBe(true);
    expect(TRADE_WORDS.test('can you put my spares up for sale?')).toBe(false);
  });
  it('passes an honest word before the list went up, and fails silence', () => {
    expect(checkTradesTold(["Trading isn't something I can set up here yet, so I can put them up for sale. OK?"]).verdict).toBe('pass');
    expect(checkTradesTold(['I can only list them for sale for now.']).verdict).toBe('pass');
    expect(checkTradesTold(['What prices would you like on them?']).verdict).toBe('fail');
    expect(TRADES_UNAVAILABLE.test('Happy to help you trade them!')).toBe(false);
  });
  it('lets the judge overrule the pattern', () => {
    const d = { told_trades_unavailable: { id: 'told_trades_unavailable' as const, holds: true, by: 'jev' as const, regex: false, values: [0.9, 0.9] } };
    expect(checkTradesTold(['Straight swaps are a no-go on here, so a sale list it is?'], d).verdict).toBe('pass');
    expect(MEANINGS.told_trades_unavailable.instructions).toMatch(/trade or swap/);
  });
});
