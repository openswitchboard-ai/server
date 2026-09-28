/**
 * THE WORDS A PERSON READS ON THEIR OWN PAGES (28 September 2026).
 *
 * The pages are for people, and people read "assistant", "want" and "have",
 * "suburb" and "match". Five branches of fixes merged on one day and a sweep
 * still found "agent", "introduction" and a raw settlement state on pages. This
 * suite renders the main pages with fixture views and reads only what a person
 * can see: the text, and the placeholder, label and title a browser shows.
 * Scripts, styles, class names, ids and form values are code and are skipped.
 *
 * The one allowed "agents" is the approved option on the how-you-hear
 * question, "Best suited to always-on agents.", kept exactly as approved.
 */
import { describe, expect, it } from 'vitest';

import * as cpages from '../../src/counter/pages.js';
import * as home from '../../src/counter/pagesHome.js';
import { groupWaitingByMatch, mergeSteps, type MatchBoxView } from '../../src/counter/matchStory.js';
import { buildSteps, type StoryFacts } from '../../src/domain/matchStory.js';
import { screeningReasonInPlainWords } from '../../src/domain/screening.js';
import type { SettlementState } from '../../src/domain/settlements.js';

const APPROVED_AGENTS = 'Best suited to always-on agents.';

/** Everything on a page a person can read, and nothing that is only code. */
function visibleText(html: string): string {
  const shown: string[] = [];
  for (const m of html.matchAll(/\s(?:placeholder|aria-label|title|alt)="([^"]*)"/g)) shown.push(m[1]!);
  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? '';
  const body = html
    .replace(/<head>[\s\S]*?<\/head>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  return [title, body, ...shown]
    .join(' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&[lr]dquo;|&#822[01];/g, '"')
    .replace(/\s+/g, ' ');
}

const RULES: [string, RegExp][] = [
  // "Card processing" is the payment card, and is the one card a page names.
  ['card', /\bcards?\b(?! process)/i],
  ['listing', /\blistings?\b/i],
  ['locality', /\blocality\b/i],
  ['Authorize', /\bauthoriz(e|ed|es|ing)\b/i],
  ['machine state', /\b(PUBLISHED|PENDING_SCREENING|SCREENING_REJECTED|WITHDRAWN|EXPIRED)\b/],
  ['agent', /\bagents?\b/i],
];

function complaints(html: string): string[] {
  const text = visibleText(html).split(APPROVED_AGENTS).join(' ');
  const out: string[] = [];
  for (const [name, re] of RULES) {
    const m = re.exec(text);
    if (m) {
      const at = Math.max(0, m.index - 40);
      out.push(`${name}: …${text.slice(at, m.index + m[0].length + 40)}…`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------
const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BUYER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SELLER = 'cccccccc-3333-4333-8333-cccccccccccc';
const OFFER = '0f0f0f0f-0000-4000-8000-000000000290';
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 27, h, m));
const NOW = at(12);
const LATER = new Date(Date.UTC(2026, 9, 3));
const DAY = (iso: string) => cpages.localTime(iso, 'day');

function facts(): StoryFacts {
  return {
    viewer: BUYER,
    match: { id: MATCH, state: 'open', stage: 4, created_at: at(1), account_want: BUYER, account_have: SELLER },
    theirName: 'Tony',
    optIns: [
      { account_id: BUYER, recorded_at: at(2) },
      { account_id: SELLER, recorded_at: at(2, 30) },
    ],
    photos: [{ account_id: SELLER, at: at(3) }],
    messages: [
      { sender_account: BUYER, at: at(3, 10) },
      { sender_account: SELLER, at: at(3, 20) },
    ],
    offers: [
      {
        id: 'o-280',
        proposer_account: BUYER,
        amount: '280',
        ccy: 'AUD',
        state: 'withdrawn',
        created_at: at(4),
        updated_at: at(4, 30),
        expiry: LATER,
      },
      {
        id: OFFER,
        proposer_account: SELLER,
        amount: '290',
        ccy: 'AUD',
        state: 'proposed',
        created_at: at(5),
        updated_at: at(5),
        expiry: LATER,
        note: "Here's what I can do.",
      },
    ],
  };
}

function box(): MatchBoxView {
  const g = groupWaitingByMatch(
    {
      openLinks: [
        {
          id: '11111111-0000-4000-8000-000000000001',
          action: 'offer-send' as const,
          ref_id: MATCH,
          amount: '280',
          ccy: 'AUD',
          category: 'goods.bicycles.road',
          payload: JSON.stringify({ amount: 285, ccy: 'AUD', good_for_days: 7, note: 'final offer' }),
          created_at: at(6),
          expires_at: at(6, 15),
        },
      ],
      offers: [{ offer_id: OFFER, match_id: MATCH, amount: '290', ccy: 'AUD' }],
      disclosures: [],
      settlements: [],
      messages: [],
    } as any,
    NOW,
  ).byMatch.get(MATCH)!;
  return {
    head: { matchId: MATCH, thing: 'road bike', theirName: 'Tony', theirArea: 'Braddon' },
    steps: mergeSteps(buildSteps(facts(), NOW), g.steps),
    actions: g.actions,
  };
}

const SETTLEMENT_STATES: SettlementState[] = [
  'proposed',
  'approved-by-buyer',
  'approved-by-seller',
  'approved',
  'funded',
  'evidence-locked',
  'confirmed',
  'disputed',
  'resolution-proposed',
  'resolved',
  'released',
  'refunded',
  'settled-split',
  'declined',
];

const settings = (over: Partial<home.EmailSettingsView> = {}): home.EmailSettingsView => ({
  hearsVia: 'email',
  timezone: 'Australia/Sydney',
  freqMatches: 'immediate',
  freqDigests: 'daily',
  complaintSuppressed: true,
  emailUnreachable: true,
  sharedProfile: 'Ana, Braddon',
  approveWith: { pin: true, passkey: true },
  arrangementSummary: 'Set: between conversations, quiet hours.',
  keyCount: 1,
  ...over,
});

const question = (over: Partial<cpages.OneQuestionView>): cpages.OneQuestionView => ({
  token: 'osb_tok',
  question: 'Send $280 AUD for the road bike?',
  yesLabel: 'Send',
  noLabel: 'Not now',
  needsPin: true,
  hasPin: true,
  hasPasskey: true,
  elevated: false,
  money: true,
  ...over,
});

const PAGES: { name: string; html: string }[] = [
  {
    name: 'main page with boxes',
    html: home.dashboardPage({
      notice: 'Saved. Every assistant you have connected picks this up on its next check.',
      firstName: 'Ana',
      emailUnreachable: true,
      killSwitchOn: false,
      ceremony: { hasPin: true, hasPasskey: true, elevated: false },
      cardCounts: { total: 3, published: 2, pending: 1 },
      matchBoxes: [box()],
      timezone: 'Australia/Sydney',
      lapsingSoon: { count: 2, soonest: DAY('2026-10-01T00:00:00.000Z') },
      inProgress: [{ href: '/matches/m-2', title: 'Kayak', last: 'Tony sent a message' }],
      messagesWaiting: [{ matchId: 'm-3', category: 'goods.bicycles.road', count: 2 } as any],
      agreed: [{ matchId: 'm-4', category: 'goods.bicycles.road', amount: '$290 AUD' } as any],
      pendingApprovals: [
        {
          label: 'Your road bike needs a change.',
          // The fallback already ends with the tile's line (routes.ts says it once).
          lines: [screeningReasonInPlainWords('some-code-with-no-words-yet')],
        },
        {
          label: 'Your road bike needs a change.',
          lines: [screeningReasonInPlainWords('pii-in-card'), home.REJECTED_TILE_LINE],
        },
        { href: '/approvals/offer/o-1', label: 'Offer on your road bike match', amount: '290 AUD' },
        { href: '/approvals/match/m-1', label: 'Share your details on your road bike match?' },
        ...SETTLEMENT_STATES.map((st) => ({
          href: '/settlements/s-1',
          label: home.settlementTileLabel('road bike', st, st === 'proposed'),
          amount: '290 AUD',
        })),
        {
          href: '/settlements/s-2',
          label: home.settlementTileLabel('road bike', 'some-state-added-later', false),
          amount: '290 AUD',
        },
      ],
    }),
  },
  {
    name: 'main page, everything stopped, passkey only',
    html: home.dashboardPage({
      killSwitchOn: true,
      ceremony: { hasPin: false, hasPasskey: true, elevated: false },
      cardCounts: { total: 0, published: 0, pending: 0 },
      pendingApprovals: [],
    }),
  },
  {
    name: 'ledger',
    html: home.ledgerPage(
      [
        {
          id: 'c-1',
          type: 'WANT',
          title: 'road bike',
          sentence: home.attributesSentence({ condition: 'good', frame: 'large' }),
          state: 'live',
          until: DAY('2026-10-01T00:00:00.000Z'),
          reach: 'within 25 km of Braddon, Australian Capital Territory, Australia',
          hasLimit: true,
          introduced: 3,
          mode: 'relay',
          lapsingSoon: true,
        },
        {
          id: 'c-2',
          type: 'HAVE',
          title: 'kayak',
          state: 'needs a change',
          reason: screeningReasonInPlainWords('some-code-with-no-words-yet'),
          until: DAY('2026-10-01T00:00:00.000Z'),
          reach: 'anywhere in Australia',
          hasLimit: false,
          introduced: 0,
          mode: 'mandate',
        },
        {
          id: 'c-3',
          type: 'HAVE',
          title: 'tent',
          state: 'being checked',
          until: DAY('2026-10-01T00:00:00.000Z'),
          reach: 'anywhere',
          hasLimit: false,
          introduced: 0,
          mode: 'relay',
        },
        {
          id: 'c-4',
          type: 'WANT',
          title: 'desk',
          state: 'taken down',
          until: DAY('2026-10-01T00:00:00.000Z'),
          reach: 'anywhere',
          hasLimit: false,
          introduced: 1,
          mode: 'relay',
        },
        {
          id: 'c-5',
          type: 'WANT',
          title: 'lamp',
          state: 'lapsed',
          until: DAY('2026-09-01T00:00:00.000Z'),
          reach: 'anywhere',
          hasLimit: false,
          introduced: 0,
          mode: 'relay',
        },
      ],
      'Taken down.',
      [{ category: 'book club', who: 'Alex, Franklin' } as any],
    ),
  },
  { name: 'settings hub', html: home.settingsPage(settings()) },
  { name: 'settings hub, hears through the assistant', html: home.settingsPage(settings({ hearsVia: 'assistant' })) },
  {
    name: 'arrangement',
    html: home.arrangementPage(
      {
        runs_on_its_own: true,
        check_every_minutes: 720,
        interrupt_for: ['a new match'],
        summarize: 'a round-up on Sunday evening',
        suggestion_appetite: 'occasional',
        quiet_hours: 'after 9pm and before 7am',
        notes: 'weekends are fine',
      },
      { notice: 'Saved.', hearsVia: 'assistant', updated: DAY('2026-09-02T04:00:00.000Z') },
    ),
  },
  { name: 'arrangement, empty', html: home.arrangementPage({}) },
  { name: 'profile, empty', html: home.sharedProfilePage({ firstName: '', locality: '' }) },
  {
    name: 'profile, filled',
    html: home.sharedProfilePage(
      { firstName: 'Ana', locality: 'Braddon' },
      { notice: 'Saved. This is what a match sees once you both say yes.' },
    ),
  },
  {
    name: 'agent keys',
    html: home.agentKeysPage(
      {
        keys: [
          {
            keyId: 'k-1',
            name: 'the laptop',
            created: DAY('2026-09-01T00:00:00.000Z'),
            lastUsed: DAY('2026-09-02T00:00:00.000Z'),
            expires: DAY('2026-11-30T00:00:00.000Z'),
          },
        ],
        hasPin: false,
        hasPasskey: true,
        elevated: false,
        atLimit: false,
      },
      'Revoked. Anything still using that key stops working right now.',
    ),
  },
  {
    name: 'agent keys, at the limit',
    html: home.agentKeysPage({ keys: [], hasPin: true, hasPasskey: false, elevated: false, atLimit: true }),
  },
  { name: 'one question: send a figure', html: cpages.oneQuestionPage(question({})) },
  {
    name: 'one question: send a figure, wrong PIN',
    html: cpages.oneQuestionPage(question({}), cpages.PIN_WRONG_SENTENCE),
  },
  {
    name: 'one question: accept a figure, main page road',
    html: cpages.oneQuestionPage(
      question({
        token: undefined,
        session: { action: 'offer-accept', refId: OFFER },
        question: 'Accept $290 AUD for the road bike?',
        yesLabel: 'Accept',
        detail: ['This figure is 3 times your usual.'],
      }),
    ),
  },
  {
    name: 'one question: share names, collecting them',
    html: cpages.oneQuestionPage(
      question({
        question: 'Share your first name and suburb with the other side?',
        yesLabel: 'Share',
        money: false,
        hasPin: false,
        collectProfile: { firstName: '', locality: '' },
      }),
    ),
  },
  { name: 'done, link road', html: cpages.donePage('Accepted', '<p>The number is agreed. Your assistant takes it from here.</p>') },
  {
    name: 'done, main page road',
    html: cpages.donePage(
      'Shared',
      '<p>Your go-ahead is recorded. Nothing goes over until the other side says yes too.</p>',
      '/',
      'Back to your main page',
    ),
  },
  {
    name: 'settlement approval',
    html: cpages.settlementApprovalPage({
      refId: 's-1',
      question: 'Agree to pay $292.15 AUD for the road bike?',
      detail: [
        "That is the $290 AUD you agreed, a $1 AUD introductory fee, and $1.15 AUD for card processing at Stripe's standard rate.",
        'The money is held until you say it arrived as agreed. The seller then receives the $290 AUD in full.',
      ],
      hasPin: true,
      hasPasskey: true,
      elevated: false,
    }),
  },
  {
    name: 'numbers page, pass on',
    html: home.cardNumbersPage({ id: 'c-1', type: 'HAVE', category: 'goods.bicycles.road', mode: 'relay' }),
  },
  {
    name: 'numbers page, auto-negotiate',
    html: home.cardNumbersPage({
      id: 'c-1',
      type: 'WANT',
      category: 'goods.bicycles.road',
      mode: 'mandate',
      mandate: { open: 250, limit: 300, ccy: 'AUD' },
      ceremony: { hasPin: true, hasPasskey: false, elevated: false },
    }),
  },
  { name: 'unsubscribe', html: home.unsubPage('osb_em_tok') },
  { name: 'landing', html: cpages.landingPage() },
  { name: 'registration closed', html: cpages.registrationClosedPage() },
];

// ---------------------------------------------------------------------------
describe('the words on the pages a person reads', () => {
  for (const p of PAGES) {
    it(`${p.name}: no card, listing, locality, Authorize, machine state or agent`, () => {
      expect(complaints(p.html)).toEqual([]);
    });
  }

  it('the approved how-you-hear option is kept exactly, and is the only "agents"', () => {
    const page = home.settingsPage(settings());
    expect(visibleText(page)).toContain(APPROVED_AGENTS);
  });

  it('the payment tile says where a payment stands in words, never its state', () => {
    for (const st of SETTLEMENT_STATES) {
      const label = home.settlementTileLabel('road bike', st, false);
      expect(label.startsWith('Payment on your road bike match'), st).toBe(true);
      // No state name: nothing hyphenated, nothing in brackets.
      expect(label, st).not.toMatch(/[()]|\w-\w/);
    }
    expect(home.settlementTileLabel('road bike', 'proposed', true)).toBe(
      'Payment on your road bike match: waiting for your approval',
    );
    expect(home.settlementTileLabel('road bike', 'funded', false)).toBe(
      'Payment on your road bike match: paid, waiting for handover',
    );
    expect(home.settlementTileLabel('road bike', 'disputed', false)).toBe('Payment on your road bike match: on hold');
    expect(home.settlementTileLabel('road bike', 'nothing-known', false)).toBe('Payment on your road bike match');
  });

  it('the fallback reason asks for the assistant, with the tile line routes.ts then leaves off', () => {
    const fallback = screeningReasonInPlainWords('no-words-yet');
    expect(fallback).not.toContain('edit what you posted');
    expect(fallback.endsWith(home.REJECTED_TILE_LINE)).toBe(true);
  });

  // The lint itself: it has to catch what it says it catches, or a green run
  // proves nothing.
  it('catches each word it is there for, and skips code', () => {
    expect(complaints('<p>Your agent posts cards.</p>').map((c) => c.split(':')[0])).toEqual(['card', 'agent']);
    expect(complaints('<p>State: PUBLISHED</p>')).toHaveLength(1);
    expect(complaints('<p>Authorize it</p>')).toHaveLength(1);
    expect(complaints('<p>Your locality</p>')).toHaveLength(1);
    expect(complaints('<p>A listing</p>')).toHaveLength(1);
    expect(complaints('<input placeholder="the laptop agent">')).toHaveLength(1);
    expect(complaints('<div class="card-row" data-card-id="x"><a href="/agent-keys">Keys</a></div>')).toEqual([]);
    expect(complaints('<script>var agent = "card";</script><style>.card{}</style>')).toEqual([]);
    expect(complaints('<p>$1.15 AUD for card processing.</p>')).toEqual([]);
  });
});
