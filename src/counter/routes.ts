/**
 * The human page class — the ONE secure surface where humans do everything
 * agents must never do: register, set the PIN, approve disclosures &
 * settlements, review the ledger, hit the kill switch. It is served from the
 * root of its own hostname (my[-dev].openswitchboard.ai); the old counter
 * hostname and the old /counter path prefix both 308 here (see app.ts).
 *
 * STRUCTURAL ISOLATION (tested in both directions):
 *  - every one of these routes lives inside this scoped plugin, whose FIRST
 *    onRequest hook hard-403s any request carrying an Authorization header —
 *    an MCP bearer token is useless here by construction;
 *  - counter auth is a host-only session cookie that /mcp never reads
 *    (its auth looks exclusively at the Authorization header);
 *  - these routes 404 on the MCP hostname (and /mcp 404s on this one).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ACCOUNTLESS_VERIFICATIONS_PER_HOUR,
  accountlessVerificationCeiling,
  anonymousSessionLimiter,
  areaSuggestLimiter,
  killSwitchLimiter,
  pinAttemptLimiter,
  rateLimitBypassed,
  verificationEmailLimiter,
} from '../abuseLimit.js';
import { getPool } from '../db.js';
import { getAccount, findAccountByEmail, getHearsVia, getTimezone, setHearsVia, setTimezone } from '../domain/accounts.js';
import { isValidTimeZone } from '../domain/localTime.js';
import { suggestAreas } from '../geo/suggest.js';
import { countryOfTimeZone } from '../geo/homeCountry.js';
import {
  CADENCE_NEEDS_RUNS_ON_ITS_OWN,
  arrangementInPlainWords,
  isEmpty as arrangementIsEmpty,
  readArrangement,
  readArrangementUpdatedAt,
  saveArrangement,
  validateArrangement,
} from '../domain/arrangement.js';
import { withdrawIntent } from '../domain/cards.js';
import { acceptOfferByHuman, proposeOffer } from '../domain/offers.js';
import {
  MODE_NAMES,
  readNegotiation,
  saveNegotiation,
  validateMandate,
  validateOfferNote,
  type NegotiationMode,
} from '../domain/negotiation.js';
import {
  declineMatch,
  getMatch,
  readVerdict,
  recordStage3OptIn,
  recordVerdict,
  sideOf,
  readerSide,
  readersOwnThingLabel,
} from '../domain/matches.js';
import { categoryLeafLabel, ownThingPhrase } from '../domain/matchRules.js';
import {
  draftToFields,
  newestOfferDraft,
  newestOfferDraftForCard,
} from '../domain/offerDrafts.js';
import {
  profileIsFilled,
  readSharedProfile,
  saveSharedProfile,
  validateSharedProfile,
} from '../domain/profile.js';
import { rejectionInPlainWords } from '../domain/screening.js';
import { REASON_MAX_CHARS, fileReport } from '../safety/reports.js';
import { emailIsSuspended, isSuspended } from '../safety/suspend.js';
import { reportLink } from '../domain/humanLinks.js';
import { OsbError } from '../protocol.js';
import * as ops from '../domain/counterOps.js';
import * as agentKeys from '../domain/agentKeys.js';
import * as settlements from '../domain/settlements.js';
import {
  checkoutUrlForSettlement,
  ensureSellerStripeAccount,
  moveSplitForSettlement,
  refundAgreedAmountForSettlement,
  sellerAccountReady,
  sellerOnboardingLink,
  sellerStripeAccountId,
  transferToSellerForSettlement,
} from '../domain/settlementStripe.js';
import {
  evidenceViewLinks,
  presignEvidenceUpload,
  writeEvidenceManifest,
} from '../domain/evidence.js';
import {
  MAX_CAPTION_CHARS,
  MAX_PHOTO_BYTES,
  PHOTO_TTL_DAYS,
  checkCaption,
  markPhotoSent,
  openPhotoLink,
  presignPhotoUpload,
} from '../domain/channelPhoto.js';
import { settlementsConfigured } from '../config.js';
import { formatMinor, isZeroDecimal, settlementBreakdown, toMinorUnits } from '../stripe.js';
import { createAuthCode, validateAuthorizeRequest } from '../auth/oauth.js';
import * as pages from './pages.js';
import * as home from './pagesHome.js';
import * as sess from './session.js';
import {
  clearPinHold,
  hashPin,
  holdRecoveredPin,
  pinFormatOk,
  pinHeldUntil,
  verifyPinAttempt,
  PIN_ELEVATION_MINUTES,
} from './pin.js';
import {
  createVerification,
  verificationRateLimited,
  verifyByCode,
  verifyByLinkToken,
} from './verification.js';
import { sendKillSwitchEmail, sendSecurityNoticeEmail, sendSettlementEmail, sendVerificationEmail } from './email.js';
import {
  aboutThing,
  categoryPhrase,
  theirThing,
  offerAmountInWords as templateMoney,
} from '../email/templates.js';
import { consumeEmailToken, verifyEmailToken } from '../email/tokens.js';
import { isEmailQueueFull } from '../email/send.js';
import { emailHashes } from '../domain/accounts.js';
import * as links from './links.js';
import {
  boxTitle,
  dropInLine,
  groupWaitingByMatch,
  matchOfLink,
  mergeSteps,
  stepTime,
  type MatchBoxView,
} from './matchStory.js';
import { buildSteps, readStoryFacts, readTheirThing } from '../domain/matchStory.js';
import { consumeLink, verifyLinkToken, type ApprovalLinkRow } from './links.js';
import {
  acceptAnomalyLine,
  counterpartyIsNew,
  offerAmountAnomaly,
  settlementAnomalyLine,
} from './anomalies.js';
import * as wa from './webauthn.js';
import * as creds from './credentials.js';
import { PATCH_FAVICON_PNG, PATCH_HEADER_PNG } from './patchAsset.js';
import type { Config } from '../config.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/**
 * Every `:id` on these pages is a uuid — a card, an introduction, an offer, a
 * settlement. Anything else is not a thing that was ever handed out, so it is
 * answered as missing rather than carried into a query that would throw and
 * come back as a 500 with a database error in the log.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A category as it reads inside a sentence: "your mountain bike match", where
 * a heading or a badge would say "Mountain bikes". Badges keep the label. The
 * shaping itself is the email templates' categoryPhrase, so a person reading
 * the email and then the page meets the same words.
 */
const phrase = (category: string) => categoryPhrase(category);

/**
 * The reader's own want or have inside a sentence on a press page, in their
 * own words: their posting's kind where it has one, the shelf's phrase only
 * where it has none (27 September 2026: "for Road bikes" was the shelf).
 * Only ever the reader's own posting; the other side's words are theirs.
 */
async function readersOwnPhrase(
  m: { account_want: string; card_want: string; card_have: string; category: string },
  accountId: string,
): Promise<string> {
  const cardId = accountId === m.account_want ? m.card_want : m.card_have;
  const r = await getPool().query('SELECT category, kind FROM cards WHERE id = $1', [cardId]);
  return ownThingPhrase(r.rows[0]?.category ?? m.category, r.rows[0]?.kind ?? null).words;
}

/**
 * The thing's name at the start of it, as a person would write it: "Trek" for
 * "trek". Nothing else in it changes. Canonicalised words arrive lower-cased,
 * and a heading that reads "your trek" looks like a typo.
 */
function firstUp(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Minor units back to the figure a person reads, for the money words. */
function fromMinor(minor: number, ccy: string): number {
  return isZeroDecimal(ccy) ? minor : minor / 100;
}

/** Every registered human-page route (method + url), recorded at registration
 *  time so the isolation test can enumerate the ENTIRE route class. */
export const COUNTER_ROUTE_TABLE: { method: string; url: string }[] = [];

type Session = NonNullable<Awaited<ReturnType<typeof sess.loadSession>>>;

export function registerCounterRoutes(app: FastifyInstance, cfg: Config): void {
  const mcpHost = new URL(cfg.publicOrigin).host;
  const counterHostName = new URL(cfg.counterOrigin).host.toLowerCase();

  app.register(async (counter) => {
    counter.addHook('onRoute', (o) => {
      for (const m of Array.isArray(o.method) ? o.method : [o.method]) {
        if (m === 'HEAD' || m === 'OPTIONS') continue;
        if (!COUNTER_ROUTE_TABLE.some((r) => r.method === m && r.url === o.url)) {
          COUNTER_ROUTE_TABLE.push({ method: m, url: o.url });
        }
      }
    });

    // ---- The route-class guard: agent credentials are rejected outright. ----
    counter.addHook('onRequest', async (req, reply) => {
      if (req.headers.authorization) {
        return reply.code(403).send({
          error: 'agent_credentials_rejected',
          error_description:
            'These pages are human-only. Agent bearer tokens are not accepted on any of them.',
        });
      }
      if ((req.headers.host ?? '').toLowerCase() === mcpHost.toLowerCase()) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // ---- Nothing on another site may press a button on this one. ----
      //
      // The session cookie is SameSite=Lax, which stops a cross-site POST in
      // every browser that honours it. This is the second lock, and it is the
      // one the server itself holds: a form on another page, or a fetch from
      // it, arrives with an Origin naming that page or a Sec-Fetch-Site
      // saying cross-site, and is turned away before any route sees it.
      //
      // Only writes are checked. A GET changes nothing here, and the browsers
      // that send neither header (old ones, and some in-app webviews) can
      // still read.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
        const site = String(req.headers['sec-fetch-site'] ?? '');
        if (site && site !== 'same-origin' && site !== 'none') {
          return reply.code(403).send({ error: 'cross_site_request' });
        }
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin !== 'null') {
          let host: string;
          try {
            host = new URL(origin).host.toLowerCase();
          } catch {
            return reply.code(403).send({ error: 'cross_site_request' });
          }
          const ours = (req.headers.host ?? '').toLowerCase();
          if (host !== ours && host !== counterHostName) {
            return reply.code(403).send({ error: 'cross_site_request' });
          }
        }
      }
      // ---- An id that is not an id is a page that does not exist. ----
      const id = (req.params as any)?.id;
      if (typeof id === 'string' && !UUID_RE.test(id)) {
        if (req.method === 'GET') {
          return reply
            .code(404)
            .type('text/html')
            .send(pages.messagePage('Not found', '<p>There is nothing here.</p>'));
        }
        return reply.code(404).send({ error: 'not_found' });
      }
    });

    const html = (reply: FastifyReply, body: string, code = 200) =>
      reply.code(code).type('text/html').send(body);

    /** The three lines a settlement charges the buyer, written out for a
     *  human. The seller receives the agreed amount in full; the introductory
     *  fee and the card processing are the buyer's, itemised. */
    type SettlementMoneyRow = {
      amount: string;
      ccy: string;
      fee_amount_minor?: number | null;
      processing_fee_minor?: number | null;
      buyer_total_minor?: number | null;
    };
    /** The same three lines in minor units, for pages that write them as sentences. */
    const settlementMinorLines = (row: SettlementMoneyRow) => {
      const amountMinor = toMinorUnits(Number(row.amount), row.ccy);
      const stored =
        row.buyer_total_minor != null &&
        row.processing_fee_minor != null &&
        row.fee_amount_minor != null;
      return stored
        ? {
            amountMinor,
            feeMinor: row.fee_amount_minor!,
            processingMinor: row.processing_fee_minor!,
            buyerTotalMinor: row.buyer_total_minor!,
          }
        : settlementBreakdown(amountMinor, cfg);
    };
    const settlementMoneyLines = (row: SettlementMoneyRow) => {
      const amountMinor = toMinorUnits(Number(row.amount), row.ccy);
      // Once a Checkout Session exists the row holds the exact figures the
      // buyer was shown, and those are what both humans keep seeing. Before
      // that there is nothing to show but what today's config would charge.
      const stored =
        row.buyer_total_minor != null &&
        row.processing_fee_minor != null &&
        row.fee_amount_minor != null;
      const b = stored
        ? {
            amountMinor,
            feeMinor: row.fee_amount_minor!,
            processingMinor: row.processing_fee_minor!,
            buyerTotalMinor: row.buyer_total_minor!,
          }
        : settlementBreakdown(amountMinor, cfg);
      return {
        amount: formatMinor(b.amountMinor, row.ccy),
        fee: formatMinor(b.feeMinor, row.ccy),
        processing: formatMinor(b.processingMinor, row.ccy),
        buyerTotal: formatMinor(b.buyerTotalMinor, row.ccy),
      };
    };

    // A failed send (SES congestion, sandbox quota) still shows the code page:
    // the code is still required, and the honest note says the email may lag.
    const sendCodeOrNote = async (
      req: FastifyRequest,
      email: string,
      v: { code: string; linkToken: string },
      purpose: 'register' | 'login',
    ): Promise<string | undefined> => {
      try {
        await sendVerificationEmail(cfg, email, v.code, v.linkToken, purpose);
        return undefined;
      } catch (err) {
        if (isEmailQueueFull(err)) {
          // The queue in front of SES is full, so this code was never sent and
          // waiting for it would be waiting for nothing. Say so plainly.
          req.log.warn({ purpose }, 'verification email refused: the send queue is full');
          return 'Our email sending is backed up right now, so no code went out. Try again in a minute.';
        }
        // The name and the HTTP status only: an SES error message quotes the
        // recipient address back, and that would sit in the log for good
        // (the same rule as src/email/send.ts).
        req.log.warn(
          { err_name: (err as any)?.name, http_status: (err as any)?.$metadata?.httpStatusCode },
          'verification email send failed; showing code page with delay note',
        );
        return 'Our email sending is congested right now, so the code may take a while to arrive. This page keeps working — enter the code once it lands.';
      }
    };

    // Notification emails must never break the action they describe.
    const notifyBestEffort = async (req: FastifyRequest, what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        req.log.warn(
          { what, err_name: (err as any)?.name, http_status: (err as any)?.$metadata?.httpStatusCode },
          'notification email failed; action completed anyway',
        );
      }
    };

    /**
     * A stopped account, met on the human surface.
     *
     * Suspending deletes the sessions, so in the ordinary course nobody gets
     * this far. This is the floor under that: a session created in the same
     * second, a link pressed from a tab that was already open, an account
     * stopped by a path that did not go through suspendAccount. Returns true
     * once it has answered, and the caller stops.
     */
    const stopped = async (accountId: string, reply: FastifyReply): Promise<boolean> => {
      if (!(await isSuspended(accountId))) return false;
      void html(reply, pages.suspendedPage(), 403);
      return true;
    };

    const requireSession = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<Session | undefined> => {
      const s = await sess.loadSession(req);
      if (!s?.accountId) {
        if (req.method === 'GET') void reply.redirect('/login', 303);
        else void reply.code(401).send({ error: 'not_signed_in' });
        return undefined;
      }
      // Nothing in, nothing out — on this surface as much as at the tools.
      if (await stopped(s.accountId, reply)) return undefined;
      return s as Session;
    };

    /**
     * What this account holds, read off the database. The RULES that follow
     * from it — what a ceremony may ask for, whether one is needed, where a
     * signed-in person belongs next — live in credentials.ts, which knows
     * nothing about sessions or SQL and is where they are tested.
     */
    const credentialsOf = async (accountId: string, a?: any): Promise<creds.CredentialState> => {
      const acct = a ?? (await getAccount(accountId));
      return { hasPin: !!acct?.pin_hash, hasPasskey: await wa.accountHasPasskey(accountId) };
    };

    /** What every page that asks for a sensitive-action ceremony has to render. */
    const ceremonyFor = async (
      accountId: string,
      elevated: boolean,
      a?: any,
    ): Promise<pages.CeremonyView> => ({ ...(await credentialsOf(accountId, a)), elevated });

    /** True once this account can approve something: either credential does. */
    const holdsCredential = async (accountId: string, a?: any): Promise<boolean> =>
      creds.holdsCredential(await credentialsOf(accountId, a));

    const nextStep = async (accountId: string, s: Session): Promise<string> => {
      const a: any = await getAccount(accountId);
      if (!a) return '/login';
      return creds.nextStepFor(a, await credentialsOf(accountId, a), {
        hasOauthCtx: !!s.oauthCtx,
      });
    };

    /**
     * Where a person goes the moment they have signed in. Onboarding and a
     * pending authorisation come first, as they always did; once there is
     * nothing of that left, a person who was sent to sign in from a link goes
     * back to that link (session.ts, takeReturnPath) rather than to the main
     * page with the link lost in the chat. The cookie is spent either way.
     */
    const afterSignIn = async (
      req: FastifyRequest,
      reply: FastifyReply,
      accountId: string,
      s: Session,
    ): Promise<string> => {
      const next = await nextStep(accountId, s);
      if (next !== '/') return next;
      return sess.takeReturnPath(req, reply) ?? next;
    };

    // ------------------------------------------------------------------
    // Patch. The one image these pages carry, at the two sizes they use it:
    // the header mark and the browser tab. Both are compiled into the build
    // (see patchAsset.ts), so they are immutable for the life of a deploy and
    // say so — a phone opening an approval link fetches each of them once.
    // ------------------------------------------------------------------
    const servePng = (reply: FastifyReply, bytes: Buffer, tag: string) =>
      reply
        .code(200)
        .type('image/png')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .header('etag', `"${tag}-${bytes.length}"`)
        .send(bytes);

    counter.get('/assets/patch.png', async (_req, reply) =>
      servePng(reply, PATCH_HEADER_PNG, 'patch'),
    );
    counter.get('/assets/favicon.png', async (_req, reply) =>
      servePng(reply, PATCH_FAVICON_PNG, 'favicon'),
    );

    // ------------------------------------------------------------------
    // Landing / dashboard.
    // ------------------------------------------------------------------
    counter.get('/', async (req, reply) => {
      const s = await sess.loadSession(req);
      if (!s?.accountId) return html(reply, pages.landingPage());
      const a: any = await getAccount(s.accountId);
      if (!a) return html(reply, pages.landingPage());
      // The onboarding question sits between the PIN and everything else, so
      // the front page sends a first-time person there before it renders.
      if (!(await holdsCredential(s.accountId, a)) || a.status === 'pending' || !a.onboarded_at) {
        return reply.redirect(await nextStep(s.accountId, s as Session), 303);
      }
      // What this page asks for is what it is going to show: the gates. The
      // one-tap verdict moved to the introduction's own page, so the front
      // page no longer reads a list of introductions to browse.
      const [profile, inLine, offers, disclosures, counts, liveSettlements, rejected, lapsingSoon, messagesWaiting, agreed] = await Promise.all([
        readSharedProfile(s.accountId, { purpose: 'dashboard-view', actor: s.accountId }),
        // Introductions still in line: nothing about them is shown or
        // pressable on this page (domain/sequencer.ts). The reads below carry
        // the live filter themselves; this set is the second wall.
        ops.inLineMatchIds(s.accountId),
        ops.pendingOffers(s.accountId),
        ops.pendingDisclosures(s.accountId),
        getPool().query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE lifecycle_state = 'PUBLISHED')::int AS published,
                  count(*) FILTER (WHERE lifecycle_state = 'PENDING_SCREENING')::int AS pending
           FROM cards WHERE account_id = $1`,
          [s.accountId],
        ),
        getPool().query(
          `SELECT st.*, m.category FROM settlements st JOIN matches m ON m.id = st.match_id
           WHERE (st.buyer_account = $1 OR st.seller_account = $1)
             AND st.state <> ALL('{released,refunded,declined}'::text[])
             AND ${ops.NOT_IN_LINE_SQL}
           ORDER BY st.created_at DESC LIMIT 20`,
          [s.accountId],
        ),
        ops.screeningRejectedCards(s.accountId),
        ops.cardsLapsingSoon(s.accountId),
        ops.messagesWaitingFor(s.accountId),
        ops.agreedOnMatches(s.accountId),
      ]);
      // Every open link this person has been handed, so a request never
      // depends on them still having the chat it came in.
      const keep = (id: unknown) => !inLine.has(String(id));
      const allOpenLinks = await links.openLinksFor(s.accountId);
      const settlementRows = liveSettlements.rows.filter((st: any) => keep(st.match_id));
      const settlementsWaiting = settlementRows.map((st: any) => {
        const mine = st.buyer_account === s.accountId ? st.buyer_approved_at : st.seller_approved_at;
        return {
          id: String(st.id),
          match_id: String(st.match_id),
          amount: st.amount,
          ccy: st.ccy,
          created_at: st.created_at,
          needsApproval:
            !mine && ['proposed', 'approved-by-buyer', 'approved-by-seller'].includes(st.state),
        };
      });
      // ONE BOX PER MATCH (27 September 2026). Everything waiting on one match
      // is gathered into one box under the story of that match, so a figure
      // and the reply to it read in the order they happened. What belongs to
      // no match keeps a plain card below.
      const ownOpen = await getPool().query(
        `SELECT match_id::text, amount, ccy FROM offers
          WHERE proposer_account = $1 AND state IN ('proposed', 'awaiting-human') AND expiry > now()`,
        [s.accountId],
      );
      const waitingNow = dropInLine(
        {
          openLinks: allOpenLinks,
          offers,
          disclosures,
          settlements: settlementsWaiting,
          messages: messagesWaiting,
          ownOpenOffers: ownOpen.rows,
        },
        inLine,
      );
      const openLinks = waitingNow.openLinks;
      const grouped = groupWaitingByMatch(waitingNow);
      const timezone: string | null = typeof a.timezone === 'string' && a.timezone ? a.timezone : null;
      const matchBoxes: MatchBoxView[] = [];
      const unboxed = new Set<string>();
      for (const [matchId, waiting] of grouped.byMatch) {
        let story: Awaited<ReturnType<typeof readStoryFacts>>;
        try {
          story = await readStoryFacts(s.accountId, matchId);
        } catch {
          story = undefined;
        }
        if (!story) {
          unboxed.add(matchId);
          continue;
        }
        // The other side's own words for their thing, read through the same
        // function that serves the details to the assistant.
        const theirs = await readTheirThing(s.accountId, matchId);
        matchBoxes.push({
          head: theirs ? { ...story.head, theirs } : story.head,
          steps: mergeSteps(buildSteps(story.facts), waiting.steps),
          actions: waiting.actions,
        });
      }
      // Newest activity first.
      const lastAt = (b: MatchBoxView) =>
        Math.max(0, ...b.steps.filter((x) => !x.noTime).map((x) => x.at.getTime() || 0));
      matchBoxes.sort((x, y) => lastAt(y) - lastAt(x));
      // IN PROGRESS (27 September 2026): every other open match, one line
      // each, so a person sees all that is going on without a decision
      // attached. The line is the latest step of the same story the boxes
      // tell, and it links to the match's own page for the rest.
      const openMatches = await getPool().query(
        `SELECT id::text FROM matches
          WHERE (account_want = $1 OR account_have = $1) AND state = 'open' AND live
          ORDER BY created_at DESC LIMIT 20`,
        [s.accountId],
      );
      const inProgress: { href: string; title: string; last: string; at: number }[] = [];
      for (const { id } of openMatches.rows as { id: string }[]) {
        if (grouped.byMatch.has(id)) continue;
        let story: Awaited<ReturnType<typeof readStoryFacts>>;
        try {
          story = await readStoryFacts(s.accountId, id);
        } catch {
          story = undefined;
        }
        if (!story) continue;
        const steps = buildSteps(story.facts);
        const last = steps[steps.length - 1];
        if (!last) continue;
        inProgress.push({
          href: `/matches/${id}`,
          title: boxTitle(story.head),
          last: last.text,
          at: last.at?.getTime?.() || 0,
        });
      }
      inProgress.sort((x, y) => y.at - x.at);
      // A match whose story could not be read falls back to the plain cards.
      const loose = openLinks.filter((l) => {
        const m = matchOfLink(l);
        return !m || unboxed.has(m);
      });
      const offerIds = new Set(waitingNow.offers.map((o) => String(o.offer_id)));
      const disclosureIds = new Set(waitingNow.disclosures.map((d) => String(d.match_id)));
      const pendingApprovals = [
        // The open requests first: each one is a page an assistant handed
        // over, and each runs out in minutes. The button goes through the
        // session (GET /open/:id), so no token is written into this page. An
        // offer or a names question that has its own row below is not listed
        // twice.
        ...loose
          .filter(
            (l) =>
              !(l.action === 'offer-accept' && offerIds.has(String(l.ref_id))) &&
              !(l.action === 'stage3-disclosure' && disclosureIds.has(String(l.ref_id))),
          )
          .map((l) => ({
            href: `/open/${l.id}`,
            label: home.openRequestLabel(l.action, l.category ? phrase(l.category) : undefined),
            ...(l.amount !== null && l.ccy ? { amount: `${Number(l.amount)} ${l.ccy}` } : {}),
            cta: home.OPEN_REQUEST_CTA,
          })),
        // A want or have screening turned away is off the board until it is
        // changed, and the change is the assistant's to make (amend_intent):
        // there is no edit page. So the tile says why and what to do, and
        // opens nothing.
        ...rejected.map((c) => {
          const rej = rejectionInPlainWords(c.screening);
          return {
            label: `Your ${ownThingPhrase(c.category, c.kind).words} needs a change.`,
            lines: [...(rej ? [rej.plain] : []), home.REJECTED_TILE_LINE],
          };
        }),
        ...waitingNow.offers
          .filter((o) => unboxed.has(String(o.match_id)))
          .map((o) => ({
            href: `/approvals/offer/${o.offer_id}`,
            label: `Offer on your ${phrase(o.category)} match`,
            amount: `${Number(o.amount)} ${o.ccy}`,
          })),
        ...waitingNow.disclosures
          .filter((d) => unboxed.has(String(d.match_id)))
          .map((d) => ({
            href: `/approvals/match/${d.match_id}`,
            label: `Share your details on your ${phrase(d.category)} match?`,
          })),
        ...settlementRows
          .filter((st: any) => unboxed.has(String(st.match_id)))
          .map((st: any) => {
            const w = settlementsWaiting.find((x) => x.id === String(st.id));
            return {
              href: w?.needsApproval ? `/approvals/settlement/${st.id}` : `/settlements/${st.id}`,
              label: `Settlement on your ${phrase(st.category)} match (${st.state})`,
              amount: `${Number(st.amount)} ${st.ccy}`,
            };
          }),
      ];
      // Sent here by the Authorize page after the agent's callback opened in
      // its own tab. The agent proves it finished by exchanging its code for a
      // token, so a fresh token for this client is the "connected" signal.
      // A save on settings, the arrangement or the shared profile lands back
      // here with one line saying so. The line is chosen from a fixed list by
      // a short code, so nothing typed into the address bar reaches the page.
      const savedKey = String((req.query as any)?.saved ?? '');
      let notice: string | undefined = Object.hasOwn(SAVED_NOTICES, savedKey) ? SAVED_NOTICES[savedKey] : undefined;
      // "Keep them all" on the lapsing tile lands back here (POST /renew/lapsing).
      if (String((req.query as any)?.renewed ?? '') === '1') notice = home.RENEWED_NOTICE;
      let awaitingConnect = false;
      const authorized = String((req.query as any)?.authorized ?? '');
      if (/^[0-9a-f-]{36}$/i.test(authorized)) {
        const c = await getPool().query(
          `SELECT c.client_name,
                  EXISTS (SELECT 1 FROM oauth_tokens t
                           WHERE t.client_id = c.client_id AND t.account_id = $2
                             AND t.created_at > now() - interval '15 minutes') AS connected
             FROM oauth_clients c WHERE c.client_id = $1`,
          [authorized, s.accountId],
        );
        const row = c.rows[0];
        if (row) {
          awaitingConnect = !row.connected;
          notice = row.connected
            ? `${row.client_name} is connected and can work the switchboard for you.`
            : `You authorised ${row.client_name}. It has not finished connecting yet. This page checks again on its own. If the new tab showed a connection error, paste the address-bar link back into ${row.client_name} where it is waiting for it.`;
        }
      }
      return html(
        reply,
        home.dashboardPage({
          notice,
          awaitingConnect,
          firstName: profile.firstName || undefined,
          emailUnreachable: !!a.email_unreachable_at,
          killSwitchOn: !!a.kill_switch_at,
          // Turning the kill switch back off is the one sensitive press on
          // this page, so it asks for whichever credential this account holds.
          ceremony: await ceremonyFor(s.accountId, sess.isElevated(s), a),
          cardCounts: counts.rows[0],
          ...(lapsingSoon
            ? {
                lapsingSoon: {
                  count: lapsingSoon.count,
                  soonest: pages.localTime(lapsingSoon.soonest, 'day'),
                },
              }
            : {}),
          pendingApprovals,
          matchBoxes,
          inProgress: inProgress.map(({ href, title, last }) => ({ href, title, last })),
          timezone,
          messagesWaiting: waitingNow.messages.filter((m) => unboxed.has(String(m.match_id))).map((m) => ({
            matchId: m.match_id,
            category: categoryLeafLabel(m.category),
            count: m.count,
          })),
          agreed: agreed.filter((a) => keep(a.match_id)).map((a) => ({
            matchId: a.match_id,
            category: categoryLeafLabel(a.category),
            amount: `${Number(a.amount)} ${a.ccy}`,
          })),
        }),
      );
    });

    counter.post('/logout', async (req, reply) => {
      await sess.destroySession(req, reply);
      return reply.redirect('/', 303);
    });

    // ------------------------------------------------------------------
    // Registration: email -> code -> a passkey OR a PIN -> consent.
    //
    // The choice screen (/secure) replaced the step that demanded a PIN on
    // 2026-09-16. Taking the passkey finishes registration with no PIN on the
    // account; taking the PIN is what always happened, and the passkey offer
    // still follows it.
    // ------------------------------------------------------------------
    counter.get('/register', async (_req, reply) => {
      if (cfg.registrationMode === 'closed') {
        return html(reply, pages.registrationClosedPage());
      }
      return html(reply, pages.registerEmailPage());
    });

    counter.post('/register', async (req, reply) => {
      if (cfg.registrationMode === 'closed') {
        // Prod: the create-account door stays SHUT until launch. No bypass.
        return html(reply, pages.registrationClosedPage());
      }
      const email = String((req.body as any)?.email ?? '').trim();
      if (!EMAIL_RE.test(email)) {
        return html(reply, pages.registerEmailPage('That does not look like an email address.'), 400);
      }
      if (await verificationRateLimited(email)) {
        return html(
          reply,
          pages.registerEmailPage('Too many codes requested for that address. Wait a few minutes.'),
          429,
        );
      }
      if (!rateLimitBypassed(req.headers as Record<string, unknown>, cfg) && verificationEmailLimiter.limited(req.ip)) {
        req.log.warn({ ip: req.ip }, 'counter-register: per-IP verification-email limit hit');
        return html(
          reply,
          pages.registerEmailPage('Too many codes requested from this connection. Wait an hour.'),
          429,
        );
      }
      // The ceiling over every accountless verification at once. A botnet is a
      // thousand IPs and no IP that did anything wrong, so this is the only
      // limiter that can see it. The sentence is the same one an address that
      // already exists would get: nothing here enumerates anybody.
      if (accountlessVerificationCeiling.limited()) {
        req.log.warn(
          { depth: accountlessVerificationCeiling.depth(), ceiling: ACCOUNTLESS_VERIFICATIONS_PER_HOUR },
          'counter-register: accountless verification ceiling hit',
        );
        return html(
          reply,
          pages.registerEmailPage('Too many codes requested just now. Try again in a minute.'),
          429,
        );
      }
      const v = await createVerification(cfg, email, 'register');
      const note = await sendCodeOrNote(req, email, v, 'register');
      return html(reply, pages.codeEntryPage({ verificationId: v.id, action: '/verify', error: note }));
    });

    const finishVerification = async (
      req: FastifyRequest,
      reply: FastifyReply,
      result: { ok: boolean; reason?: string; email?: string; purpose?: string },
      verificationIdForRetry?: string,
    ) => {
      if (!result.ok) {
        const msg = {
          expired: 'That code has expired. Codes live for 15 minutes — request a fresh one.',
          used: 'That code was already used. Request a fresh one.',
          locked: 'Too many wrong attempts. Request a fresh code.',
          'bad-code': 'Wrong code. Check the most recent email.',
          'not-found': 'That code is not valid. Request a fresh one.',
        }[result.reason ?? 'not-found'];
        if (result.reason === 'bad-code' && verificationIdForRetry) {
          return html(
            reply,
            pages.codeEntryPage({
              verificationId: verificationIdForRetry,
              action: '/verify',
              error: msg,
            }),
            401,
          );
        }
        return html(
          reply,
          pages.messagePage('That code did not work', `<p>${pages.esc(msg!)}</p>`, '/register', 'Start again'),
          401,
        );
      }
      // An address a suspended account was opened under does not open another
      // one. One plain sentence and no detail: which account, when, or why is
      // nobody's business at this door, and an answer that said any of it
      // would be a way of asking the switchboard about a stranger.
      if (await emailIsSuspended(result.email!)) {
        return html(
          reply,
          pages.messagePage(
            'We cannot open an account for that address',
            '<p>That address cannot be used on the switchboard. If you think that is wrong, write to us and we will look.</p>',
            '/',
            'Back',
          ),
          403,
        );
      }
      let account: any = await findAccountByEmail(result.email!);
      if (!account) {
        // A verified address with no account behind it opens one, whichever
        // door the person came through. Someone sent to "sign in" by their
        // agent has just proved the address with this code; asking them to
        // register and prove it again with a second code was a dead end
        // (the 2026-09-09 rehearsal walked into it). Only a closed deployment
        // still says no.
        if (cfg.registrationMode === 'closed') {
          if (result.purpose === 'register') return html(reply, pages.registrationClosedPage());
          return html(
            reply,
            pages.messagePage(
              'No account for that email',
              `<p>There is no account under that address yet.</p>`,
              '/',
              'Back',
            ),
            404,
          );
        }
        account = { id: (await ops.createPendingAccount(result.email!)).id };
      }
      // A fresh session row and a fresh cookie, and the one they arrived with
      // deleted: see rotateSession for why signing in never reuses a row.
      const existing = await sess.loadSession(req);
      let s: Session = (await sess.rotateSession(reply, existing, account.id)) as Session;
      // An account with NO PIN holds a passkey, and a person can be standing
      // at a device that has never seen it. So here the emailed code opens a
      // window for the everyday presses — sharing names, keeping a
      // conversation going — and without it the person signs in and dead-ends
      // at a page asking for a passkey the device cannot produce.
      //
      // It is marked as a CODE window (28 September 2026), because anyone who
      // can read the inbox can produce one. Setting a first PIN, adding a
      // passkey, making an agent key and authorising an assistant all look for
      // the passkey itself, and money never leans on a window at all. The way
      // through for a lost passkey is /pin/recover, which says out loud what
      // it does. An account WITH a PIN keeps the old rule — a code signs you
      // in and the PIN approves.
      const acct: any = await getAccount(account.id);
      if (!acct?.pin_hash) {
        await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES, 'code');
        s = {
          ...s,
          pinOkUntil: new Date(Date.now() + PIN_ELEVATION_MINUTES * 60_000),
          elevatedVia: 'code',
        } as Session;
      }
      return reply.redirect(await afterSignIn(req, reply, account.id, s), 303);
    };

    counter.post('/verify', async (req, reply) => {
      const b: any = req.body ?? {};
      const result = await verifyByCode(cfg, String(b.verification_id ?? ''), String(b.code ?? ''));
      return finishVerification(req, reply, result, String(b.verification_id ?? ''));
    });

    counter.get('/verify', async (req, reply) => {
      const t = String((req.query as any)?.t ?? '');
      if (!t) return html(reply, pages.linkDeadPage('invalid'), 404);
      const result = await verifyByLinkToken(cfg, t);
      return finishVerification(req, reply, result);
    });

    // ------------------------------------------------------------------
    // How you approve things: the choice at registration, and the two doors
    // for adding or changing either credential afterwards.
    //
    // Once an account holds ANY credential, fitting it another one takes a
    // fresh ceremony of what it holds now — so a borrowed session cannot
    // quietly enrol its own passkey or set its own PIN. Setting a PIN and
    // enrolling a passkey both elevate the session themselves, which is what
    // lets a person walk straight from one to the other.
    // ------------------------------------------------------------------
    counter.get('/secure', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      if (await holdsCredential(s.accountId!)) {
        return reply.redirect(await nextStep(s.accountId!, s), 303);
      }
      return html(reply, pages.credentialChoicePage());
    });

    /** The gate in front of changing how you approve things. Only a window
     *  the account's own credential opened counts here, never an emailed code. */
    const freshCeremonyOr = async (
      reply: FastifyReply,
      s: Session,
      next: string,
    ): Promise<boolean> => {
      const c = await ceremonyFor(s.accountId!, sess.isStronglyElevated(s));
      if (!creds.needsFreshCeremony(c, c.elevated)) return true;
      void html(reply, pages.confirmItsYouPage(c, next));
      return false;
    };

    counter.get('/security', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const a: any = await getAccount(s.accountId!);
      const keys = await wa.listCredentials(s.accountId!);
      // The only detail this account holds about a passkey is when it was set,
      // and a date said in someone else's zone is a date that can be a day out.
      const setOn = keys
        .map((k: any) => new Date(k.created_at))
        .sort((x, y) => x.getTime() - y.getTime())[0];
      const tz = (await getTimezone(s.accountId!)) ?? 'UTC';
      // What the authenticator told us at enrolment, said the way a person
      // would recognise it. Unknown or missing transports say nothing rather
      // than guess: a wrong description of where somebody's key lives is worse
      // than no description.
      const PASSKEY_KINDS: Record<string, string> = {
        internal: 'On this device',
        hybrid: 'On a phone or tablet',
        usb: 'On a security key',
        nfc: 'On a security key',
        ble: 'On a security key',
      };
      const first: any = setOn
        ? keys.slice().sort((x: any, y: any) => +new Date(x.created_at) - +new Date(y.created_at))[0]
        : undefined;
      const passkeyKind = (first?.transports ?? [])
        .map((t: string) => PASSKEY_KINDS[t])
        .find(Boolean);
      return html(
        reply,
        pages.securityPage({
          hasPin: !!a?.pin_hash,
          passkeyCount: keys.length,
          passkeyKind,
          passkeySetOn: setOn
            ? `set ${new Intl.DateTimeFormat('en-AU', {
                timeZone: tz,
                day: 'numeric',
                month: 'short',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })
                .format(setOn)
                .replace('Sept', 'Sep')
                .replace(', ', ' at ')
                .replace(' am', 'am')
                .replace(' pm', 'pm')}`
            : undefined,
        }),
      );
    });

    /** The ceremony in front of /pin and /passkey, and nothing else. */
    const CONFIRM_TARGETS = new Set(['/pin', '/passkey']);

    counter.post('/confirm', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const next = CONFIRM_TARGETS.has(String(b.next ?? '')) ? String(b.next) : '/security';
      const okNow = await credentialCeremony(s, reply, String(b.pin ?? ''));
      if (!okNow) return;
      return reply.redirect(next, 303);
    });

    /**
     * The way through on a device that holds neither the passkey nor a PIN:
     * the same emailed code that signs a person in. On an account with no PIN
     * it opens a window for the everyday presses, and nothing that changes a
     * credential, makes a key or moves money — see finishVerification.
     */
    counter.post('/confirm/code', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const email = await ops.accountEmail(s.accountId!, 'sign-in-code');
      if (!email) {
        return html(
          reply,
          pages.messagePage('No address on file', '<p>There is no email address on this account.</p>'),
          409,
        );
      }
      if (await verificationRateLimited(email)) {
        return html(
          reply,
          pages.messagePage('Too many codes', '<p>Too many codes have gone out for this account. Wait a few minutes.</p>'),
          429,
        );
      }
      // The same per-IP rail sign-in has. This door sends an email too, and
      // being behind a session is no protection from one session pressing it
      // in a loop and draining the sending quota.
      if (!rateLimitBypassed(req.headers as Record<string, unknown>, cfg) && verificationEmailLimiter.limited(req.ip)) {
        req.log.warn({ ip: req.ip }, 'confirm-code: per-IP verification-email limit hit');
        return html(
          reply,
          pages.messagePage('Too many codes', '<p>Too many codes have gone out from this connection. Wait an hour.</p>'),
          429,
        );
      }
      const v = await createVerification(cfg, email, 'login');
      const note = await sendCodeOrNote(req, email, v, 'login');
      return html(
        reply,
        pages.codeEntryPage({ verificationId: v.id, action: '/verify', heading: 'Check your email.', error: note }),
      );
    });

    counter.get('/confirm/code', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      return html(
        reply,
        pages.messagePage(
          'Have a code emailed to you',
          `<p>We will email a six-digit code to the address on this account. Entering it signs you
in on this device and lets you approve what is waiting.</p>
<form method="POST" action="/confirm/code"><button type="submit">Email me a code</button></form>`,
        ),
      );
    });

    counter.get('/pin', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      if (!(await freshCeremonyOr(reply, s, '/pin'))) return;
      const a: any = await getAccount(s.accountId!);
      return html(reply, pages.pinSetPage(undefined, { hasPin: !!a?.pin_hash }));
    });

    counter.post('/pin/set', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const pin = String(b.pin ?? '');
      const a: any = await getAccount(s.accountId!);
      const setUp = await holdsCredential(s.accountId!, a);
      // The choice screen carries this same form, so a refusal has to come
      // back on the page the person is actually looking at.
      const refuse = (msg: string) =>
        html(
          reply,
          setUp ? pages.pinSetPage(msg, { hasPin: !!a?.pin_hash }) : pages.credentialChoicePage(msg),
          400,
        );
      if (!pinFormatOk(pin)) return refuse('The PIN must be six to twelve digits.');
      if (pin !== String(b.pin2 ?? '')) return refuse('The two entries did not match.');
      const hadPasskey = await wa.accountHasPasskey(s.accountId!);
      if (creds.needsFreshCeremony({ hasPin: !!a?.pin_hash, hasPasskey: hadPasskey }, sess.isStronglyElevated(s))) {
        // Adding or changing a PIN on an account that already holds something
        // needs a fresh ceremony of whatever it holds now. An emailed code is
        // not one: that road is /pin/recover, which holds the new PIN back.
        return html(reply, pages.confirmItsYouPage(await ceremonyFor(s.accountId!, sess.isStronglyElevated(s), a), '/pin'), 403);
      }
      await ops.setAccountPin(s.accountId!, await hashPin(pin));
      // Set behind the account's own credential (or inside registration, where
      // there is none yet), so nothing about this PIN waits.
      await clearPinHold(s.accountId!);
      // Setting a PIN is itself a ceremony: the person just proved it twice.
      // That is what lets them go straight on to add a passkey.
      await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES, 'pin');
      // 0.E security notice: an EXISTING PIN was just changed, or a first PIN
      // went onto an account that already held a passkey. Both are a new way
      // into the account, and the person hears about either.
      const noticeEvent = a?.pin_hash ? 'pin-changed' : hadPasskey ? 'pin-set' : undefined;
      if (noticeEvent) {
        const email = await ops.accountEmail(s.accountId!, 'security-notice');
        if (email) await notifyBestEffort(req, noticeEvent, () => sendSecurityNoticeEmail(cfg, email, s.accountId!, noticeEvent));
      }
      if (a?.status === 'pending') return reply.redirect('/passkey', 303);
      return reply.redirect('/security', 303);
    });

    // ------------------------------------------------------------------
    // LOST YOUR PASSKEY (28 September 2026).
    //
    // An account holding a passkey and no PIN, on a device that cannot produce
    // the passkey. The emailed code is the only thing that can stand behind a
    // PIN here, and anyone who can read the inbox can produce one, so this
    // road says what it does and does three things about it:
    //   - the security notice goes out the moment the PIN is set;
    //   - the new PIN moves no money for 24 hours (pin.ts, pin_money_from);
    //   - for those 24 hours it counts as the emailed code would, so it cannot
    //     add a passkey, make an agent key or authorise an assistant either,
    //     which would otherwise be a way round the wait.
    // The passkey keeps working throughout.
    // ------------------------------------------------------------------
    /** Only an account holding a passkey and no PIN comes this way. */
    const recoverable = async (accountId: string): Promise<boolean> => {
      const c = await credentialsOf(accountId);
      return c.hasPasskey && !c.hasPin;
    };

    counter.get('/pin/recover', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      if (!(await recoverable(s.accountId!))) return reply.redirect('/security', 303);
      // Just confirmed with the passkey: the ordinary road, with no wait.
      if (sess.isStronglyElevated(s)) return reply.redirect('/pin', 303);
      if (sess.isCodeElevated(s)) return html(reply, pages.pinRecoverPage());
      return html(reply, pages.pinRecoverStartPage());
    });

    counter.post('/pin/recover/code', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      if (!(await recoverable(s.accountId!))) return reply.redirect('/security', 303);
      const email = await ops.accountEmail(s.accountId!, 'sign-in-code');
      if (!email) {
        return html(
          reply,
          pages.messagePage('No address on file', '<p>There is no email address on this account.</p>'),
          409,
        );
      }
      if (await verificationRateLimited(email)) {
        return html(
          reply,
          pages.messagePage('Too many codes', '<p>Too many codes have gone out for this account. Wait a few minutes.</p>'),
          429,
        );
      }
      if (!rateLimitBypassed(req.headers as Record<string, unknown>, cfg) && verificationEmailLimiter.limited(req.ip)) {
        req.log.warn({ ip: req.ip }, 'pin-recover-code: per-IP verification-email limit hit');
        return html(
          reply,
          pages.messagePage('Too many codes', '<p>Too many codes have gone out from this connection. Wait an hour.</p>'),
          429,
        );
      }
      const v = await createVerification(cfg, email, 'login');
      const note = await sendCodeOrNote(req, email, v, 'login');
      return html(
        reply,
        pages.codeEntryPage({
          verificationId: v.id,
          action: '/pin/recover/verify',
          heading: 'Check your email.',
          error: note,
        }),
      );
    });

    counter.post('/pin/recover/verify', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      if (!(await recoverable(s.accountId!))) return reply.redirect('/security', 303);
      const b: any = req.body ?? {};
      const vid = String(b.verification_id ?? '');
      const result = await verifyByCode(cfg, vid, String(b.code ?? ''));
      const a: any = await getAccount(s.accountId!);
      const hashes = result.ok ? emailHashes(result.email!) : undefined;
      if (!result.ok || !a || (hashes!.v2 !== a.email_hash_v2 && hashes!.v1 !== a.email_hash)) {
        return html(
          reply,
          pages.codeEntryPage({
            verificationId: vid,
            action: '/pin/recover/verify',
            heading: 'Check your email.',
            error: 'That code did not work. Check the most recent email, or go back and have a fresh one sent.',
          }),
          401,
        );
      }
      await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES, 'code');
      return html(reply, pages.pinRecoverPage());
    });

    counter.post('/pin/recover', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      if (!(await recoverable(s.accountId!))) return reply.redirect('/security', 303);
      if (!sess.isElevated(s)) return html(reply, pages.pinRecoverStartPage(), 403);
      const b: any = req.body ?? {};
      const pin = String(b.pin ?? '');
      if (!pinFormatOk(pin)) return html(reply, pages.pinRecoverPage('The PIN must be six to twelve digits.'), 400);
      if (pin !== String(b.pin2 ?? '')) return html(reply, pages.pinRecoverPage('The two entries did not match.'), 400);
      // The hold first, then the PIN, so the new PIN never stands unheld.
      const from = await holdRecoveredPin(s.accountId!);
      await ops.setAccountPin(s.accountId!, await hashPin(pin));
      // At once, and before the page answers: this is the one line that tells
      // the owner if it was not them.
      const email = await ops.accountEmail(s.accountId!, 'security-notice');
      if (email) {
        await notifyBestEffort(req, 'pin-set-by-code', () =>
          sendSecurityNoticeEmail(cfg, email, s.accountId!, 'pin-set-by-code'),
        );
      }
      return html(reply, pages.pinRecoveredPage(await plainWhen(s.accountId!, from)));
    });

    // ------------------------------------------------------------------
    // Passkeys: enrolment (registration ceremony) + skip.
    // ------------------------------------------------------------------
    counter.get('/passkey', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      if (!(await freshCeremonyOr(reply, s, '/passkey'))) return;
      const a: any = await getAccount(s.accountId!);
      return html(
        reply,
        pages.passkeyOfferPage({
          hasPasskey: await wa.accountHasPasskey(s.accountId!),
          hasPin: !!a?.pin_hash,
          skipLabel: a?.status === 'pending' ? 'Skip for now' : 'Back',
        }),
      );
    });

    counter.post('/passkey/options', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      // Fitting a second key to an account that already holds one is a
      // sensitive action, so it takes the ceremony the account can do now —
      // its own credential, never a window an emailed code opened.
      if (creds.needsFreshCeremony(await credentialsOf(s.accountId!), sess.isStronglyElevated(s))) {
        return reply.code(403).send({ error: 'ceremony_required' });
      }
      const options = await wa.registrationOptions(cfg, s.accountId!, 'OpenSwitchboard account');
      await sess.setWebauthnChallenge(s.id, options.challenge);
      return reply.send(options);
    });

    counter.post('/passkey/verify', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const challenge = await sess.takeWebauthnChallenge(s.id);
      if (!challenge) return reply.code(400).send({ error: 'no_pending_challenge' });
      const had = await holdsCredential(s.accountId!);
      await wa.verifyRegistration(cfg, s.accountId!, challenge, req.body);
      // A successful passkey ceremony is a sensitive-action ceremony, and
      // enrolling one is a ceremony too: the device just checked the person.
      await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES, 'passkey');
      if (had) {
        const email = await ops.accountEmail(s.accountId!, 'security-notice');
        if (email) {
          await notifyBestEffort(req, 'passkey-added', () =>
            sendSecurityNoticeEmail(cfg, email, s.accountId!, 'passkey-added'),
          );
        }
      }
      // The passkey a person picked at the choice screen is the whole of their
      // credential, so registration carries straight on from here.
      return reply.send({ ok: true, next: await nextStep(s.accountId!, s) });
    });

    counter.post('/passkey/skip', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      return reply.redirect(await nextStep(s.accountId!, s), 303);
    });

    // ------------------------------------------------------------------
    // Consent: 18+ + the consent statement -> account live. WORM first.
    // ------------------------------------------------------------------
    counter.get('/consent', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const a: any = await getAccount(s.accountId!);
      if (a?.status !== 'pending') return reply.redirect('/', 303);
      return html(reply, home.consentPage());
    });

    counter.post('/consent', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      if (b.adult !== 'yes' || b.consent !== 'yes') {
        return html(reply, home.consentPage('Tick both to open your account.'), 400);
      }
      const a: any = await getAccount(s.accountId!);
      if (!(await holdsCredential(s.accountId!, a))) return reply.redirect('/secure', 303);
      if (a.status === 'pending') {
        await ops.activateAccountWithConsent(s.accountId!, home.CONSENT_STATEMENT);
      }
      // nextStep rather than a hard-coded target: the onboarding question sits
      // between here and authorising an agent, and a first-time person passes
      // it whichever way they arrived.
      return reply.redirect(await nextStep(s.accountId!, s), 303);
    });

    // ------------------------------------------------------------------
    // Hello: the one onboarding question. How this person will hear about
    // things (hears_via), plus the first name and area they would share.
    // Skipping leaves hears_via on 'email', the safe answer.
    // ------------------------------------------------------------------
    const helloView = async (accountId: string): Promise<home.HelloView> => {
      const profile = await readSharedProfile(accountId, {
        purpose: 'onboarding-view',
        actor: accountId,
      });
      const arrangement = await readArrangement(accountId);
      return {
        hearsVia: await getHearsVia(accountId),
        firstName: profile.firstName,
        locality: profile.locality,
        timezone: await getTimezone(accountId),
        checkEvery:
          arrangement.check_every_minutes === undefined
            ? undefined
            : String(arrangement.check_every_minutes),
      };
    };

    counter.get('/hello', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const a: any = await getAccount(s.accountId!);
      if (!(await holdsCredential(s.accountId!, a)) || a.status === 'pending' || a.onboarded_at) {
        return reply.redirect(await nextStep(s.accountId!, s), 303);
      }
      return html(reply, home.helloPage(await helloView(s.accountId!)));
    });

    counter.post('/hello', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const a: any = await getAccount(s.accountId!);
      if (!(await holdsCredential(s.accountId!, a)) || a.status === 'pending') {
        return reply.redirect(await nextStep(s.accountId!, s), 303);
      }
      const b: any = req.body ?? {};
      const skipped = String(b.skip ?? '') === 'yes';
      // The browser's zone, filled into a hidden box. Recorded on a skip too
      // (26 September 2026): it is not a choice the person makes, and an
      // account made through an assistant's sign-in that skipped this page
      // was left with no clock at all. A bad or missing value is simply not
      // recorded; the settings page has the picker.
      const tz = String(b.timezone ?? '').trim();
      if (isValidTimeZone(tz)) await setTimezone(s.accountId!, tz);
      if (!skipped) {
        const want = String(b.hears_via ?? '');
        if (want === 'email' || want === 'assistant') {
          await setHearsVia(s.accountId!, want, 'counter');
        }
        // An always-on agent leaves this page with a rhythm to work to, rather
        // than an empty arrangement its agent has to negotiate from scratch.
        // Only ever onto an EMPTY arrangement: an account that already has one
        // has been through this decision properly, and a first-run page is no
        // place to overwrite it. The two stay separate questions — this writes
        // runs_on_its_own because the person just said their agent runs, not
        // because of how they hear about things.
        const cadence = String(b.check_every_minutes ?? '').trim();
        if (want === 'assistant' && cadence) {
          const existing = await readArrangement(s.accountId!);
          if (arrangementIsEmpty(existing)) {
            const checked = validateArrangement({
              runs_on_its_own: 'on',
              check_every_minutes: Number(cadence),
            });
            if (checked.ok) await saveArrangement(s.accountId!, checked.value, 'counter');
          }
        }
        const firstName = String(b.first_name ?? '').trim();
        const locality = String(b.locality ?? '').trim();
        // Both boxes or neither. Half a shared profile shares nothing, and the
        // names step would only ask for the other half later anyway.
        if (firstName || locality) {
          const checked = validateSharedProfile({ firstName, locality });
          if (!checked.ok) {
            return html(
              reply,
              home.helloPage(
                { hearsVia: await getHearsVia(s.accountId!), firstName, locality },
                checked.error,
              ),
              400,
            );
          }
          await saveSharedProfile(s.accountId!, checked.value, 'counter', cfg);
        }
      }
      await ops.markOnboarded(s.accountId!);
      return reply.redirect(await nextStep(s.accountId!, s), 303);
    });

    // ------------------------------------------------------------------
    // Login: email + code (re-verification) OR passkey.
    // ------------------------------------------------------------------
    counter.get('/login', async (req, reply) => {
      const s = await sess.loadSession(req);
      if (s?.accountId) return reply.redirect('/', 303);
      return html(reply, pages.loginEmailPage());
    });

    counter.post('/login', async (req, reply) => {
      const email = String((req.body as any)?.email ?? '').trim();
      if (!EMAIL_RE.test(email)) {
        return html(reply, pages.loginEmailPage('That does not look like an email address.'), 400);
      }
      if (await verificationRateLimited(email)) {
        return html(
          reply,
          pages.loginEmailPage('Too many codes requested for that address. Wait a few minutes.'),
          429,
        );
      }
      if (!rateLimitBypassed(req.headers as Record<string, unknown>, cfg) && verificationEmailLimiter.limited(req.ip)) {
        req.log.warn({ ip: req.ip }, 'counter-login: per-IP verification-email limit hit');
        return html(
          reply,
          pages.loginEmailPage('Too many codes requested from this connection. Wait an hour.'),
          429,
        );
      }
      // The same ceiling over every accountless verification at once; see the
      // register door above, and src/abuseLimit.ts for why it exists at all.
      if (accountlessVerificationCeiling.limited()) {
        req.log.warn(
          { depth: accountlessVerificationCeiling.depth(), ceiling: ACCOUNTLESS_VERIFICATIONS_PER_HOUR },
          'counter-login: accountless verification ceiling hit',
        );
        return html(
          reply,
          pages.loginEmailPage('Too many codes requested just now. Try again in a minute.'),
          429,
        );
      }
      // Anti-enumeration: the code page renders whether or not an account
      // exists; the emailed code is required to learn anything further.
      const v = await createVerification(cfg, email, 'login');
      const note = await sendCodeOrNote(req, email, v, 'login');
      return html(
        reply,
        pages.codeEntryPage({ verificationId: v.id, action: '/verify', heading: 'Check your email.', error: note }),
      );
    });

    counter.post('/login/passkey/options', async (req, reply) => {
      let s = await sess.loadSession(req);
      if (!s) {
        // A row for somebody not signed in yet, so it is paced per connection.
        if (!rateLimitBypassed(req.headers as Record<string, unknown>, cfg) && anonymousSessionLimiter.limited(req.ip)) {
          req.log.warn({ ip: req.ip }, 'login-passkey-options: per-IP anonymous session limit hit');
          return reply.code(429).send({ error: 'rate_limited', error_description: 'Too many tries from this connection. Wait a minute.' });
        }
        s = await sess.createSession(reply, null);
      }
      const options = await wa.authenticationOptions(cfg);
      await sess.setWebauthnChallenge(s.id, options.challenge);
      return reply.send(options);
    });

    counter.post('/login/passkey/verify', async (req, reply) => {
      const s = await sess.loadSession(req);
      if (!s) return reply.code(400).send({ error: 'no_session' });
      const challenge = await sess.takeWebauthnChallenge(s.id);
      if (!challenge) return reply.code(400).send({ error: 'no_pending_challenge' });
      const accountId = await wa.verifyAuthentication(cfg, challenge, req.body);
      const b: any = req.body ?? {};
      let live = s;
      if (b.elevate_only) {
        if (s.accountId !== accountId) return reply.code(403).send({ error: 'wrong_account' });
      } else {
        // Signing in takes a new row and a new cookie, never the one the
        // browser arrived holding.
        live = await sess.rotateSession(reply, s, accountId);
      }
      // A successful passkey ceremony is a sensitive-action ceremony.
      await sess.elevateSession(live.id, PIN_ELEVATION_MINUTES, 'passkey');
      const signedIn = { ...live, accountId } as Session;
      // Signing in goes back to the link that sent the person here; a ceremony
      // on a page they are already on goes nowhere new.
      const next = b.elevate_only
        ? await nextStep(accountId, signedIn)
        : await afterSignIn(req, reply, accountId, signedIn);
      return reply.send({ ok: true, next });
    });

    // ------------------------------------------------------------------
    // The sensitive-action ceremony (elevation).
    //
    // An elevated session passes whatever elevated it — a PIN, a passkey, or
    // an emailed code on an account that has no PIN — for the everyday
    // presses. Changing a credential, an agent key and authorising an
    // assistant take credentialCeremony below instead. Otherwise the PIN is
    // checked. An account with no PIN has nothing to check here: its page put
    // the passkey ceremony on the button itself, so reaching this without
    // elevation means the ceremony has yet to happen, and the answer says so
    // rather than calling an empty box a wrong PIN.
    // ------------------------------------------------------------------
    const ceremony = async (
      s: Session,
      reply: FastifyReply,
      pin: string,
    ): Promise<boolean> => {
      if (sess.isElevated(s)) return true;
      const a: any = await getAccount(s.accountId!);
      if (!a?.pin_hash) {
        void reply.code(401).send({
          error: 'ceremony_required',
          error_description:
            'Confirm with your passkey. On a device that does not have it, have a code emailed to you at /confirm/code.',
        });
        return false;
      }
      return pinCheck(s, reply, pin);
    };

    /** The PIN itself: checked, counted against the lockout, and on success
     *  the window opens for the presses that may lean on it. A PIN that
     *  emailed-code recovery set, and that is still waiting, opens only the
     *  kind of window the emailed code would have. */
    const pinCheck = async (s: Session, reply: FastifyReply, pin: string): Promise<boolean> => {
      // Ten tries a minute per account before argon2 or the database is
      // asked anything; the lockout in pin.ts is the rule, this is the pacing.
      if (pinAttemptLimiter.limited(s.accountId!)) {
        void reply.code(429).send({
          error: 'too_many_attempts',
          error_description: 'Too many tries. Wait a minute and try again.',
        });
        return false;
      }
      const check = await verifyPinAttempt(s.accountId!, pin);
      if (check.ok) {
        await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES, check.heldUntil ? 'code' : 'pin');
        return true;
      }
      if (check.locked) {
        void reply.code(423).send({
          error: 'pin_locked',
          error_description: `Too many wrong PINs. Locked — try again in ${Math.ceil((check.retryAfterS ?? 60) / 60)} minute(s).`,
          retry_after_s: check.retryAfterS,
        });
      } else {
        void reply.code(401).send({ error: 'pin_incorrect' });
      }
      return false;
    };

    /** A moment in the account's own clock, the way a person reads it. */
    const plainWhen = async (accountId: string, d: Date): Promise<string> => {
      const tz = (await getTimezone(accountId)) ?? 'UTC';
      const said = new Intl.DateTimeFormat('en-AU', {
        timeZone: tz,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      })
        .format(d)
        .replace('Sept', 'Sep')
        .replace(' am', 'am')
        .replace(' pm', 'pm');
      return tz === 'UTC' ? `${said} UTC` : said;
    };

    /** The sentence a PIN that is still waiting out a recovery is refused with. */
    const heldPinRefusal = async (reply: FastifyReply, accountId: string, held: Date, what: string) => {
      void reply.code(403).send({
        error: 'pin_held',
        error_description: `A new PIN can ${what} from ${await plainWhen(accountId, held)}. Your passkey works now.`,
      });
    };

    // ------------------------------------------------------------------
    // THE CREDENTIAL CEREMONY (28 September 2026).
    //
    // Changing how you approve things, making an agent key and authorising an
    // assistant hand out something that lasts. An emailed code is the
    // account's recovery and anyone who can read the inbox can produce one,
    // so none of these lean on a window it opened: they take the passkey, or
    // a PIN that is not still waiting out a recovery.
    // ------------------------------------------------------------------
    const credentialCeremony = async (
      s: Session,
      reply: FastifyReply,
      pin: string,
    ): Promise<boolean> => {
      if (sess.isStronglyElevated(s)) return true;
      const a: any = await getAccount(s.accountId!);
      if (!a?.pin_hash) {
        // A passkey, pressed on the page; or, on an account that holds
        // nothing yet, nothing that could stand behind this at all.
        const hasPasskey = await wa.accountHasPasskey(s.accountId!);
        void reply.code(401).send({
          error: 'ceremony_required',
          error_description: hasPasskey
            ? 'This takes your passkey. Go back and press again with it.'
            : 'Set up a passkey or a PIN first.',
        });
        return false;
      }
      const held = await pinHeldUntil(s.accountId!);
      if (held) {
        await heldPinRefusal(reply, s.accountId!, held, 'do this');
        return false;
      }
      return pinCheck(s, reply, pin);
    };

    // ------------------------------------------------------------------
    // MONEY ALWAYS TAKES A FRESH CEREMONY (Lachlan, 27 September 2026).
    //
    // Accepting a figure, sending one, and approving or confirming a payment
    // or a settlement are checked here, at the press, whatever window a
    // sign-in or an earlier press opened (credentials.ts MONEY_ACTIONS). A
    // passkey comes inside the form itself (the page's script puts the
    // assertion in a `passkey` field instead of elevating first), so what is
    // verified is a ceremony made for this press. Otherwise the PIN is
    // checked. An account holding only a passkey is never asked for a PIN it
    // does not have.
    // ------------------------------------------------------------------
    const moneyCeremony = async (s: Session, reply: FastifyReply, b: any): Promise<boolean> => {
      const passkey = typeof b?.passkey === 'string' ? b.passkey : '';
      if (passkey) {
        const challenge = await sess.takeWebauthnChallenge(s.id);
        let who: string | undefined;
        if (challenge) {
          try {
            who = await wa.verifyAuthentication(cfg, challenge, JSON.parse(passkey));
          } catch {
            who = undefined;
          }
        }
        if (!who || who !== s.accountId) {
          void reply.code(401).send({
            error: 'passkey_failed',
            error_description: 'That passkey did not confirm it. Go back and press again.',
          });
          return false;
        }
        await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES, 'passkey');
        return true;
      }
      const a: any = await getAccount(s.accountId!);
      if (!a?.pin_hash) {
        void reply.code(401).send({
          error: 'ceremony_required',
          error_description: 'Money takes your passkey every time. Go back and press again with it.',
        });
        return false;
      }
      // A PIN that emailed-code recovery set moves no money until its day
      // comes round. The passkey still does.
      const held = await pinHeldUntil(s.accountId!);
      if (held) {
        await heldPinRefusal(reply, s.accountId!, held, 'move money');
        return false;
      }
      return pinCheck(s, reply, String(b?.pin ?? ''));
    };

    /** The ceremony for one press: fresh for money, the window for the rest. */
    const pressCeremony = async (
      s: Session,
      reply: FastifyReply,
      b: any,
      action: string,
    ): Promise<boolean> =>
      creds.isMoneyAction(action) ? moneyCeremony(s, reply, b) : ceremony(s, reply, String(b?.pin ?? ''));

    counter.post('/pin/verify', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (okNow) return reply.send({ ok: true });
    });

    // ------------------------------------------------------------------
    // The payment approval. Link entry (/a/:token) is single-use + 15-min
    // TTL; the main page reaches the same page through the signed-in session.
    // The figures and the heading follow the one-question pages below, and the
    // money is written out in sentences rather than labelled boxes.
    // ------------------------------------------------------------------
    const settlementApprovalView = async (
      accountId: string,
      refId: string,
    ): Promise<pages.SettlementApprovalView | { error: string }> => {
      const s = await settlements.getSettlement(refId);
      if (!s) return { error: 'This payment no longer exists.' };
      let party: 'buyer' | 'seller';
      try {
        party = settlements.partyOf(s, accountId);
      } catch {
        return { error: 'This payment is not yours to decide.' };
      }
      const myApproval = party === 'buyer' ? s.buyer_approved_at : s.seller_approved_at;
      if (myApproval) return { error: 'You have already approved this payment.' };
      if (!['proposed', 'approved-by-buyer', 'approved-by-seller'].includes(s.state)) {
        return { error: 'This payment has moved on, so there is nothing to decide here.' };
      }
      const m = await getMatch(s.match_id);
      const thing = m ? firstUp(await readersOwnPhrase(m, accountId)) : '';
      const b = settlementMinorLines(s);
      const said = (minor: number) => templateMoney(fromMinor(minor, s.ccy), s.ccy);
      // Both humans see the same figures in the same words: the buyer pays the
      // fees, itemised, and the seller receives the agreed amount in full.
      const question =
        party === 'buyer'
          ? `Agree to pay ${said(b.buyerTotalMinor)}${thing ? ` for the ${thing}` : ''}?`
          : `Agree to be paid ${said(b.amountMinor)}${thing ? ` for your ${thing}` : ''}?`;
      const detail =
        party === 'buyer'
          ? [
              `That is the ${said(b.amountMinor)} you agreed, a ${said(b.feeMinor)} introductory fee, and ${said(b.processingMinor)} for card processing at Stripe's standard rate.`,
              `The money is held until you say it arrived as agreed. The seller then receives the ${said(b.amountMinor)} in full.`,
            ]
          : [
              `The buyer pays ${said(b.buyerTotalMinor)}: the ${said(b.amountMinor)} you agreed, a ${said(b.feeMinor)} introductory fee, and ${said(b.processingMinor)} for card processing.`,
              `The money is held until the buyer says it arrived as agreed. You then receive the ${said(b.amountMinor)} in full.`,
            ];
      const counterparty = party === 'buyer' ? s.seller_account : s.buyer_account;
      const anomaly = settlementAnomalyLine(await counterpartyIsNew(counterparty));
      if (anomaly) detail.push(anomaly);
      return {
        refId,
        question,
        detail,
        ...(await ceremonyFor(accountId, false)),
      };
    };

    /** The done pages both roads share, word for word. */
    const ACCEPTED_DONE: [string, string] = [
      'Accepted',
      '<p>The number is agreed. Your assistant takes it from here.</p>',
    ];
    const sharedDone = (both: boolean): [string, string] => [
      'Shared',
      both
        ? '<p>Both of you have said yes. Your first name and suburb are with them now, and theirs with you.</p>'
        : '<p>Your go-ahead is recorded. Nothing goes over until the other side says yes too.</p>',
    ];

    /** Where a done page sends the person: back to the assistant on the link
     *  road, back to the main page on the other. */
    const doneFor = (road: 'link' | 'session', title: string, body: string) =>
      road === 'link'
        ? pages.donePage(title, body)
        : pages.donePage(title, body, '/', 'Back to your main page');

    // ------------------------------------------------------------------
    // The one-question pages. One sentence, two buttons, the PIN ceremony
    // where identity or money moves. The link is bound to the exact figures
    // and ids the question names, and the PRESS is what consumes it — so the
    // page can be re-read, and a second press fails plainly.
    //
    // TWO ROADS, ONE PAGE (28 September 2026). The assistant's link opens this
    // page; so does the button on the main page (/approvals/offer/:id and
    // /approvals/match/:id), through the signed-in session. The session road
    // mints nothing and spends nothing: it builds the same question from the
    // same rows, posts to /approve, and leaves any link the assistant is
    // holding exactly as it was.
    // ------------------------------------------------------------------
    type QuestionRow = Pick<ApprovalLinkRow, 'action' | 'ref_id' | 'amount' | 'ccy' | 'payload'>;

    const oneQuestionView = async (
      accountId: string,
      row: QuestionRow,
      road: { token: string } | 'session',
    ): Promise<pages.OneQuestionView | { error: string }> => {
      const figures = links.readPayload(row) ?? {};
      const base = {
        ...(road === 'session'
          ? { session: { action: row.action, refId: row.ref_id } }
          : { token: road.token }),
        noLabel: 'Not now',
        // Elevation is stamped on by the caller, which has the session.
        ...(await ceremonyFor(accountId, false)),
        // Money asks at the press, whatever the window (credentials.ts).
        money: creds.isMoneyAction(row.action),
      };
      if (row.action === 'offer-send') {
        const m = await getMatch(row.ref_id);
        if (!m || m.state !== 'open') return { error: 'This introduction is no longer open.' };
        let side: 'want' | 'have';
        try {
          side = sideOf(m, accountId);
        } catch {
          return { error: 'This introduction is not yours.' };
        }
        const figure = templateMoney(Number(figures.amount), String(figures.ccy ?? ''));
        const short = `$${figure.slice(1).split(' ')[0]}`;
        const thing = firstUp(await readersOwnPhrase(m, accountId));
        const detail: string[] = [];
        if (figures.note) detail.push(`With your line: “${String(figures.note)}”.`);
        detail.push('Nothing is agreed until one of you accepts, and that takes a press too.');
        // Which way the money goes decides the words. A seller asks a price for
        // their own thing; a buyer offers one for the thing they are after. A
        // swap has no buyer and no seller, and says neither.
        if (m.swap) {
          return {
            ...base,
            question: `Put ${figure} to the other side?`,
            detail,
            yesLabel: 'Send this figure',
            needsPin: true,
          };
        }
        return {
          ...base,
          question:
            side === 'have'
              ? `Ask ${figure}${thing ? ` for your ${thing}` : ''}?`
              : `Offer ${figure}${thing ? ` for the ${thing}` : ''}?`,
          detail,
          yesLabel: side === 'have' ? `Offer it at ${short}` : `Offer ${short}`,
          needsPin: true,
        };
      }
      if (row.action === 'offer-accept') {
        const r = await getPool().query(
          `SELECT o.*, m.category, m.stage, m.swap, m.account_want, m.account_have, m.card_want, m.card_have FROM offers o
           JOIN matches m ON m.id = o.match_id WHERE o.id = $1`,
          [row.ref_id],
        );
        const o = r.rows[0];
        if (!o) return { error: 'That figure is no longer on the table.' };
        if (o.account_want !== accountId && o.account_have !== accountId) {
          return { error: 'That figure is not yours to decide.' };
        }
        if (o.proposer_account === accountId) {
          return { error: "That figure is your own side's. Only the other person can accept it." };
        }
        if (o.state !== 'proposed' && o.state !== 'awaiting-human') {
          return {
            error:
              o.state === 'accepted-by-human'
                ? 'That figure has already been accepted.'
                : 'That figure is no longer on the table.',
          };
        }
        // On the link road the amount and currency come off the signed row, so
        // the figure on the page is the figure the link was minted for. The
        // main page's road has no link, and reads the offer itself.
        const figure =
          row.amount !== null && row.amount !== undefined
            ? templateMoney(Number(row.amount), String(row.ccy ?? ''))
            : templateMoney(Number(o.amount), String(o.ccy ?? ''));
        const thing = firstUp(await readersOwnPhrase(o, accountId));
        const detail: string[] = [];
        // One line about anything out of the ordinary, and only when the
        // figure itself is (anomalies.ts).
        const anomaly = acceptAnomalyLine(
          await offerAmountAnomaly(accountId, o.id, Number(o.amount)),
          await counterpartyIsNew(o.proposer_account),
        );
        if (anomaly) detail.push(anomaly);
        // One line (27 September 2026): the page accepts, and everything else
        // about the number is said to the assistant.
        detail.push(pages.OFFER_ELSEWHERE_LINE);
        const own = o.swap ? '' : o.account_have === accountId ? 'your' : 'the';
        return {
          ...base,
          question: `Accept ${figure}${thing && own ? ` for ${own} ${thing}` : ''}?`,
          detail,
          yesLabel: 'Accept',
          needsPin: true,
        };
      }
      if (row.action === 'stage3-disclosure') {
        // The names question. One of the three that come to this page every
        // time: an agent can fetch the link and say what it asks, and the
        // press here is the only thing that records the go-ahead.
        const m = await getMatch(row.ref_id);
        if (!m || m.state !== 'open') return { error: 'This introduction is no longer open.' };
        try {
          sideOf(m, accountId);
        } catch {
          return { error: 'This introduction is not yours.' };
        }
        if (m.stage < 2) {
          return { error: 'The details on this one are not open yet.' };
        }
        // Nothing was ever asked for at sign-up, so the first time someone gets
        // here the page asks for the two things it is about to share.
        const own = await readSharedProfile(accountId, {
          purpose: 'stage3-approval-page',
          actor: accountId,
          refs: { match_id: row.ref_id },
        });
        return {
          ...base,
          question: 'Share your first name and suburb with the other side?',
          detail: [
            'A first name and a suburb are the only things that ever cross. Nothing goes over until the other side says yes too.',
            'Once you press it, your assistant picks the result up on its next look.',
          ],
          yesLabel: 'Share',
          needsPin: true,
          ...(profileIsFilled(own)
            ? {}
            : { collectProfile: { firstName: own.firstName, locality: own.locality } }),
        };
      }
      if (row.action === 'report') {
        // THE ONE PAGE THAT ENDS SOMETHING, and it takes the credential every
        // other press here takes. Built credential-free on 17 September, on the
        // argument that a frightened person should not have to find a PIN
        // first; the same day Lachlan decided a report is a formal press like
        // the others, because a browser-driving assistant could otherwise
        // complete it alone. A passkey is the one thing an assistant cannot
        // press for its human, and closing a conversation for good is not a
        // press anybody but the human should be able to make.
        const m = await getMatch(row.ref_id);
        if (!m) return { error: 'There is no such introduction of yours.' };
        try {
          sideOf(m, accountId);
        } catch {
          return { error: 'This introduction is not yours.' };
        }
        if (m.state !== 'open') {
          return { error: 'This one is already closed, so there is nothing left to close.' };
        }
        return {
          ...base,
          question: 'Report this person?',
          detail: [
            'Reporting closes this one straight away. Nothing more goes either way, the two of you are never put together again, and somebody here looks at what was said.',
            'They are told only that the switchboard has closed the conversation. They are never told that you reported them, who you are, or what you wrote here.',
            'This press is yours alone, so it asks for your passkey or PIN like every other decision here.',
          ],
          collectReason: {
            label: 'What happened?',
            hint: 'A line in your own words is plenty. You can leave it blank if you would rather.',
            value: '',
            maxLength: REASON_MAX_CHARS,
          },
          yesLabel: 'Report and close this',
          needsPin: true,
        };
      }
      if (row.action === 'conversation-renew') {
        // Keeping a conversation going. The question is the human's own
        // attention, so it takes the same credential the rest of these take —
        // an assistant that could press this for its human would have made the
        // budget a formality it renews for itself, which is the whole of what
        // the budget exists to stop.
        const m = await getMatch(row.ref_id);
        if (!m) return { error: 'There is no such introduction of yours.' };
        try {
          sideOf(m, accountId);
        } catch {
          return { error: 'This introduction is not yours.' };
        }
        if (m.state !== 'open' || m.stage < 4 || !m.channel_id) {
          return { error: 'There is no open conversation on this one.' };
        }
        const other = m.account_want === accountId ? m.account_have : m.account_want;
        const name = await ops.disclosedFirstName(
          accountId,
          other,
          { match_id: row.ref_id },
          'one-question-page',
        );
        const { readWindow } = await import('../domain/conversationWindow.js');
        const w = await readWindow(cfg, row.ref_id, accountId);
        const sent = w.sent === 1 ? 'One message has gone' : `${w.sent} messages have gone`;
        return {
          ...base,
          question: `Your assistant has been talking with ${name ?? 'the other person'}'s assistant about ${theirThing(await readersOwnPhrase(m, accountId), readerSide(m, accountId))}. Keep the conversation going?`,
          detail: [
            `${sent} from your side so far.`,
            'Saying yes gives your assistant another run of messages on this one. Not now leaves it paused: nothing is lost, anything they send still reaches you, and you can start it again whenever you like.',
            'They are told none of this.',
          ],
          yesLabel: 'Keep going',
          needsPin: true,
        };
      }
      if (row.action === 'collection-close') {
        // A link minted before migration 030, opened after it. The window it
        // was for no longer exists, so the page says so rather than failing.
        return { error: 'Nothing is being held up on that one any more. You can go ahead whenever you like.' };
      }
      // negotiation-auto
      const r = await getPool().query(
        'SELECT category, type, kind FROM cards WHERE id = $1 AND account_id = $2',
        [row.ref_id, accountId],
      );
      const card = r.rows[0];
      if (!card) return { error: 'Nothing like that on your ledger.' };
      const checked = validateMandate(figures, card.type);
      if (!checked.ok) return { error: checked.error };
      const m = checked.value;
      const bits: string[] = [];
      if (m.open !== undefined) bits.push(`open at ${templateMoney(m.open, m.ccy)}`);
      bits.push(
        card.type === 'HAVE'
          ? `take no less than ${templateMoney(m.limit, m.ccy)}`
          : `pay no more than ${templateMoney(m.limit, m.ccy)}`,
      );
      if (m.step !== undefined) bits.push(`move in steps of ${templateMoney(m.step, m.ccy)}`);
      return {
        ...base,
        question: `Let your assistant negotiate the ${ownThingPhrase(card.category, card.kind).words}: ${bits.join(', ')}?`,
        detail: [
          'Between those numbers your assistant can put figures on the table without asking you each time. Anything outside them still comes back to you.',
          'Accepting an offer is still yours, every single time.',
        ],
        yesLabel: 'Yes, let it negotiate',
        needsPin: true,
      };
    };

    // ------------------------------------------------------------------
    // The shelf page (SHELF_PICK). Same link machinery, its own page, and no
    // ceremony: a shelf discloses nothing and spends nothing. NOT consumed on
    // the view, because a person searches more than once before they tap.
    // ------------------------------------------------------------------
    const shelfView = async (
      accountId: string,
      row: ApprovalLinkRow,
      token: string,
      q: string,
    ): Promise<{ view: pages.ShelfPickView; asPosted: string; kind: string | null } | { error: string }> => {
      const { readShelfAttemptById } = await import('../domain/shelfGaps.js');
      const shelf = await import('../domain/shelfPick.js');
      const attempt = await readShelfAttemptById(accountId, row.ref_id);
      if (!attempt) {
        return {
          error:
            'That question is over: the posting has gone up, or the question ran out. If it still needs a shelf, ask your assistant for a fresh page.',
        };
      }
      if (attempt.picked) {
        return { error: `A shelf is already chosen for this one: ${shelf.shelfInWords(attempt.picked)}.` };
      }
      const shelves = shelf.openLeaves();
      const query = q.slice(0, 80);
      const general = shelf.generalShelf(attempt.as_posted);
      return {
        asPosted: attempt.as_posted,
        kind: attempt.kind,
        view: {
          token,
          kind: attempt.kind,
          q: query,
          wordCount: shelf.searchWords(query).length,
          shelves,
          shown: new Set(shelf.searchShelves(query, shelves).map((x) => x.category)),
          general: { category: general, words: shelf.shelfInWords(general) },
        },
      };
    };

    // ------------------------------------------------------------------
    // The photo page. Same link machinery, its own page, because a person
    // picks a file before they press — and the link is bound to ONE
    // conversation, so there is nothing on the page to choose.
    // ------------------------------------------------------------------
    const photoView = async (
      accountId: string,
      row: ApprovalLinkRow,
      token: string,
      typed?: { caption?: string; photoId?: string },
    ): Promise<pages.PhotoView | { error: string }> => {
      const m = await getMatch(row.ref_id);
      if (!m || m.state !== 'open') return { error: 'This introduction is no longer open.' };
      try {
        sideOf(m, accountId);
      } catch {
        return { error: 'This introduction is not yours.' };
      }
      if (m.stage < 4 || !m.channel_id) {
        return { error: 'There is no open conversation on this one yet.' };
      }
      const other = m.account_want === accountId ? m.account_have : m.account_want;
      const name = await ops.disclosedFirstName(
        accountId,
        other,
        { match_id: row.ref_id },
        'photo-page',
      );
      return {
        token,
        who: name ?? 'the other side',
        thing: await readersOwnPhrase(m, accountId),
        maxMb: Math.round(MAX_PHOTO_BYTES / (1024 * 1024)),
        ttlDays: PHOTO_TTL_DAYS,
        captionMax: MAX_CAPTION_CHARS,
        ...(typed?.caption ? { caption: typed.caption } : {}),
        ...(typed?.photoId ? { photoId: typed.photoId } : {}),
      };
    };

    /** The presign, from the photo page's own script. The link is the
     *  authority for WHICH conversation; the session is the authority for who
     *  is asking. Neither the bytes nor the image ever reach this process. */
    counter.post('/a/:token/photo', async (req, reply) => {
      const token = String((req.params as any).token ?? '');
      const check = await verifyLinkToken(token);
      if (!check.ok || check.row?.action !== 'conversation-photo') {
        return reply.code(404).send({ error: 'that page is no longer live' });
      }
      const row = check.row as ApprovalLinkRow;
      const s = await sess.loadSession(req);
      if (!s?.accountId || s.accountId !== row.account_id) {
        return reply.code(401).send({ error: 'sign in and open the link again' });
      }
      const b: any = req.body ?? {};
      try {
        const presigned = await presignPhotoUpload(cfg, s.accountId, row.ref_id, {
          filename: String(b.filename ?? ''),
          content_type: String(b.content_type ?? ''),
          size: Number(b.size),
          sha256_b64: String(b.sha256_b64 ?? ''),
          // The page states that it stripped the file on the device. Anything
          // that cannot state it gets no URL (domain/channelPhoto.ts).
          metadata_removed: b.metadata_removed,
        });
        return reply.send({ url: presigned.url, photo_id: presigned.photo_id });
      } catch (e: any) {
        if (e instanceof OsbError) {
          return reply.code(400).send({ error: String(e.payload?.human_action ?? 'refused') });
        }
        if (e?.validation || e?.notFound) return reply.code(400).send({ error: String(e.message) });
        throw e;
      }
    });

    /**
     * A collected photo's short link (domain/channelPhoto.ts, openPhotoLink).
     * It signs a fresh S3 GET for what is left of the fifteen minutes since
     * collection and redirects there, so the bytes never pass through here
     * and no bucket address ever reaches an assistant.
     *
     * A BEARER LINK, like the presigned URL it replaces: the recipient's
     * assistant may open it itself to show the picture, and an assistant has
     * no session. It needs no sign-in for the same reason.
     */
    counter.get('/p/:token', async (req, reply) => {
      const token = String((req.params as any).token ?? '');
      const opened = await openPhotoLink(cfg, token);
      if (!opened) {
        return reply
          .code(404)
          .header('cache-control', 'no-store')
          .type('text/html')
          .send(pages.photoLinkDeadPage());
      }
      return reply.header('cache-control', 'no-store').redirect(opened.url, 302);
    });

    /**
     * An open request, opened from the main page through the signed-in
     * session rather than through the link in the chat. The row has to be this
     * account's own, unpressed and unexpired, and it is sent on to the page its
     * link opens, so the question is the same question on either road. The
     * token only ever travels in the redirect, never in the page's HTML.
     */
    counter.get('/open/:id', async (req, reply) => {
      const signedIn = await sess.loadSession(req);
      if (!signedIn?.accountId) {
        // Signed out: sign in, then come straight back to this request.
        sess.rememberReturnPath(reply, `/open/${String((req.params as any).id)}`);
        return reply.redirect('/login', 303);
      }
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await links.openLinkFor(s.accountId!, String((req.params as any).id));
      if (found === 'expired') return html(reply, pages.linkDeadPage('expired'));
      if (found === 'used') return html(reply, pages.linkDeadPage('used'));
      if (!found) {
        return html(reply, pages.messagePage('Not found', '<p>There is nothing here.</p>'), 404);
      }
      return reply.header('cache-control', 'no-store').redirect(`/a/${encodeURIComponent(found)}`, 303);
    });

    counter.get('/a/:token', async (req, reply) => {
      const token = String((req.params as any).token ?? '');
      const check = await verifyLinkToken(token);
      if (!check.ok) {
        if (check.reason === 'used') return html(reply, pages.linkDeadPage('used'));
        if (check.reason === 'expired') return html(reply, pages.linkDeadPage('expired'));
        return html(reply, pages.linkDeadPage('invalid'), 404);
      }
      const row = check.row as ApprovalLinkRow;
      const s = await sess.loadSession(req);
      if (s?.accountId && s.accountId !== row.account_id) {
        // Signed in as somebody else. The link is NOT consumed. The old page
        // said "sign in", and the sign-in page then saw a live session and
        // bounced the person home, so they could go round that loop for ever
        // without a word about why (first seen when one person ran both sides
        // of a rehearsal in one browser). Say what is wrong and offer the
        // one move that fixes it.
        return html(reply, pages.wrongAccountPage(), 401);
      }
      if (!s?.accountId) {
        // Not signed in: the link is NOT consumed. The path is kept, and
        // signing in comes straight back to it (session.ts, takeReturnPath).
        sess.rememberReturnPath(reply, `/a/${token}`);
        return html(reply, pages.signInToSeePage(), 401);
      }
      if (await stopped(s.accountId, reply)) return;
      if (row.action === 'report' && !(await holdsCredential(s.accountId))) {
        // Nothing to press with. Rather than show a question this account
        // cannot answer, send it where every other page sends an account that
        // holds neither credential, and let them come back: a one-question link
        // burns on the press and never on the view, so it is still good.
        return reply.redirect(await nextStep(s.accountId, s as Session), 303);
      }
      if (row.action === 'shelf-pick') {
        const v = await shelfView(s.accountId, row, token, String((req.query as any)?.q ?? ''));
        if ('error' in v) {
          return html(reply, pages.donePage('Nothing to choose', `<p>${pages.esc(v.error)}</p>`));
        }
        return html(reply, pages.shelfPickPage(v.view));
      }
      if (row.action === 'conversation-photo') {
        // NOT consumed on the view: the link has to survive the person going
        // to their camera roll and back.
        const v = await photoView(s.accountId, row, token);
        if ('error' in v) {
          return html(reply, pages.donePage('Nothing to send', `<p>${pages.esc(v.error)}</p>`));
        }
        return html(reply, pages.photoPage(v));
      }
      if (links.isOneQuestionAction(row.action)) {
        const q = await oneQuestionView(s.accountId, row, { token });
        if ('error' in q) {
          return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(q.error)}</p>`));
        }
        q.elevated = creds.elevationFor(row.action, sess.isElevated(s));
        return html(reply, pages.oneQuestionPage(q));
      }
      // The one left is a payment approval. It burns on the PRESS, the way the
      // one-question pages do: this page is about money, and somebody who
      // opens the link, looks at the figures and comes back to it in the
      // evening must not find their own link dead because they read it once.
      if (row.action !== 'settlement-approve') return html(reply, pages.linkDeadPage('invalid'), 404);
      const v = await settlementApprovalView(s.accountId, row.ref_id);
      if ('error' in v) return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
      v.linkToken = token;
      return html(reply, pages.settlementApprovalPage(v));
    });

    /** The press. Verify, check the PIN, burn the link, then act. */
    counter.post('/a/:token', async (req, reply) => {
      const token = String((req.params as any).token ?? '');
      const check = await verifyLinkToken(token);
      if (!check.ok) {
        if (check.reason === 'used') return html(reply, pages.linkDeadPage('used'));
        if (check.reason === 'expired') return html(reply, pages.linkDeadPage('expired'));
        return html(reply, pages.linkDeadPage('invalid'), 404);
      }
      const row = check.row as ApprovalLinkRow;
      if (
        !links.isOneQuestionAction(row.action) &&
        row.action !== 'conversation-photo' &&
        row.action !== 'shelf-pick'
      ) {
        return reply.code(400).send({ error: 'bad_request' });
      }
      const s = await sess.loadSession(req);
      if (s?.accountId && s.accountId !== row.account_id) {
        return html(reply, pages.wrongAccountPage(), 401);
      }
      if (!s?.accountId) {
        sess.rememberReturnPath(reply, `/a/${token}`);
        return html(reply, pages.signInToSeePage(), 401);
      }
      if (await stopped(s.accountId, reply)) return;
      // The shelf press. No ceremony, and the shelf is checked BEFORE the link
      // is burnt, so a tampered or stale value costs a fresh look at the list
      // rather than the link. Burnt first after that, so of two presses of one
      // link exactly one records a shelf; the decision is written last, which
      // is what wait_for_press waits for, so the shelf is there when it looks.
      if (row.action === 'shelf-pick') {
        const pb: any = req.body ?? {};
        const v = await shelfView(s.accountId, row, token, '');
        if ('error' in v) {
          await consumeLink(row.id);
          return html(reply, pages.donePage('Nothing to choose', `<p>${pages.esc(v.error)}</p>`));
        }
        if (String(pb.decision ?? '') === 'no') {
          if (!(await consumeLink(row.id))) return html(reply, pages.linkDeadPage('used'));
          await links.recordLinkDecision(row.id, 'declined');
          return html(
            reply,
            pages.donePage('Left unposted', '<p>Nothing went up. Tell your assistant whenever you want to try again.</p>'),
          );
        }
        const shelf = await import('../domain/shelfPick.js');
        const category = String(pb.category ?? '');
        if (!shelf.pickable(category, v.asPosted)) {
          return html(reply, pages.shelfPickPage(v.view, 'Pick one of the shelves on this page.'), 400);
        }
        if (!(await consumeLink(row.id))) return html(reply, pages.linkDeadPage('used'));
        const gaps = await import('../domain/shelfGaps.js');
        await gaps.recordShelfPick(s.accountId, row.ref_id, category);
        await gaps.recordShelfGap({
          attempt: row.ref_id,
          as_posted: v.asPosted,
          kind: v.kind,
          outcome: 'picked_from_list',
          picked: category,
        });
        await links.recordLinkDecision(row.id, 'approved');
        return html(
          reply,
          pages.donePage(
            'Shelf chosen',
            `<p>It goes under ${pages.esc(shelf.shelfInWords(category))}. Your assistant puts it up there now.</p>`,
          ),
        );
      }
      // The photo press. Ordered like every other press on this page: the
      // caption is checked BEFORE the link is burnt, so a figure typed beside
      // the picture costs a rewrite rather than the link their assistant gave
      // them, and the photo they already uploaded is still there to send.
      if (row.action === 'conversation-photo') {
        const pb: any = req.body ?? {};
        const said = String(pb.decision ?? '');
        if (said === 'no') {
          await consumeLink(row.id);
          await links.recordLinkDecision(row.id, 'declined');
          return html(
            reply,
            pages.donePage('Not now', '<p>Nothing was sent, and the other side hears nothing about it.</p>'),
          );
        }
        if (said !== 'yes') return reply.code(400).send({ error: 'bad_request' });
        const v = await photoView(s.accountId, row, token, {
          caption: String(pb.caption ?? ''),
          photoId: String(pb.photo_id ?? ''),
        });
        if ('error' in v) {
          await consumeLink(row.id);
          return html(reply, pages.donePage('Nothing to send', `<p>${pages.esc(v.error)}</p>`));
        }
        let caption: string | undefined;
        try {
          caption = checkCaption(pb.caption);
        } catch (e: any) {
          const why =
            e instanceof OsbError
              ? String(e.payload?.human_action ?? '')
              : String(e?.message ?? 'that line will not go');
          return html(
            reply,
            pages.photoPage(
              v,
              e instanceof OsbError
                ? 'Take the price out of the description. Prices go through your assistant.'
                : why,
            ),
            400,
          );
        }
        const photoId = String(pb.photo_id ?? '');
        if (!photoId) {
          return html(reply, pages.photoPage(v, 'Pick a photo first.'), 400);
        }
        if (String(pb.confirm ?? '') !== 'yes') {
          return html(reply, pages.photoPage(v, 'Tick the box to say what the photo does not show.'), 400);
        }
        if (!(await consumeLink(row.id))) return html(reply, pages.linkDeadPage('used'));
        try {
          await markPhotoSent(cfg, s.accountId, row.ref_id, photoId, caption);
        } catch (e: any) {
          return html(
            reply,
            pages.donePage(
              'It did not go',
              `<p>${pages.esc(String(e?.message ?? 'that photo did not go'))} Ask your assistant for a fresh page.</p>`,
            ),
            400,
          );
        }
        await links.recordLinkDecision(row.id, 'approved');
        return html(
          reply,
          pages.donePage('Photo sent', '<p>It is only held here until it is passed on.</p>'),
        );
      }
      const b: any = req.body ?? {};
      const decision = String(b.decision ?? '');
      const q = await oneQuestionView(s.accountId, row, { token });
      if ('error' in q) {
        await consumeLink(row.id);
        return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(q.error)}</p>`));
      }
      if (decision === 'no') {
        await consumeLink(row.id);
        await links.recordLinkDecision(row.id, 'declined');
        return html(
          reply,
          pages.donePage('Not now', '<p>Nothing changed, and no reason was sent.</p>'),
        );
      }
      if (decision !== 'yes') return reply.code(400).send({ error: 'bad_request' });
      // Saying yes to the names question with nothing on file means saying,
      // right here, what gets shared. The boxes are checked BEFORE the PIN
      // ceremony and before the link is burnt, so a typo in a suburb costs
      // neither a PIN attempt nor the link their assistant gave them.
      let profileToSave: { firstName: string; locality: string } | undefined;
      if (q.collectProfile) {
        const checked = validateSharedProfile({
          firstName: b.first_name,
          locality: b.locality,
        });
        if (!checked.ok) {
          q.elevated = sess.isElevated(s);
          q.collectProfile = {
            firstName: String(b.first_name ?? ''),
            locality: String(b.locality ?? ''),
          };
          return html(reply, pages.oneQuestionPage(q, checked.error), 400);
        }
        profileToSave = checked.value;
      }
      // The words on a report, checked BEFORE the link is burnt, the same way
      // the caption and the profile boxes are: a line that ran long costs a
      // trim rather than the link their assistant gave them.
      if (q.collectReason && String(b.reason ?? '').trim().length > REASON_MAX_CHARS) {
        q.elevated = sess.isElevated(s);
        q.collectReason = { ...q.collectReason, value: String(b.reason ?? '') };
        return html(
          reply,
          pages.oneQuestionPage(
            q,
            `Keep it to ${REASON_MAX_CHARS} characters. A line is plenty, and somebody will read it.`,
          ),
          400,
        );
      }
      // Nothing to press with. The same door as the view, held shut here too:
      // no credential, no report, and the link is left unburnt behind them.
      if (row.action === 'report' && !(await holdsCredential(s.accountId!))) {
        return reply.redirect(await nextStep(s.accountId!, s as Session), 303);
      }
      // The PIN comes before the link is burnt: a mistyped PIN must not cost
      // someone the link their assistant gave them.
      if (q.needsPin) {
        const okNow = await pressCeremony(s as Session, reply, b, row.action);
        if (!okNow) return;
      }
      // Single-use, enforced here: whoever wins the UPDATE acts, and a second
      // press of the same link finds nothing left to burn.
      if (!(await consumeLink(row.id))) return html(reply, pages.linkDeadPage('used'));
      const figures = links.readPayload(row) ?? {};
      try {
        if (row.action === 'report') {
          const r = await fileReport(
            cfg,
            { reporterAccount: s.accountId!, matchId: row.ref_id, reason: b.reason },
            { warn: (line) => req.log.warn(line) },
          );
          await links.recordLinkDecision(row.id, 'approved');
          return html(
            reply,
            pages.donePage(
              'Reported',
              `<p>Thank you for telling us. That one is closed: nothing more goes either way, and the two of you will not be put together again.</p>
<p>Somebody here will look at what you wrote. The other person has been told the switchboard closed the conversation, and nothing else at all.</p>${
                r.words_kept
                  ? ''
                  : '<p>What you typed is held for a person to read rather than filed with the report, which changes nothing about the report itself.</p>'
              }`,
            ),
          );
        }
        if (row.action === 'offer-accept') {
          await acceptOfferByHuman(row.ref_id, s.accountId!, 'counter', cfg);
          await links.recordLinkDecision(row.id, 'approved');
          return html(reply, doneFor('link', ...ACCEPTED_DONE));
        }
        if (row.action === 'offer-send') {
          const placed = await proposeOffer(
            cfg,
            s.accountId!,
            {
              match_id: row.ref_id,
              amount: Number(figures.amount),
              ccy: String(figures.ccy),
              expiry: new Date(
                Date.now() + Number(figures.good_for_days ?? 7) * 86_400_000,
              ).toISOString(),
              ...(figures.note ? { message: String(figures.note) } : {}),
            },
            // The figure came off a link this person's own press authorised,
            // so it is theirs the same way one typed into their own box is.
            { author: 'human' },
          );
          await links.recordLinkDecision(row.id, 'approved');
          if ('already_on_table' in placed) {
            return html(
              reply,
              pages.donePage('Already on the table', `<p>${pages.esc(placed.say)}</p>`),
            );
          }
          return html(
            reply,
            pages.donePage('Sent', '<p>Your number is on the table for the other side.</p>'),
          );
        }
        if (row.action === 'stage3-disclosure') {
          // The press itself, and the only thing that records the go-ahead.
          if (profileToSave) await saveSharedProfile(s.accountId!, profileToSave, 'counter', cfg);
          const r = await recordStage3OptIn(cfg, row.ref_id, s.accountId!, 'counter');
          await links.recordLinkDecision(row.id, 'approved');
          return html(reply, doneFor('link', ...sharedDone(r.both)));
        }
        if (row.action === 'conversation-renew') {
          // The press that starts a fresh window for this side, and the whole
          // of what it does. It writes a consent event the way every other
          // press here does, because that is what it is: one human saying, on
          // the record, that this conversation still matters to them.
          const { startFreshWindow } = await import('../domain/conversationWindow.js');
          const { writeConsentEvent } = await import('../crypto.js');
          await writeConsentEvent({
            event: 'conversation-renew',
            match_id: row.ref_id,
            account_id: s.accountId!,
            recorded_via: 'counter',
          });
          await startFreshWindow(row.ref_id, s.accountId!, 'renewal-press');
          await links.recordLinkDecision(row.id, 'approved');
          return html(
            reply,
            pages.donePage(
              'Carry on',
              '<p>Your assistant can keep talking on this one. It will ask you again after a while, and nothing goes out from your side in the meantime that you have not asked for.</p>',
            ),
          );
        }
        if (row.action === 'collection-close') {
          // Retired with migration 030; an old link is answered and retired
          // rather than left to fall through to something it never meant.
          await links.recordLinkDecision(row.id, 'approved');
          return html(
            reply,
            pages.donePage(
              'Nothing to close',
              '<p>Nothing is being held up on that one any more. You can go ahead whenever you like.</p>',
            ),
          );
        }
        const cardRow = await getPool().query(
          'SELECT type FROM cards WHERE id = $1 AND account_id = $2',
          [row.ref_id, s.accountId!],
        );
        if (!cardRow.rowCount) {
          return html(reply, pages.donePage('Nothing to decide', '<p>Nothing like that on your ledger.</p>'));
        }
        const checked = validateMandate(figures, cardRow.rows[0].type);
        if (!checked.ok) {
          return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(checked.error)}</p>`));
        }
        await saveNegotiation(
          s.accountId!,
          row.ref_id,
          { mode: 'mandate', mandate: checked.value },
          'counter',
        );
        await links.recordLinkDecision(row.id, 'approved');
        return html(
          reply,
          pages.donePage(
            'Done',
            `<p>Your assistant can negotiate this one between your numbers. It is on ${pages.esc(MODE_NAMES.mandate)} until you change it.</p>`,
          ),
        );
      } catch (e: any) {
        if (e instanceof OsbError) {
          return html(
            reply,
            pages.donePage(
              'Not yet',
              `<p>${pages.esc(e.payload.human_action ?? 'This step is locked right now.')}</p>`,
            ),
            409,
          );
        }
        if (e?.notFound) {
          return html(reply, pages.donePage('Nothing to decide', '<p>This is no longer yours to decide.</p>'));
        }
        throw e;
      }
    });

    // ------------------------------------------------------------------
    // The main page's road to the same questions. Accepting a figure and
    // sharing names open the SAME one-question page the assistant's link does
    // (oneQuestionView, road 'session'), and the press lands on the same done
    // page with a way back to the main page instead of back to the assistant.
    // ------------------------------------------------------------------
    const sessionQuestion = async (
      reply: FastifyReply,
      s: Session,
      action: 'offer-accept' | 'stage3-disclosure',
      refId: string,
    ) => {
      const q = await oneQuestionView(
        s.accountId!,
        { action, ref_id: refId, amount: null, ccy: null, payload: null },
        'session',
      );
      if ('error' in q) return html(reply, doneFor('session', 'Nothing to decide', `<p>${pages.esc(q.error)}</p>`));
      q.elevated = creds.elevationFor(action, sess.isElevated(s));
      return html(reply, pages.oneQuestionPage(q));
    };

    counter.get('/approvals/offer/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      return sessionQuestion(reply, s, 'offer-accept', String((req.params as any).id));
    });

    counter.get('/approvals/match/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      return sessionQuestion(reply, s, 'stage3-disclosure', String((req.params as any).id));
    });

    counter.get('/approvals/settlement/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await settlementApprovalView(s.accountId!, String((req.params as any).id));
      if ('error' in v) return html(reply, doneFor('session', 'Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
      return html(reply, pages.settlementApprovalPage(v));
    });

    counter.post('/approve', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const action = String(b.action ?? '');
      const refId = String(b.ref_id ?? '');
      // 'yes' is what the one-question page sends; 'approve' what the payment
      // page sends. They mean the same press.
      const decision = String(b.decision ?? '') === 'yes' ? 'approve' : String(b.decision ?? '');
      if (!['offer-accept', 'stage3-disclosure', 'settlement-approve'].includes(action) || !UUID_RE.test(refId)) {
        return reply.code(400).send({ error: 'bad_request' });
      }
      if (decision === 'decline') {
        // Declining shares nothing and needs no ceremony. No reason is carried.
        if (action === 'offer-accept') await ops.declineOfferByHuman(refId, s.accountId!);
        else if (action === 'settlement-approve') {
          try {
            await settlements.declineSettlement(settlements.counterAction(s.accountId!), refId);
          } catch (e: any) {
            if (!e?.notFound && !(e instanceof OsbError)) throw e;
            return html(reply, doneFor('session', 'Nothing to decide', '<p>This payment has moved on.</p>'));
          }
          return html(
            reply,
            doneFor('session', 'Declined', '<p>Nothing was paid or promised. No reason was sent.</p>'),
          );
        }
        else await declineMatch(refId, s.accountId!, cfg);
        return html(
          reply,
          doneFor('session', 'Declined', '<p>Nothing was shared or accepted. No reason was sent.</p>'),
        );
      }
      if (decision !== 'approve') return reply.code(400).send({ error: 'bad_request' });

      if (action === 'settlement-approve') {
        const view = await settlementApprovalView(s.accountId!, refId);
        if ('error' in view) {
          return html(reply, doneFor('session', 'Nothing to decide', `<p>${pages.esc(view.error)}</p>`));
        }
        // Money: the PIN or the passkey at this press, whatever the window.
        const okNow = await pressCeremony(s, reply, b, action);
        if (!okNow) return;
        // The link this page came from, spent here rather than when the page
        // was opened. After the ceremony, so a mistyped PIN costs a retype and
        // not the link. Absent when the person came from their own main page,
        // which is not a one-use road. Bound to the account, the payment AND
        // the action, so a link minted for anything else spends nothing here.
        const linkToken = String(b.link_token ?? '');
        if (linkToken) {
          const check = await verifyLinkToken(linkToken);
          if (!check.ok) {
            const why = check.reason === 'used' || check.reason === 'expired' ? check.reason : 'invalid';
            return html(reply, pages.linkDeadPage(why), why === 'invalid' ? 404 : 200);
          }
          const linkRow = check.row as ApprovalLinkRow;
          if (
            linkRow.account_id !== s.accountId ||
            linkRow.ref_id !== refId ||
            linkRow.action !== action
          ) {
            return reply.code(400).send({ error: 'bad_request' });
          }
          if (!(await consumeLink(linkRow.id))) return html(reply, pages.linkDeadPage('used'));
        }
        try {
          const r = await settlements.approveSettlement(settlements.counterAction(s.accountId!), refId);
          // Seller onboarding starts at first settlement approval: make sure
          // the connected account exists the moment the seller says yes.
          if (r.row.seller_account === s.accountId && settlementsConfigured(cfg)) {
            await ensureSellerStripeAccount(cfg, s.accountId!, r.row);
          }
        } catch (e: any) {
          if (e instanceof OsbError) {
            return html(
              reply,
              doneFor('session', 'Not yet', `<p>${pages.esc(e.payload.human_action ?? 'This step is locked right now.')}</p>`),
              409,
            );
          }
          if (e?.notFound) {
            return html(reply, doneFor('session', 'Nothing to decide', '<p>This payment has moved on.</p>'));
          }
          throw e;
        }
        return reply.redirect(`/settlements/${refId}`, 303);
      }

      // Accepting a figure or sharing names: the one-question page's own
      // checks, boxes and done pages, reached through the session.
      const q = await oneQuestionView(
        s.accountId!,
        { action: action as 'offer-accept' | 'stage3-disclosure', ref_id: refId, amount: null, ccy: null, payload: null },
        'session',
      );
      if ('error' in q) {
        return html(reply, doneFor('session', 'Nothing to decide', `<p>${pages.esc(q.error)}</p>`));
      }
      // Saying yes to the names question with nothing on file means saying,
      // right here, what gets shared. The boxes are checked BEFORE the PIN
      // ceremony, so a typo in a suburb never costs a PIN attempt.
      let profileToSave: { firstName: string; locality: string } | undefined;
      if (q.collectProfile) {
        const checked = validateSharedProfile({ firstName: b.first_name, locality: b.locality });
        if (!checked.ok) {
          q.elevated = creds.elevationFor(action, sess.isElevated(s));
          q.collectProfile = {
            firstName: String(b.first_name ?? ''),
            locality: String(b.locality ?? ''),
          };
          return html(reply, pages.oneQuestionPage(q, checked.error), 400);
        }
        profileToSave = checked.value;
      }
      // Money (a figure) takes the PIN or the passkey at this press; the names
      // step may lean on the window.
      const okNow = await pressCeremony(s, reply, b, action);
      if (!okNow) return;
      try {
        if (action === 'offer-accept') {
          await acceptOfferByHuman(refId, s.accountId!, 'counter', cfg);
          return html(reply, doneFor('session', ...ACCEPTED_DONE));
        }
        if (profileToSave) await saveSharedProfile(s.accountId!, profileToSave, 'counter', cfg);
        const r = await recordStage3OptIn(cfg, refId, s.accountId!, 'counter');
        return html(reply, doneFor('session', ...sharedDone(r.both)));
      } catch (e: any) {
        // An empty profile at this point means the collection boxes were
        // skipped: send the person back to the page that asks for them.
        if (e instanceof OsbError && e.payload.code === 'CONSENT_REQUIRED') {
          return reply.redirect(`/approvals/match/${encodeURIComponent(refId)}`, 303);
        }
        if (e instanceof OsbError) {
          return html(
            reply,
            doneFor('session', 'Not yet', `<p>${pages.esc(e.payload.human_action ?? 'This step is locked right now.')}</p>`),
            409,
          );
        }
        if (e?.notFound) {
          return html(reply, doneFor('session', 'Nothing to decide', '<p>This is no longer yours to decide.</p>'));
        }
        throw e;
      }
    });

    // ------------------------------------------------------------------
    // 1.A safe hands: the settlement page and its actions. Humans drive
    // every step here; money-state (funded/released/refunded) still lands
    // only via the verified Stripe webhook.
    // ------------------------------------------------------------------
    const loadSettlementFor = async (
      accountId: string,
      id: string,
    ): Promise<{ row: settlements.SettlementRow; role: 'buyer' | 'seller' } | undefined> => {
      const row = await settlements.getSettlement(id);
      if (!row) return undefined;
      try {
        return { row, role: settlements.partyOf(row, accountId) };
      } catch {
        return undefined;
      }
    };

    const settlementView = async (
      accountId: string,
      row: settlements.SettlementRow,
      role: 'buyer' | 'seller',
      elevated: boolean,
    ): Promise<pages.SettlementView> => {
      const m = await getMatch(row.match_id);
      let canPay = false;
      let needsPaymentSetup = false;
      if (row.state === 'approved' && settlementsConfigured(cfg)) {
        const acctId = await sellerStripeAccountId(row.seller_account, row.id);
        const ready = acctId ? await sellerAccountReady(acctId) : false;
        canPay = role === 'buyer' && ready;
        needsPaymentSetup = role === 'seller' && !ready;
      }
      const showEvidence = [
        'evidence-locked',
        'confirmed',
        'disputed',
        'resolution-proposed',
        'resolved',
        'released',
        'refunded',
        'settled-split',
      ].includes(row.state);
      const inDispute = settlements.IN_DISPUTE.includes(row.state);
      const myApproval = role === 'buyer' ? row.buyer_approved_at : row.seller_approved_at;
      // The handover notice, while the clock is running. The seller's first
      // name is decrypted only here, where it changes what the page says.
      let handover: pages.SettlementView['handover'];
      if (row.state === 'evidence-locked' && row.handed_over_at && row.auto_release_at) {
        const sellerName =
          role === 'buyer'
            ? await ops.disclosedFirstName(accountId, row.seller_account, { settlement_id: row.id })
            : undefined;
        handover = {
          sellerName: sellerName ?? 'The seller',
          onDay: pages.localTime(row.handed_over_at, 'day'),
          byDay: pages.localTime(row.auto_release_at, 'day'),
        };
      }
      return {
        id: row.id,
        role,
        state: row.state,
        ...settlementMoneyLines(row),
        category: m ? await readersOwnThingLabel(m, accountId) : 'your match',
        descriptionText: row.description?.text,
        myApprovalPending:
          !myApproval && ['proposed', 'approved-by-buyer', 'approved-by-seller'].includes(row.state),
        canPay,
        needsPaymentSetup,
        canLockEvidence: role === 'seller' && row.state === 'funded',
        canConfirm: role === 'buyer' && row.state === 'evidence-locked',
        // The release did not go through the first time (the transfer was
        // refused, so nothing moved): the buyer can send it again from here.
        canRetryRelease: role === 'buyer' && row.state === 'confirmed',
        canDispute: ['funded', 'evidence-locked'].includes(row.state),
        evidence: showEvidence ? await evidenceViewLinks(cfg, row.id) : [],
        ...(await ceremonyFor(accountId, elevated)),
        autoReleaseDays: cfg.settlementAutoReleaseDays,
        autoReleased: row.auto_released === true,
        handover,
        // --- the frozen half: what each of them can do while it is frozen ---
        inDispute,
        disputeGround: row.dispute_ground ?? undefined,
        // The seller adds tracking at the handover as readily as inside a
        // dispute; it is the same record either way.
        canAddTracking:
          role === 'seller' &&
          ['funded', 'evidence-locked', 'disputed', 'resolution-proposed'].includes(row.state),
        deliveryTracking: row.delivery_tracking ?? undefined,
        canMarkReturned: role === 'buyer' && inDispute && !row.returned_at,
        returnTracking: row.return_tracking ?? undefined,
        returnedOnDay: row.returned_at ? pages.localTime(row.returned_at, 'day') : undefined,
        returnSilenceByDay: row.returned_at
          ? pages.localTime(
              new Date(
                new Date(row.returned_at).getTime() +
                  cfg.settlementReturnSilenceDays * 86_400_000,
              ),
              'day',
            )
          : undefined,
        canConfirmReturn: role === 'seller' && inDispute && !!row.returned_at && !row.return_received_at,
        // The seller's answer to a return, on the same terms as confirming
        // one: only while there is a return open to answer.
        canDisputeReturn:
          role === 'seller' &&
          inDispute &&
          !!row.returned_at &&
          !row.return_received_at &&
          !row.return_disputed_at,
        returnDisputed: !!row.return_disputed_at,
        trackingGraceByDay:
          row.disputed_at && row.dispute_ground === 'not_arrived' && !row.delivery_tracking
            ? pages.localTime(
                new Date(
                  new Date(row.disputed_at).getTime() +
                    cfg.settlementTrackingGraceDays * 86_400_000,
                ),
                'day',
              )
            : undefined,
        deadlockByDay: row.deadlock_at ? pages.localTime(row.deadlock_at, 'day') : undefined,
        // The split on the table, if there is one, in the same money words as
        // every other figure on this page.
        split:
          row.refund_minor !== null && row.release_minor !== null
            ? {
                refundMinor: row.refund_minor,
                releaseMinor: row.release_minor,
                refund: formatMinor(row.refund_minor, row.ccy),
                release: formatMinor(row.release_minor, row.ccy),
                mine: role === 'buyer' ? !!row.split_buyer_approved_at : !!row.split_seller_approved_at,
                theirs: role === 'buyer' ? !!row.split_seller_approved_at : !!row.split_buyer_approved_at,
              }
            : undefined,
        canProposeSplit: inDispute,
        // Only a split the OTHER side put up is this human's to accept.
        canApproveSplit:
          row.state === 'resolution-proposed' &&
          row.split_proposed_by !== accountId &&
          !(role === 'buyer' ? row.split_buyer_approved_at : row.split_seller_approved_at),
        agreedMinor: toMinorUnits(Number(row.amount), row.ccy),
        ccy: row.ccy,
      };
    };

    const settlementNotFound = (reply: FastifyReply) =>
      html(reply, pages.messagePage('Not found', '<p>No such settlement on your ledger.</p>'), 404);

    counter.get('/settlements/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      return html(
        reply,
        pages.settlementPage(await settlementView(s.accountId!, found.row, found.role, sess.isElevated(s))),
      );
    });

    // Buyer starts the hosted payment. The payment page is Stripe's; the
    // money is taken and HELD by the switchboard until the buyer confirms
    // receipt, and only then transferred on to the seller.
    counter.post('/settlements/:id/pay', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      if (found.role !== 'buyer' || found.row.state !== 'approved' || !settlementsConfigured(cfg)) {
        return html(reply, pages.messagePage('Not yet', '<p>This settlement is not ready for payment.</p>'), 409);
      }
      const sellerId = await sellerStripeAccountId(found.row.seller_account, found.row.id);
      if (!sellerId || !(await sellerAccountReady(sellerId))) {
        return html(
          reply,
          pages.messagePage('Not yet', '<p>The seller has not finished payment setup. You will get an email when the payment can go ahead.</p>'),
          409,
        );
      }
      const url = await checkoutUrlForSettlement(cfg, found.row);
      return reply.redirect(url, 303);
    });

    // Seller finishes payment setup on Stripe's hosted onboarding.
    counter.post('/settlements/:id/payment-setup', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      if (found.role !== 'seller' || !settlementsConfigured(cfg)) {
        return html(reply, pages.messagePage('Not yet', '<p>Payment setup is the seller&#39;s step.</p>'), 409);
      }
      const acctId = await ensureSellerStripeAccount(cfg, s.accountId!, found.row);
      const url = await sellerOnboardingLink(cfg, acctId, found.row.id);
      return reply.redirect(url, 303);
    });

    // Seller's evidence uploads: presigned, straight into the WORM bucket.
    counter.post('/settlements/:id/evidence/presign', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return reply.code(404).send({ error: 'not_found' });
      if (found.role !== 'seller' || found.row.state !== 'funded') {
        return reply.code(409).send({ error: 'not_applicable' });
      }
      const b: any = req.body ?? {};
      try {
        const presigned = await presignEvidenceUpload(cfg, found.row, s.accountId!, {
          filename: String(b.filename ?? ''),
          content_type: String(b.content_type ?? ''),
          size: Number(b.size),
          sha256_b64: String(b.sha256_b64 ?? ''),
        });
        return reply.send(presigned);
      } catch (e: any) {
        if (e?.validation) return reply.code(400).send({ error: String(e.message) });
        throw e;
      }
    });

    // Seller locks the evidence: manifest snapshot into the WORM bucket,
    // then funded -> evidence-locked, then the buyer is asked to confirm.
    counter.post('/settlements/:id/evidence/lock', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      if (found.role !== 'seller' || found.row.state !== 'funded') {
        return html(reply, pages.messagePage('Not yet', '<p>Evidence locks while the payment is held.</p>'), 409);
      }
      let manifestKey: string;
      try {
        const r = await writeEvidenceManifest(cfg, found.row, s.accountId!);
        manifestKey = r.manifestKey;
      } catch (e: any) {
        if (e?.validation) {
          const v = await settlementView(s.accountId!, found.row, found.role, sess.isElevated(s));
          return html(reply, pages.settlementPage(v, String(e.message)), 400);
        }
        throw e;
      }
      const handedOver = await settlements.lockEvidence(
        settlements.counterAction(s.accountId!),
        found.row.id,
        manifestKey,
        cfg.settlementAutoReleaseDays,
      );
      // The handover starts the buyer's clock, so both mails carry the date it
      // runs out. The buyer's is the new one — it is their window and their
      // two ways to end it; the seller's is the existing confirm-request note,
      // which now names the same date.
      const deadline = handedOver.auto_release_at ?? undefined;
      for (const [accountId, role, template] of [
        [found.row.buyer_account, 'buyer', 'handover-window'],
        [found.row.seller_account, 'seller', 'confirm-receipt-request'],
      ] as const) {
        const email = await ops.accountEmail(accountId, 'settlement-confirm-request-notification');
        if (email) {
          await notifyBestEffort(req, template, () =>
            sendSettlementEmail(cfg, {
              to: email,
              accountId,
              template,
              settlementId: found.row.id,
              role,
              deadline,
            }),
          );
        }
      }
      return reply.redirect(`/settlements/${found.row.id}`, 303);
    });

    // Buyer confirms receipt (PIN/passkey ceremony) — this is what releases
    // the held payment: the same signed request starts the transfer to the
    // seller, and the 'released' state lands when Stripe's webhook reports
    // the transfer. Confirming is idempotent, so this route doubles as the
    // retry when a transfer was refused (an unfunded platform balance, a
    // seller account whose capability lapsed) and nothing moved.
    counter.post('/settlements/:id/confirm', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      const okNow = await pressCeremony(s, reply, req.body, 'settlement-confirm');
      if (!okNow) return;
      let row: settlements.SettlementRow;
      try {
        row = await settlements.confirmReceipt(settlements.counterAction(s.accountId!), found.row.id);
      } catch (e) {
        if (e instanceof OsbError && e.payload.code === 'NOT_UNLOCKED_YET') {
          return html(
            reply,
            pages.messagePage('Not yet', `<p>${pages.esc(e.payload.human_action ?? 'This step is locked right now.')}</p>`),
            409,
          );
        }
        throw e;
      }
      try {
        await transferToSellerForSettlement(cfg, row);
      } catch (e: any) {
        // The receipt is confirmed and stays confirmed; the money simply did
        // not move. Say so plainly rather than pretending it is on its way.
        req.log.error(
          { err: e?.message, settlement_id: row.id },
          'settlement release transfer failed',
        );
        return html(
          reply,
          pages.messagePage(
            'Receipt confirmed',
            `<p>Your confirmation is recorded. The payment to the seller did not go through
this time, and nothing has moved. Try sending it again from the settlement page.</p>`,
            `/settlements/${row.id}`,
            'Back to this settlement',
          ),
          502,
        );
      }
      return html(
        reply,
        pages.messagePage(
          'Receipt confirmed',
          '<p>The held payment is on its way to the seller. Both of you get an email when it lands.</p>',
        ),
      );
    });

    // Every step below is a human's, on their own page, and every one of them
    // reports the same way when the settlement has moved on underneath them.
    const settlementStep = async (
      reply: FastifyReply,
      run: () => Promise<{ title: string; body: string }>,
    ) => {
      try {
        const r = await run();
        return html(reply, pages.messagePage(r.title, r.body));
      } catch (e: any) {
        if (e instanceof OsbError && e.payload.code === 'NOT_UNLOCKED_YET') {
          return html(
            reply,
            pages.messagePage('Not yet', `<p>${pages.esc(e.payload.human_action ?? 'This step is locked right now.')}</p>`),
            409,
          );
        }
        if (e?.validation) {
          return html(reply, pages.messagePage('Not quite', `<p>${pages.esc(String(e.message))}</p>`), 400);
        }
        throw e;
      }
    };

    // Either human says something is wrong: the held payment FREEZES. Nothing
    // moves. They pick which of the two things went wrong, and from there the
    // two of them have the settlement page to sort it out on.
    counter.post('/settlements/:id/dispute', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      const ground = String((req.body as any)?.ground ?? 'not_as_described');
      if (ground !== 'not_arrived' && ground !== 'not_as_described') {
        return html(reply, pages.messagePage('Not quite', '<p>Say which of the two things went wrong.</p>'), 400);
      }
      // Freezing a payment is a sensitive action: it stops a release that was
      // otherwise going to happen.
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (!okNow) return;
      return settlementStep(reply, async () => {
        const row = await settlements.openDispute(
          settlements.counterAction(s.accountId!),
          found.row.id,
          ground,
          cfg.settlementDisputeDeadlockDays,
        );
        for (const [accountId, role] of [
          [row.buyer_account, 'buyer'],
          [row.seller_account, 'seller'],
        ] as const) {
          const email = await ops.accountEmail(accountId, 'settlement-disputed-notification');
          if (email) {
            await notifyBestEffort(req, 'settlement-disputed', () =>
              sendSettlementEmail(cfg, {
                to: email,
                accountId,
                template: 'disputed',
                settlementId: row.id,
                role,
              }),
            );
          }
        }
        return {
          title: 'On hold',
          body:
            '<p>The payment is frozen where it is. Nothing has moved and nothing will move until the two of you ' +
            'agree how to settle it, the item goes back, or fourteen days pass and the rule on the settlement page decides.</p>',
        };
      });
    });

    // The seller's tracking reference. It can go on at the handover or inside
    // a dispute; either way it is the record of where the parcel went.
    counter.post('/settlements/:id/tracking', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      // The deadlock rule decides on this line, so writing it is sensitive.
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (!okNow) return;
      return settlementStep(reply, async () => {
        await settlements.addDeliveryTracking(
          settlements.counterAction(s.accountId!),
          cfg,
          found.row.id,
          String((req.body as any)?.tracking ?? ''),
        );
        return {
          title: 'Tracking added',
          body: '<p>Both of you can see it on the settlement page now.</p>',
        };
      });
    });

    // The buyer says it is on its way back.
    counter.post('/settlements/:id/returned', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      // Starting the return clock is what puts the agreed amount on its way
      // back, so it takes the same ceremony the release does.
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (!okNow) return;
      return settlementStep(reply, async () => {
        await settlements.markReturned(
          settlements.counterAction(s.accountId!),
          cfg,
          found.row.id,
          String((req.body as any)?.tracking ?? ''),
        );
        return {
          title: 'Marked as sent back',
          body:
            `<p>The seller has been asked to say when they have it. Once they do, the agreed amount comes back to you; ` +
            `if they say nothing for ${pages.esc(String(cfg.settlementReturnSilenceDays))} days, it comes back anyway.</p>`,
        };
      });
    });

    // The seller says the returned item is back with them: the agreed amount
    // goes to the buyer. This one moves money, so it takes the PIN ceremony.
    counter.post('/settlements/:id/return-received', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      const okNow = await pressCeremony(s, reply, req.body, 'settlement-return-received');
      if (!okNow) return;
      return settlementStep(reply, async () => {
        const row = await settlements.confirmReturnReceived(
          settlements.counterAction(s.accountId!),
          found.row.id,
        );
        await refundAgreedAmountForSettlement(row, row.refund_minor!);
        return {
          title: 'Sent back to the buyer',
          body:
            '<p>The agreed amount is on its way to the buyer. The introductory fee and the card processing stay ' +
            'paid, because the card processor keeps its own fee on a refund.</p>',
        };
      });
    });

    // The seller's answer to a return: what came back is not what went out.
    // It moves no money — it stops money moving on its own — but it decides
    // which way two clocks fall, so it takes the same ceremony as the rest.
    counter.post('/settlements/:id/return-disputed', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (!okNow) return;
      return settlementStep(reply, async () => {
        await settlements.disputeReturn(settlements.counterAction(s.accountId!), found.row.id);
        return {
          title: 'You have said the return is not what it claims to be',
          body:
            '<p>Nothing goes back on its own now. The buyer can see what you said, and the two of you have this ' +
            'page to agree a split on; with nothing agreed, the rule decides on the deadlock day.</p>',
        };
      });
    });

    // Either human proposes how to divide the held amount. Proposing is
    // agreeing, so this stamps the proposer's own approval; nothing moves
    // until the other side approves the same two figures.
    counter.post('/settlements/:id/resolution', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      // Proposing IS agreeing — this stamps the proposer's own approval on two
      // figures — so it takes what approving the other side's figures takes.
      const okNow = await pressCeremony(s, reply, req.body, 'settlement-resolution');
      if (!okNow) return;
      const b: any = req.body ?? {};
      const money = (raw: unknown) => {
        const n = Number(String(raw ?? '').trim());
        if (!Number.isFinite(n) || n < 0) {
          throw Object.assign(new Error('Both figures have to be amounts of money, and neither can be less than nothing.'), { validation: true });
        }
        // A zero side is a perfectly good proposal, so this cannot go through
        // toMinorUnits, which refuses one. The list of currencies with no minor
        // unit is Stripe's and lives in one place; JPY was only ever the one we
        // had thought of.
        return Math.round(n * (isZeroDecimal(found.row.ccy) ? 1 : 100));
      };
      return settlementStep(reply, async () => {
        const row = await settlements.proposeResolution(
          settlements.counterAction(s.accountId!),
          found.row.id,
          money(b.refund_to_buyer),
          money(b.release_to_seller),
        );
        const otherAccount = found.role === 'buyer' ? row.seller_account : row.buyer_account;
        const otherRole = found.role === 'buyer' ? 'seller' : 'buyer';
        const email = await ops.accountEmail(otherAccount, 'settlement-resolution-notification');
        if (email) {
          await notifyBestEffort(req, 'settlement-resolution-proposed', () =>
            sendSettlementEmail(cfg, {
              to: email,
              accountId: otherAccount,
              template: 'resolution-proposed',
              settlementId: row.id,
              role: otherRole,
            }),
          );
        }
        return {
          title: 'Put to the other side',
          body:
            `<p>${pages.esc(formatMinor(row.refund_minor ?? 0, row.ccy))} back to the buyer and ` +
            `${pages.esc(formatMinor(row.release_minor ?? 0, row.ccy))} to the seller. The money moves once they agree to the same two figures.</p>`,
        };
      });
    });

    // The other human agrees to the same two figures, and the money moves.
    // Both legs go out here; 'settled-split' lands from Stripe's own events.
    counter.post('/settlements/:id/resolution/approve', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      const okNow = await pressCeremony(s, reply, req.body, 'settlement-resolution-approve');
      if (!okNow) return;
      const b: any = req.body ?? {};
      return settlementStep(reply, async () => {
        const row = await settlements.approveResolution(
          settlements.counterAction(s.accountId!),
          found.row.id,
          Number(b.refund_minor),
          Number(b.release_minor),
        );
        try {
          await moveSplitForSettlement(cfg, row);
        } catch (e: any) {
          req.log.error({ err: e?.message, settlement_id: row.id }, 'settlement split payment failed');
          return {
            title: 'Agreed',
            body:
              '<p>Your agreement is recorded. The money did not go through this time and nothing has moved. ' +
              'The switchboard tries again by itself; open the settlement page if it is still waiting tomorrow.</p>',
          };
        }
        return {
          title: 'Agreed',
          body:
            `<p>${pages.esc(formatMinor(row.refund_minor ?? 0, row.ccy))} is on its way back to the buyer and ` +
            `${pages.esc(formatMinor(row.release_minor ?? 0, row.ccy))} to the seller. Both of you get an email when it lands.</p>`,
        };
      });
    });

    // ------------------------------------------------------------------
    // 0.F: one-tap match-quality verdicts.
    // ------------------------------------------------------------------
    counter.post('/verdict', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      // The page posts the plain words; the two older spellings are still read
      // so a form rendered before the rename still answers.
      const verdict = readVerdict(b.verdict);
      if (!verdict) {
        return reply.code(400).send({ error: 'bad_request' });
      }
      const matchId = String(b.match_id ?? '');
      try {
        await recordVerdict(matchId, s.accountId!, verdict, 'counter', cfg);
      } catch {
        return html(reply, pages.messagePage('Not found', '<p>No such match on your ledger.</p>'), 404);
      }
      // The ask lives at the foot of the introduction's own page now, so the
      // answer goes back to the page it was asked on.
      const back = String(b.return_to ?? '');
      return reply.redirect(back && back === matchId ? `/matches/${encodeURIComponent(matchId)}` : '/', 303);
    });

    // The holder's early-close button lived here. The collection window is
    // gone (migration 030): nothing blocks a holder now, so there is nothing
    // to close.

    // ------------------------------------------------------------------
    // Ledger.
    // ------------------------------------------------------------------
    // Screening's verdict for the card's OWN human, in plain words. Only a
    // card actually sitting in SCREENING_REJECTED says anything.
    const screeningRejectionView = (
      c: ops.LedgerCard,
    ): { plain: string; code?: string } | undefined => {
      if (c.lifecycle_state !== 'SCREENING_REJECTED') return undefined;
      const rej = rejectionInPlainWords(c.screening);
      return rej ? { plain: rej.plain, code: rej.reasonCode } : undefined;
    };

    const NOT_ON_LIST = 'That want or have is not on your list.';

    // Where a want or have stands, in the ledger's own words.
    const ledgerState = (c: ops.LedgerCard): home.LedgerState => {
      switch (c.lifecycle_state) {
        case 'PENDING_SCREENING':
          return 'being checked';
        case 'SCREENING_REJECTED':
          return 'needs a change';
        case 'WITHDRAWN':
          return 'taken down';
        case 'EXPIRED':
          return 'lapsed';
        default:
          if (new Date(c.expires_at).getTime() <= Date.now()) return 'lapsed';
          return c.protocol_status === 'latent' ? 'paused' : 'live';
      }
    };

    const cardToView = (c: ops.LedgerCard): home.LedgerCardView => {
      const state = ledgerState(c);
      const expires = new Date(c.expires_at);
      return {
        id: c.id,
        type: c.type,
        title: categoryLeafLabel(c.category, c.kind),
        sentence: home.attributesSentence(c.attributes),
        state,
        ...(state === 'needs a change' ? { reason: screeningRejectionView(c)?.plain } : {}),
        until: pages.localTime(expires, 'day'),
        reach: c.reach_words,
        hasLimit: !!c.price?.band,
        introduced: Number(c.matchCount ?? 0),
        mode: c.negotiation_mode,
        lapsingSoon:
          c.lifecycle_state === 'PUBLISHED' &&
          expires.getTime() > Date.now() &&
          expires.getTime() <= Date.now() + ops.LAPSING_DAYS * 86_400_000,
      };
    };

    // The ledger's few notices, chosen by a short code so nothing typed into
    // the address bar reaches the page.
    const LEDGER_NOTICES: Record<string, string> = {
      renewed: home.RENEWED_NOTICE,
      'taken-down': 'Taken down.',
    };

    counter.get('/ledger', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const cards = await ops.ledgerCards(cfg, s.accountId!);
      const archived = await ops.archivedConnections(s.accountId!);
      const past = archived.map((a) => ({
        category: categoryLeafLabel(a.category),
        who: a.counterparty
          ? `${a.counterparty.first_name}, ${a.counterparty.locality}`
          : undefined,
        archivedOn: a.archived_at
          ? new Date(a.archived_at).toISOString().slice(0, 10)
          : undefined,
      }));
      const notice = LEDGER_NOTICES[String((req.query as any)?.done ?? '')];
      return html(reply, home.ledgerPage(cards.map(cardToView), notice, past));
    });

    // There is no edit page any more (28 September 2026). What a want or have
    // says is the assistant's to change, through amend_intent, and it goes
    // back to be checked from there. An old link lands on the list.
    counter.get('/ledger/:id/edit', async (_req, reply) => reply.redirect('/ledger', 303));

    // "Keep it" on one lapsing row: restarts that one's clock, and nothing
    // else's. A signed-in session is enough: it is the person's own posting
    // and it asks nothing new of anybody.
    counter.post('/ledger/:id/renew', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const id = String((req.params as any).id);
      if (!UUID_RE.test(id)) return html(reply, pages.messagePage('Not found', `<p>${NOT_ON_LIST}</p>`), 404);
      const renewed = await ops.renewAllCards(s.accountId!, 'counter', { cardId: id });
      return reply.redirect(renewed.length ? '/ledger?done=renewed' : '/ledger', 303);
    });

    // ------------------------------------------------------------------
    // 1.E "Your numbers": who authors the figures this card negotiates with.
    //
    // These routes live in the human page class, which is the whole point of
    // them — the onRequest guard above 403s any agent bearer token before a
    // line of this code runs, so a mandate can only ever be written by the
    // person it belongs to. Nothing here re-screens the card: a negotiating
    // instruction is not card content and never goes near the network.
    // ------------------------------------------------------------------
    const numbersView = async (
      accountId: string,
      cardId: string,
      sess0: Session,
    ): Promise<home.CardNumbersView | undefined> => {
      const cards = await ops.ledgerCards(cfg, accountId);
      const c = cards.find((x) => x.id === cardId);
      if (!c) return undefined;
      const neg = await readNegotiation(accountId, cardId, { purpose: 'counter-numbers-view' });
      // A figure this card's agent was refused for on Pass on sits at the top
      // of the page the refusal points at.
      const draft = await newestOfferDraftForCard(accountId, cardId);
      return {
        id: c.id,
        type: c.type,
        category: categoryLeafLabel(c.category),
        mode: neg.mode,
        mandate: neg.mandate,
        ...(draft ? { draft: { ...draftToFields(draft), matchId: draft.matchId } } : {}),
        ceremony: await ceremonyFor(accountId, sess.isElevated(sess0)),
      };
    };

    counter.get('/ledger/:id/numbers', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await numbersView(s.accountId!, String((req.params as any).id), s);
      if (!v) return html(reply, pages.messagePage('Not found', `<p>${NOT_ON_LIST}</p>`), 404);
      return html(reply, home.cardNumbersPage(v));
    });

    counter.post('/ledger/:id/numbers', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const id = String((req.params as any).id);
      const v = await numbersView(s.accountId!, id, s);
      if (!v) return html(reply, pages.messagePage('Not found', `<p>${NOT_ON_LIST}</p>`), 404);
      const b: any = req.body ?? {};
      const mode: NegotiationMode = b.mode === 'mandate' ? 'mandate' : 'relay';
      const form = {
        open: String(b.open ?? ''),
        limit: String(b.limit ?? ''),
        step: String(b.step ?? ''),
        ccy: String(b.ccy ?? ''),
      };
      // The same control stands on the offers page, so a save from there comes
      // back to the match it was set on. Nothing is trusted about the value:
      // it names a match, and offersView only ever answers for this person's
      // own matches.
      const returnTo = String(b.return_to ?? '').trim();
      const backToMatch = async (error?: string, notice?: string, code = 200) => {
        const v2 = await offersView(s.accountId!, returnTo, s);
        if (!v2) return undefined;
        return html(reply, home.matchOffersPage({ ...v2, mode }, error, notice), code);
      };
      const wroteNumbers = [form.open, form.limit, form.step, form.ccy].some((x) => x.trim() !== '');

      // Switching to Auto-negotiate without numbers is the one combination
      // that cannot stand: it would leave an agent inside a box with no walls.
      if (mode === 'mandate' && !wroteNumbers && !v.mandate) {
        const msg = 'Auto-negotiate needs your numbers. Write at least a limit and a currency.';
        if (returnTo) {
          const back = await backToMatch(msg, undefined, 400);
          if (back) return back;
        }
        return html(reply, home.cardNumbersPage({ ...v, mode, form }, msg), 400);
      }
      let mandate: ReturnType<typeof validateMandate> | undefined;
      if (wroteNumbers) {
        mandate = validateMandate(form, v.type);
        if (!mandate.ok) {
          if (returnTo) {
            const back = await backToMatch(mandate.error, undefined, 400);
            if (back) return back;
          }
          return html(reply, home.cardNumbersPage({ ...v, mode, form }, mandate.error), 400);
        }
      }
      // Auto-negotiate hands the agent a band it can spend inside without
      // coming back, and the figures ARE that band. Setting either takes the
      // same ceremony an approval takes; going back to Pass on with nothing
      // written is a de-escalation and takes nothing.
      if (mode === 'mandate' || wroteNumbers) {
        const okNow = await ceremony(s, reply, String(b.pin ?? ''));
        if (!okNow) return;
      }
      await saveNegotiation(
        s.accountId!,
        id,
        { mode, ...(mandate?.ok ? { mandate: mandate.value } : {}) },
        'counter',
      );
      const notice = `Saved. On this ${v.type === 'HAVE' ? 'have' : 'want'}, ${home.figuresPhrase(mode)}.`;
      if (returnTo) {
        const back = await backToMatch(undefined, notice);
        if (back) return back;
      }
      const saved = await numbersView(s.accountId!, id, s);
      return html(reply, home.cardNumbersPage(saved!, undefined, notice));
    });

    counter.post('/ledger/:id/numbers/clear', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const id = String((req.params as any).id);
      const v = await numbersView(s.accountId!, id, s);
      if (!v) return html(reply, pages.messagePage('Not found', `<p>${NOT_ON_LIST}</p>`), 404);
      await saveNegotiation(s.accountId!, id, { mode: 'relay', mandate: null }, 'counter');
      const saved = await numbersView(s.accountId!, id, s);
      return html(
        reply,
        home.cardNumbersPage(
          saved!,
          undefined,
          `Cleared. On this ${v.type === 'HAVE' ? 'have' : 'want'}, ${home.figuresPhrase('relay')}.`,
        ),
      );
    });

    // ------------------------------------------------------------------
    // 1.E: the offers on one match, and the box where this person types the
    // next figure. Sending one is the human acting, so it needs a signed-in
    // session — and no more than that, because a proposal binds nothing.
    // Accepting one still asks for the PIN, on /approve.
    // ------------------------------------------------------------------
    const NO_SUCH_MATCH = 'That introduction is not one of yours.';

    const offersView = async (
      accountId: string,
      matchId: string,
      sess0: Session,
    ): Promise<home.MatchOffersView | undefined> => {
      // Not a uuid, not theirs, or still in line: all the same "not found".
      if (!UUID_RE.test(matchId)) return undefined;
      const m = await ops.matchForHuman(accountId, matchId);
      if (!m) return undefined;
      const offers = await ops.offersOnMatch(matchId);
      const draft = await newestOfferDraft(accountId, matchId);
      const verdict = await ops.verdictOnMatch(accountId, matchId);
      const neg = await readNegotiation(accountId, m.card_id, { purpose: 'counter-offers-view' });
      const blocked =
        m.state !== 'open'
          ? 'This match is closed, so no more figures can go across it.'
          : m.stage < 2
            ? 'Offers open once the details on this one are open.'
            : undefined;
      // A figure of theirs that is still live: the form has nothing to ask for
      // until they want to change it.
      const mine = offers.filter((o) => o.proposer_account === accountId);
      const live = [...mine]
        .reverse()
        .find((o) => o.state === 'proposed' && new Date(o.expiry).getTime() > Date.now());
      // Accepting is a human act with a PIN behind it, on either side, and it
      // is the end of the switchboard's part.
      const agreed = offers.find((o) => o.state === 'accepted-by-human');
      return {
        matchId,
        cardId: m.card_id,
        category: categoryLeafLabel(m.category),
        type: m.card_type,
        mode: neg.mode,
        ceremony: await ceremonyFor(accountId, sess.isElevated(sess0)),
        canOffer: !blocked,
        canOfferBlockedBecause: blocked,
        // There is something to close while it is open, and nothing to close
        // once it is not.
        canReport: m.state === 'open',
        ...(live ? { myOfferOnTable: `${Number(live.amount)} ${live.ccy}` } : {}),
        ...(agreed ? { agreedAmount: `${Number(agreed.amount)} ${agreed.ccy}` } : {}),
        ...(draft ? { draft: draftToFields(draft) } : {}),
        ...(verdict ? { verdict } : {}),
        ...(await (async () => {
          // The whole story of this match, drawn by the same renderer as the
          // main page's box. A read that fails leaves the page as it was.
          try {
            const story = await readStoryFacts(accountId, matchId);
            if (!story) return {};
            const acct: any = await getAccount(accountId);
            const theirs = await readTheirThing(accountId, matchId);
            return {
              thing: story.head.thing,
              ...(story.head.theirName ? { theirName: story.head.theirName } : {}),
              ...(theirs ? { theirs } : {}),
              story: buildSteps(story.facts),
              timezone: typeof acct?.timezone === 'string' && acct.timezone ? acct.timezone : null,
            };
          } catch {
            return {};
          }
        })()),
        offers: offers.map((o) => ({
          amount: `${Number(o.amount)} ${o.ccy}`,
          mine: o.proposer_account === accountId,
          state: o.state,
          authoredByMe: o.proposer_account === accountId ? o.authored_by : undefined,
          note: o.message?.text,
          expires: pages.localTime(o.expiry),
        })),
      };
    };

    counter.get('/matches/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await offersView(s.accountId!, String((req.params as any).id), s);
      if (!v) return html(reply, pages.messagePage('Not found', `<p>${NO_SUCH_MATCH}</p>`), 404);
      return html(reply, home.matchOffersPage(v));
    });

    /**
     * REPORTING WITHOUT AN ASSISTANT IN THE WAY. The agent road is
     * respond(request_report), which mints this same link and hands it over;
     * this is the other road to the same one question, for the person sitting
     * on their own page beside the introduction.
     *
     * It mints and redirects rather than rendering a page of its own, so there
     * is exactly one report page in the codebase and it is the one an
     * assistant's link opens. Nothing is reported here: the press is.
     */
    counter.get('/matches/:id/report', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      // The same door as the match page: an introduction still in line is not
      // one this person can open anything on (matchForHuman leaves it out).
      const matchId = String((req.params as any).id);
      if (!UUID_RE.test(matchId) || !(await ops.matchForHuman(s.accountId!, matchId))) {
        return html(reply, pages.messagePage('Not found', `<p>${NO_SUCH_MATCH}</p>`), 404);
      }
      try {
        const minted = await reportLink(cfg, s.accountId!, String((req.params as any).id));
        return reply.redirect(new URL(minted.link).pathname + new URL(minted.link).search, 303);
      } catch (e: any) {
        if (e instanceof OsbError) {
          return html(
            reply,
            pages.donePage(
              'Nothing to close',
              `<p>${pages.esc(e.payload.human_action ?? 'This one is already closed.')}</p>`,
            ),
          );
        }
        if (e?.notFound) {
          return html(reply, pages.messagePage('Not found', '<p>No such introduction of yours.</p>'), 404);
        }
        throw e;
      }
    });

    counter.post('/matches/:id/offer', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const matchId = String((req.params as any).id);
      const v = await offersView(s.accountId!, matchId, s);
      if (!v) return html(reply, pages.messagePage('Not found', `<p>${NO_SUCH_MATCH}</p>`), 404);
      const b: any = req.body ?? {};
      const form = {
        amount: String(b.amount ?? '').trim(),
        ccy: String(b.ccy ?? '').trim().toUpperCase(),
        note: String(b.note ?? ''),
      };
      const bad = (error: string, code = 400) =>
        html(reply, home.matchOffersPage({ ...v, form }, error), code);

      const amount = Number(form.amount);
      if (!Number.isFinite(amount) || amount <= 0) return bad('Your number needs to be more than nothing.');
      if (Math.round(amount * 100) !== Number((amount * 100).toFixed(6))) {
        return bad('Your number goes no finer than cents.');
      }
      if (!/^[A-Z]{3}$/.test(form.ccy)) return bad('The currency is a three-letter code, like AUD.');
      const note = validateOfferNote(form.note);
      if (!note.ok) return bad(note.error);
      const days = [3, 7, 14].includes(Number(b.good_for)) ? Number(b.good_for) : 7;
      // Sending a figure is money: the PIN or the passkey at this press, after
      // the boxes are checked so a typo never costs a PIN attempt.
      if (!(await pressCeremony(s, reply, b, 'offer-send'))) return;

      let sameFigure: string | undefined;
      try {
        const placed = await proposeOffer(
          cfg,
          s.accountId!,
          {
            match_id: matchId,
            amount: Math.round(amount * 100) / 100,
            ccy: form.ccy,
            expiry: new Date(Date.now() + days * 86_400_000).toISOString(),
            ...(note.value ? { message: note.value } : {}),
          },
          // The human typed this figure on their own page, so the card's
          // negotiation mode has nothing to say about it: the mode governs
          // what an AGENT may author, and this is the human authoring.
          { author: 'human' },
        );
        if ('already_on_table' in placed) sameFigure = placed.say;
      } catch (e: any) {
        if (e instanceof OsbError) {
          const rateLimited =
            e.payload.code === 'RATE_LIMITED_OFFERS' || e.payload.code === 'QUOTA_EXCEEDED';
          return bad(
            rateLimited
              ? 'That is more offers than this match takes in a day. Your figure is safe here; try again later.'
              : (e.payload.human_action ?? 'This match is not taking offers right now.'),
            rateLimited ? 429 : 409,
          );
        }
        if (e?.notFound) return bad('This match is no longer yours to offer on.', 404);
        throw e;
      }
      const after = await offersView(s.accountId!, matchId, s);
      return html(
        reply,
        home.matchOffersPage(
          after!,
          undefined,
          sameFigure ?? 'Sent. Your number is on the table for the other side.',
        ),
      );
    });

    // "Take it down" asks once, on a page of its own, before it does anything.
    counter.get('/ledger/:id/withdraw', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const cards = await ops.ledgerCards(cfg, s.accountId!);
      const c = cards.find((x) => x.id === String((req.params as any).id));
      if (!c) return html(reply, pages.messagePage('Not found', `<p>${NOT_ON_LIST}</p>`), 404);
      const st = ledgerState(c);
      if (st === 'taken down' || st === 'lapsed') return reply.redirect('/ledger', 303);
      return html(
        reply,
        home.takeDownPage({ id: c.id, type: c.type, thing: ownThingPhrase(c.category, c.kind).words }),
      );
    });

    counter.post('/ledger/:id/withdraw', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      try {
        await withdrawIntent(s.accountId!, String((req.params as any).id), cfg);
      } catch {
        return html(reply, pages.messagePage('Not found', `<p>${NOT_ON_LIST}</p>`), 404);
      }
      return reply.redirect('/ledger?done=taken-down', 303);
    });

    // ------------------------------------------------------------------
    // Kill switch: ONE TAP OFF, A CEREMONY BACK ON.
    //
    // It briefly took a PIN in both directions. It does not any more
    // (2026-09-17). A brake is not a door: somebody reaching for this is
    // somebody who wants everything to stop NOW, and the wrong end of that
    // trade is a person hunting for a credential while the thing they are
    // frightened of carries on. Everything it does is reversible by them and
    // nothing it does is reversible by anybody else — it pauses their postings
    // and suspends their agents' tokens, and turning it back ON is where the
    // ceremony belongs and stays.
    //
    // What guards it instead: the cross-site check that now stands over this
    // whole page class, so no other site can press it, and the pacing below, so
    // a stolen session cannot hold the tap down and drown the person in mail.
    // ------------------------------------------------------------------
    counter.post('/kill', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      // Five an hour, per account. This is not a security boundary — the
      // cross-site check is — it is the thing that stops a loop turning one
      // switch into an inbox. In memory and per process on purpose, the same
      // reasoning as every other limiter in src/abuseLimit.ts: blunting a burst
      // rather than precise global accounting.
      if (killSwitchLimiter.limited(s.accountId!)) {
        return html(
          reply,
          pages.messagePage(
            'Just a moment',
            '<p>That switch has been pressed several times in the last hour. Everything is already paused; give it a few minutes before pressing again.</p>',
          ),
          429,
        );
      }
      await ops.killSwitchOn(s.accountId!);
      const email = await ops.accountEmail(s.accountId!, 'kill-switch-confirmation');
      if (email) await notifyBestEffort(req, 'kill-switch-on', () => sendKillSwitchEmail(cfg, email, s.accountId!, true));
      return reply.redirect('/', 303);
    });

    counter.post('/kill/off', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (!okNow) return;
      await ops.killSwitchOff(s.accountId!);
      const email = await ops.accountEmail(s.accountId!, 'kill-switch-confirmation');
      if (email) await notifyBestEffort(req, 'kill-switch-off', () => sendKillSwitchEmail(cfg, email, s.accountId!, false));
      return reply.redirect('/', 303);
    });

    // ------------------------------------------------------------------
    // Agent keys (1.C). Static bearer tokens for the agents that cannot do
    // a browser sign-in. Issuing one is a sensitive action: signed-in
    // session PLUS a PIN or passkey ceremony, exactly like an approval.
    // The key itself never reaches an approval surface — every route in
    // this plugin 403s an Authorization header, keys included.
    // ------------------------------------------------------------------
    const agentKeysView = async (accountId: string, s: Session): Promise<home.AgentKeysView> => {
      const keys = await agentKeys.listAgentKeys(accountId);
      const when = (d: Date | null) => (d ? pages.localTime(d, 'day') : undefined);
      return {
        keys: keys.map((k) => ({
          keyId: k.keyId,
          name: k.name,
          created: when(k.createdAt)!,
          lastUsed: when(k.lastUsedAt),
          expires: when(k.expiresAt)!,
        })),
        ...(await ceremonyFor(accountId, sess.isStronglyElevated(s))),
        atLimit: keys.length >= agentKeys.AGENT_KEY_MAX_LIVE,
      };
    };

    counter.get('/agent-keys', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      return html(reply, home.agentKeysPage(await agentKeysView(s.accountId!, s)));
    });

    counter.post('/agent-keys', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const name = String(b.name ?? '').trim();
      if (!name) {
        return html(
          reply,
          home.agentKeysPage(await agentKeysView(s.accountId!, s), undefined, 'Give the key a name so you can tell your keys apart.'),
          400,
        );
      }
      // Sensitive action: the passkey or a PIN, never a window an emailed code
      // opened, because a key lasts ninety days.
      const okNow = await credentialCeremony(s, reply, String(b.pin ?? ''));
      if (!okNow) return;
      let made: Awaited<ReturnType<typeof agentKeys.createAgentKey>>;
      try {
        made = await agentKeys.createAgentKey(s.accountId!, name);
      } catch (e) {
        if (e instanceof agentKeys.AgentKeyLimitError) {
          return html(
            reply,
            home.agentKeysPage(
              await agentKeysView(s.accountId!, s),
              undefined,
              'You are holding as many keys as we allow at once. Revoke one to make room.',
            ),
            409,
          );
        }
        throw e;
      }
      // Security notice: a static credential for the account now exists.
      const noticeEmail = await ops.accountEmail(s.accountId!, 'security-notice');
      if (noticeEmail) {
        await notifyBestEffort(req, 'agent-key-created', () =>
          sendSecurityNoticeEmail(cfg, noticeEmail, s.accountId!, 'agent-key-created', made.row.name),
        );
      }
      return html(
        reply,
        home.agentKeyCreatedPage({
          name: made.row.name,
          token: made.token,
          expires: pages.localTime(made.row.expiresAt, 'day'),
        }),
      );
    });

    counter.post('/agent-keys/revoke', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const keyId = String((req.body as any)?.key_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(keyId)) {
        return html(
          reply,
          home.agentKeysPage(await agentKeysView(s.accountId!, s), undefined, 'That key is unknown.'),
          400,
        );
      }
      const revoked = await agentKeys.revokeAgentKey(s.accountId!, keyId);
      return html(
        reply,
        home.agentKeysPage(
          await agentKeysView(s.accountId!, s),
          revoked
            ? 'Revoked. Anything still using that key stops working right now.'
            : 'That key was already gone.',
        ),
      );
    });

    // ------------------------------------------------------------------
    // What you share on a match: the first name and area that go across at
    // stage 3, viewable and changeable any time. A signed-in session is
    // enough — changing these two boxes discloses nothing by itself, and the
    // disclosure they feed still needs its own PIN ceremony.
    // ------------------------------------------------------------------
    counter.get('/profile', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const p = await readSharedProfile(s.accountId!, {
        purpose: 'shared-profile-page',
        actor: s.accountId!,
      });
      return html(reply, home.sharedProfilePage({ firstName: p.firstName, locality: p.locality }));
    });

    // ------------------------------------------------------------------
    // The area box's suggestions. The offline gazetteer answers it, so a
    // person typing the name of their own suburb reaches no third party and
    // leaves no trail off this service. It is the same asset that places
    // every posting, which is the point: the area a person shares and the
    // area their postings match on now come from one source.
    //
    // Four things keep it cheap and keep it from becoming a way to walk the
    // gazetteer or to probe the service: the human's own session, a minimum
    // query length, eight answers at most, and the per-IP limiter.
    // ------------------------------------------------------------------
    counter.get('/areas', async (req, reply) => {
      const s = await sess.loadSession(req);
      if (!s?.accountId) return reply.code(401).send({ error: 'not_signed_in' });
      if (!rateLimitBypassed(req.headers as any, cfg) && areaSuggestLimiter.limited(req.ip)) {
        return reply.code(429).send({ error: 'slow_down' });
      }
      const q = String((req.query as any)?.q ?? '');
      // Their own country first. The hint comes from the zone alone and never
      // from the area on file: this box is where the area is being replaced,
      // and reading the old one would mean an identity decrypt on every
      // keystroke to order a list that a zone orders just as well.
      const hint = { country: countryOfTimeZone(await getTimezone(s.accountId)) };
      return reply
        .header('cache-control', 'private, max-age=60')
        .send({ places: suggestAreas(q, undefined, hint) });
    });

    // Saving a preference goes back to the main page rather than staying
    // on the form: the person came from the menu, and a save is the end of
    // the errand. Errors stay on the form, where the fix is.
    const SAVED_NOTICES: Record<string, string> = {
      profile: 'Saved. This is what a match sees once you both say yes.',
      arrangement: 'Saved. Every agent you have connected picks this up on its next check.',
      'arrangement-cleared': 'Cleared. Your agents will ask you afresh how you want this to go.',
      'hears-assistant': 'Saved. Match and reply emails are off.',
      'hears-email': 'Saved. Matches and replies reach you by email.',
      timezone: 'Saved your time zone.',
      'blind-on': 'Blind mode is on.',
      'blind-off': 'Blind mode is off.',
      frequency: 'Saved. Effective immediately.',
      'email-resumed': 'Email is back on.',
    };
    const savedTo = (reply: any, code: keyof typeof SAVED_NOTICES) =>
      reply.redirect(`/?saved=${code}`, 303);

    counter.post('/profile', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const checked = validateSharedProfile({ firstName: b.first_name, locality: b.locality });
      if (!checked.ok) {
        return html(
          reply,
          home.sharedProfilePage(
            { firstName: String(b.first_name ?? ''), locality: String(b.locality ?? '') },
            { error: checked.error },
          ),
          400,
        );
      }
      await saveSharedProfile(s.accountId!, checked.value, 'counter', cfg);
      return savedTo(reply, 'profile');
    });

    // ------------------------------------------------------------------
    // How your agents behave (1.D): the standing arrangement. A signed-in
    // session is enough to read and change it — it holds cadence and
    // etiquette rather than identity — and every write goes through the same
    // validator the agent surface uses, then the WORM consent log.
    // ------------------------------------------------------------------
    const arrangementView = async (accountId: string) => ({
      arrangement: await readArrangement(accountId),
      updated: await readArrangementUpdatedAt(accountId).then((d) =>
        d ? pages.localTime(d) : undefined,
      ),
    });

    counter.get('/arrangement', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await arrangementView(s.accountId!);
      return html(
        reply,
        home.arrangementPage(v.arrangement, { updated: v.updated, hearsVia: await getHearsVia(s.accountId!) }),
      );
    });

    counter.post('/arrangement', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      // The textarea is one instruction per line; blank lines drop out.
      const interruptFor = String(b.interrupt_for ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const submitted = {
        ...(String(b.check_every_minutes ?? '').trim()
          ? { check_every_minutes: Number(String(b.check_every_minutes).trim()) }
          : {}),
        ...(interruptFor.length ? { interrupt_for: interruptFor } : {}),
        ...(b.runs_on_its_own ? { runs_on_its_own: String(b.runs_on_its_own) } : {}),
        ...(b.summarize ? { summarize: String(b.summarize) } : {}),
        ...(b.suggestion_appetite ? { suggestion_appetite: String(b.suggestion_appetite) } : {}),
        ...(b.quiet_hours ? { quiet_hours: String(b.quiet_hours) } : {}),
        ...(b.notes ? { notes: String(b.notes) } : {}),
      };
      const checked = validateArrangement(submitted);
      if (!checked.ok) {
        // The cadence rule is written for an assistant; a person gets it in
        // the page's own words.
        const error =
          checked.error === CADENCE_NEEDS_RUNS_ON_ITS_OWN ? home.CADENCE_NEEDS_RUNS_ON_ITS_OWN_PAGE : checked.error;
        return html(
          reply,
          home.arrangementPage(
            { ...(submitted as any), runs_on_its_own: submitted.runs_on_its_own === 'on' },
            { error, hearsVia: await getHearsVia(s.accountId!) },
          ),
          400,
        );
      }
      await saveArrangement(s.accountId!, checked.value, 'counter');
      return savedTo(reply, 'arrangement');
    });

    counter.post('/arrangement/clear', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      await saveArrangement(s.accountId!, {}, 'counter');
      return savedTo(reply, 'arrangement-cleared');
    });

    // ------------------------------------------------------------------
    // Settings: email frequency controls + blind mode (0.E). Every change
    // is effective immediately (the send pipeline reads the account row at
    // send time) and writes to the WORM consent log first.
    // ------------------------------------------------------------------
    const settingsView = async (accountId: string): Promise<home.EmailSettingsView> => {
      const [es, hearsVia, timezone, profile, creds0, arrangement, keys] = await Promise.all([
        ops.emailSettings(accountId),
        getHearsVia(accountId),
        getTimezone(accountId),
        readSharedProfile(accountId, { purpose: 'settings-view', actor: accountId }),
        credentialsOf(accountId),
        readArrangement(accountId),
        agentKeys.listAgentKeys(accountId),
      ]);
      // Which parts of the standing arrangement are set; the whole of it is a tap away.
      const summary = home.arrangementSummaryLine(arrangementInPlainWords(arrangement));
      return {
        hearsVia,
        timezone,
        ...(profileIsFilled(profile) ? { sharedProfile: `${profile.firstName}, ${profile.locality}` } : {}),
        approveWith: { pin: !!creds0.hasPin, passkey: !!creds0.hasPasskey },
        ...(summary ? { arrangementSummary: summary } : {}),
        keyCount: keys.length,
        freqMatches: es.freqMatches,
        freqDigests: es.freqDigests,
        complaintSuppressed: es.complaintSuppressed,
        emailUnreachable: es.unreachable,
      };
    };

    counter.get('/settings', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      return html(reply, home.settingsPage(await settingsView(s.accountId!)));
    });

    // Which way this person hears about their switchboard. It is the one thing
    // the software cannot work out for itself: an agent that checks on its own
    // and a chat assistant that waits to be spoken to look identical from
    // here, and getting it wrong leaves someone waiting on news that a silent
    // agent was supposed to bring them.
    counter.post('/settings/hears-via', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const want = String((req.body as any)?.hears_via ?? '');
      if (want !== 'email' && want !== 'assistant') {
        return html(
          reply,
          home.settingsPage(await settingsView(s.accountId!), 'Pick one of the two.'),
          400,
        );
      }
      await setHearsVia(s.accountId!, want, 'counter');
      return savedTo(reply, want === 'assistant' ? 'hears-assistant' : 'hears-email');
    });

    counter.post('/settings/timezone', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const tz = String((req.body as any)?.timezone ?? '').trim();
      if (!isValidTimeZone(tz)) {
        return html(
          reply,
          home.settingsPage(await settingsView(s.accountId!), 'Pick a zone from the list.'),
          400,
        );
      }
      await setTimezone(s.accountId!, tz);
      return savedTo(reply, 'timezone');
    });

    counter.post('/settings/blind-mode', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const on = String((req.body as any)?.blind_mode ?? '') === 'on';
      await ops.setBlindMode(s.accountId!, on);
      return savedTo(reply, on ? 'blind-on' : 'blind-off');
    });

    counter.post('/settings/frequency', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const fm = String(b.freq_matches ?? '');
      const fd = String(b.freq_digests ?? '');
      if (!ops.EMAIL_FREQUENCIES.includes(fm as any) || !ops.EMAIL_FREQUENCIES.includes(fd as any)) {
        return html(
          reply,
          home.settingsPage(await settingsView(s.accountId!), 'That frequency is unknown.'),
          400,
        );
      }
      await ops.setEmailFrequency(s.accountId!, fm as any, fd as any, 'counter');
      return savedTo(reply, 'frequency');
    });

    counter.post('/settings/email-resume', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      await ops.resumeNonTransactionalEmail(s.accountId!);
      return savedTo(reply, 'email-resumed');
    });

    // ------------------------------------------------------------------
    // Unsubscribe: the emailed footer link (GET, human confirm) and the
    // RFC 8058 one-click POST target share this signed-token endpoint.
    // Auth-less by design — the token is HMAC-bound to the account.
    // ------------------------------------------------------------------
    counter.get('/email/unsub', async (req, reply) => {
      const t = String((req.query as any)?.t ?? '');
      const v = verifyEmailToken(t, 'unsubscribe');
      // A dead or expired link still gets a real page, and a 200: mailbox
      // providers pre-fetch List-Unsubscribe URLs and score a 404 against
      // the sender (seen in iCloud's junk verdict on the placement test).
      if (!v.ok) return html(reply, pages.linkDeadPage(v.reason ?? 'invalid'));
      return html(reply, home.unsubPage(t));
    });

    counter.post('/email/unsub', async (req, reply) => {
      const t = String((req.query as any)?.t ?? (req.body as any)?.t ?? '');
      const v = verifyEmailToken(t, 'unsubscribe');
      if (!v.ok) return html(reply, pages.linkDeadPage(v.reason ?? 'invalid'), 404);
      await ops.unsubscribeAllNonTransactional(v.accountId!, 'email-unsubscribe-link');
      return html(
        reply,
        pages.messagePage(
          'Unsubscribed',
          `<p>Match summons and activity digests are off. Sign-in codes, approvals
and security notices keep sending.
Turn anything back on any time in <a href="/settings">settings</a>.</p>`,
        ),
      );
    });

    // ------------------------------------------------------------------
    // "Still true?" renewal (signed link from the renewal email).
    // ------------------------------------------------------------------
    counter.get('/renew', async (req, reply) => {
      const t = String((req.query as any)?.t ?? '');
      const v = verifyEmailToken(t, 'renew-all');
      if (!v.ok) return html(reply, pages.linkDeadPage(v.reason ?? 'invalid'), 404);
      const cards = await getPool().query(
        `SELECT type, category, attributes, expires_at,
                (expires_at <= now() + interval '7 days') AS expiring_soon
         FROM cards
         WHERE account_id = $1 AND lifecycle_state = 'PUBLISHED' AND expires_at > now()
         ORDER BY expires_at`,
        [v.accountId],
      );
      if (!cards.rowCount) {
        return html(
          reply,
          pages.messagePage('Nothing to renew', '<p>Nothing is open to renew right now.</p>', '/', 'Back'),
        );
      }
      return html(
        reply,
        home.renewPage(
          cards.rows.map((c: any) => ({
            type: c.type,
            category: categoryLeafLabel(c.category),
            attributes: home.attributesSentence(c.attributes),
            expires: new Date(c.expires_at).toISOString().slice(0, 10),
            expiringSoon: !!c.expiring_soon,
          })),
          t,
        ),
      );
    });

    counter.post('/renew', async (req, reply) => {
      const t = String((req.body as any)?.t ?? (req.query as any)?.t ?? '');
      const v = verifyEmailToken(t, 'renew-all');
      if (!v.ok) return html(reply, pages.linkDeadPage(v.reason ?? 'invalid'), 404);
      // One press. Restarting the clock on everything an account holds is not
      // something a forwarded email should be able to do over and over.
      if (!(await consumeEmailToken({ ...v, purpose: 'renew-all' }))) {
        return html(reply, pages.linkDeadPage('used'));
      }
      const renewed = await ops.renewAllCards(v.accountId!, 'email-renew-all-link');
      return html(
        reply,
        pages.messagePage(
          'Renewed',
          `<p>Renewed ${renewed.length === 1 ? 'one want or have' : `${renewed.length} wants and haves`}.</p>`,
          '/ledger',
          'See your wants and haves',
        ),
      );
    });

    // "Keep them all" on the main page's lapsing tile (28 September 2026). The
    // tile used to point at the ledger, which had no way to renew, and the
    // token route above is reachable only from an email. This is the same
    // renewal, from the signed-in session, for exactly the ones that are
    // lapsing: the set the tile counted, and nothing else.
    counter.post('/renew/lapsing', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const renewed = await ops.renewAllCards(s.accountId!, 'counter', 'lapsing');
      return reply.redirect(renewed.length ? '/?renewed=1' : '/', 303);
    });

    // ------------------------------------------------------------------
    // Email re-verification after a hard bounce (dashboard banner).
    // ------------------------------------------------------------------
    counter.post('/reverify', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const email = await ops.accountEmail(s.accountId!, 'email-reverification');
      if (!email) return html(reply, pages.messagePage('No address', '<p>No email on file.</p>'), 404);
      if (await verificationRateLimited(email)) {
        return html(
          reply,
          pages.messagePage('Slow down', '<p>Too many codes requested. Wait a few minutes.</p>'),
          429,
        );
      }
      if (!rateLimitBypassed(req.headers as Record<string, unknown>, cfg) && verificationEmailLimiter.limited(req.ip)) {
        req.log.warn({ ip: req.ip }, 'counter-reverify: per-IP verification-email limit hit');
        return html(
          reply,
          pages.messagePage('Slow down', '<p>Too many codes requested from this connection. Wait an hour.</p>'),
          429,
        );
      }
      const v = await createVerification(cfg, email, 'login');
      await sendCodeOrNote(req, email, v, 'login');
      return html(reply, home.reverifyCodePage(v.id));
    });

    counter.post('/reverify/verify', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const result = await verifyByCode(cfg, String(b.verification_id ?? ''), String(b.code ?? ''));
      if (!result.ok) {
        return html(
          reply,
          home.reverifyCodePage(String(b.verification_id ?? ''), 'That code did not work. Check the most recent email.'),
          401,
        );
      }
      const a: any = await getAccount(s.accountId!);
      // Either spelling: this account's row may or may not have been rehashed.
      const codeHashes = emailHashes(result.email!);
      if (!a || (codeHashes.v2 !== a.email_hash_v2 && codeHashes.v1 !== a.email_hash)) {
        return html(reply, pages.messagePage('Wrong account', '<p>That code belongs to a different address.</p>'), 403);
      }
      await ops.clearEmailUnreachable(s.accountId!);
      return reply.redirect('/', 303);
    });

    // ------------------------------------------------------------------
    // Agent authorization (OAuth): the human-facing half of /oauth/authorize.
    // ------------------------------------------------------------------
    counter.get('/authorize', async (req, reply) => {
      const q: any = req.query ?? {};
      let s = await sess.loadSession(req);
      const ctx =
        q.client_id
          ? {
              client_id: q.client_id,
              redirect_uri: q.redirect_uri,
              response_type: 'code',
              code_challenge: q.code_challenge,
              code_challenge_method: 'S256',
              scope: q.scope || 'switchboard',
              state: q.state || '',
              resource: q.resource || '',
            }
          : s?.oauthCtx;
      if (!ctx?.client_id) {
        return html(reply, pages.messagePage('Nothing to authorise', '<p>There is no assistant waiting to be connected. Ask your assistant to connect again.</p>'));
      }
      const v = await validateAuthorizeRequest(ctx);
      if (v.error) {
        return reply.code(400).type('text/plain').send(`invalid authorization request: ${v.error}`);
      }
      if (!s) {
        // A row for somebody not signed in yet, so it is paced per connection.
        if (!rateLimitBypassed(req.headers as Record<string, unknown>, cfg) && anonymousSessionLimiter.limited(req.ip)) {
          req.log.warn({ ip: req.ip }, 'authorize: per-IP anonymous session limit hit');
          return html(
            reply,
            pages.messagePage('Too many tries', '<p>Too many tries from this connection. Wait a minute, then ask your assistant to connect again.</p>'),
            429,
          );
        }
        s = await sess.createSession(reply, null);
      }
      await sess.setOauthCtx(s.id, ctx);
      if (!s.accountId) return reply.redirect('/login', 303);
      const a: any = await getAccount(s.accountId);
      if (!(await holdsCredential(s.accountId, a)) || a.status === 'pending') {
        return reply.redirect(await nextStep(s.accountId, s as Session), 303);
      }
      return html(
        reply,
        pages.authorizePage(
          v.client!.client_name,
          '/authorize',
          {},
          v.client!.client_id,
          await ceremonyFor(s.accountId, sess.isStronglyElevated(s as Session), a),
          ctx.redirect_uri,
        ),
      );
    });

    counter.post('/authorize', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const ctx = s.oauthCtx;
      if (!ctx?.client_id) {
        return html(reply, pages.messagePage('Nothing to authorise', '<p>There is no assistant waiting to be connected. Ask your assistant to connect again.</p>'), 400);
      }
      const v = await validateAuthorizeRequest(ctx);
      if (v.error) {
        return reply.code(400).type('text/plain').send(`invalid authorization request: ${v.error}`);
      }
      const a: any = await getAccount(s.accountId!);
      if (!a || a.status !== 'active') {
        return html(reply, pages.messagePage('Account not active', '<p>Finish opening your account first.</p>'), 403);
      }
      const target = new URL(ctx.redirect_uri);
      if (String((req.body as any)?.decision ?? '') !== 'approve') {
        await sess.setOauthCtx(s.id, null);
        target.searchParams.set('error', 'access_denied');
        if (ctx.state) target.searchParams.set('state', ctx.state);
        return reply.redirect(target.toString(), 303);
      }
      // Handing an agent a key is a sensitive action, and it takes the
      // passkey or a PIN rather than a window an emailed code opened. The
      // pending request is cleared only once the ceremony is through, so a
      // wrong PIN leaves the person on a page that still knows what they were
      // being asked.
      const okNow = await credentialCeremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (!okNow) return;
      await sess.setOauthCtx(s.id, null);
      const code = await createAuthCode({
        clientId: ctx.client_id,
        accountId: s.accountId!,
        redirectUri: ctx.redirect_uri,
        codeChallenge: ctx.code_challenge,
        scope: ctx.scope,
        resource: ctx.resource || undefined,
      });
      // 0.E security notice: a new agent was just authorised.
      const email = await ops.accountEmail(s.accountId!, 'security-notice');
      if (email) {
        await notifyBestEffort(req, 'agent-authorized', () =>
          sendSecurityNoticeEmail(cfg, email, s.accountId!, 'agent-authorized', v.client!.client_name),
        );
      }
      target.searchParams.set('code', code);
      if (ctx.state) target.searchParams.set('state', ctx.state);
      // Plain OAuth redirect, loopback included. A CLI that is listening on
      // 127.0.0.1 completes at once (top-level navigations are exempt from the
      // browser's local-network fetch rules, which a probing page is not); one
      // that printed the link and exited shows a connection error, and the
      // person pastes the address-bar URL back, which is the loopback
      // convention every such client already explains.
      return reply.redirect(target.toString(), 303);
    });
  });
}
