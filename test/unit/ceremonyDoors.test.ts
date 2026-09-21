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
  // Turning the switch back ON. Turning it off is deliberately NOT here: see
  // below.
  '/kill/off',
];

/**
 * THE BRAKE IS NOT A DOOR (2026-09-17).
 *
 * POST /kill took a ceremony for a day and does not any more. Somebody reaching
 * for the kill switch wants everything to stop NOW, and the wrong end of that
 * trade is a person hunting for a credential while the thing they are
 * frightened of carries on. It is the one direction that is safe to make easy:
 * everything it does is reversible by them and nothing it does is reversible by
 * anybody else, and turning it back ON is where the ceremony belongs and stays.
 *
 * What guards it instead is asserted here, so a later edit cannot quietly leave
 * it bare: the cross-site check over this whole page class, and a limiter, so a
 * stolen session cannot hold the tap down and drown the person in mail.
 */
const ONE_TAP = ['/kill'];

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

describe('the one door that must NOT ask again', () => {
  it('runs no ceremony', () => {
    for (const path of ONE_TAP) {
      expect(HANDLERS.has(path)).toBe(true);
      expect(HANDLERS.get(path)!).not.toMatch(/await ceremony\(/);
    }
  });

  it('is paced instead, so a run of taps cannot become a run of emails', () => {
    expect(HANDLERS.get('/kill')!).toMatch(/killSwitchLimiter\.limited\(/);
  });

  it('and the email behind it is keyed on the state rather than the moment', () => {
    const email = readFileSync(join(__dirname, '..', '..', 'src', 'counter', 'email.ts'), 'utf8');
    const line = email.split('\n').find((l) => l.includes('dedupeKey: `kill-'))!;
    expect(line).toBeTruthy();
    expect(line).not.toContain('Date.now()');
  });

  it('but it still requires a signed-in session of this person`s own', () => {
    expect(HANDLERS.get('/kill')!).toMatch(/await requireSession\(/);
  });
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
    const html = cpages.authorizePage(
      'Claude for Chores',
      '/authorize',
      {},
      'c-1',
      ASKS,
      'https://claude.ai/api/mcp/auth_callback',
    );
    // A name is whatever the agent typed at registration; the address is not.
    expect(html).toContain('claude.ai');
    expect(html).toContain(PIN_BOX);
    // Refusing is never gated, so the Cancel button skips the box's validation.
    expect(html).toContain('value="deny"');
    expect(html).toContain('formnovalidate');
  });

  it('un-pausing everything — and pausing it asks for nothing', () => {
    const view = (killSwitchOn: boolean) =>
      chome.dashboardPage({
        killSwitchOn,
        cardCounts: { total: 0, published: 0, pending: 0 },
        pendingApprovals: [],
        ceremony: ASKS,
      } as any);
    const off = view(true);
    expect(off).toContain('id="killOffForm"');
    expect(off).toContain(PIN_BOX);
    // And the brake itself: one button, no box.
    const on = view(false);
    expect(on).toContain('id="killOnForm"');
    expect(on).not.toContain(PIN_BOX);
    expect(on).toContain('One tap, no PIN');
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

// ---------------------------------------------------------------------------
// And the one thing an assistant may never hold. There is nothing to enforce
// here — a PIN handed over is a PIN we cannot tell apart from the human's own —
// so the rule lives entirely in copy, and copy that has to be there is copy a
// test holds down.
describe('the PIN belongs to the human', () => {
  it('the page where one is chosen says so, on the way in and on a change', () => {
    const line = 'Do not give it to your assistant; the PIN is how we know it is you.';
    expect(cpages.pinSetPage()).toContain(line);
    expect(cpages.pinSetPage(undefined, { hasPin: true })).toContain(line);
    expect(cpages.pinSetPage()).toContain('Keep this PIN to yourself.');
  });
});
