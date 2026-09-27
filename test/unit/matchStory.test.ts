/**
 * One box per match on the main page, the timeline inside it, and the same
 * figure put up twice (27 September 2026, production).
 *
 * During a negotiation the main page showed "Send your number on your road
 * bike match? 280 AUD" beside "Offer on your road bike match 290 AUD" as two
 * loose cards, and nobody could tell what had happened in what order. What is
 * asserted here:
 *
 *  - the steps of a match come out oldest first, in plain words, with each
 *    offer's state and the note that came with it;
 *  - everything waiting on one match is gathered into one box, with one button
 *    per decision and no button twice;
 *  - the box is an ordered list with visible words for every step, the other
 *    side's words are escaped, and the page passes the copy lint;
 *  - a long story shows its newest steps and links to the rest;
 *  - times are in the account's own zone where one is set, and labelled UTC
 *    where it is not;
 *  - the same figure again, while this side's is still open, puts nothing new
 *    on the table: it answers with one sentence and sends any note as a
 *    message down the channel's own path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMessage = vi.fn();
vi.mock('../../src/domain/channel.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

import * as db from '../../src/db.js';
import { buildSteps, type StoryFacts } from '../../src/domain/matchStory.js';
import {
  BOX_STEP_LIMIT,
  boxTitle,
  groupWaitingByMatch,
  mergeSteps,
  stepTime,
  timelineHtml,
  type MatchBoxView,
} from '../../src/counter/matchStory.js';
import { dashboardPage, matchOffersPage } from '../../src/counter/pagesHome.js';
import * as offers from '../../src/domain/offers.js';
import { lintHumanCopy } from '../../src/email/lint.js';
import { OsbError } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const cfg = {
  envName: 'dev',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
} as unknown as Config;

const MATCH = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BUYER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SELLER = 'cccccccc-3333-4333-8333-cccccccccccc';
const OFFER_280 = '0f0f0f0f-0000-4000-8000-000000000280';
const OFFER_290 = '0f0f0f0f-0000-4000-8000-000000000290';
const LINK_SEND = '11111111-0000-4000-8000-000000000001';
const LINK_ACCEPT = '11111111-0000-4000-8000-000000000002';

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 27, h, m));
const NOW = at(12);
const LATER = new Date(Date.UTC(2026, 9, 3));

/** The negotiation from production, from the buyer's side. */
function negotiation(): StoryFacts {
  return {
    viewer: BUYER,
    match: {
      id: MATCH,
      state: 'open',
      stage: 4,
      created_at: at(1),
      account_want: BUYER,
      account_have: SELLER,
    },
    theirName: 'Tony',
    optIns: [
      { account_id: BUYER, recorded_at: at(2) },
      { account_id: SELLER, recorded_at: at(2, 30) },
    ],
    photos: [{ account_id: SELLER, at: at(3) }],
    messages: [
      { sender_account: BUYER, at: at(3, 10) },
      { sender_account: BUYER, at: at(3, 12) },
      { sender_account: SELLER, at: at(3, 20) },
    ],
    offers: [
      {
        id: OFFER_280,
        proposer_account: BUYER,
        amount: '280',
        ccy: 'AUD',
        state: 'proposed',
        created_at: at(4),
        updated_at: at(4),
        expiry: LATER,
      },
      {
        id: OFFER_290,
        proposer_account: SELLER,
        amount: '290',
        ccy: 'AUD',
        state: 'proposed',
        created_at: at(5),
        updated_at: at(5),
        expiry: LATER,
        note: "Thanks for the offer - here's what I can do.",
      },
    ],
  };
}

const waitingInputs = () => ({
  openLinks: [
    {
      id: LINK_SEND,
      action: 'offer-send' as const,
      ref_id: MATCH,
      amount: '280',
      ccy: 'AUD',
      category: 'goods.bicycles.road',
      payload: JSON.stringify({ amount: 280, ccy: 'AUD', good_for_days: 7, note: 'take it or leave it' }),
      created_at: at(6),
      expires_at: at(6, 15),
    },
    {
      id: LINK_ACCEPT,
      action: 'offer-accept' as const,
      ref_id: OFFER_290,
      amount: '290',
      ccy: 'AUD',
      category: 'goods.bicycles.road',
      match_id: MATCH,
      created_at: at(5, 30),
      expires_at: at(5, 45),
    },
    {
      id: '11111111-0000-4000-8000-000000000003',
      action: 'shelf-pick' as const,
      ref_id: 'x',
      amount: null,
      ccy: null,
      category: null,
      expires_at: at(6, 15),
    },
  ],
  offers: [{ offer_id: OFFER_290, match_id: MATCH, amount: '290', ccy: 'AUD' }],
  disclosures: [],
  settlements: [],
  messages: [],
});

function box(): MatchBoxView {
  const g = groupWaitingByMatch(waitingInputs(), NOW).byMatch.get(MATCH)!;
  return {
    head: { matchId: MATCH, thing: 'road bike', theirName: 'Tony', theirArea: 'Braddon' },
    steps: mergeSteps(buildSteps(negotiation(), NOW), g.steps),
    actions: g.actions,
  };
}

// ---------------------------------------------------------------------------
describe('the steps of one match', () => {
  it('tells the negotiation oldest first, with each offer, its state and its note', () => {
    const steps = buildSteps(negotiation(), NOW);
    expect(steps.map((s) => s.text)).toEqual([
      'You were introduced',
      'You and Tony shared first names',
      'Tony sent a photo',
      'You sent 2 messages',
      'Tony sent a message',
      'You offered $280 AUD',
      'Tony countered with $290 AUD',
    ]);
    const mine = steps[5]!;
    expect(mine.tag).toBe('still open');
    expect(mine.waiting).toBeFalsy();
    const theirs = steps[6]!;
    expect(theirs.waiting).toBe(true);
    expect(theirs.tag).toBe('waiting for you');
    expect(theirs.quote).toEqual({ words: "Thanks for the offer - here's what I can do.", mine: false });
  });

  it('says how each offer ended: accepted, declined, withdrawn, lapsed', () => {
    const f = negotiation();
    f.offers = [
      { ...f.offers[0]!, state: 'declined', updated_at: at(5, 5) },
      { ...f.offers[1]!, state: 'accepted-by-human', updated_at: at(7) },
      {
        id: 'x1',
        proposer_account: BUYER,
        amount: '270',
        ccy: 'AUD',
        state: 'withdrawn',
        created_at: at(3, 50),
        updated_at: at(3, 55),
        expiry: LATER,
      },
      {
        id: 'x2',
        proposer_account: SELLER,
        amount: '300',
        ccy: 'AUD',
        state: 'proposed',
        created_at: at(3, 40),
        updated_at: at(3, 40),
        expiry: at(3, 45),
      },
    ];
    const texts = buildSteps(f, NOW).map((s) => s.text);
    expect(texts).toContain('Tony declined your $280 AUD');
    expect(texts).toContain('You accepted $290 AUD');
    expect(texts).toContain('You withdrew your $270 AUD');
    expect(texts).toContain("Tony's $300 AUD lapsed");
    for (const t of texts) expect(lintHumanCopy(t), t).toEqual([]);
  });

  it('names nobody before names have crossed, and never tells the other side\'s yes early', () => {
    const f = negotiation();
    f.match.stage = 2;
    delete f.theirName;
    f.optIns = [{ account_id: SELLER, recorded_at: at(2) }];
    const texts = buildSteps(f, NOW).map((s) => s.text);
    expect(texts.join(' ')).not.toMatch(/Tony|first names/);
    expect(texts).toContain('They sent a photo');
    expect(texts).toContain('They countered with $290 AUD');
  });
});

// ---------------------------------------------------------------------------
describe('everything waiting on one match, in one box', () => {
  it('gathers the pending send and the counter into one box, one button each', () => {
    const { byMatch, otherLinks } = groupWaitingByMatch(waitingInputs(), NOW);
    expect([...byMatch.keys()]).toEqual([MATCH]);
    const g = byMatch.get(MATCH)!;
    expect(g.actions).toEqual([
      { href: `/approvals/offer/${OFFER_290}`, label: 'Accept $290 AUD' },
      { href: `/open/${LINK_SEND}`, label: 'Send your $280 AUD' },
    ]);
    expect(g.steps).toHaveLength(1);
    expect(g.steps[0]).toMatchObject({
      text: 'Your offer of $280 AUD is ready to send',
      waiting: true,
      quote: { words: 'take it or leave it', mine: true },
    });
    // Nothing tied to a match keeps its own plain card.
    expect(otherLinks.map((l) => l.action)).toEqual(['shelf-pick']);
  });

  it('draws one box: title, ordered steps, the quote escaped, the buttons', () => {
    const b = box();
    b.steps.push({ at: at(7), text: 'Tony sent a message', quote: { words: '<script>x</script>', mine: false } });
    const page = dashboardPage({
      killSwitchOn: false,
      cardCounts: { total: 1, published: 1, pending: 0 },
      matchBoxes: [b],
      timezone: 'Australia/Sydney',
      pendingApprovals: [],
    });
    expect(page.match(/class="matchbox"/g)).toHaveLength(1);
    expect(page).toContain('Road bike · with Tony (Braddon)');
    expect(page).toContain('<ol class="story">');
    expect(page).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(page).not.toContain('<script>x</script>');
    expect(page).toContain('Accept $290 AUD');
    expect(page).toContain('Send your $280 AUD');
    expect(page).toContain('&ldquo;take it or leave it&rdquo;');
    // The waiting steps say so in words as well as with the dot.
    expect(page).toMatch(/<li class="step now">[\s\S]*?waiting for you/);
    expect(page).not.toContain('Nothing to decide right now.');
    expect(lintHumanCopy(page.replace(/<[^>]+>/g, ' '))).toEqual([]);
  });

  it('shows the newest steps of a long story, every waiting one, and a link to the rest', () => {
    const b = box();
    expect(b.steps.length).toBeGreaterThan(BOX_STEP_LIMIT);
    const html = timelineHtml(b.steps, { limit: BOX_STEP_LIMIT, seeAllHref: `/matches/${MATCH}` });
    expect((html.match(/<li /g) ?? []).length).toBe(BOX_STEP_LIMIT);
    expect(html).toContain(`${b.steps.length - BOX_STEP_LIMIT} earlier steps`);
    expect(html).toContain(`href="/matches/${MATCH}"`);
    expect(html).toContain('Tony countered with $290 AUD');
    // An old waiting step is never cut.
    const old = [{ at: at(0), text: 'Old and waiting', waiting: true }, ...b.steps];
    expect(timelineHtml(old, { limit: 2 })).toContain('Old and waiting');
  });

  it('titles a match with the thing alone before names cross', () => {
    expect(boxTitle({ matchId: MATCH, thing: 'road bike' })).toBe('Road bike');
  });

  it('puts the full story on the match page with the same renderer', () => {
    const page = matchOffersPage({
      matchId: MATCH,
      cardId: 'c',
      category: 'road bike',
      type: 'WANT',
      mode: 'relay',
      offers: [],
      canOffer: true,
      story: box().steps,
      timezone: null,
    });
    expect(page).toContain('What has happened');
    expect(page).toContain('<ol class="story">');
    expect(page).toContain('You were introduced');
    expect(page).not.toContain('earlier steps');
  });
});

// ---------------------------------------------------------------------------
describe('the time on a step', () => {
  it('is in the account\'s own zone where one is set', () => {
    const t = stepTime(at(4, 14), 'Australia/Sydney');
    expect(t).toContain('Sun 27 Sep, 2:14');
    expect(t).not.toContain('data-local');
    expect(t).not.toContain('UTC');
  });

  it('is labelled UTC, for the page to rewrite, where no zone is set', () => {
    const t = stepTime(at(4, 14), null);
    expect(t).toContain('Sun 27 Sep, 04:14 UTC');
    expect(t).toContain('data-local="short"');
  });
});

// ---------------------------------------------------------------------------
describe('the same figure, put up again', () => {
  let sql: string[];
  let standing: any[];

  beforeEach(() => {
    sql = [];
    sendMessage.mockReset();
    standing = [
      {
        id: OFFER_280,
        match_id: MATCH,
        proposer_account: BUYER,
        amount: '280',
        ccy: 'AUD',
        expiry: LATER,
        state: 'proposed',
        message: null,
      },
    ];
    vi.spyOn(db, 'getPool').mockReturnValue({
      query: async (q: string, params: any[] = []) => {
        sql.push(q);
        if (/SELECT \* FROM matches WHERE id/.test(q)) {
          return {
            rows: [
              {
                id: MATCH,
                card_want: 'cw',
                card_have: 'ch',
                account_want: BUYER,
                account_have: SELLER,
                category: 'goods.bicycles.road',
                state: 'open',
                stage: 4,
              },
            ],
            rowCount: 1,
          };
        }
        if (/amount = \$3::numeric/.test(q)) {
          const hit = standing.filter(
            (o) => o.proposer_account === params[1] && Number(o.amount) === Number(params[2]) && o.ccy === params[3],
          );
          return { rows: hit, rowCount: hit.length };
        }
        return { rows: [], rowCount: 0 };
      },
    } as any);
  });

  const offer = (amount: number, message?: string) => ({
    match_id: MATCH,
    amount,
    ccy: 'AUD',
    expiry: LATER.toISOString(),
    ...(message ? { message } : {}),
  });

  it('puts nothing new on the table and says the figure is still there', async () => {
    const r: any = await offers.proposeOffer(cfg, BUYER, offer(280));
    expect(r).toMatchObject({ already_on_table: true, offer_id: OFFER_280, amount: 280, ccy: 'AUD' });
    expect(r.say).toBe('Your $280 AUD is still on the table.');
    expect(lintHumanCopy(r.say)).toEqual([]);
    expect(sql.some((q) => /INSERT INTO offers/.test(q))).toBe(false);
    // On Pass on, no page is minted to send it again either.
    expect(sql.some((q) => /INSERT INTO approval_links/.test(q))).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends the note as a message, down the channel\'s own path, and says so', async () => {
    sendMessage.mockResolvedValue({ conversation_id: 'c', message_id: 'm', sent_at: 'now' });
    const r: any = await offers.proposeOffer(cfg, BUYER, offer(280, 'take it or leave it'), {
      author: 'human',
    });
    expect(sendMessage).toHaveBeenCalledWith(BUYER, MATCH, 'take it or leave it', cfg);
    expect(r.note_sent).toBe(true);
    expect(r.say).toBe('Your $280 AUD is still on the table. Your note went to them as a message.');
  });

  it('says the note did not go when the channel refuses it, money in the words and all', async () => {
    sendMessage.mockRejectedValue(
      new OsbError('CONSENT_REQUIRED', { human_action: 'Take the price out of the words' }),
    );
    const r: any = await offers.proposeOffer(cfg, BUYER, offer(280, 'fine, $275 then'));
    expect(r.note_sent).toBe(false);
    expect(r.say).toBe(
      'Your $280 AUD is still on the table. The note did not go: Take the price out of the words.',
    );
  });

  it('carries on as before for a different figure', async () => {
    await expect(offers.proposeOffer(cfg, BUYER, offer(285))).rejects.toBeTruthy();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('carries on as before once the standing figure is no longer open', async () => {
    standing = [];
    await expect(offers.proposeOffer(cfg, BUYER, offer(280))).rejects.toBeTruthy();
  });
});

// 27 September 2026: a send link for a figure already on the table sends only
// its note, so the step and the button say that.
describe('a send link for a figure already on the table', () => {
  it('reads as a note ready to send', () => {
    const { byMatch } = groupWaitingByMatch({
      openLinks: [
        {
          id: 'l1',
          action: 'offer-send',
          ref_id: 'm1',
          match_id: 'm1',
          amount: 280,
          ccy: 'AUD',
          payload: JSON.stringify({ note: 'take it or leave it' }),
          created_at: new Date('2026-09-27T05:40:00Z'),
        } as any,
      ],
      offers: [],
      disclosures: [],
      settlements: [],
      messages: [],
      ownOpenOffers: [{ match_id: 'm1', amount: '280', ccy: 'AUD' }],
    });
    const g = byMatch.get('m1')!;
    expect(g.steps.map((x) => x.text).join(' ')).toMatch(/still on the table\. Your note is ready to send/);
    expect(g.actions.map((a) => a.label)).toEqual(['Send your note']);
  });
});

