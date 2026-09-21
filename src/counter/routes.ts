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
  areaSuggestLimiter,
  killSwitchLimiter,
  rateLimitBypassed,
  verificationEmailLimiter,
} from '../abuseLimit.js';
import { getPool } from '../db.js';
import { getAccount, findAccountByEmail, getHearsVia, getTimezone, setHearsVia, setTimezone } from '../domain/accounts.js';
import { isValidTimeZone } from '../domain/localTime.js';
import { suggestAreas } from '../geo/suggest.js';
import { countryOfTimeZone } from '../geo/homeCountry.js';
import {
  arrangementInPlainWords,
  isEmpty as arrangementIsEmpty,
  readArrangement,
  readArrangementUpdatedAt,
  saveArrangement,
  validateArrangement,
} from '../domain/arrangement.js';
import { amendIntent, withdrawIntent } from '../domain/cards.js';
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
  readersOwnThingLabel,
} from '../domain/matches.js';
import { categoryLeafLabel } from '../domain/matchRules.js';
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
  presignPhotoUpload,
} from '../domain/channelPhoto.js';
import { settlementsConfigured } from '../config.js';
import { formatMinor, isZeroDecimal, settlementBreakdown, toMinorUnits } from '../stripe.js';
import { createAuthCode, validateAuthorizeRequest } from '../auth/oauth.js';
import * as pages from './pages.js';
import * as home from './pagesHome.js';
import * as sess from './session.js';
import { hashPin, pinFormatOk, verifyPinAttempt, PIN_ELEVATION_MINUTES } from './pin.js';
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
import { consumeLink, verifyLinkToken, type ApprovalLinkRow } from './links.js';
import { offerAmountAnomaly, newCounterpartyAnomaly } from './anomalies.js';
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
    const settlementMoneyLines = (row: {
      amount: string;
      ccy: string;
      fee_amount_minor?: number | null;
      processing_fee_minor?: number | null;
      buyer_total_minor?: number | null;
    }) => {
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
        req.log.warn({ err }, 'verification email send failed; showing code page with delay note');
        return 'Our email sending is congested right now, so the code may take a while to arrive. This page keeps working — enter the code once it lands.';
      }
    };

    // Notification emails must never break the action they describe.
    const notifyBestEffort = async (req: FastifyRequest, what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        req.log.warn({ err, what }, 'notification email failed; action completed anyway');
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
      const [profile, arrangement, offers, disclosures, counts, liveSettlements, rejected, lapsingSoon, messagesWaiting, agreed] = await Promise.all([
        readSharedProfile(s.accountId, { purpose: 'dashboard-view', actor: s.accountId }),
        readArrangement(s.accountId),
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
           ORDER BY st.created_at DESC LIMIT 20`,
          [s.accountId],
        ),
        ops.screeningRejectedCards(s.accountId),
        ops.cardsLapsingSoon(s.accountId),
        ops.messagesWaitingFor(s.accountId),
        ops.agreedOnMatches(s.accountId),
      ]);
      const pendingApprovals = [
        // A want or have screening turned away is off the board until this
        // person changes it, so it sits at the top of what is waiting for them.
        ...rejected.map((c) => ({
          href: `/ledger/${c.id}/edit`,
          // The row says what happened; the button below it says what to do,
          // so the label no longer says both.
          label: `Your ${phrase(c.category)} didn't pass screening`,
          cta: 'See why and fix it',
        })),
        ...offers.map((o) => ({
          href: `/approvals/offer/${o.offer_id}`,
          label: `Offer on your ${phrase(o.category)} match`,
          amount: `${Number(o.amount)} ${o.ccy}`,
        })),
        ...disclosures.map((d) => ({
          href: `/approvals/match/${d.match_id}`,
          label: `Share your details on your ${phrase(d.category)} match?`,
        })),
        ...liveSettlements.rows.map((st: any) => {
          const mine = st.buyer_account === s.accountId ? st.buyer_approved_at : st.seller_approved_at;
          const needsApproval =
            !mine && ['proposed', 'approved-by-buyer', 'approved-by-seller'].includes(st.state);
          return {
            href: needsApproval
              ? `/approvals/settlement/${st.id}`
              : `/settlements/${st.id}`,
            label: `Settlement on your ${phrase(st.category)} match (${st.state})`,
            amount: `${Number(st.amount)} ${st.ccy}`,
          };
        }),
      ];
      // Sent here by the Authorize page after the agent's callback opened in
      // its own tab. The agent proves it finished by exchanging its code for a
      // token, so a fresh token for this client is the "connected" signal.
      let notice: string | undefined;
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
          sharedProfile: profileIsFilled(profile)
            ? `${profile.firstName}, ${profile.locality}`
            : undefined,
          emailUnreachable: !!a.email_unreachable_at,
          // One line on the dashboard; the whole of it is a tap away.
          arrangementSummary: (() => {
            const lines = arrangementInPlainWords(arrangement);
            if (!lines.length) return undefined;
            const head = lines[0];
            const rest = lines.length - 1;
            return `${head.k.toLowerCase()} — ${head.v}${rest ? ` (and ${rest} more)` : ''}`;
          })(),
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
          messagesWaiting: messagesWaiting.map((m) => ({
            matchId: m.match_id,
            category: categoryLeafLabel(m.category),
            count: m.count,
          })),
          agreed: agreed.map((a) => ({
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
      if (!rateLimitBypassed(req.headers as Record<string, unknown>) && verificationEmailLimiter.limited(req.ip)) {
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
      // at a device that has never seen it. The emailed code is that account's
      // whole recovery already, so here it is also the sensitive-action
      // ceremony: without this the person signs in and then dead-ends at a
      // page asking for a passkey the device cannot produce. An account WITH a
      // PIN keeps the old rule — a code signs you in and the PIN approves —
      // because that account has a second credential to be asked for.
      const acct: any = await getAccount(account.id);
      if (!acct?.pin_hash) {
        await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES);
        s = { ...s, pinOkUntil: new Date(Date.now() + PIN_ELEVATION_MINUTES * 60_000) } as Session;
      }
      return reply.redirect(await nextStep(account.id, s), 303);
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

    /** The gate in front of changing how you approve things. */
    const freshCeremonyOr = async (
      reply: FastifyReply,
      s: Session,
      next: string,
    ): Promise<boolean> => {
      const c = await ceremonyFor(s.accountId!, sess.isElevated(s));
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
      const okNow = await ceremony(s, reply, String(b.pin ?? ''));
      if (!okNow) return;
      return reply.redirect(next, 303);
    });

    /**
     * The way through on a device that holds neither the passkey nor a PIN:
     * the same emailed code that signs a person in. It is the account's own
     * recovery either way, so on an account with no PIN it also stands as the
     * sensitive-action ceremony — see finishVerification.
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
      if (!rateLimitBypassed(req.headers as Record<string, unknown>) && verificationEmailLimiter.limited(req.ip)) {
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
      if (!pinFormatOk(pin)) return refuse('The PIN must be 6 to 12 digits.');
      if (pin !== String(b.pin2 ?? '')) return refuse('The two entries did not match.');
      if (creds.needsFreshCeremony({ hasPin: !!a?.pin_hash, hasPasskey: await wa.accountHasPasskey(s.accountId!) }, sess.isElevated(s))) {
        // Adding or changing a PIN on an account that already holds something
        // needs a fresh ceremony of whatever it holds now.
        return html(reply, pages.confirmItsYouPage(await ceremonyFor(s.accountId!, sess.isElevated(s), a), '/pin'), 403);
      }
      await ops.setAccountPin(s.accountId!, await hashPin(pin));
      // Setting a PIN is itself a ceremony: the person just proved it twice.
      // That is what lets them go straight on to add a passkey.
      await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES);
      if (a?.pin_hash) {
        // 0.E security notice: an EXISTING PIN was just changed.
        const email = await ops.accountEmail(s.accountId!, 'security-notice');
        if (email) await notifyBestEffort(req, 'pin-changed', () => sendSecurityNoticeEmail(cfg, email, s.accountId!, 'pin-changed'));
      }
      if (a?.status === 'pending') return reply.redirect('/passkey', 303);
      return reply.redirect('/security', 303);
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
          skipLabel: a?.status === 'pending' ? 'Skip for now' : 'Back',
        }),
      );
    });

    counter.post('/passkey/options', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      // Fitting a second key to an account that already holds one is a
      // sensitive action, so it takes the ceremony the account can do now.
      if (creds.needsFreshCeremony(await credentialsOf(s.accountId!), sess.isElevated(s))) {
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
      await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES);
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
      return html(reply, pages.consentPage());
    });

    counter.post('/consent', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      if (b.adult !== 'yes' || b.consent !== 'yes') {
        return html(reply, pages.consentPage('Both statements are required to open the account.'), 400);
      }
      const a: any = await getAccount(s.accountId!);
      if (!(await holdsCredential(s.accountId!, a))) return reply.redirect('/secure', 303);
      if (a.status === 'pending') {
        await ops.activateAccountWithConsent(s.accountId!, pages.CONSENT_STATEMENT);
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
        // The browser's zone, filled into a hidden box. A bad or missing
        // value is simply not recorded; the settings page has the picker.
        const tz = String(b.timezone ?? '').trim();
        if (isValidTimeZone(tz)) await setTimezone(s.accountId!, tz);
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
      if (!rateLimitBypassed(req.headers as Record<string, unknown>) && verificationEmailLimiter.limited(req.ip)) {
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
      if (!s) s = await sess.createSession(reply, null);
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
      await sess.elevateSession(live.id, PIN_ELEVATION_MINUTES);
      const next = await nextStep(accountId, { ...live, accountId } as Session);
      return reply.send({ ok: true, next });
    });

    // ------------------------------------------------------------------
    // The sensitive-action ceremony (elevation).
    //
    // An elevated session passes whatever elevated it — a PIN, a passkey, or
    // an emailed code on an account that has no PIN. Otherwise the PIN is
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
      const check = await verifyPinAttempt(s.accountId!, pin);
      if (check.ok) {
        await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES);
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

    counter.post('/pin/verify', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (okNow) return reply.send({ ok: true });
    });

    // ------------------------------------------------------------------
    // Approvals. Link entry (/a/:token) is single-use + 15-min TTL;
    // the dashboard reaches the same page via a session-authorized route.
    // ------------------------------------------------------------------
    const approvalView = async (
      accountId: string,
      action: 'offer-accept' | 'stage3-disclosure' | 'settlement-approve',
      refId: string,
    ): Promise<pages.ApprovalView | { error: string }> => {
      const anomalies: string[] = [];
      const facts: { k: string; v: string }[] = [];
      let collectProfile: pages.ApprovalView['collectProfile'];
      if (action === 'settlement-approve') {
        const s = await settlements.getSettlement(refId);
        if (!s) return { error: 'This settlement no longer exists.' };
        let party: 'buyer' | 'seller';
        try {
          party = settlements.partyOf(s, accountId);
        } catch {
          return { error: 'This settlement is not yours to decide.' };
        }
        const myApproval = party === 'buyer' ? s.buyer_approved_at : s.seller_approved_at;
        if (myApproval) return { error: 'You have already approved this settlement.' };
        if (!['proposed', 'approved-by-buyer', 'approved-by-seller'].includes(s.state)) {
          return { error: `This settlement is ${s.state} — nothing to decide.` };
        }
        const m = await getMatch(s.match_id);
        const money = settlementMoneyLines(s);
        // Both humans see the same three lines, in the same words, on the page
        // where they act: the buyer pays the fees, itemised, and the seller
        // receives the agreed amount in full.
        facts.push(
          {
            k: party === 'buyer' ? 'You would pay' : 'You would be paid',
            v: party === 'buyer' ? money.buyerTotal : money.amount,
          },
          { k: 'For', v: m ? await readersOwnThingLabel(m, accountId) : 'your match' },
          { k: 'What you agreed', v: money.amount },
          { k: 'Introductory fee', v: `${money.fee}, paid by the buyer` },
          { k: 'Card processing', v: `${money.processing}, at Stripe's standard rate` },
          { k: 'The seller receives', v: `${money.amount} in full` },
          {
            k: 'How it works',
            v: party === 'buyer' ? 'held until you confirm receipt' : 'held until the buyer confirms receipt',
          },
        );
        const counterparty = party === 'buyer' ? s.seller_account : s.buyer_account;
        const cp = await newCounterpartyAnomaly(counterparty, 'settlement-approve');
        if (cp) anomalies.push(cp.text);
      } else if (action === 'offer-accept') {
        const r = await getPool().query(
          `SELECT o.*, m.category, m.account_want, m.account_have FROM offers o
           JOIN matches m ON m.id = o.match_id WHERE o.id = $1`,
          [refId],
        );
        const o = r.rows[0];
        if (!o) return { error: 'This offer no longer exists.' };
        if (o.account_want !== accountId && o.account_have !== accountId) {
          return { error: 'This offer is not yours to decide.' };
        }
        if (o.proposer_account === accountId) return { error: 'You proposed this offer; the other side decides.' };
        if (o.state !== 'awaiting-human' && o.state !== 'proposed') {
          return { error: `This offer is ${o.state} — nothing to decide.` };
        }
        // Their agent has not weighed in on this one. For most people the
        // email is the delivery and nothing is on its way, so the nudge is an
        // offer of a second opinion, never a suggestion to wait.
        if (o.state === 'proposed') {
          anomalies.push(
            'Want a second opinion first? Ask your assistant what it makes of the price — it can see the details. It is yours to accept now either way.',
          );
        }
        facts.push(
          { k: 'You are agreeing to', v: `${Number(o.amount)} ${o.ccy}` },
          { k: 'For', v: categoryLeafLabel(o.category) },
          { k: 'Offer expires', v: new Date(o.expiry).toUTCString() },
        );
        const amountAnomaly = await offerAmountAnomaly(accountId, o.id, Number(o.amount));
        if (amountAnomaly) anomalies.push(amountAnomaly.text);
        const cp = await newCounterpartyAnomaly(o.proposer_account, 'offer-accept');
        if (cp) anomalies.push(cp.text);
      } else {
        const m = await getMatch(refId);
        if (!m || m.state !== 'open') return { error: 'This match is no longer open.' };
        try {
          sideOf(m, accountId);
        } catch {
          return { error: 'This match is not yours to decide.' };
        }
        const counterparty = m.account_want === accountId ? m.account_have : m.account_want;
        facts.push(
          { k: 'What gets shared', v: 'first name + locality' },
          { k: 'For', v: await readersOwnThingLabel(m, accountId) },
          { k: 'Shared with', v: 'your matched counterparty' },
        );
        const cp = await newCounterpartyAnomaly(counterparty, 'stage3-disclosure');
        if (cp) anomalies.push(cp.text);
        // Nothing was ever asked for at sign-up, so the first time someone
        // gets here the page asks for the two things it is about to share.
        const own = await readSharedProfile(accountId, {
          purpose: 'stage3-approval-page',
          actor: accountId,
          refs: { match_id: refId },
        });
        if (!profileIsFilled(own)) collectProfile = { firstName: own.firstName, locality: own.locality };
      }
      return {
        action,
        refId,
        facts,
        anomalies,
        collectProfile,
        ...(await ceremonyFor(accountId, false)),
        postPath: '/approve',
      };
    };

    // ------------------------------------------------------------------
    // The one-question pages. One sentence, two buttons, the PIN ceremony
    // where identity or money moves. The link is bound to the exact figures
    // and ids the question names, and the PRESS is what consumes it — so the
    // page can be re-read, and a second press fails plainly.
    // ------------------------------------------------------------------
    const oneQuestionView = async (
      accountId: string,
      row: ApprovalLinkRow,
      token: string,
    ): Promise<pages.OneQuestionView | { error: string }> => {
      const figures = links.readPayload(row) ?? {};
      const base = {
        token,
        noLabel: 'Not now',
        // Elevation is stamped on by the caller, which has the session.
        ...(await ceremonyFor(accountId, false)),
      };
      if (row.action === 'offer-send') {
        const m = await getMatch(row.ref_id);
        if (!m || m.state !== 'open') return { error: 'This introduction is no longer open.' };
        try {
          sideOf(m, accountId);
        } catch {
          return { error: 'This introduction is not yours.' };
        }
        const other = m.account_want === accountId ? m.account_have : m.account_want;
        // The other person's first name, once they have both shared it. Before
        // that there is nobody to name, so the sentence says "the other side".
        const name =
          m.stage >= 3
            ? await ops.disclosedFirstName(
                accountId,
                other,
                { match_id: row.ref_id },
                'one-question-page',
              )
            : undefined;
        const figure = templateMoney(Number(figures.amount), String(figures.ccy ?? ''));
        const detail: string[] = [];
        if (figures.note) detail.push(`With your line: “${String(figures.note)}”.`);
        detail.push(
          'It binds nothing — either of you can still say no — and accepting anything comes back to a page like this one.',
        );
        return {
          ...base,
          question: `Send ${figure} to ${name ?? 'the other side'}${aboutThing(phrase(m.category), m.account_have === accountId ? 'have' : 'want')}?`,
          detail,
          yesLabel: 'Send',
          needsPin: true,
        };
      }
      if (row.action === 'offer-accept') {
        const r = await getPool().query(
          `SELECT o.*, m.category, m.stage, m.account_want, m.account_have FROM offers o
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
          return { error: `That figure is ${o.state} — there is nothing left to accept.` };
        }
        // The amount and currency come off the signed row, so the figure on the
        // page is the figure the link was minted for.
        const figure = templateMoney(Number(row.amount), String(row.ccy ?? ''));
        const name =
          o.stage >= 3
            ? await ops.disclosedFirstName(
                accountId,
                o.proposer_account,
                { match_id: o.match_id },
                'one-question-page',
              )
            : undefined;
        const detail: string[] = [];
        // Their agent has not weighed in on this one. The nudge offers a second
        // opinion; the figure is theirs to take now either way.
        if (o.state === 'proposed') {
          detail.push(
            'Want a second opinion first? Ask your assistant what it makes of the price — it can see the details.',
          );
        }
        detail.push('Accepting agrees the number, and your assistant takes it from there.');
        return {
          ...base,
          question: `${name ?? 'The other side'} ${o.account_have === accountId ? 'offers' : 'wants'} ${figure}${aboutThing(phrase(o.category), o.account_have === accountId ? 'have' : 'want')}.`,
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
          question: 'Share your first name and area with the other side?',
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
          question: `Your assistant has been talking with ${name ?? 'the other person'}'s assistant about ${theirThing(phrase(m.category), m.account_have === accountId ? 'have' : 'want')}. Keep the conversation going?`,
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
        'SELECT category, type FROM cards WHERE id = $1 AND account_id = $2',
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
        question: `Let your assistant negotiate the ${phrase(card.category)}: ${bits.join(', ')}?`,
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
        thing: phrase(m.category),
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
        // Not signed in: the link is NOT consumed; sign in and come back to it.
        return html(
          reply,
          pages.donePage(
            'Sign in to review this',
            '<p>Sign in, then open the link your assistant gave you again.</p>',
            '/login',
            'Sign in',
          ),
          401,
        );
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
        const q = await oneQuestionView(s.accountId, row, token);
        if ('error' in q) {
          return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(q.error)}</p>`));
        }
        q.elevated = sess.isElevated(s);
        return html(reply, pages.oneQuestionPage(q));
      }
      // A settlement approval burns on the PRESS, the way the one-question
      // pages do: this page is about money, and somebody who opens the link,
      // looks at the figures and comes back to it in the evening must not find
      // their own link dead because they read it once. The other two still
      // burn on the view, where opening the page IS the disclosure.
      const burnsOnPress = row.action === 'settlement-approve';
      if (!burnsOnPress) await consumeLink(row.id);
      const v = await approvalView(s.accountId, row.action, row.ref_id);
      if ('error' in v) return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
      v.elevated = sess.isElevated(s);
      if (burnsOnPress) v.linkToken = token;
      return html(reply, pages.approvalPage(v));
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
        return html(
          reply,
          pages.donePage(
            'Sign in to review this',
            '<p>Sign in, then open the link your assistant gave you again.</p>',
            '/login',
            'Sign in',
          ),
          401,
        );
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
                ? 'A price goes to your assistant, where your own limits are read first. Take the number out of that line and send the photo.'
                : why,
            ),
            400,
          );
        }
        const photoId = String(pb.photo_id ?? '');
        if (!photoId) {
          return html(reply, pages.photoPage(v, 'Pick a photo first.'), 400);
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
          pages.donePage(
            'Sent',
            `<p>${pages.esc(v.who)} picks it up through their own assistant. It is held here until they do and gone the moment they have it.</p>`,
          ),
        );
      }
      const b: any = req.body ?? {};
      const decision = String(b.decision ?? '');
      const q = await oneQuestionView(s.accountId, row, token);
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
        const okNow = await ceremony(s as Session, reply, String(b.pin ?? ''));
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
          return html(
            reply,
            pages.donePage('Accepted', '<p>The number is agreed. Your assistant takes it from here.</p>'),
          );
        }
        if (row.action === 'offer-send') {
          await proposeOffer(
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
          return html(
            reply,
            pages.donePage(
              'Shared',
              r.both
                ? '<p>Both of you have said yes. Your first name and area are with them now, and theirs with you.</p>'
                : '<p>Your go-ahead is recorded. Nothing goes over until the other side says yes too.</p>',
            ),
          );
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

    counter.get('/approvals/offer/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await approvalView(s.accountId!, 'offer-accept', String((req.params as any).id));
      if ('error' in v) return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
      v.elevated = sess.isElevated(s);
      return html(reply, pages.approvalPage(v));
    });

    counter.get('/approvals/match/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await approvalView(s.accountId!, 'stage3-disclosure', String((req.params as any).id));
      if ('error' in v) return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
      v.elevated = sess.isElevated(s);
      return html(reply, pages.approvalPage(v));
    });

    counter.get('/approvals/settlement/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await approvalView(s.accountId!, 'settlement-approve', String((req.params as any).id));
      if ('error' in v) return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
      v.elevated = sess.isElevated(s);
      return html(reply, pages.approvalPage(v));
    });

    counter.post('/approve', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const action = String(b.action ?? '');
      const refId = String(b.ref_id ?? '');
      const decision = String(b.decision ?? '');
      if (!['offer-accept', 'stage3-disclosure', 'settlement-approve'].includes(action) || !refId) {
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
            return html(reply, pages.donePage('Nothing to decide', '<p>This settlement has moved on.</p>'));
          }
          return html(
            reply,
            pages.donePage('Declined', '<p>Nothing was paid or promised. No reason was sent.</p>'),
          );
        }
        else await declineMatch(refId, s.accountId!, cfg);
        return html(
          reply,
          pages.donePage('Declined', '<p>Nothing was shared or accepted. No reason was sent.</p>'),
        );
      }
      if (decision !== 'approve') return reply.code(400).send({ error: 'bad_request' });
      // Approving a disclosure with an empty profile means saying, right here,
      // what gets shared. The boxes are checked BEFORE the PIN ceremony so a
      // typo in a suburb never costs a PIN attempt.
      let profileToSave: { firstName: string; locality: string } | undefined;
      if (action === 'stage3-disclosure') {
        const view = await approvalView(s.accountId!, 'stage3-disclosure', refId);
        if ('error' in view) {
          return html(reply, pages.donePage('Nothing to decide', `<p>${pages.esc(view.error)}</p>`));
        }
        if (view.collectProfile) {
          const checked = validateSharedProfile({
            firstName: b.first_name,
            locality: b.locality,
          });
          if (!checked.ok) {
            view.elevated = sess.isElevated(s);
            view.collectProfile = {
              firstName: String(b.first_name ?? ''),
              locality: String(b.locality ?? ''),
            };
            return html(reply, pages.approvalPage(view, checked.error), 400);
          }
          profileToSave = checked.value;
        }
      }
      // Sensitive action: PIN (or a passkey ceremony that elevated the session).
      const okNow = await ceremony(s, reply, String(b.pin ?? ''));
      if (!okNow) return;
      // The link this page came from, spent here rather than when the page was
      // opened. After the ceremony, so a mistyped PIN costs a retype and not
      // the link. Absent when the person came from their own approval page,
      // which is not a one-use road.
      const linkToken = String(b.link_token ?? '');
      if (linkToken) {
        const check = await verifyLinkToken(linkToken);
        if (!check.ok) {
          const why = check.reason === 'used' || check.reason === 'expired' ? check.reason : 'invalid';
          return html(reply, pages.linkDeadPage(why), why === 'invalid' ? 404 : 200);
        }
        const linkRow = check.row as ApprovalLinkRow;
        if (linkRow.account_id !== s.accountId || linkRow.ref_id !== refId) {
          return reply.code(400).send({ error: 'bad_request' });
        }
        if (!(await consumeLink(linkRow.id))) return html(reply, pages.linkDeadPage('used'));
      }
      try {
        if (profileToSave) await saveSharedProfile(s.accountId!, profileToSave, 'counter', cfg);
        if (action === 'settlement-approve') {
          const r = await settlements.approveSettlement(
            settlements.counterAction(s.accountId!),
            refId,
          );
          // Seller onboarding starts at first settlement approval: make sure
          // the connected account exists the moment the seller says yes.
          if (r.row.seller_account === s.accountId && settlementsConfigured(cfg)) {
            await ensureSellerStripeAccount(cfg, s.accountId!, r.row);
          }
          return reply.redirect(`/settlements/${refId}`, 303);
        }
        if (action === 'offer-accept') {
          await acceptOfferByHuman(refId, s.accountId!, 'counter', cfg);
          return html(
            reply,
            pages.donePage('Approved', '<p>The settlement is agreed. Your agent can take it from here.</p>'),
          );
        }
        const r = await recordStage3OptIn(cfg, refId, s.accountId!, 'counter');
        return html(
          reply,
          pages.donePage(
            'Approved',
            r.both
              ? '<p>Both of you have opted in — your first name and locality are now mutually shared on this match.</p>'
              : '<p>Your opt-in is recorded. Nothing is shared until the other side opts in too.</p>',
          ),
        );
      } catch (e) {
        // An empty profile at this point means the collection boxes were
        // skipped: send the person back to the page that asks for them.
        if (e instanceof OsbError && e.payload.code === 'CONSENT_REQUIRED') {
          return reply.redirect(`/approvals/match/${encodeURIComponent(refId)}`, 303);
        }
        // Collection window still open on the holder's card: explain, don't 500.
        if (e instanceof OsbError && e.payload.code === 'NOT_UNLOCKED_YET') {
          return html(
            reply,
            pages.donePage(
              'Not yet',
              `<p>${pages.esc(e.payload.human_action ?? 'This step is locked right now.')}</p>`,
              '/',
              'Back',
            ),
            409,
          );
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
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
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
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
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
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
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
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
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
    // The human-readable detail line for a card row: its own typed attributes.
    // With slugs culled from every page, this is what tells two same-category
    // cards apart ("Mountain bikes — condition: good · frame: large").
    const attrsSummary = (attrs: any): string | undefined =>
      attrs && Object.keys(attrs).length
        ? Object.entries(attrs)
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join(' · ')
        : undefined;

    // Screening's verdict for the card's OWN human, in plain words. Only a
    // card actually sitting in SCREENING_REJECTED says anything.
    const screeningRejectionView = (
      c: ops.LedgerCard,
    ): { plain: string; code?: string } | undefined => {
      if (c.lifecycle_state !== 'SCREENING_REJECTED') return undefined;
      const rej = rejectionInPlainWords(c.screening);
      return rej ? { plain: rej.plain, code: rej.reasonCode } : undefined;
    };

    const cardToView = (c: ops.LedgerCard): home.LedgerCardView => ({
      id: c.id,
      type: c.type,
      category: categoryLeafLabel(c.category),
      // Where the card is, then how far it reaches — the two things only the
      // person who lives there can tell are wrong.
      location: c.location ? `${c.location} — ${c.reach_line}` : undefined,
      state: c.lifecycle_state,
      status: c.protocol_status,
      expiresAt: new Date(c.expires_at).toISOString().slice(0, 10),
      priceBand: c.price?.band ? `${c.price.band.min}–${c.price.band.max} ${c.price.ccy ?? ''}`.trim() : undefined,
      ask: c.ask ? `${c.ask.amount} ${c.ask.ccy ?? ''}`.trim() : undefined,
      matchSummary: c.matchCount === 0 ? 'no matches yet' : `${c.matchCount} match${c.matchCount === 1 ? '' : 'es'}`,
      attributes: attrsSummary(c.attributes),
      mode: c.negotiation_mode,
    });

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
      return html(reply, home.ledgerPage(cards.map(cardToView), undefined, past));
    });

    counter.get('/ledger/:id/edit', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const cards = await ops.ledgerCards(cfg, s.accountId!);
      const c = cards.find((x) => x.id === String((req.params as any).id));
      if (!c) return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      return html(
        reply,
        home.cardEditPage({
          id: c.id,
          type: c.type,
          category: categoryLeafLabel(c.category),
          urgency: c.urgency,
          status: c.protocol_status,
          ttlDays: c.ttl_days,
          attributesJson: JSON.stringify(c.attributes ?? {}, null, 2),
          askAmount: c.ask?.amount != null ? String(c.ask.amount) : undefined,
          askCcy: c.ask?.ccy,
          bandMin: c.price?.band?.min != null ? String(c.price.band.min) : undefined,
          bandMax: c.price?.band?.max != null ? String(c.price.band.max) : undefined,
          bandCcy: c.price?.ccy,
          slots: c.slots ?? 1,
          screeningRejection: screeningRejectionView(c),
        }),
      );
    });

    counter.post('/ledger/:id/edit', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const id = String((req.params as any).id);
      const b: any = req.body ?? {};
      let attributes: any;
      try {
        attributes = b.attributes ? JSON.parse(b.attributes) : {};
      } catch {
        const cards = await ops.ledgerCards(cfg, s.accountId!);
        const c = cards.find((x) => x.id === id);
        if (!c) return html(reply, pages.messagePage('Not found', '<p>No such card.</p>'), 404);
        return html(
          reply,
          home.cardEditPage(
            {
              id,
              type: c.type,
              category: categoryLeafLabel(c.category),
              urgency: c.urgency,
              status: c.protocol_status,
              ttlDays: c.ttl_days,
              attributesJson: String(b.attributes ?? ''),
              slots: c.slots ?? 1,
              screeningRejection: screeningRejectionView(c),
            },
            'Attributes must be valid JSON.',
          ),
          400,
        );
      }
      const patch: any = {
        attributes,
        urgency: b.urgency || 'none',
        status: b.status === 'latent' ? 'latent' : 'active',
        ttl_days: Math.max(1, Math.min(365, Number(b.ttl_days) || 60)),
      };
      if (b.ask_amount) {
        patch.ask = { amount: Number(b.ask_amount), ccy: String(b.ask_ccy || 'AUD').toUpperCase() };
      }
      if (b.band_min && b.band_max) {
        patch.price = {
          band: { min: Number(b.band_min), max: Number(b.band_max) },
          ccy: String(b.band_ccy || 'AUD').toUpperCase(),
        };
      }
      try {
        await amendIntent(cfg, s.accountId!, id, patch);
      } catch (e: any) {
        // A refusal that is the switchboard working carries a sentence; an
        // OsbError's own `message` is the bare code, and a person editing
        // their own card should never be shown one. (The way in: setting an
        // asking price on a sale by best offer, where the floor is private —
        // domain/cards.ts.)
        const said = e?.payload?.human_action ?? e?.message ?? 'invalid card';
        return html(
          reply,
          pages.messagePage('Could not save', `<p>${pages.esc(said)}</p>`, `/ledger/${id}/edit`, 'Back to editing'),
          400,
        );
      }
      return html(
        reply,
        home.ledgerPage((await ops.ledgerCards(cfg, s.accountId!)).map(cardToView), 'Saved. The card is back in screening before it returns to the network.'),
      );
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
      if (!v) return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      return html(reply, home.cardNumbersPage(v));
    });

    counter.post('/ledger/:id/numbers', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const id = String((req.params as any).id);
      const v = await numbersView(s.accountId!, id, s);
      if (!v) return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
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
      const notice = `Saved. This card negotiates on ${MODE_NAMES[mode]}.`;
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
      if (!v) return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      await saveNegotiation(s.accountId!, id, { mode: 'relay', mandate: null }, 'counter');
      const saved = await numbersView(s.accountId!, id, s);
      return html(
        reply,
        home.cardNumbersPage(
          saved!,
          undefined,
          `Cleared. This card is back on ${MODE_NAMES.relay} — every figure comes from you.`,
        ),
      );
    });

    // ------------------------------------------------------------------
    // 1.E: the offers on one match, and the box where this person types the
    // next figure. Sending one is the human acting, so it needs a signed-in
    // session — and no more than that, because a proposal binds nothing.
    // Accepting one still asks for the PIN, on /approve.
    // ------------------------------------------------------------------
    const offersView = async (
      accountId: string,
      matchId: string,
      sess0: Session,
    ): Promise<home.MatchOffersView | undefined> => {
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
        ...(neg.mandate ? { mandate: neg.mandate } : {}),
        ...(live ? { myOfferOnTable: `${Number(live.amount)} ${live.ccy}` } : {}),
        ...(agreed ? { agreedAmount: `${Number(agreed.amount)} ${agreed.ccy}` } : {}),
        ...(draft ? { draft: draftToFields(draft) } : {}),
        ...(verdict ? { verdict } : {}),
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
      if (!v) return html(reply, pages.messagePage('Not found', '<p>No such match on your ledger.</p>'), 404);
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
      if (!v) return html(reply, pages.messagePage('Not found', '<p>No such match on your ledger.</p>'), 404);
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

      try {
        await proposeOffer(
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
        home.matchOffersPage(after!, undefined, 'Sent. Your number is on the table for the other side.'),
      );
    });

    counter.post('/ledger/:id/withdraw', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      try {
        await withdrawIntent(s.accountId!, String((req.params as any).id), cfg);
      } catch {
        return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      }
      return html(
        reply,
        home.ledgerPage((await ops.ledgerCards(cfg, s.accountId!)).map(cardToView), 'Withdrawn — effective immediately.'),
      );
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
        ...(await ceremonyFor(accountId, sess.isElevated(s))),
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
      // Sensitive action: PIN (or a passkey ceremony that elevated the session).
      const okNow = await ceremony(s, reply, String(b.pin ?? ''));
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
      if (!rateLimitBypassed(req.headers as any) && areaSuggestLimiter.limited(req.ip)) {
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
      return html(
        reply,
        home.sharedProfilePage(checked.value, {
          notice: 'Saved. This is what a match sees once you both say yes.',
        }),
      );
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
      return html(reply, home.arrangementPage(v.arrangement, { updated: v.updated }));
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
        return html(
          reply,
          home.arrangementPage(submitted as any, { error: checked.error }),
          400,
        );
      }
      await saveArrangement(s.accountId!, checked.value, 'counter');
      return html(
        reply,
        home.arrangementPage(checked.value, {
          notice: 'Saved. Every agent you have connected picks this up on its next check.',
        }),
      );
    });

    counter.post('/arrangement/clear', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      await saveArrangement(s.accountId!, {}, 'counter');
      return html(
        reply,
        home.arrangementPage(
          {},
          { notice: 'Cleared. Your agents will ask you afresh how you want this to go.' },
        ),
      );
    });

    // ------------------------------------------------------------------
    // Settings: email frequency controls + blind mode (0.E). Every change
    // is effective immediately (the send pipeline reads the account row at
    // send time) and writes to the WORM consent log first.
    // ------------------------------------------------------------------
    const settingsView = async (accountId: string): Promise<home.EmailSettingsView> => {
      const [es, hearsVia, timezone] = await Promise.all([
        ops.emailSettings(accountId),
        getHearsVia(accountId),
        getTimezone(accountId),
      ]);
      return {
        hearsVia,
        timezone,
        blindMode: es.blindMode,
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
      return html(
        reply,
        home.settingsPage(
          await settingsView(s.accountId!),
          want === 'assistant'
            ? 'Saved. Match and reply emails are off.'
            : 'Saved. Matches and replies reach you by email.',
        ),
      );
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
      return html(
        reply,
        home.settingsPage(
          await settingsView(s.accountId!),
          `Saved. Your assistant says times in ${tz.replace(/_/g, ' ')}.`,
        ),
      );
    });

    counter.post('/settings/blind-mode', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const on = String((req.body as any)?.blind_mode ?? '') === 'on';
      await ops.setBlindMode(s.accountId!, on);
      return html(
        reply,
        home.settingsPage(
          await settingsView(s.accountId!),
          on ? 'Blind mode is on: emails become content-free pointers.' : 'Blind mode is off.',
        ),
      );
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
      return html(
        reply,
        home.settingsPage(await settingsView(s.accountId!), 'Saved. Effective immediately.'),
      );
    });

    counter.post('/settings/email-resume', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      await ops.resumeNonTransactionalEmail(s.accountId!);
      return html(
        reply,
        home.settingsPage(await settingsView(s.accountId!), 'Email is back on.'),
      );
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
          pages.messagePage('Nothing to renew', '<p>No open cards on your ledger right now.</p>', '/', 'Back'),
        );
      }
      return html(
        reply,
        home.renewPage(
          cards.rows.map((c: any) => ({
            type: c.type,
            category: categoryLeafLabel(c.category),
            attributes: attrsSummary(c.attributes),
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
          `<p>${renewed.length} card${renewed.length === 1 ? '' : 's'} renewed — each clock
restarted for its own TTL. The renewal is in your consent log.</p>`,
          '/ledger',
          'Open the ledger',
        ),
      );
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
      if (!rateLimitBypassed(req.headers as Record<string, unknown>) && verificationEmailLimiter.limited(req.ip)) {
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
        return html(reply, pages.messagePage('Nothing to authorize', '<p>No authorization request is pending.</p>'));
      }
      const v = await validateAuthorizeRequest(ctx);
      if (v.error) {
        return reply.code(400).type('text/plain').send(`invalid authorization request: ${v.error}`);
      }
      if (!s) s = await sess.createSession(reply, null);
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
          await ceremonyFor(s.accountId, sess.isElevated(s as Session), a),
          ctx.redirect_uri,
        ),
      );
    });

    counter.post('/authorize', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const ctx = s.oauthCtx;
      if (!ctx?.client_id) {
        return html(reply, pages.messagePage('Nothing to authorize', '<p>No authorization request is pending.</p>'), 400);
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
      // Handing an agent a key is a sensitive action. The pending request is
      // cleared only once the ceremony is through, so a wrong PIN leaves the
      // person on a page that still knows what they were being asked.
      const okNow = await ceremony(s, reply, String((req.body as any)?.pin ?? ''));
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
