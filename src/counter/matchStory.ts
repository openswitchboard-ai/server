/**
 * ONE BOX PER MATCH on the main page, and the timeline inside it
 * (27 September 2026).
 *
 * The facts and the words for each step come from domain/matchStory.ts. This
 * file groups everything that is waiting for a person by the match it belongs
 * to, adds the waiting steps and the buttons, and draws it. The same timeline
 * renderer draws the whole history on the match's own page (/matches/:id), so
 * the two can never tell the story two ways.
 *
 * TIME. Where the account has a time zone on file, every step's time is
 * written on the server in that zone ("Sat 27 Sep, 2:14 pm") and left alone by
 * the browser. Where it has none, the time goes out as UTC with "UTC" after it
 * and the page's own clock script rewrites it into the reader's local time,
 * the same way every other time on these pages is shown.
 *
 * ACCESSIBILITY. The timeline is an ordered list. Every step says what it is in
 * words, and a step waiting for the reader carries the visible words "waiting
 * for you" as well as its accent dot, so nothing rests on colour alone.
 */
import { offerAmountInWords } from '../email/templates.js';
import type { MatchStep, StoryHead } from '../domain/matchStory.js';
import { STEP_TAG_WAITING } from '../domain/matchStory.js';
import { readPayload, type OpenLink } from './links.js';
import { esc } from './pages.js';

export interface MatchAction {
  href: string;
  label: string;
}

export interface MatchBoxView {
  head: StoryHead;
  steps: MatchStep[];
  actions: MatchAction[];
}

/** How many steps a box shows before "See all". */
export const BOX_STEP_LIMIT = 5;

const money = (amount: string | number, ccy: string) => offerAmountInWords(Number(amount), ccy);

/** "Road bike · with Tony (Braddon)", or just "Road bike" before names cross. */
export function boxTitle(head: StoryHead): string {
  const thing = head.thing.trim();
  const cap = thing ? thing[0]!.toUpperCase() + thing.slice(1) : 'Your match';
  if (!head.theirName) return cap;
  return `${cap} · with ${head.theirName}${head.theirArea ? ` (${head.theirArea})` : ''}`;
}

const SHORT_DAY: Intl.DateTimeFormatOptions = {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
};

/**
 * One step's time, as markup. In the account's own zone where one is set;
 * otherwise UTC, labelled, for the page's clock script to rewrite.
 */
export function stepTime(at: Date, timezone?: string | null): string {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return '';
  const iso = at.toISOString();
  if (timezone) {
    try {
      const text = new Intl.DateTimeFormat('en-AU', { ...SHORT_DAY, timeZone: timezone })
        .format(at)
        .replace(/^(\w{3}),\s/, '$1 ')
        .replace('Sept', 'Sep');
      return `<time datetime="${iso}">${esc(text)}</time>`;
    } catch {
      // An unknown zone falls through to the labelled UTC time below.
    }
  }
  const text =
    new Intl.DateTimeFormat('en-AU', { ...SHORT_DAY, hour12: false, timeZone: 'UTC' })
      .format(at)
      .replace(/^(\w{3}),\s/, '$1 ')
      .replace('Sept', 'Sep') + ' UTC';
  return `<time datetime="${iso}" data-local="short">${esc(text)}</time>`;
}

function stepHtml(s: MatchStep, timezone?: string | null): string {
  const when = s.noTime ? '' : stepTime(s.at, timezone);
  return `<li class="step ${s.waiting ? 'now' : 'past'}"><span class="dot" aria-hidden="true"></span>
<div class="st-line">${esc(s.text)}${s.tag ? ` <span class="st-tag">${esc(s.tag)}</span>` : ''}</div>
${s.quote ? `<p class="st-quote">&ldquo;${esc(s.quote.words)}&rdquo;</p>` : ''}${
    when ? `<div class="st-when">${when}</div>` : ''
  }</li>`;
}

/**
 * The timeline. With `limit`, only the newest steps show, every waiting step
 * shows whatever its age, and a line above them says how many earlier steps
 * there are with a link to the match's own page.
 */
export function timelineHtml(
  steps: MatchStep[],
  opts: { timezone?: string | null; limit?: number; seeAllHref?: string } = {},
): string {
  if (!steps.length) return '';
  let shown = steps;
  if (opts.limit && steps.length > opts.limit) {
    const cut = steps.length - opts.limit;
    shown = steps.filter((s, i) => i >= cut || s.waiting);
  }
  const hidden = steps.length - shown.length;
  const more =
    hidden > 0
      ? `<p class="story-more">${hidden === 1 ? 'One earlier step' : `${hidden} earlier steps`}${
          opts.seeAllHref ? ` · <a href="${esc(opts.seeAllHref)}">See all</a>` : ''
        }</p>`
      : '';
  return `${more}<ol class="story">${shown.map((s) => stepHtml(s, opts.timezone)).join('')}</ol>`;
}

/** One match's box on the main page. */
export function matchBoxHtml(box: MatchBoxView, timezone?: string | null): string {
  const id = `mb-${box.head.matchId.replace(/[^A-Za-z0-9-]/g, '')}`;
  const actions = box.actions
    .map(
      (a, i) =>
        `<a class="btn${i === 0 ? '' : ' secondary'}" href="${esc(a.href)}">${esc(a.label)}</a>`,
    )
    .join('');
  // No "waiting for you" badge: every box under Decisions is waiting by
  // definition, and the accent border and each waiting step's own tag say so.
  // The muted line under the title tells two boxes about the same kind of
  // thing apart: the other side's own words for theirs, and their asking
  // figure where they gave one (28 September 2026).
  return `<section class="matchbox" aria-labelledby="${id}">
<h3 class="mb-title" id="${id}">${esc(boxTitle(box.head))}</h3>
${box.head.theirs ? `<p class="mb-theirs">${esc(box.head.theirs)}</p>` : ''}
${timelineHtml(box.steps, {
  timezone,
  limit: BOX_STEP_LIMIT,
  seeAllHref: `/matches/${box.head.matchId}`,
})}
${actions ? `<div class="mb-actions">${actions}</div>` : ''}
</section>`;
}

// ---------------------------------------------------------------------------
// Grouping what is waiting by the match it belongs to.
// ---------------------------------------------------------------------------

/** A seller with something to confirm in writing: the step and its button. */
export const CONFIRM_WAITING_STEP = 'The buyer has asked you to confirm something in writing';
export const CONFIRM_WAITING_LABEL = 'See what they asked';

/** The link actions whose ref is the match itself. */
const MATCH_REF_ACTIONS = new Set([
  'conversation-photo',
  'stage3-disclosure',
  'offer-send',
  'conversation-renew',
  'report',
  'contact-send',
  'lines-confirm',
]);

export interface WaitingInputs {
  openLinks: (OpenLink & { match_id?: string | null; payload?: string | null; created_at?: Date })[];
  offers: { offer_id: string; match_id: string; amount: string | number; ccy: string }[];
  disclosures: { match_id: string }[];
  settlements: {
    id: string;
    match_id: string;
    amount: string | number;
    ccy: string;
    needsApproval: boolean;
    created_at?: Date;
  }[];
  messages: { match_id: string; count: number }[];
  /** This person's own offers still open, so a send link for the same figure
   *  reads as the note it now is. */
  ownOpenOffers?: { match_id: string; amount: string | number; ccy: string }[];
  /** Introductions on which the buyer has asked this person, the seller, to
   *  confirm something in writing that they have not answered yet
   *  (domain/confirmLines.ts). */
  confirmations?: { match_id: string; asked_at?: Date }[];
}

export interface WaitingForMatch {
  steps: MatchStep[];
  actions: MatchAction[];
}

/** The match an open link is about, where it is about one. */
export function matchOfLink(l: WaitingInputs['openLinks'][number]): string | undefined {
  if (l.match_id) return String(l.match_id);
  if (MATCH_REF_ACTIONS.has(l.action)) return String(l.ref_id);
  return undefined;
}

/**
 * Everything waiting, sorted into the matches it belongs to, with the steps
 * and buttons each adds. What belongs to no match is handed back untouched as
 * `otherLinks`, for the plain cards the main page has always drawn.
 */
export function groupWaitingByMatch(
  w: WaitingInputs,
  now: Date = new Date(),
): { byMatch: Map<string, WaitingForMatch>; otherLinks: OpenLink[] } {
  const byMatch = new Map<string, WaitingForMatch>();
  const otherLinks: OpenLink[] = [];
  const slot = (id: string): WaitingForMatch => {
    let g = byMatch.get(id);
    if (!g) {
      g = { steps: [], actions: [] };
      byMatch.set(id, g);
    }
    return g;
  };
  const addAction = (g: WaitingForMatch, a: MatchAction) => {
    if (g.actions.some((x) => x.href === a.href || x.label === a.label)) return;
    g.actions.push(a);
  };
  const waitingStep = (at: Date | undefined, text: string, extra: Partial<MatchStep> = {}): MatchStep => ({
    at: at ? new Date(at) : now,
    text,
    waiting: true,
    tag: STEP_TAG_WAITING,
    ...extra,
  });

  // The other side's open offers first: accepting one is the decision.
  const pendingOfferIds = new Set<string>();
  for (const o of w.offers) {
    pendingOfferIds.add(String(o.offer_id));
    addAction(slot(String(o.match_id)), {
      href: `/approvals/offer/${o.offer_id}`,
      label: `Accept ${money(o.amount, o.ccy)}`,
    });
  }

  for (const l of w.openLinks) {
    const matchId = matchOfLink(l);
    if (!matchId) {
      otherLinks.push(l);
      continue;
    }
    const g = slot(matchId);
    const href = `/open/${l.id}`;
    switch (l.action) {
      case 'offer-send': {
        const p = readPayload(l) ?? {};
        const amount = l.amount ?? p.amount;
        const ccy = l.ccy ?? p.ccy;
        const m = amount != null && ccy ? money(amount, String(ccy)) : 'your number';
        const note = typeof p.note === 'string' && p.note.trim() ? p.note : undefined;
        // The same figure is already on the table: pressing sends only the
        // note (offers.ts, the same-figure rule), so the step says so.
        const alreadyOpen =
          amount != null &&
          ccy &&
          (w.ownOpenOffers ?? []).some(
            (o) =>
              String(o.match_id) === matchId &&
              Number(o.amount) === Number(amount) &&
              String(o.ccy).toUpperCase() === String(ccy).toUpperCase(),
          );
        if (alreadyOpen && note) {
          g.steps.push(
            waitingStep(l.created_at, `Your ${m} is still on the table. Your note is ready to send`, {
              quote: { words: note, mine: true },
            }),
          );
          addAction(g, { href, label: 'Send your note' });
          break;
        }
        if (alreadyOpen) break;
        g.steps.push(
          waitingStep(l.created_at, `Your offer of ${m} is ready to send`, {
            ...(note ? { quote: { words: note, mine: true } } : {}),
          }),
        );
        addAction(g, { href, label: amount != null && ccy ? `Send your ${m}` : 'Send your number' });
        break;
      }
      case 'offer-accept': {
        // The offer step already says it is waiting; the button is the same
        // decision the pending offer above already has, so it is added once.
        if (pendingOfferIds.has(String(l.ref_id))) break;
        const m = l.amount != null && l.ccy ? money(l.amount, l.ccy) : undefined;
        addAction(g, { href, label: m ? `Accept ${m}` : 'Take the offer' });
        break;
      }
      case 'conversation-photo':
        g.steps.push(waitingStep(l.created_at, 'A page to send a photo is ready'));
        addAction(g, { href, label: 'Send a photo' });
        break;
      case 'stage3-disclosure':
        g.steps.push(waitingStep(l.created_at, 'Sharing first names needs your go-ahead'));
        addAction(g, { href, label: 'Share your name' });
        break;
      case 'conversation-renew':
        g.steps.push(waitingStep(l.created_at, 'Keeping the conversation going needs your go-ahead'));
        addAction(g, { href, label: 'Keep talking' });
        break;
      case 'contact-send':
        g.steps.push(waitingStep(l.created_at, 'A page to send your contact details is ready'));
        addAction(g, { href, label: 'Send your contact details' });
        break;
      case 'report':
        g.steps.push(waitingStep(l.created_at, 'Your report is ready to finish'));
        addAction(g, { href, label: 'Finish your report' });
        break;
      case 'lines-confirm':
        // The step and the button come from the lines themselves, below, so
        // the page says it once whichever road reached it first. A link whose
        // lines are not in that read still gets its button.
        if (!(w.confirmations ?? []).some((c) => String(c.match_id) === matchId)) {
          g.steps.push(waitingStep(l.created_at, CONFIRM_WAITING_STEP));
          addAction(g, { href, label: CONFIRM_WAITING_LABEL });
        }
        break;
      default:
        addAction(g, { href, label: 'Open it' });
    }
  }

  for (const d of w.disclosures) {
    const g = slot(String(d.match_id));
    const hasNamesStep = g.steps.some((s) => s.text === 'Sharing first names needs your go-ahead');
    if (!hasNamesStep) g.steps.push(waitingStep(undefined, 'Sharing first names needs your go-ahead', { noTime: true }));
    // One button for the names question, whichever road reached it first.
    if (!g.actions.some((a) => a.label === 'Share your name')) {
      addAction(g, { href: `/approvals/match/${d.match_id}`, label: 'Share your name' });
    }
  }

  for (const c of w.confirmations ?? []) {
    const g = slot(String(c.match_id));
    g.steps.push(waitingStep(c.asked_at, CONFIRM_WAITING_STEP));
    addAction(g, { href: `/approvals/confirm/${c.match_id}`, label: CONFIRM_WAITING_LABEL });
  }

  for (const st of w.settlements) {
    const g = slot(String(st.match_id));
    const m = money(st.amount, st.ccy);
    if (st.needsApproval) {
      g.steps.push(waitingStep(st.created_at, `A payment of ${m} needs your approval`));
      addAction(g, { href: `/approvals/settlement/${st.id}`, label: 'Approve the payment' });
    } else {
      g.steps.push({ at: st.created_at ? new Date(st.created_at) : now, text: `A payment of ${m} is under way` });
      addAction(g, { href: `/settlements/${st.id}`, label: 'See the payment' });
    }
  }

  for (const msg of w.messages) {
    const g = slot(String(msg.match_id));
    const one = msg.count === 1;
    g.steps.push(
      waitingStep(
        undefined,
        `${one ? 'A message is' : `${msg.count} messages are`} waiting. Ask your assistant and it will read ${one ? 'it' : 'them'} to you.`,
        { noTime: true },
      ),
    );
  }

  return { byMatch, otherLinks };
}

/**
 * Everything waiting, less anything on an introduction still in line.
 *
 * The page never shows an in-line introduction (domain/sequencer.ts: "the
 * holder is never shown them at all", and the person waiting is told one
 * sentence by their assistant). The reads in domain/counterOps.ts already
 * carry the live filter; this is the second wall, applied to every list the
 * main page groups, including the open links, whose reads live elsewhere.
 */
export function dropInLine<W extends WaitingInputs>(w: W, inLine: Set<string>): W {
  if (!inLine.size) return w;
  const keep = (id: unknown) => !inLine.has(String(id));
  return {
    ...w,
    openLinks: w.openLinks.filter((l) => {
      const m = matchOfLink(l);
      return !m || keep(m);
    }),
    offers: w.offers.filter((o) => keep(o.match_id)),
    disclosures: w.disclosures.filter((d) => keep(d.match_id)),
    settlements: w.settlements.filter((st) => keep(st.match_id)),
    messages: w.messages.filter((m) => keep(m.match_id)),
    ...(w.confirmations ? { confirmations: w.confirmations.filter((c) => keep(c.match_id)) } : {}),
    ...(w.ownOpenOffers ? { ownOpenOffers: w.ownOpenOffers.filter((o) => keep(o.match_id)) } : {}),
  };
}

/** A box's steps: the match's own story, then what is waiting, oldest first. */
export function mergeSteps(story: MatchStep[], waiting: MatchStep[]): MatchStep[] {
  return [...story, ...waiting]
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.at.getTime() - b.s.at.getTime() || a.i - b.i)
    .map((x) => x.s);
}
