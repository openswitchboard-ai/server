/**
 * Render the signed-in main page with sample data, to a static HTML file.
 *
 *   npx tsx scripts/render-dashboard-sample.mts [out-dir]
 *
 * The sample is the negotiation from 27 September 2026, seen from the buyer's
 * side: names shared, a photo from the seller, the buyer's $280, the seller's
 * counter at $290 with a note, and the buyer's assistant's page to send $280
 * again with "take it or leave it". One thing not tied to a match sits below
 * it, as a plain card. Nothing here touches a database.
 *
 * Two files: dashboard-sample.html (the reader's own light or dark setting)
 * and dashboard-sample-dark.html (dark forced, by copying the page's own dark
 * tokens onto :root — the page itself has no switch; it follows the system).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSteps, type StoryFacts } from '../src/domain/matchStory.js';
import { groupWaitingByMatch, mergeSteps } from '../src/counter/matchStory.js';
import { dashboardPage, openRequestLabel, OPEN_REQUEST_CTA } from '../src/counter/pagesHome.js';

const outDir =
  process.argv[2] ??
  '/private/tmp/claude-501/-Users-lachlantaylor-IntentExchange/49bb31ba-578f-4fd1-9c82-bc668e4e13f1/scratchpad';

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BUYER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SELLER = 'cccccccc-3333-4333-8333-cccccccccccc';
const OFFER_280 = '0f0f0f0f-0000-4000-8000-000000000280';
const OFFER_290 = '0f0f0f0f-0000-4000-8000-000000000290';

// Times in UTC; the account is in Sydney, so they read 10:05 am onwards.
const at = (d: number, h: number, m = 0) => new Date(Date.UTC(2026, 8, d, h, m));
const now = at(27, 3, 30);
const expiry = new Date(Date.UTC(2026, 9, 4));

const facts: StoryFacts = {
  viewer: BUYER,
  match: {
    id: MATCH,
    state: 'open',
    stage: 4,
    created_at: at(26, 23, 5),
    account_want: BUYER,
    account_have: SELLER,
  },
  theirName: 'Tony',
  optIns: [
    { account_id: BUYER, recorded_at: at(26, 23, 20) },
    { account_id: SELLER, recorded_at: at(26, 23, 41) },
  ],
  photos: [{ account_id: SELLER, at: at(27, 0, 12) }],
  messages: [
    { sender_account: BUYER, at: at(27, 0, 20) },
    { sender_account: SELLER, at: at(27, 0, 34) },
    { sender_account: SELLER, at: at(27, 0, 35) },
  ],
  offers: [
    {
      id: OFFER_280,
      proposer_account: BUYER,
      amount: '280',
      ccy: 'AUD',
      state: 'proposed',
      created_at: at(27, 1, 2),
      updated_at: at(27, 1, 2),
      expiry,
    },
    {
      id: OFFER_290,
      proposer_account: SELLER,
      amount: '290',
      ccy: 'AUD',
      state: 'proposed',
      created_at: at(27, 2, 47),
      updated_at: at(27, 2, 47),
      expiry,
      note: "Thanks for the offer - here's what I can do.",
    },
  ],
};

const grouped = groupWaitingByMatch(
  {
    openLinks: [
      {
        id: '11111111-0000-4000-8000-000000000001',
        action: 'offer-send',
        ref_id: MATCH,
        amount: '280',
        ccy: 'AUD',
        category: 'goods.bicycles.road',
        payload: JSON.stringify({ amount: 280, ccy: 'AUD', good_for_days: 7, note: 'take it or leave it' }),
        created_at: at(27, 3, 21),
        expires_at: at(27, 3, 36),
      },
      {
        id: '11111111-0000-4000-8000-000000000002',
        action: 'shelf-pick',
        ref_id: '22222222-0000-4000-8000-000000000002',
        amount: null,
        ccy: null,
        category: null,
        created_at: at(27, 3, 25),
        expires_at: at(27, 3, 40),
      },
    ],
    offers: [{ offer_id: OFFER_290, match_id: MATCH, amount: '290', ccy: 'AUD' }],
    disclosures: [],
    settlements: [],
    messages: [],
  },
  now,
);

const waiting = grouped.byMatch.get(MATCH)!;
const view = {
  firstName: 'Lachlan',
  killSwitchOn: false,
  ceremony: { hasPin: true, hasPasskey: true, elevated: false },
  cardCounts: { total: 3, published: 3, pending: 0 },
  sharedProfile: 'Lachlan, Kambah',
  arrangementSummary: 'how often to check — every 2 hours (and 3 more)',
  timezone: 'Australia/Sydney',
  matchBoxes: [
    {
      head: { matchId: MATCH, thing: 'road bike', theirName: 'Tony', theirArea: 'Braddon' },
      steps: mergeSteps(buildSteps(facts, now), waiting.steps),
      actions: waiting.actions,
    },
  ],
  // The one thing waiting that belongs to no match: a plain card, as before.
  pendingApprovals: grouped.otherLinks.map((l) => ({
    href: `/open/${l.id}`,
    label: openRequestLabel(l.action),
    cta: OPEN_REQUEST_CTA,
  })),
};

const light = dashboardPage(view);

// Dark, forced: the page's own dark tokens, copied onto :root outright.
const darkTokens = /@media \(prefers-color-scheme: dark\) \{\s*(:root \{[^}]*\})\s*\}/.exec(light);
if (!darkTokens) throw new Error('could not find the dark tokens in the page CSS');
const dark = light.replace(
  '</head>',
  `<style>${darkTokens[1]} :root { color-scheme: dark; }</style></head>`,
);

mkdirSync(outDir, { recursive: true });
const lightPath = join(outDir, 'dashboard-sample.html');
const darkPath = join(outDir, 'dashboard-sample-dark.html');
writeFileSync(lightPath, light);
writeFileSync(darkPath, dark);
console.log(lightPath);
console.log(darkPath);
