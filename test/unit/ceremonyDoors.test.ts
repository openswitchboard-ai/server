/**
 * Which doors take a ceremony.
 *
 * A signed-in session is not a decision. Anything that moves money, freezes
 * it, writes a fact the deadlock rule then decides on, hands an agent a key,
 * or widens what an agent may do on its own asks for the PIN or the passkey
 * again — even inside a live session, because the session may not be the
 * person's any more.
 *
 * The routes are read as text, the way linkActionsMigrated reads the
 * migrations: a door added later cannot quietly skip the list.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as cpages from '../../src/counter/pages.js';
import * as chome from '../../src/counter/pagesHome.js';

const SRC = readFileSync(join(__dirname, '..', '..', 'src', 'counter', 'routes.ts'), 'utf8');

/** Every POST handler in the human page class, as method+path → its body. */
function postHandlers(): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...SRC.matchAll(/counter\.(get|post)\(\s*'([^']+)'/g)];
  for (let i = 0; i < starts.length; i++) {
    const m = starts[i];
    if (m[1] !== 'post') continue;
    const from = m.index!;
    const to = i + 1 < starts.length ? starts[i + 1].index! : SRC.length;
    out.set(m[2], SRC.slice(from, to));
  }
  return out;
}

const HANDLERS = postHandlers();

/** Every door that must ask again before it acts. */
const SENSITIVE = [
  // Money, and the facts the deadlock rule reads.
  '/settlements/:id/confirm',
  '/settlements/:id/return-received',
  '/settlements/:id/resolution',
  '/settlements/:id/resolution/approve',
  '/settlements/:id/dispute',
  '/settlements/:id/tracking',
  '/settlements/:id/returned',
  // Credentials handed to an agent, and the band an agent may spend inside.
  '/authorize',
  '/agent-keys',
  '/ledger/:id/numbers',
  // The switch that suspends every agent token the account holds, both ways.
  '/kill',
  '/kill/off',
];

describe('the doors that ask again', () => {
  it('every one of them is a route that exists', () => {
    for (const path of SENSITIVE) {
      expect(HANDLERS.has(path), `POST ${path} is not a human-page route`).toBe(true);
    }
  });

  it('every one of them runs the ceremony before it acts', () => {
    for (const path of SENSITIVE) {
      const body = HANDLERS.get(path)!;
      expect(body, `POST ${path} does not run the ceremony`).toMatch(/await ceremony\(/);
      expect(body, `POST ${path} runs the ceremony without honouring its answer`).toMatch(
        /if \(!okNow\) return;/,
      );
    }
  });
});

/** A person with a PIN, mid-session, who has not confirmed anything recently. */
const ASKS: cpages.CeremonyView = { hasPin: true, hasPasskey: false, elevated: false };
const PIN_BOX = 'Confirm with your PIN';

const settlementView = (over: Partial<any> = {}): any => ({
  id: 's-1',
  role: 'buyer',
  state: 'funded',
  category: 'Mountain bikes',
  amount: '400 AUD',
  fee: '1 AUD',
  processing: '5 AUD',
  buyerTotal: '406 AUD',
  ccy: 'AUD',
  autoReleaseDays: 7,
  evidence: [],
  ...ASKS,
  ...over,
});

describe('the pages those doors are pressed from carry the box', () => {
  it('raising a dispute', () => {
    const html = cpages.settlementPage(settlementView({ canDispute: true }));
    expect(html).toContain('id="disputeForm"');
    expect(html).toContain(PIN_BOX);
  });

  it('adding tracking', () => {
    const html = cpages.settlementPage(settlementView({ role: 'seller', canAddTracking: true }));
    expect(html).toContain('id="trackingForm"');
    expect(html).toContain(PIN_BOX);
  });

  it('saying an item went back', () => {
    const html = cpages.settlementPage(
      settlementView({ inDispute: true, canMarkReturned: true }),
    );
    expect(html).toContain('id="returnedForm"');
    expect(html).toContain(PIN_BOX);
  });

  it('proposing a split', () => {
    const html = cpages.settlementPage(settlementView({ inDispute: true, canProposeSplit: true }));
    expect(html).toContain('id="proposeForm"');
    expect(html).toContain(PIN_BOX);
  });

  it('authorising an agent — and cancelling still takes nothing', () => {
    const html = cpages.authorizePage('Claude for Chores', '/authorize', {}, 'c-1', ASKS);
    expect(html).toContain(PIN_BOX);
    // Refusing is never gated, so the Cancel button skips the box's validation.
    expect(html).toContain('value="deny"');
    expect(html).toContain('formnovalidate');
  });

  it('pausing everything, not just un-pausing it', () => {
    const on = chome.dashboardPage({
      killSwitchOn: false,
      cardCounts: { total: 0, published: 0, pending: 0 },
      pendingApprovals: [],
      ceremony: ASKS,
    } as any);
    expect(on).toContain('id="killOnForm"');
    expect(on).toContain(PIN_BOX);
  });

  it('setting the band an agent may spend inside', () => {
    const html = chome.cardNumbersPage({
      id: 'c-1',
      type: 'WANT',
      category: 'Mountain bikes',
      mode: 'relay',
      ceremony: ASKS,
    });
    expect(html).toContain('id="numbersForm"');
    expect(html).toContain(PIN_BOX);
  });
});
