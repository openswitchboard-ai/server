/**
 * Phase 1.A gate (G1): the safe-hands escrow state machine is structurally
 * unreachable except through a signed human action or a verified Stripe
 * webhook event.
 *
 *  - PROPERTY: every settlement transition function (enumerated from the
 *    module's registry, cross-checked against its exports) refuses any
 *    context that was not minted by this module — including a forged object
 *    that is structurally identical to a real context. The guard fires
 *    BEFORE any database access (these tests run with no database at all).
 *  - SOURCE INVARIANTS: exactly one place in the codebase writes
 *    settlements.state; human contexts are minted only in the counter route
 *    class; webhook contexts only in the signature-verified webhook handler;
 *    the internal ops worker has no settlement vocabulary at all.
 *  - ROUTES: /stripe/webhook does not exist unless the deployment is
 *    configured for settlements; when it exists it rejects unsigned posts.
 *  - MONEY MATH: fee parameter present, wired, and equal to 0.
 *  - WEBHOOK SIGNATURES: Stripe's own constructEvent rejects a wrong secret
 *    and a tampered payload (real verification code, no mocks).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Stripe from 'stripe';
import * as settlements from '../../src/domain/settlements.js';
import { SETTLEMENT_TRANSITIONS } from '../../src/domain/settlements.js';
import { TOOLS, dispatchTool } from '../../src/mcp/tools.js';
import { buildApp } from '../../src/app.js';
import {
  WEBHOOK_EVENTS,
  feeMinorUnits,
  formatMinor,
  settlementFeeMinor,
  toMinorUnits,
} from '../../src/stripe.js';
import { validateOutbound, validatePayload } from '../../src/protocol.js';
import type { Config } from '../../src/config.js';

const baseCfg: Config = {
  envName: 'dev',
  port: 0,
  publicOrigin: 'https://mcp.test',
  counterOrigin: 'https://my.test',
  legacyCounterHosts: ['counter.test'],
  sesFrom: 'OpenSwitchboard <board@openswitchboard.ai>',
  sesReplyTo: 'info@openswitchboard.ai',
  sesConfigurationSet: 'unused',
  emailEventsQueueUrl: 'http://unused',
  dbSecretArn: 'unused',
  screeningQueueUrl: 'http://unused',
  matchingQueueUrl: 'http://unused',
  opsQueueUrl: 'http://unused',
  consentLogBucket: 'unused',
  identityKeyArn: 'unused',
  bedrockModelId: 'unused',
  bedrockEmbedModelId: 'unused',
  registrationMode: 'dev-bootstrap',
  region: 'us-east-1',
  quotas: { maxOpenCards: 5, maxPublishesPerDay: 10, maxOffersPerHour: 6 },
  docsBase: 'https://openswitchboard.ai/docs',
  settlementFeePercent: 0,
  settlementFeeFlatMinor: 100,
};

const srcRoot = join(__dirname, '..', '..', 'src');
const read = (rel: string) => readFileSync(join(srcRoot, rel), 'utf8');
const allSourceFiles = (dir = srcRoot): string[] => {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...allSourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
};

describe('escrow state machine: no reachable money transition without a human signature or webhook', () => {
  const forgedContexts: any[] = [
    undefined,
    null,
    {},
    // Structurally identical to a real human context, but not minted here:
    { kind: 'human', accountId: '00000000-0000-0000-0000-000000000000', recordedVia: 'counter' },
    // Structurally identical to a real webhook context:
    { kind: 'webhook', eventId: 'evt_x', eventType: 'checkout.session.completed' },
    // An agent/ops-flavoured attempt:
    { kind: 'ops', op: 'release-settlement' },
  ];

  const args: Record<string, any[]> = {
    approveSettlement: ['sid'],
    declineSettlement: ['sid'],
    lockEvidence: ['sid', 'manifest-key'],
    confirmReceipt: ['sid'],
    openDispute: ['sid'],
    markFunded: ['sid', { checkoutSession: 'cs_x', paymentIntent: 'pi_x' }],
    markReleased: ['sid'],
    markRefunded: ['sid'],
  };

  it('the registry names every exported transition and nothing is missing', () => {
    // Every registry entry is a real exported function...
    for (const name of Object.keys(SETTLEMENT_TRANSITIONS)) {
      expect(typeof (settlements as any)[name], name).toBe('function');
      expect(args[name], `test args for ${name}`).toBeTruthy();
    }
    // ...and every export whose implementation calls applyTransition is in
    // the registry (source cross-check below pins applyTransition as the
    // sole state writer).
    const src = read('domain/settlements.ts');
    const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    for (const name of exported) {
      const body = src.slice(src.indexOf(`export async function ${name}`));
      const nextFn = body.indexOf('\nexport ', 10);
      const scope = nextFn === -1 ? body : body.slice(0, nextFn);
      if (/\bapplyTransition\(/.test(scope.replace(/^[^{]*/, ''))) {
        expect(
          Object.keys(SETTLEMENT_TRANSITIONS),
          `${name} calls applyTransition but is not in the registry`,
        ).toContain(name);
      }
    }
  });

  for (const [name, kind] of Object.entries(SETTLEMENT_TRANSITIONS)) {
    it(`${name} (${kind}) refuses every forged context before touching anything`, async () => {
      const fn = (settlements as any)[name] as (...a: any[]) => Promise<unknown>;
      for (const forged of forgedContexts) {
        // No DB is initialised in this suite: if the guard did not fire
        // first, we would see 'db not initialised' instead.
        await expect(fn(forged, ...args[name])).rejects.toThrow(
          /settlement transition requires a human-action or verified-webhook context/,
        );
      }
    });
  }

  it('exactly one statement in the codebase writes settlements.state', () => {
    let writers = 0;
    for (const f of allSourceFiles()) {
      const src = readFileSync(f, 'utf8');
      const matches = src.match(/UPDATE settlements[\s\S]{0,80}?SET[\s\S]{0,80}?state\s*=/g) ?? [];
      writers += matches.length;
      if (matches.length) expect(f.endsWith('domain/settlements.ts'), f).toBe(true);
    }
    expect(writers).toBe(1); // applyTransition, and nothing else
  });

  it('human contexts are minted only in the counter route class', () => {
    for (const f of allSourceFiles()) {
      const src = readFileSync(f, 'utf8');
      if (f.endsWith('domain/settlements.ts')) continue; // the definition
      if (src.includes('counterAction(')) {
        expect(f.endsWith('counter/routes.ts'), f).toBe(true);
      }
    }
  });

  it('webhook contexts are minted only in the signature-verified webhook handler', () => {
    for (const f of allSourceFiles()) {
      const src = readFileSync(f, 'utf8');
      if (f.endsWith('domain/settlements.ts')) continue;
      if (src.includes('webhookAction(')) {
        expect(f.endsWith('stripeWebhook.ts'), f).toBe(true);
      }
    }
    // And the handler mints it only after constructEvent-based verification.
    const handler = read('stripeWebhook.ts');
    expect(handler.indexOf('verifyWebhookSignature')).toBeGreaterThan(-1);
    expect(handler.indexOf('verifyWebhookSignature')).toBeLessThan(handler.indexOf('webhookAction('));
  });

  it('the internal ops worker has no settlement vocabulary', () => {
    const src = read('workers/opsWorker.ts');
    expect(src.toLowerCase()).not.toContain('settlement');
    expect(src).not.toContain('stripe');
  });
});

describe('route surface', () => {
  it('/stripe/webhook does not exist when settlements are unconfigured', async () => {
    const app = buildApp(baseCfg);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/webhook',
      headers: { host: 'mcp.test', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('when configured, /stripe/webhook refuses an unsigned post and never serves the counter host', async () => {
    const app = buildApp({
      ...baseCfg,
      stripeSecretArn: 'arn:aws:secretsmanager:us-east-1:0:secret:unused',
      evidenceBucket: 'unused-bucket',
    });
    await app.ready();
    const unsigned = await app.inject({
      method: 'POST',
      url: '/stripe/webhook',
      headers: { host: 'mcp.test', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(unsigned.statusCode).toBe(400);
    expect(unsigned.json().error).toBe('missing_signature');
    const counterHost = await app.inject({
      method: 'POST',
      url: '/stripe/webhook',
      headers: { host: 'my.test', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(counterHost.statusCode).toBe(404);
    await app.close();
  });

  it('half-configuration (stripe without the evidence vault) refuses to build', () => {
    expect(() =>
      buildApp({ ...baseCfg, stripeSecretArn: 'arn:unused' }),
    ).toThrow(/EVIDENCE_BUCKET/);
  });
});

describe('settle tool', () => {
  it('is on the tool surface with a proposal-or-read input schema', () => {
    const t = TOOLS.find((x) => x.name === 'settle');
    expect(t).toBeTruthy();
    expect(Object.keys(t!.inputSchema.properties)).toEqual(
      expect.arrayContaining(['intro_id', 'settlement_id', 'amount', 'ccy', 'description']),
    );
    expect(t!.inputSchema.additionalProperties).toBe(false);
  });

  it('answers SETTLEMENT_UNAVAILABLE when the deployment has no Stripe secret', async () => {
    const r = await dispatchTool(baseCfg, '00000000-0000-0000-0000-000000000000', 'settle', {
      match_id: '00000000-0000-0000-0000-000000000000',
      amount: 100,
      ccy: 'AUD',
    });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as any).code).toBe('SETTLEMENT_UNAVAILABLE');
    // The error payload itself validates against the protocol error schema.
    expect(validateOutbound('error', r.structuredContent).valid).toBe(true);
  });
});

describe('money math (a flat introductory fee, taken off the seller)', () => {
  it('converts to minor units per currency', () => {
    expect(toMinorUnits(600, 'AUD')).toBe(60000);
    expect(toMinorUnits(12.34, 'AUD')).toBe(1234);
    expect(toMinorUnits(600, 'JPY')).toBe(600);
    expect(() => toMinorUnits(0, 'AUD')).toThrow();
    expect(() => toMinorUnits(-5, 'AUD')).toThrow();
  });

  it('the percentage part is a parameter and sits at 0', () => {
    for (const minor of [1, 999, 60000, 123457, 99_999_999]) {
      expect(feeMinorUnits(minor, baseCfg.settlementFeePercent)).toBe(0);
    }
    // ...and it still works, if it is ever raised.
    expect(feeMinorUnits(60000, 2)).toBe(1200);
    expect(feeMinorUnits(999, 2.5)).toBe(25);
    expect(() => feeMinorUnits(1000, -1)).toThrow();
    expect(() => feeMinorUnits(1000, 101)).toThrow();
  });

  it('the whole fee is the flat 100 minor units, whatever the amount', () => {
    for (const minor of [101, 999, 8765, 60000, 99_999_999]) {
      expect(settlementFeeMinor(minor, baseCfg)).toBe(100);
    }
  });

  it('the flat fee and the percentage add up when both are set', () => {
    const cfg = { settlementFeeFlatMinor: 100, settlementFeePercent: 2 };
    expect(settlementFeeMinor(60000, cfg)).toBe(1300); // 100 + 1200
  });

  it('refuses a settlement the fee would swallow', () => {
    expect(() => settlementFeeMinor(100, baseCfg)).toThrow(/not larger than/);
    expect(() => settlementFeeMinor(50, baseCfg)).toThrow(/not larger than/);
    expect(settlementFeeMinor(101, baseCfg)).toBe(100); // one minor unit over is fine
    expect(() => settlementFeeMinor(1000, { ...baseCfg, settlementFeeFlatMinor: -1 })).toThrow();
  });

  it('writes the fee out the way both humans see it', () => {
    expect(formatMinor(100, 'AUD')).toBe('1.00 AUD');
    expect(formatMinor(1300, 'aud')).toBe('13.00 AUD');
    expect(formatMinor(100, 'JPY')).toBe('100 JPY'); // zero-decimal
  });

  it('the seller receives amount - fee and the buyer pays the amount exactly', () => {
    const amountMinor = toMinorUnits(87.65, 'AUD');
    expect(amountMinor).toBe(8765);
    expect(amountMinor - settlementFeeMinor(amountMinor, baseCfg)).toBe(8665);
  });
});

/**
 * The money shape itself, asserted over the source: separate charges and
 * transfers, Accounts v2 recipients, and none of the destination-charge or
 * manual-capture machinery this replaced.
 */
describe('the settlement money shape', () => {
  const stripeSrc = read('domain/settlementStripe.ts');
  // The comments explain at length what this shape does NOT do, so the source
  // scans below run over the code alone.
  const code = stripeSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('takes the buyer\'s money into the platform balance, with nothing routed away', () => {
    for (const gone of [
      'capture_method',
      'payment_method_types',
      'paymentIntents.capture',
      'paymentIntents.cancel',
    ]) {
      expect(code, gone).not.toContain(gone);
    }
    // transfer_data and application_fee_amount each appear exactly once, and
    // only to REFUSE a payment that would route the money somewhere other
    // than the platform balance.
    for (const guard of ['transfer_data', 'application_fee_amount']) {
      expect(code.match(new RegExp(guard, 'g')), guard).toHaveLength(1);
      expect(code.indexOf('verifyPaymentMatchesSettlement'), guard).toBeLessThan(
        code.indexOf(guard),
      );
    }
    // The settlement id ties the charge and the transfer together.
    expect(code).toContain('transfer_group: s.id');
  });

  it('opens seller accounts as v2 recipients, never as an express type', () => {
    expect(code).toContain('v2.core.accounts.create');
    expect(code).toContain('stripe_transfers: { requested: true }');
    expect(code).toContain("dashboard: 'express'");
    expect(code).not.toContain("type: 'express'");
    expect(code).toContain("fees_collector: 'application'");
    expect(code).toContain("losses_collector: 'application'");
  });

  it('reads readiness from stripe_transfers alone', () => {
    expect(code).toContain('stripe_transfers?.status');
    expect(code).not.toContain('charges_enabled');
    expect(code).not.toContain('payouts_enabled');
  });

  it('pays the seller once: the settlement id is the idempotency key', () => {
    expect(code).toContain('idempotencyKey: `osb-settlement-release-${s.id}`');
  });

  it('never uses a global Stripe key: every call comes off the client instance', () => {
    for (const f of allSourceFiles()) {
      const src = readFileSync(f, 'utf8');
      if (f.endsWith('src/stripe.ts')) continue; // where the client is built
      if (/\bnew Stripe\(/.test(src)) expect(f, `${f} builds its own Stripe client`).toBe('');
    }
  });

  it('the webhook set is the one this shape produces', () => {
    expect([...WEBHOOK_EVENTS].sort()).toEqual([
      'charge.refunded',
      'checkout.session.async_payment_failed',
      'checkout.session.async_payment_succeeded',
      'checkout.session.completed',
      'transfer.created',
    ]);
  });

  it('funding is gated on the payment having actually landed', () => {
    const handler = read('stripeWebhook.ts');
    expect(handler).toContain("session.payment_status === 'unpaid'");
    // And 'released' is a webhook state, off the transfer, never off the
    // synchronous API response in the human route.
    expect(handler).toContain("case 'transfer.created'");
    expect(read('counter/routes.ts')).not.toContain('markReleased');
  });
});

describe('webhook signature verification (Stripe reference implementation)', () => {
  const stripe = new Stripe('sk_test_unused_for_signature_math');
  const payload = JSON.stringify({ id: 'evt_test', object: 'event', type: 'checkout.session.completed' });

  it('accepts a correctly signed payload', () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_correct' });
    const event = stripe.webhooks.constructEvent(payload, header, 'whsec_correct');
    expect(event.id).toBe('evt_test');
  });

  it('rejects a signature made with a different secret', () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' });
    expect(() => stripe.webhooks.constructEvent(payload, header, 'whsec_correct')).toThrow(
      /No signatures found matching/,
    );
  });

  it('rejects a tampered payload', () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_correct' });
    const tampered = payload.replace('checkout.session.completed', 'payment_intent.succeeded');
    expect(() => stripe.webhooks.constructEvent(tampered, header, 'whsec_correct')).toThrow(
      /No signatures found matching/,
    );
  });

  it('rejects a stale timestamp (replay window)', () => {
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_correct',
      timestamp: Math.floor(Date.now() / 1000) - 60 * 60,
    });
    expect(() => stripe.webhooks.constructEvent(payload, header, 'whsec_correct')).toThrow(
      /Timestamp outside the tolerance zone/,
    );
  });
});

describe('settlement protocol payloads', () => {
  const row = {
    id: '7a2e5c1d-9f4b-4c8a-b3e6-2d1f0a9b8c7d',
    match_id: '0d9f2c1e-7b4a-4f7e-9c2d-1a2b3c4d5e6f',
    proposer_account: 'a',
    buyer_account: 'a',
    seller_account: 'b',
    amount: '600',
    ccy: 'AUD',
    description: { text: 'bike', provenance: 'counterparty-untrusted' },
    state: 'proposed',
    fee_amount_minor: 0,
    buyer_approved_at: null,
    seller_approved_at: null,
    stripe_checkout_session: null,
    stripe_payment_intent: null,
    stripe_transfer_id: null,
    evidence_manifest_key: null,
  } as any;

  it('serializes to a schema-valid settlement message for every state', () => {
    for (const state of [
      'proposed', 'approved-by-buyer', 'approved-by-seller', 'approved', 'funded',
      'evidence-locked', 'confirmed', 'disputed', 'released', 'refunded', 'declined',
    ]) {
      const out = settlements.serializeSettlement({ ...row, state });
      expect(validateOutbound('settlement', out).valid).toBe(true);
      expect((out as any).state).toBe(state);
    }
  });

  it('never carries Stripe identifiers or approval timestamps on the wire', () => {
    const out: any = settlements.serializeSettlement({
      ...row,
      stripe_checkout_session: 'cs_x',
      stripe_payment_intent: 'pi_x',
    });
    const flat = JSON.stringify(out);
    expect(flat).not.toContain('cs_x');
    expect(flat).not.toContain('pi_x');
    expect(flat).not.toContain('approved_at');
  });
});
