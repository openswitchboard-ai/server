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
import { rateLimitBypassed, verificationEmailLimiter } from '../abuseLimit.js';
import { getPool } from '../db.js';
import { getAccount, findAccountByEmail } from '../domain/accounts.js';
import {
  arrangementInPlainWords,
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
  closeCollectionByCard,
  declineMatch,
  getMatch,
  recordStage3OptIn,
  recordVerdict,
  sideOf,
} from '../domain/matches.js';
import { categoryLeafLabel, defaultCollectWindowMinutes } from '../domain/matchRules.js';
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
import { OsbError } from '../protocol.js';
import * as ops from '../domain/counterOps.js';
import * as agentKeys from '../domain/agentKeys.js';
import * as settlements from '../domain/settlements.js';
import {
  cancelPaymentForSettlement,
  capturePaymentForSettlement,
  checkoutUrlForSettlement,
  ensureSellerStripeAccount,
  sellerAccountReady,
  sellerOnboardingLink,
  sellerStripeAccountId,
} from '../domain/settlementStripe.js';
import {
  evidenceViewLinks,
  presignEvidenceUpload,
  writeEvidenceManifest,
} from '../domain/evidence.js';
import { settlementsConfigured } from '../config.js';
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
import { verifyEmailToken } from '../email/tokens.js';
import { emailHash } from '../domain/accounts.js';
import { consumeLink, verifyLinkToken, type ApprovalLinkRow } from './links.js';
import { offerAmountAnomaly, newCounterpartyAnomaly } from './anomalies.js';
import * as wa from './webauthn.js';
import { PATCH_FAVICON_PNG, PATCH_HEADER_PNG } from './patchAsset.js';
import type { Config } from '../config.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Every registered human-page route (method + url), recorded at registration
 *  time so the isolation test can enumerate the ENTIRE route class. */
export const COUNTER_ROUTE_TABLE: { method: string; url: string }[] = [];

type Session = NonNullable<Awaited<ReturnType<typeof sess.loadSession>>>;

export function registerCounterRoutes(app: FastifyInstance, cfg: Config): void {
  const mcpHost = new URL(cfg.publicOrigin).host;

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
    });

    const html = (reply: FastifyReply, body: string, code = 200) =>
      reply.code(code).type('text/html').send(body);

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
      return s as Session;
    };

    const nextStep = async (accountId: string, s: Session): Promise<string> => {
      const a: any = await getAccount(accountId);
      if (!a) return '/login';
      if (!a.pin_hash) return '/pin';
      if (a.status === 'pending') return '/consent';
      if (s.oauthCtx) return '/authorize';
      return '/';
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
      if (!a.pin_hash || a.status === 'pending') {
        return reply.redirect(await nextStep(s.accountId, s as Session), 303);
      }
      const [profile, arrangement, offers, disclosures, verdictable, windows, counts, liveSettlements, rejected, lapsingSoon] = await Promise.all([
        readSharedProfile(s.accountId, { purpose: 'dashboard-view', actor: s.accountId }),
        readArrangement(s.accountId),
        ops.pendingOffers(s.accountId),
        ops.pendingDisclosures(s.accountId),
        ops.verdictableMatches(s.accountId),
        ops.openCollectionWindows(s.accountId),
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
      ]);
      const pendingApprovals = [
        // A card screening turned away is off the board until this person
        // changes it, so it sits at the top of what is waiting for them.
        ...rejected.map((c) => ({
          href: `/ledger/${c.id}/edit`,
          // The card says what happened; the button below it says what to do,
          // so the label no longer says both.
          label: `Your ${categoryLeafLabel(c.category)} card didn't pass screening`,
          cta: 'See why and fix it',
        })),
        ...offers.map((o) => ({
          href: `/approvals/offer/${o.offer_id}`,
          label: `Offer on your ${categoryLeafLabel(o.category)} match`,
          amount: `${Number(o.amount)} ${o.ccy}`,
        })),
        ...disclosures.map((d) => ({
          href: `/approvals/match/${d.match_id}`,
          label: `Share your details on your ${categoryLeafLabel(d.category)} match?`,
        })),
        ...liveSettlements.rows.map((st: any) => {
          const mine = st.buyer_account === s.accountId ? st.buyer_approved_at : st.seller_approved_at;
          const needsApproval =
            !mine && ['proposed', 'approved-by-buyer', 'approved-by-seller'].includes(st.state);
          return {
            href: needsApproval
              ? `/approvals/settlement/${st.id}`
              : `/settlements/${st.id}`,
            label: `Settlement on your ${categoryLeafLabel(st.category)} match (${st.state})`,
            amount: `${Number(st.amount)} ${st.ccy}`,
          };
        }),
      ];
      return html(
        reply,
        home.dashboardPage({
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
          cardCounts: counts.rows[0],
          ...(lapsingSoon ? { lapsingSoon } : {}),
          pendingApprovals,
          matches: verdictable.map((m) => ({
            matchId: m.match_id,
            category: categoryLeafLabel(m.category),
            score: Number(m.score),
            verdict: m.verdict ?? undefined,
          })),
          collectionWindows: windows.map((w) => ({
            cardId: w.card_id,
            category: categoryLeafLabel(w.category),
            type: w.type,
            until: new Date(w.until).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
            interestedParties: w.interested_parties,
          })),
        }),
      );
    });

    counter.post('/logout', async (req, reply) => {
      await sess.destroySession(req, reply);
      return reply.redirect('/', 303);
    });

    // ------------------------------------------------------------------
    // Registration: email -> code -> PIN -> optional passkey -> consent.
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
      let account: any = await findAccountByEmail(result.email!);
      if (!account) {
        if (result.purpose === 'register') {
          if (cfg.registrationMode === 'closed') return html(reply, pages.registrationClosedPage());
          account = { id: (await ops.createPendingAccount(result.email!)).id };
        } else {
          return html(
            reply,
            pages.messagePage(
              'No account for that email',
              `<p>There is no account under that address yet.</p>`,
              '/register',
              'Open an account',
            ),
            404,
          );
        }
      }
      const existing = await sess.loadSession(req);
      let s: Session;
      if (existing) {
        await sess.attachAccount(existing.id, account.id);
        s = { ...existing, accountId: account.id } as Session;
      } else {
        s = (await sess.createSession(reply, account.id)) as Session;
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
    // PIN.
    // ------------------------------------------------------------------
    counter.get('/pin', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      return html(reply, pages.pinSetPage());
    });

    counter.post('/pin/set', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const pin = String(b.pin ?? '');
      if (!pinFormatOk(pin)) {
        return html(reply, pages.pinSetPage('The PIN must be 6 to 12 digits.'), 400);
      }
      if (pin !== String(b.pin2 ?? '')) {
        return html(reply, pages.pinSetPage('The two entries did not match.'), 400);
      }
      const a: any = await getAccount(s.accountId!);
      if (a?.pin_hash && !sess.isElevated(s)) {
        // Changing an existing PIN needs a fresh PIN/passkey ceremony first.
        return html(
          reply,
          pages.messagePage(
            'Confirm it is you',
            '<p>To change your PIN, approve with your current PIN or passkey first.</p>',
          ),
          403,
        );
      }
      await ops.setAccountPin(s.accountId!, await hashPin(pin));
      if (a?.pin_hash) {
        // 0.E security notice: an EXISTING PIN was just changed.
        const email = await ops.accountEmail(s.accountId!, 'security-notice');
        if (email) await notifyBestEffort(req, 'pin-changed', () => sendSecurityNoticeEmail(cfg, email, s.accountId!, 'pin-changed'));
      }
      if (a?.status === 'pending') return reply.redirect('/passkey', 303);
      return reply.redirect('/', 303);
    });

    // ------------------------------------------------------------------
    // Passkeys: enrolment (registration ceremony) + skip.
    // ------------------------------------------------------------------
    counter.get('/passkey', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      return html(reply, pages.passkeyOfferPage());
    });

    counter.post('/passkey/options', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const options = await wa.registrationOptions(cfg, s.accountId!, 'OpenSwitchboard account');
      await sess.setWebauthnChallenge(s.id, options.challenge);
      return reply.send(options);
    });

    counter.post('/passkey/verify', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const challenge = await sess.takeWebauthnChallenge(s.id);
      if (!challenge) return reply.code(400).send({ error: 'no_pending_challenge' });
      await wa.verifyRegistration(cfg, s.accountId!, challenge, req.body);
      return reply.send({ ok: true });
    });

    counter.post('/passkey/skip', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      return reply.redirect('/consent', 303);
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
      if (!a?.pin_hash) return reply.redirect('/pin', 303);
      if (a.status === 'pending') {
        await ops.activateAccountWithConsent(s.accountId!, pages.CONSENT_STATEMENT);
      }
      return reply.redirect(s.oauthCtx ? '/authorize' : '/', 303);
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
      if (b.elevate_only) {
        if (s.accountId !== accountId) return reply.code(403).send({ error: 'wrong_account' });
      } else {
        await sess.attachAccount(s.id, accountId);
      }
      // A successful passkey ceremony is a sensitive-action ceremony.
      await sess.elevateSession(s.id, PIN_ELEVATION_MINUTES);
      const next = await nextStep(accountId, { ...s, accountId } as Session);
      return reply.send({ ok: true, next });
    });

    // ------------------------------------------------------------------
    // PIN ceremony endpoint (elevation for sensitive actions).
    // ------------------------------------------------------------------
    const pinCeremony = async (
      s: Session,
      reply: FastifyReply,
      pin: string,
    ): Promise<boolean> => {
      if (sess.isElevated(s)) return true;
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
      const okNow = await pinCeremony(s, reply, String((req.body as any)?.pin ?? ''));
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
      let counterOffer: pages.ApprovalView['counterOffer'];
      let draft: pages.ApprovalView['draft'];
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
        facts.push(
          {
            k: party === 'buyer' ? 'You would pay' : 'You would be paid',
            v: `${Number(s.amount)} ${s.ccy}`,
          },
          { k: 'For', v: m ? categoryLeafLabel(m.category) : 'your match' },
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
        if (o.state !== 'awaiting-human') return { error: `This offer is ${o.state} — nothing to decide.` };
        facts.push(
          { k: 'You are agreeing to', v: `${Number(o.amount)} ${o.ccy}` },
          { k: 'For', v: categoryLeafLabel(o.category) },
          { k: 'Offer expires', v: new Date(o.expiry).toUTCString() },
        );
        // The third door out of this page: answer with a figure of your own,
        // opened on the number their agent already tried to send if it has one.
        counterOffer = { matchId: o.match_id, ccy: o.ccy };
        const carried = await newestOfferDraft(accountId, o.match_id);
        if (carried) draft = draftToFields(carried);
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
          { k: 'For', v: categoryLeafLabel(m.category) },
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
        counterOffer,
        draft,
        hasPasskey: await wa.accountHasPasskey(accountId),
        elevated: false,
        postPath: '/approve',
      };
    };

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
      if (!s?.accountId || s.accountId !== row.account_id) {
        // Not signed in (or wrong account): the link is NOT consumed; sign in
        // and come back to it.
        return html(
          reply,
          pages.messagePage(
            'Sign in to review this',
            '<p>Sign in, then open the link from your email again.</p>',
            '/login',
            'Sign in',
          ),
          401,
        );
      }
      await consumeLink(row.id); // single-use: burns on first authenticated view
      const v = await approvalView(s.accountId, row.action, row.ref_id);
      if ('error' in v) return html(reply, pages.messagePage('Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
      v.elevated = sess.isElevated(s);
      return html(reply, pages.approvalPage(v));
    });

    counter.get('/approvals/offer/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await approvalView(s.accountId!, 'offer-accept', String((req.params as any).id));
      if ('error' in v) return html(reply, pages.messagePage('Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
      v.elevated = sess.isElevated(s);
      return html(reply, pages.approvalPage(v));
    });

    counter.get('/approvals/match/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await approvalView(s.accountId!, 'stage3-disclosure', String((req.params as any).id));
      if ('error' in v) return html(reply, pages.messagePage('Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
      v.elevated = sess.isElevated(s);
      return html(reply, pages.approvalPage(v));
    });

    counter.get('/approvals/settlement/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await approvalView(s.accountId!, 'settlement-approve', String((req.params as any).id));
      if ('error' in v) return html(reply, pages.messagePage('Nothing to decide', `<p>${pages.esc(v.error)}</p>`));
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
            return html(reply, pages.messagePage('Nothing to decide', '<p>This settlement has moved on.</p>'));
          }
          return html(
            reply,
            pages.messagePage('Declined', '<p>Nothing was paid or promised. No reason was sent.</p>'),
          );
        }
        else await declineMatch(refId, s.accountId!);
        return html(
          reply,
          pages.messagePage('Declined', '<p>Nothing was shared or accepted. No reason was sent.</p>'),
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
          return html(reply, pages.messagePage('Nothing to decide', `<p>${pages.esc(view.error)}</p>`));
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
      const okNow = await pinCeremony(s, reply, String(b.pin ?? ''));
      if (!okNow) return;
      try {
        if (profileToSave) await saveSharedProfile(s.accountId!, profileToSave, 'counter');
        if (action === 'settlement-approve') {
          const r = await settlements.approveSettlement(
            settlements.counterAction(s.accountId!),
            refId,
          );
          // Seller onboarding starts at first settlement approval: make sure
          // the connected account exists the moment the seller says yes.
          if (r.row.seller_account === s.accountId && settlementsConfigured(cfg)) {
            await ensureSellerStripeAccount(cfg, s.accountId!, refId);
          }
          return reply.redirect(`/settlements/${refId}`, 303);
        }
        if (action === 'offer-accept') {
          await acceptOfferByHuman(refId, s.accountId!, 'counter');
          return html(
            reply,
            pages.messagePage('Approved', '<p>The settlement is agreed. Your agent can take it from here.</p>'),
          );
        }
        const r = await recordStage3OptIn(cfg, refId, s.accountId!, 'counter');
        return html(
          reply,
          pages.messagePage(
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
            pages.messagePage(
              'Not yet',
              `<p>${pages.esc(e.payload.human_action ?? 'This step is locked right now.')}</p>`,
              '/',
              'Back to your approval page',
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
      const showEvidence = ['evidence-locked', 'confirmed', 'disputed', 'released', 'refunded'].includes(row.state);
      const myApproval = role === 'buyer' ? row.buyer_approved_at : row.seller_approved_at;
      return {
        id: row.id,
        role,
        state: row.state,
        amount: `${Number(row.amount)} ${row.ccy}`,
        category: m ? categoryLeafLabel(m.category) : 'your match',
        descriptionText: row.description?.text,
        myApprovalPending:
          !myApproval && ['proposed', 'approved-by-buyer', 'approved-by-seller'].includes(row.state),
        canPay,
        needsPaymentSetup,
        canLockEvidence: role === 'seller' && row.state === 'funded',
        canConfirm: role === 'buyer' && row.state === 'evidence-locked',
        canDispute: ['funded', 'evidence-locked'].includes(row.state),
        evidence: showEvidence ? await evidenceViewLinks(cfg, row.id) : [],
        hasPasskey: await wa.accountHasPasskey(accountId),
        elevated,
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

    // Buyer starts the hosted payment. The card page is Stripe's; the money
    // is authorised and HELD (manual capture) with the seller as destination.
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
      const url = await checkoutUrlForSettlement(cfg, found.row, sellerId);
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
      const acctId = await ensureSellerStripeAccount(cfg, s.accountId!, found.row.id);
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
      await settlements.lockEvidence(settlements.counterAction(s.accountId!), found.row.id, manifestKey);
      for (const [accountId, role] of [
        [found.row.buyer_account, 'buyer'],
        [found.row.seller_account, 'seller'],
      ] as const) {
        const email = await ops.accountEmail(accountId, 'settlement-confirm-request-notification');
        if (email) {
          await notifyBestEffort(req, 'confirm-receipt-request', () =>
            sendSettlementEmail(cfg, {
              to: email,
              accountId,
              template: 'confirm-receipt-request',
              settlementId: found.row.id,
              role,
            }),
          );
        }
      }
      return reply.redirect(`/settlements/${found.row.id}`, 303);
    });

    // Buyer confirms receipt (PIN/passkey ceremony) — this is what releases
    // the held payment: the same signed request starts the capture, and the
    // 'released' state lands when Stripe's webhook reports it.
    counter.post('/settlements/:id/confirm', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      const okNow = await pinCeremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (!okNow) return;
      try {
        const row = await settlements.confirmReceipt(settlements.counterAction(s.accountId!), found.row.id);
        await capturePaymentForSettlement(row);
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
      return html(
        reply,
        pages.messagePage(
          'Receipt confirmed',
          '<p>The held payment is on its way to the seller. Both of you get an email when it lands.</p>',
        ),
      );
    });

    // Either human disputes: the held payment goes BACK to the buyer (the
    // safe direction). Like a decline, no reason is carried.
    counter.post('/settlements/:id/dispute', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const found = await loadSettlementFor(s.accountId!, String((req.params as any).id));
      if (!found) return settlementNotFound(reply);
      try {
        const row = await settlements.openDispute(settlements.counterAction(s.accountId!), found.row.id);
        await cancelPaymentForSettlement(row);
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
      return html(
        reply,
        pages.messagePage(
          'Disputed',
          '<p>The held payment goes back to the buyer in full. No reason was sent.</p>',
        ),
      );
    });

    // ------------------------------------------------------------------
    // 0.F: one-tap match-quality verdicts + collection-window early close.
    // ------------------------------------------------------------------
    counter.post('/verdict', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const verdict = String(b.verdict ?? '');
      if (verdict !== 'good-call' && verdict !== 'not-for-me') {
        return reply.code(400).send({ error: 'bad_request' });
      }
      try {
        await recordVerdict(String(b.match_id ?? ''), s.accountId!, verdict as any, 'counter');
      } catch {
        return html(reply, pages.messagePage('Not found', '<p>No such match on your ledger.</p>'), 404);
      }
      return reply.redirect('/', 303);
    });

    counter.post('/collect/:cardId/close', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      try {
        await closeCollectionByCard(String((req.params as any).cardId), s.accountId!, 'counter');
      } catch {
        return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      }
      return reply.redirect('/', 303);
    });

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
          collectWindowMinutes:
            c.collect_window_minutes != null ? String(c.collect_window_minutes) : undefined,
          collectWindowDefault: defaultCollectWindowMinutes(c.urgency),
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
              collectWindowDefault: defaultCollectWindowMinutes(c.urgency),
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
      // Collection-window override: only SHORTER than the urgency default.
      if (b.collect_window !== undefined) {
        const raw = String(b.collect_window).trim();
        const dflt = defaultCollectWindowMinutes(patch.urgency);
        const mins = raw === '' ? null : Math.floor(Number(raw));
        if (mins !== null && (!Number.isFinite(mins) || mins < 1 || mins > dflt)) {
          return html(
            reply,
            pages.messagePage(
              'Could not save',
              `<p>The collection window may only be shortened: 1–${dflt} minutes for this card.</p>`,
              `/ledger/${id}/edit`,
              'Back to editing',
            ),
            400,
          );
        }
        await ops.setCollectWindowOverride(s.accountId!, id, mins);
      }
      try {
        await amendIntent(cfg, s.accountId!, id, patch);
      } catch (e: any) {
        return html(
          reply,
          pages.messagePage('Could not save', `<p>${pages.esc(e?.message ?? 'invalid card')}</p>`, `/ledger/${id}/edit`, 'Back to editing'),
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
      };
    };

    counter.get('/ledger/:id/numbers', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await numbersView(s.accountId!, String((req.params as any).id));
      if (!v) return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      return html(reply, home.cardNumbersPage(v));
    });

    counter.post('/ledger/:id/numbers', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const id = String((req.params as any).id);
      const v = await numbersView(s.accountId!, id);
      if (!v) return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      const b: any = req.body ?? {};
      const mode: NegotiationMode = b.mode === 'mandate' ? 'mandate' : 'relay';
      const form = {
        open: String(b.open ?? ''),
        limit: String(b.limit ?? ''),
        step: String(b.step ?? ''),
        ccy: String(b.ccy ?? ''),
      };
      const wroteNumbers = [form.open, form.limit, form.step, form.ccy].some((x) => x.trim() !== '');

      // Switching to Auto-negotiate without numbers is the one combination
      // that cannot stand: it would leave an agent inside a box with no walls.
      if (mode === 'mandate' && !wroteNumbers && !v.mandate) {
        return html(
          reply,
          home.cardNumbersPage(
            { ...v, mode, form },
            'Auto-negotiate needs your numbers. Write at least a limit and a currency.',
          ),
          400,
        );
      }
      let mandate: ReturnType<typeof validateMandate> | undefined;
      if (wroteNumbers) {
        mandate = validateMandate(form, v.type);
        if (!mandate.ok) {
          return html(reply, home.cardNumbersPage({ ...v, mode, form }, mandate.error), 400);
        }
      }
      await saveNegotiation(
        s.accountId!,
        id,
        { mode, ...(mandate?.ok ? { mandate: mandate.value } : {}) },
        'counter',
      );
      const saved = await numbersView(s.accountId!, id);
      return html(
        reply,
        home.cardNumbersPage(
          saved!,
          undefined,
          `Saved. This card negotiates on ${MODE_NAMES[mode]}.`,
        ),
      );
    });

    counter.post('/ledger/:id/numbers/clear', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const id = String((req.params as any).id);
      const v = await numbersView(s.accountId!, id);
      if (!v) return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      await saveNegotiation(s.accountId!, id, { mode: 'relay', mandate: null }, 'counter');
      const saved = await numbersView(s.accountId!, id);
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
    ): Promise<home.MatchOffersView | undefined> => {
      const m = await ops.matchForHuman(accountId, matchId);
      if (!m) return undefined;
      const offers = await ops.offersOnMatch(matchId);
      const draft = await newestOfferDraft(accountId, matchId);
      const blocked =
        m.state !== 'open'
          ? 'This match is closed, so no more figures can go across it.'
          : m.stage < 2
            ? 'Offers open once both sides have shown interest.'
            : undefined;
      return {
        matchId,
        cardId: m.card_id,
        category: categoryLeafLabel(m.category),
        type: m.card_type,
        mode: m.negotiation_mode,
        canOffer: !blocked,
        canOfferBlockedBecause: blocked,
        ...(draft ? { draft: draftToFields(draft) } : {}),
        offers: offers.map((o) => ({
          amount: `${Number(o.amount)} ${o.ccy}`,
          mine: o.proposer_account === accountId,
          state: o.state,
          authoredByMe: o.proposer_account === accountId ? o.authored_by : undefined,
          note: o.message?.text,
          expires: new Date(o.expiry).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
        })),
      };
    };

    counter.get('/matches/:id', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const v = await offersView(s.accountId!, String((req.params as any).id));
      if (!v) return html(reply, pages.messagePage('Not found', '<p>No such match on your ledger.</p>'), 404);
      return html(reply, home.matchOffersPage(v));
    });

    counter.post('/matches/:id/offer', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const matchId = String((req.params as any).id);
      const v = await offersView(s.accountId!, matchId);
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
      const after = await offersView(s.accountId!, matchId);
      return html(
        reply,
        home.matchOffersPage(after!, undefined, 'Sent. Your number is on the table for the other side.'),
      );
    });

    counter.post('/ledger/:id/withdraw', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      try {
        await withdrawIntent(s.accountId!, String((req.params as any).id));
      } catch {
        return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      }
      return html(
        reply,
        home.ledgerPage((await ops.ledgerCards(cfg, s.accountId!)).map(cardToView), 'Withdrawn — effective immediately.'),
      );
    });

    // ------------------------------------------------------------------
    // Kill switch: one tap on; login + PIN off.
    // ------------------------------------------------------------------
    counter.post('/kill', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      await ops.killSwitchOn(s.accountId!);
      const email = await ops.accountEmail(s.accountId!, 'kill-switch-confirmation');
      if (email) await notifyBestEffort(req, 'kill-switch-on', () => sendKillSwitchEmail(cfg, email, s.accountId!, true));
      return reply.redirect('/', 303);
    });

    counter.post('/kill/off', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const okNow = await pinCeremony(s, reply, String((req.body as any)?.pin ?? ''));
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
      const when = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : undefined);
      return {
        keys: keys.map((k) => ({
          keyId: k.keyId,
          name: k.name,
          created: when(k.createdAt)!,
          lastUsed: when(k.lastUsedAt),
          expires: when(k.expiresAt)!,
        })),
        elevated: sess.isElevated(s),
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
      const okNow = await pinCeremony(s, reply, String(b.pin ?? ''));
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
          expires: made.row.expiresAt.toISOString().slice(0, 10),
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
      await saveSharedProfile(s.accountId!, checked.value, 'counter');
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
        d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : undefined,
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
      const es = await ops.emailSettings(accountId);
      return {
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
          pages.messagePage('Nothing to renew', '<p>No open cards on your ledger right now.</p>', '/', 'To your approval page'),
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
      if (!a || emailHash(result.email!) !== a.email_hash) {
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
      if (!a?.pin_hash || a.status === 'pending') {
        return reply.redirect(await nextStep(s.accountId, s as Session), 303);
      }
      return html(
        reply,
        pages.authorizePage(v.client!.client_name, '/authorize', {}),
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
      await sess.setOauthCtx(s.id, null);
      const target = new URL(ctx.redirect_uri);
      if (String((req.body as any)?.decision ?? '') !== 'approve') {
        target.searchParams.set('error', 'access_denied');
        if (ctx.state) target.searchParams.set('state', ctx.state);
        return reply.redirect(target.toString(), 303);
      }
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
      // Loopback callbacks get the handoff page: it delivers the code to the
      // local listener itself, and shows the code for copy-back when no
      // listener answers (some CLIs print the link and exit). Real https
      // redirects proceed untouched.
      const isLoopback = ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname);
      if (isLoopback) {
        return html(
          reply,
          pages.loopbackHandoffPage({
            callbackUrl: target.toString(),
            code,
            clientName: v.client!.client_name,
          }),
        );
      }
      return reply.redirect(target.toString(), 303);
    });
  });
}
