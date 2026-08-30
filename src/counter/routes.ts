/**
 * /counter — the ONE secure page-class where humans do everything agents
 * must never do: register, set the PIN, approve disclosures & settlements,
 * review the ledger, hit the kill switch.
 *
 * STRUCTURAL ISOLATION (tested in both directions):
 *  - every /counter route lives inside this scoped plugin, whose FIRST
 *    onRequest hook hard-403s any request carrying an Authorization header —
 *    an MCP bearer token is useless here by construction;
 *  - counter auth is a host-only session cookie that /mcp never reads
 *    (its auth looks exclusively at the Authorization header);
 *  - requests for /counter on the MCP hostname 404 (and vice versa).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '../db.js';
import { getAccount, findAccountByEmail } from '../domain/accounts.js';
import { amendIntent, withdrawIntent } from '../domain/cards.js';
import { acceptOfferByHuman } from '../domain/offers.js';
import {
  closeCollectionByCard,
  declineMatch,
  getMatch,
  recordStage3OptIn,
  recordVerdict,
  sideOf,
} from '../domain/matches.js';
import { defaultCollectWindowMinutes } from '../domain/matchRules.js';
import { OsbError } from '../protocol.js';
import * as ops from '../domain/counterOps.js';
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
import { sendKillSwitchEmail, sendSecurityNoticeEmail, sendVerificationEmail } from './email.js';
import { verifyEmailToken } from '../email/tokens.js';
import { emailHash } from '../domain/accounts.js';
import { consumeLink, verifyLinkToken, type ApprovalLinkRow } from './links.js';
import { offerAmountAnomaly, newCounterpartyAnomaly } from './anomalies.js';
import * as wa from './webauthn.js';
import type { Config } from '../config.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Every registered /counter route (method + url), recorded at registration
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
            'The counter is human-only. Agent bearer tokens are not accepted on any /counter route.',
        });
      }
      if ((req.headers.host ?? '').toLowerCase() === mcpHost.toLowerCase()) {
        return reply.code(404).send({ error: 'not_found' });
      }
    });

    const html = (reply: FastifyReply, body: string, code = 200) =>
      reply.code(code).type('text/html').send(body);

    const requireSession = async (
      req: FastifyRequest,
      reply: FastifyReply,
    ): Promise<Session | undefined> => {
      const s = await sess.loadSession(req);
      if (!s?.accountId) {
        if (req.method === 'GET') void reply.redirect('/counter/login', 303);
        else void reply.code(401).send({ error: 'not_signed_in' });
        return undefined;
      }
      return s as Session;
    };

    const nextStep = async (accountId: string, s: Session): Promise<string> => {
      const a: any = await getAccount(accountId);
      if (!a) return '/counter/login';
      if (!a.pin_hash) return '/counter/pin';
      if (a.status === 'pending') return '/counter/consent';
      if (s.oauthCtx) return '/counter/authorize';
      return '/counter';
    };

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
      const [offers, disclosures, verdictable, windows, counts] = await Promise.all([
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
      ]);
      const pendingApprovals = [
        ...offers.map((o) => ({
          href: `/counter/approvals/offer/${o.offer_id}`,
          label: `Offer on your ${o.category} match`,
          amount: `${Number(o.amount)} ${o.ccy}`,
        })),
        ...disclosures.map((d) => ({
          href: `/counter/approvals/match/${d.match_id}`,
          label: `Share your details on your ${d.category} match?`,
        })),
      ];
      return html(
        reply,
        home.dashboardPage({
          emailUnreachable: !!a.email_unreachable_at,
          killSwitchOn: !!a.kill_switch_at,
          cardCounts: counts.rows[0],
          pendingApprovals,
          matches: verdictable.map((m) => ({
            matchId: m.match_id,
            category: m.category,
            score: Number(m.score),
            verdict: m.verdict ?? undefined,
          })),
          collectionWindows: windows.map((w) => ({
            cardId: w.card_id,
            category: w.category,
            type: w.type,
            until: new Date(w.until).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
            interestedParties: w.interested_parties,
          })),
        }),
      );
    });

    counter.post('/logout', async (req, reply) => {
      await sess.destroySession(req, reply);
      return reply.redirect('/counter', 303);
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
      const v = await createVerification(cfg, email, 'register');
      await sendVerificationEmail(cfg, email, v.code, v.linkToken, 'register');
      return html(reply, pages.codeEntryPage({ verificationId: v.id, action: '/counter/verify' }));
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
              action: '/counter/verify',
              error: msg,
            }),
            401,
          );
        }
        return html(
          reply,
          pages.messagePage('That code did not work', `<p>${pages.esc(msg!)}</p>`, '/counter/register', 'Start again'),
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
              '/counter/register',
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
        if (email) await sendSecurityNoticeEmail(cfg, email, s.accountId!, 'pin-changed');
      }
      if (a?.status === 'pending') return reply.redirect('/counter/passkey', 303);
      return reply.redirect('/counter', 303);
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
      return reply.redirect('/counter/consent', 303);
    });

    // ------------------------------------------------------------------
    // Consent: 18+ + the consent statement -> account live. WORM first.
    // ------------------------------------------------------------------
    counter.get('/consent', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const a: any = await getAccount(s.accountId!);
      if (a?.status !== 'pending') return reply.redirect('/counter', 303);
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
      if (!a?.pin_hash) return reply.redirect('/counter/pin', 303);
      if (a.status === 'pending') {
        await ops.activateAccountWithConsent(s.accountId!, pages.CONSENT_STATEMENT);
      }
      return reply.redirect(s.oauthCtx ? '/counter/authorize' : '/counter', 303);
    });

    // ------------------------------------------------------------------
    // Login: email + code (re-verification) OR passkey.
    // ------------------------------------------------------------------
    counter.get('/login', async (req, reply) => {
      const s = await sess.loadSession(req);
      if (s?.accountId) return reply.redirect('/counter', 303);
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
      // Anti-enumeration: the code page renders whether or not an account
      // exists; the emailed code is required to learn anything further.
      const v = await createVerification(cfg, email, 'login');
      await sendVerificationEmail(cfg, email, v.code, v.linkToken, 'login');
      return html(
        reply,
        pages.codeEntryPage({ verificationId: v.id, action: '/counter/verify', heading: 'Check your email.' }),
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
    // Approvals. Link entry (/counter/a/:token) is single-use + 15-min TTL;
    // the dashboard reaches the same page via a session-authorized route.
    // ------------------------------------------------------------------
    const approvalView = async (
      accountId: string,
      action: 'offer-accept' | 'stage3-disclosure',
      refId: string,
    ): Promise<pages.ApprovalView | { error: string }> => {
      const anomalies: string[] = [];
      const facts: { k: string; v: string }[] = [];
      if (action === 'offer-accept') {
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
          { k: 'For', v: o.category },
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
          { k: 'For', v: m.category },
          { k: 'Shared with', v: 'your matched counterparty' },
        );
        const cp = await newCounterpartyAnomaly(counterparty, 'stage3-disclosure');
        if (cp) anomalies.push(cp.text);
      }
      return {
        action,
        refId,
        facts,
        anomalies,
        hasPasskey: await wa.accountHasPasskey(accountId),
        elevated: false,
        postPath: '/counter/approve',
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
            '<p>Sign in to the counter, then open the link from your email again.</p>',
            '/counter/login',
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

    counter.post('/approve', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const b: any = req.body ?? {};
      const action = String(b.action ?? '');
      const refId = String(b.ref_id ?? '');
      const decision = String(b.decision ?? '');
      if (!['offer-accept', 'stage3-disclosure'].includes(action) || !refId) {
        return reply.code(400).send({ error: 'bad_request' });
      }
      if (decision === 'decline') {
        // Declining shares nothing and needs no ceremony. No reason is carried.
        if (action === 'offer-accept') await ops.declineOfferByHuman(refId, s.accountId!);
        else await declineMatch(refId, s.accountId!);
        return html(
          reply,
          pages.messagePage('Declined', '<p>Nothing was shared or accepted. No reason was sent.</p>'),
        );
      }
      if (decision !== 'approve') return reply.code(400).send({ error: 'bad_request' });
      // Sensitive action: PIN (or a passkey ceremony that elevated the session).
      const okNow = await pinCeremony(s, reply, String(b.pin ?? ''));
      if (!okNow) return;
      try {
        if (action === 'offer-accept') {
          await acceptOfferByHuman(refId, s.accountId!, 'counter');
          return html(
            reply,
            pages.messagePage('Approved', '<p>The settlement is agreed. Your agent can take it from here.</p>'),
          );
        }
        const r = await recordStage3OptIn(refId, s.accountId!, 'counter');
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
        // Collection window still open on the holder's card: explain, don't 500.
        if (e instanceof OsbError && e.payload.code === 'STAGE_LOCKED') {
          return html(
            reply,
            pages.messagePage(
              'Not yet',
              `<p>${pages.esc(e.payload.human_action ?? 'This step is locked right now.')}</p>`,
              '/counter',
              'Back to the counter',
            ),
            409,
          );
        }
        throw e;
      }
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
      return reply.redirect('/counter', 303);
    });

    counter.post('/collect/:cardId/close', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      try {
        await closeCollectionByCard(String((req.params as any).cardId), s.accountId!, 'counter');
      } catch {
        return html(reply, pages.messagePage('Not found', '<p>No such card on your ledger.</p>'), 404);
      }
      return reply.redirect('/counter', 303);
    });

    // ------------------------------------------------------------------
    // Ledger.
    // ------------------------------------------------------------------
    const cardToView = (c: ops.LedgerCard): home.LedgerCardView => ({
      id: c.id,
      type: c.type,
      category: c.category,
      state: c.lifecycle_state,
      status: c.protocol_status,
      expiresAt: new Date(c.expires_at).toISOString().slice(0, 10),
      priceBand: c.price?.band ? `${c.price.band.min}–${c.price.band.max} ${c.price.ccy ?? ''}`.trim() : undefined,
      ask: c.ask ? `${c.ask.amount} ${c.ask.ccy ?? ''}`.trim() : undefined,
      matchSummary: c.matchCount === 0 ? 'no matches yet' : `${c.matchCount} match${c.matchCount === 1 ? '' : 'es'}`,
      attributes:
        c.attributes && Object.keys(c.attributes).length
          ? Object.entries(c.attributes)
              .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
              .join(' · ')
          : undefined,
    });

    counter.get('/ledger', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const cards = await ops.ledgerCards(cfg, s.accountId!);
      return html(reply, home.ledgerPage(cards.map(cardToView)));
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
          category: c.category,
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
              category: c.category,
              urgency: c.urgency,
              status: c.protocol_status,
              ttlDays: c.ttl_days,
              attributesJson: String(b.attributes ?? ''),
              collectWindowDefault: defaultCollectWindowMinutes(c.urgency),
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
              `/counter/ledger/${id}/edit`,
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
          pages.messagePage('Could not save', `<p>${pages.esc(e?.message ?? 'invalid card')}</p>`, `/counter/ledger/${id}/edit`, 'Back to editing'),
          400,
        );
      }
      return html(
        reply,
        home.ledgerPage((await ops.ledgerCards(cfg, s.accountId!)).map(cardToView), 'Saved. The card is back in screening before it returns to the network.'),
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
      if (email) await sendKillSwitchEmail(cfg, email, s.accountId!, true);
      return reply.redirect('/counter', 303);
    });

    counter.post('/kill/off', async (req, reply) => {
      const s = await requireSession(req, reply);
      if (!s) return;
      const okNow = await pinCeremony(s, reply, String((req.body as any)?.pin ?? ''));
      if (!okNow) return;
      await ops.killSwitchOff(s.accountId!);
      const email = await ops.accountEmail(s.accountId!, 'kill-switch-confirmation');
      if (email) await sendKillSwitchEmail(cfg, email, s.accountId!, false);
      return reply.redirect('/counter', 303);
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
      if (!v.ok) return html(reply, pages.linkDeadPage(v.reason ?? 'invalid'), 404);
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
and security notices keep sending — they are your account's safety rail.
Turn anything back on any time in <a href="/counter/settings">settings</a>.</p>`,
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
        `SELECT type, category, expires_at,
                (expires_at <= now() + interval '7 days') AS expiring_soon
         FROM cards
         WHERE account_id = $1 AND lifecycle_state = 'PUBLISHED' AND expires_at > now()
         ORDER BY expires_at`,
        [v.accountId],
      );
      if (!cards.rowCount) {
        return html(
          reply,
          pages.messagePage('Nothing to renew', '<p>No open cards on your ledger right now.</p>', '/counter', 'To the counter'),
        );
      }
      return html(
        reply,
        home.renewPage(
          cards.rows.map((c: any) => ({
            type: c.type,
            category: c.category,
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
          '/counter/ledger',
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
      const v = await createVerification(cfg, email, 'login');
      await sendVerificationEmail(cfg, email, v.code, v.linkToken, 'login');
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
      return reply.redirect('/counter', 303);
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
      if (!s.accountId) return reply.redirect('/counter/login', 303);
      const a: any = await getAccount(s.accountId);
      if (!a?.pin_hash || a.status === 'pending') {
        return reply.redirect(await nextStep(s.accountId, s as Session), 303);
      }
      return html(
        reply,
        pages.authorizePage(v.client!.client_name, '/counter/authorize', {}),
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
        await sendSecurityNoticeEmail(
          cfg,
          email,
          s.accountId!,
          'agent-authorized',
          v.client!.client_name,
        );
      }
      target.searchParams.set('code', code);
      if (ctx.state) target.searchParams.set('state', ctx.state);
      return reply.redirect(target.toString(), 303);
    });
  }, { prefix: '/counter' });
}
