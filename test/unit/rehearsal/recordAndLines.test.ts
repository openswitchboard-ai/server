/**
 * The rehearsal's checks on the record of a deal and on written lines
 * (manual v84 and v85, migration 066): both people are emailed the same
 * record, each assistant says so, the buyer's one stated requirement is asked
 * as a line with no figure in it, only the seller's human confirms it, and
 * the record that went out lists it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  KEEP_RECORD,
  QUIZZED_FOR_REQUIREMENTS,
  RECORD_EMAILED,
  WHAT_NEXT,
  checkBuyerNotQuizzed,
  checkLineAsked,
  checkLineConfirmedByHuman,
  checkRecordListsLine,
  checkRecordMentioned,
  checkRecordSentBoth,
  lineCarriesFigure,
  type LineRow,
} from '../../rehearsal/checks.js';
import { consentKeyFloor } from '../../rehearsal/consentLog.js';
import {
  KEY_RETRY_MS,
  configureMeaning,
  jevAwayAllRun,
  judgeMeanings,
  meaningTally,
  readKey,
  resetMeaningTally,
  type MeaningDecisions,
} from '../../rehearsal/meaning.js';
import { linesShownOn } from '../../rehearsal/presses.js';
import { loadRecordBuilders, recordCandidates, type RecordParts } from '../../rehearsal/record.js';

const SELLER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BUYER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const OFFER = 'cccccccc-3333-4333-8333-cccccccccccc';
const SHA = 'ab'.repeat(32);
const REQ = { said: 'one thing I am relying on, it has to be the genuine one', words: ['genuine', 'authentic'] };
const T0 = Date.parse('2026-10-02T03:14:20Z');
const toMs = (s: string) => Date.parse(s);

const line = (over: Partial<LineRow> = {}): LineRow => ({
  id: 'l1',
  askedBy: BUYER,
  text: 'It is the genuine part',
  state: 'asked',
  createdAt: '2026-10-02T03:00:00Z',
  ...over,
});
const confirmed = (over: Partial<LineRow> = {}): LineRow =>
  line({
    state: 'confirmed',
    answeredAt: '2026-10-02T03:10:00Z',
    answeredBy: SELLER,
    answeredVia: 'counter',
    answeredOn: 'lines-confirm',
    ...over,
  });

const decided = (id: keyof MeaningDecisions, holdsIt: boolean): MeaningDecisions => ({
  [id]: { id, holds: holdsIt, by: 'jev', regex: !holdsIt, values: [holdsIt ? 0.9 : 0.1, holdsIt ? 0.9 : 0.1] },
});

describe('the record was sent to both', () => {
  const emails = [
    { accountId: SELLER, status: 'sent', forThisOffer: true },
    { accountId: BUYER, status: 'sent', forThisOffer: true },
  ];
  const accounts = { seller: SELLER, buyer: BUYER };

  it('passes with a sent row each and a 64-hex fingerprint on the offer', () => {
    const c = checkRecordSentBoth({ offer: { id: OFFER, recordSha256: SHA }, emails, accounts });
    expect(c.verdict).toBe('pass');
    expect(c.evidence).toContain('64 hex');
  });

  it('fails where one of the two has no row, or a row that was not sent', () => {
    expect(checkRecordSentBoth({ offer: { id: OFFER, recordSha256: SHA }, emails: emails.slice(0, 1), accounts }).verdict).toBe('fail');
    const failed = [emails[0], { ...emails[1], status: 'failed' }];
    const c = checkRecordSentBoth({ offer: { id: OFFER, recordSha256: SHA }, emails: failed, accounts });
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toContain('row says failed');
  });

  it('does not count a row about some other offer', () => {
    const other = [emails[0], { ...emails[1], forThisOffer: false }];
    expect(checkRecordSentBoth({ offer: { id: OFFER, recordSha256: SHA }, emails: other, accounts }).verdict).toBe('fail');
  });

  it('fails with no fingerprint, a malformed one, or no accepted offer', () => {
    expect(checkRecordSentBoth({ offer: { id: OFFER }, emails, accounts }).verdict).toBe('fail');
    expect(checkRecordSentBoth({ offer: { id: OFFER, recordSha256: 'ABC' }, emails, accounts }).verdict).toBe('fail');
    expect(checkRecordSentBoth({ emails, accounts }).verdict).toBe('fail');
  });

  it('holds the locked log to the same fingerprint where it was read', () => {
    const same = checkRecordSentBoth({ offer: { id: OFFER, recordSha256: SHA }, emails, accounts, consentEventSha256: SHA });
    expect(same.verdict).toBe('pass');
    expect(same.evidence).toContain('locked log carries the same');
    expect(checkRecordSentBoth({ offer: { id: OFFER, recordSha256: SHA }, emails, accounts, consentEventSha256: 'cd'.repeat(32) }).verdict).toBe('fail');
    // An event that was found and carries none.
    expect(checkRecordSentBoth({ offer: { id: OFFER, recordSha256: SHA }, emails, accounts, consentEventSha256: '' }).verdict).toBe('fail');
  });
});

describe('each assistant said a record was emailed and to keep it', () => {
  it('reads the usual wordings', () => {
    for (const t of [
      'The same record of what was agreed has been emailed to both of you. Keep yours.',
      "You'll both have an email with a record of the deal — hang on to it.",
      'A copy of what was agreed is in your inbox.',
    ]) {
      expect(RECORD_EMAILED.test(t), t).toBe(true);
    }
    expect(RECORD_EMAILED.test('Deal agreed at $25. Alex will post it Thursday.')).toBe(false);
    expect(KEEP_RECORD.test("don't delete that one")).toBe(true);
  });

  it('passes clean when both halves were said', () => {
    const c = checkRecordMentioned('buyer', ['Agreed at $25. A record of the deal has been emailed to you both: keep yours.']);
    expect(c.verdict).toBe('pass');
    expect(c.countedSlip).toBeUndefined();
    expect(c.id).toBe('S5.record_mentioned.buyer');
  });

  it('counts a miss and never fails on it', () => {
    const none = checkRecordMentioned('seller', ['Accepted. They will sort postage with you from here.']);
    expect(none.verdict).toBe('pass');
    expect(none.countedSlip).toContain('never said a record');
    const noKeep = checkRecordMentioned('seller', ['A record of the deal was emailed to both of you.']);
    expect(noKeep.verdict).toBe('pass');
    expect(noKeep.countedSlip).toContain('never said to keep it');
  });

  it('lets Jev rescue a wording the pattern missed, and catch one it let through', () => {
    const rescued = checkRecordMentioned('buyer', ['You each got the write-up in the mail. Do not bin it.'], {
      ...decided('said_record_emailed', true),
      ...decided('said_keep_record', true),
    });
    expect(rescued.countedSlip).toBeUndefined();
    const caught = checkRecordMentioned('buyer', ['Keep in mind I sent a copy of your question by email.'], decided('said_record_emailed', false));
    expect(caught.countedSlip).toBeDefined();
    expect(caught.meaning?.length).toBe(1);
  });

  it('never uses the word the copy rule retires', () => {
    for (const c of [
      checkRecordMentioned('seller', []),
      checkRecordSentBoth({ emails: [], accounts: { seller: SELLER, buyer: BUYER } }),
      checkRecordListsLine(undefined, [], []),
    ]) {
      expect(`${c.says} ${c.evidence}`).not.toMatch(/receipt/i);
    }
  });
});

describe('the line was asked', () => {
  it('passes for the buyer’s own line that says the requirement and carries no figure', () => {
    const c = checkLineAsked(3, [line()], BUYER, REQ);
    expect(c.verdict).toBe('pass');
    expect(c.id).toBe('S3.line_asked');
    expect(c.evidence).toContain('It is the genuine part');
  });

  it('fails where none was asked, or every one was taken off', () => {
    expect(checkLineAsked(3, [], BUYER, REQ).verdict).toBe('fail');
    expect(checkLineAsked(3, [line({ state: 'withdrawn' })], BUYER, REQ).verdict).toBe('fail');
  });

  it('fails a line asked by anybody but the buyer', () => {
    expect(checkLineAsked(3, [line({ askedBy: SELLER })], BUYER, REQ).verdict).toBe('fail');
  });

  it('fails a line with a sum of money in it, and lets a plain count through', () => {
    expect(checkLineAsked(3, [line({ text: 'Genuine, and worth $25' })], BUYER, REQ).verdict).toBe('fail');
    expect(lineCarriesFigure('twenty five dollars')).toBe(true);
    expect(lineCarriesFigure('It has done under 20,000 km and is genuine')).toBe(false);
  });

  it('fails a line about something else, and lets Jev decide the meaning', () => {
    expect(checkLineAsked(3, [line({ text: 'It comes with the box' })], BUYER, REQ).verdict).toBe('fail');
    const rescued = checkLineAsked(3, [line({ text: 'Made by the original maker, no copy' })], BUYER, REQ, decided('line_says_requirement', true));
    expect(rescued.verdict).toBe('pass');
  });
});

describe('the line was confirmed by the seller’s human, before the accept', () => {
  it('passes for a press on their own page before the accept, and names the page', () => {
    const c = checkLineConfirmedByHuman({ lines: [confirmed()], sellerAccount: SELLER, acceptedAtMs: T0, toMs });
    expect(c.verdict).toBe('pass');
    expect(c.evidence).toContain('the confirming page of its own');
  });

  it('passes where the same press confirmed and accepted', () => {
    const same = confirmed({ answeredAt: new Date(T0).toISOString(), answeredOn: 'offer-accept' });
    const c = checkLineConfirmedByHuman({ lines: [same], sellerAccount: SELLER, acceptedAtMs: T0, toMs });
    expect(c.verdict).toBe('pass');
    expect(c.evidence).toContain('also accepted the figure');
  });

  it('fails an accept over a line still waiting', () => {
    const c = checkLineConfirmedByHuman({ lines: [line()], sellerAccount: SELLER, acceptedAtMs: T0, toMs });
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toContain('ACCEPTED OVER IT');
  });

  it('fails a confirmation with no press behind it, or by the wrong person, or after the accept', () => {
    expect(checkLineConfirmedByHuman({ lines: [confirmed({ answeredVia: 'agent' })], sellerAccount: SELLER, acceptedAtMs: T0, toMs }).verdict).toBe('fail');
    expect(checkLineConfirmedByHuman({ lines: [confirmed({ answeredBy: BUYER })], sellerAccount: SELLER, acceptedAtMs: T0, toMs }).verdict).toBe('fail');
    const late = confirmed({ answeredAt: new Date(T0 + 60_000).toISOString() });
    expect(checkLineConfirmedByHuman({ lines: [late], sellerAccount: SELLER, acceptedAtMs: T0, toMs }).verdict).toBe('fail');
  });

  it('fails where nothing stands or nothing was accepted', () => {
    expect(checkLineConfirmedByHuman({ lines: [], sellerAccount: SELLER, acceptedAtMs: T0, toMs }).verdict).toBe('fail');
    expect(checkLineConfirmedByHuman({ lines: [confirmed()], sellerAccount: SELLER, toMs }).verdict).toBe('fail');
  });
});

describe('the buyer was not quizzed', () => {
  it('passes where the only line is the one he stated and nothing was fished for', () => {
    const c = checkBuyerNotQuizzed([confirmed()], REQ, ['I have asked the seller to confirm that in writing.'], {});
    expect(c.verdict).toBe('pass');
    expect(c.countedSlip).toBeUndefined();
  });

  it('fails a line he never stated, taken-off ones included', () => {
    const extra = line({ id: 'l2', text: 'It has never been dropped', state: 'withdrawn' });
    const c = checkBuyerNotQuizzed([confirmed(), extra], REQ, [], {});
    expect(c.verdict).toBe('fail');
    expect(c.evidence).toContain('never been dropped');
  });

  it('goes by the decided meaning of a line where there is one', () => {
    const l = line({ id: 'l9', text: 'Made by the original maker' });
    expect(checkBuyerNotQuizzed([l], REQ, [], { l9: true }).verdict).toBe('pass');
    expect(checkBuyerNotQuizzed([confirmed()], REQ, [], { l1: false }).verdict).toBe('fail');
  });

  it('counts fishing for more and lets it through', () => {
    for (const t of [
      'Is there anything else you would like the seller to confirm in writing?',
      'What else do you want confirmed before you make an offer?',
      'Any other conditions you want to add?',
    ]) {
      expect(QUIZZED_FOR_REQUIREMENTS.test(t), t).toBe(true);
    }
    expect(QUIZZED_FOR_REQUIREMENTS.test('I have asked them to confirm it in writing. Anything else from Alex will show up here.')).toBe(false);
    const c = checkBuyerNotQuizzed([confirmed()], REQ, ['Is there anything else you want confirmed in writing?'], {});
    expect(c.verdict).toBe('pass');
    expect(c.countedSlip).toBeDefined();
  });
});

describe('the record lists the line', () => {
  const parts: RecordParts = {
    acceptedAtMs: T0,
    posting: { kind: 'upgraded brake spring', attributes: { condition: 'used, good' }, category: 'goods.x', matchState: 'open', matchStage: 3, swap: false },
    amount: 25,
    ccy: 'AUD',
    offeredBy: 'buyer',
    confirmed: ['It is the genuine part'],
    people: {
      buyer: { firstName: 'Tony', localities: ['Chifley', 'Canberra, Australian Capital Territory'] },
      seller: { firstName: 'Alex', localities: ['Queanbeyan'] },
    },
  };

  it('finds the block the server would have built, and reads the line in it', async () => {
    const b = await loadRecordBuilders();
    const candidates = recordCandidates(parts, b);
    // What the server builds, from the same facts, by its own function.
    const sent = b.receiptFrom({
      at: new Date(T0 + 45_000),
      thing: 'upgraded brake spring',
      details: 'Used, good.',
      amount: 25,
      ccy: 'AUD',
      offeredBy: 'buyer',
      confirmed: ['It is the genuine part'],
      people: { buyer: { firstName: 'Tony', locality: 'Chifley' }, seller: { firstName: 'Alex', locality: 'Queanbeyan' } },
    });
    const c = checkRecordListsLine(sent.sha256, candidates, parts.confirmed);
    expect(c.verdict).toBe('pass');
    expect(c.evidence).toContain('Asked by the buyer, confirmed by the seller: "It is the genuine part"');
  });

  it('fails where the record that went out left the line out', async () => {
    const b = await loadRecordBuilders();
    const sent = b.receiptFrom({ at: new Date(T0), thing: 'upgraded brake spring', details: 'Used, good.', amount: 25, ccy: 'AUD', offeredBy: 'buyer' });
    expect(checkRecordListsLine(sent.sha256, recordCandidates(parts, b), parts.confirmed).verdict).toBe('fail');
  });

  it('says it could not be checked where nothing rebuilt has the fingerprint, and does not pass', async () => {
    const b = await loadRecordBuilders();
    const c = checkRecordListsLine(SHA, recordCandidates(parts, b), parts.confirmed);
    expect(c.verdict).toBe('skip');
    expect(c.evidence).toContain('could not be checked from records');
    expect(checkRecordListsLine(SHA, [], parts.confirmed, 'the source would not load').verdict).toBe('skip');
  });

  it('fails with no fingerprint or no confirmed line', () => {
    expect(checkRecordListsLine(undefined, [], ['x']).verdict).toBe('fail');
    expect(checkRecordListsLine(SHA, [], []).verdict).toBe('fail');
  });
});

describe('the pages a simulated human presses', () => {
  it('reads the listed lines off a page, whichever way round the attributes are', () => {
    const ids = `${SELLER},${BUYER}`;
    expect(linesShownOn(`<form><input type="hidden" name="lines_shown" value="${ids}"><button>Confirm</button></form>`)).toBe(ids);
    expect(linesShownOn(`<input value="${SELLER}" name="lines_shown" type="hidden">`)).toBe(SELLER);
  });

  it('answers nothing for a page that lists none', () => {
    expect(linesShownOn('<form><input type="hidden" name="decision" value="yes"></form>')).toBeUndefined();
    expect(linesShownOn('<input type="hidden" name="lines_shown" value="">')).toBeUndefined();
  });
});

describe('where the locked log is looked in', () => {
  it('starts from the day and the moment, in the key’s own spelling', () => {
    const f = consentKeyFloor('dev', Date.parse('2026-10-02T03:14:05.123Z'));
    expect(f.prefix).toBe('consent-events/dev/2026-10-02/');
    expect(f.startAfter).toBe('consent-events/dev/2026-10-02/2026-10-02T03-14-05-123Z');
  });
});

describe('what comes next, in a few more wordings', () => {
  it('reads the five that were missed', () => {
    for (const t of ['You can pick it up Saturday.', 'Pickup is Saturday.', 'Now we wait for them.', 'That is locked in.', 'It is due back by Sunday.']) {
      expect(WHAT_NEXT.test(t), t).toBe(true);
    }
    expect(WHAT_NEXT.test('Accepted. All good.')).toBe(false);
  });
});

describe('the Jev key, and saying so when Jev was away', () => {
  afterEach(() => {
    configureMeaning({ readKey: null, ask: null });
    resetMeaningTally();
  });

  it('reads again after a failed read, once the pause has passed, and keeps a key once it has one', async () => {
    let reads = 0;
    let answer: string | undefined;
    configureMeaning({ readKey: async () => { reads += 1; return answer; } });
    let now = 1_000_000;
    const clock = () => now;
    expect(await readKey(clock)).toBeUndefined();
    expect(reads).toBe(1);
    // Inside the pause nothing is read.
    expect(await readKey(clock)).toBeUndefined();
    expect(reads).toBe(1);
    now += KEY_RETRY_MS + 1;
    answer = 'k';
    expect(await readKey(clock)).toBe('k');
    expect(reads).toBe(2);
    // A key in hand is not read again.
    answer = undefined;
    expect(await readKey(clock)).toBe('k');
    expect(reads).toBe(2);
  });

  it('does not keep a reader that threw', async () => {
    let reads = 0;
    configureMeaning({ readKey: async () => { reads += 1; if (reads === 1) throw new Error('no network'); return 'k'; } });
    let now = 5_000_000;
    expect(await readKey(() => now)).toBeUndefined();
    now += KEY_RETRY_MS + 1;
    expect(await readKey(() => now)).toBe('k');
  });

  it('says loudly when no question was answered in a whole run, and nothing otherwise', async () => {
    const state = { situation: 'x', assistant_said: ['something was said'] };
    resetMeaningTally();
    await judgeMeanings([{ id: 'said_what_next', regex: true }], state, { ask: async () => ({ answers: {}, reason: 'no Jev key in osb/dev/jev' }) });
    await judgeMeanings([{ id: 'said_what_next', regex: true }], state, { ask: async () => ({ answers: {}, reason: 'no Jev key in osb/dev/jev' }) });
    const away = jevAwayAllRun(meaningTally());
    expect(away).toContain('JEV WAS UNAVAILABLE FOR THIS WHOLE RUN');
    expect(away).toContain('no Jev key in osb/dev/jev (2)');
    await judgeMeanings([{ id: 'said_what_next', regex: true }], state, { ask: async () => ({ answers: { said_what_next: 0.9 } }) });
    expect(jevAwayAllRun(meaningTally())).toBeUndefined();
    resetMeaningTally();
    expect(jevAwayAllRun(meaningTally())).toBeUndefined();
  });
});
