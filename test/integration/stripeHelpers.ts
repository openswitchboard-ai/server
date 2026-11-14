/**
 * Stripe-sandbox helpers for the settlement integration suite.
 *
 * The suite runs against LIVE dev + the dev Stripe sandbox. One shortcut
 * keeps it deterministic without softening anything real:
 *
 *  - The SELLER'S CONNECTED ACCOUNT is created pre-verified through Stripe's
 *    own test-mode API: a v2 account with the Recipient configuration, the
 *    identity fields filled in directly, and the terms-of-service attestation
 *    that stripe_transfers waits on. Production sellers reach the same place
 *    through the hosted account-link flow, which this skips.
 *
 * The BUYER'S PAYMENT is not shortcut: the real hosted Checkout Session the
 * server created is completed in a browser, with a Stripe test card, because
 * checkout.session.completed is what funds a settlement and no API call
 * produces it. The funded/released/refunded transitions land exclusively via
 * the real, signature-verified webhook on live dev.
 *
 * The seller's connected-account id is attached to the seller's account row
 * with the SAME envelope encryption the server uses (the harness holds
 * dev-scoped KMS access, like its existing RDS-Data observability).
 */
import { createCipheriv, randomBytes } from 'node:crypto';
import { chromium, type Locator, type Page } from '@playwright/test';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DecryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { ExecuteStatementCommand, RDSDataClient } from '@aws-sdk/client-rds-data';
import { ENV_NAME } from './helpers.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const ssm = new SSMClient({ region });
const sm = new SecretsManagerClient({ region });
const kms = new KMSClient({ region });
const rdsData = new RDSDataClient({ region });

let stripeKey: string | undefined;
export async function stripeSecretKey(): Promise<string> {
  if (stripeKey) return stripeKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: `osb/${ENV_NAME}/stripe` }));
  const json = JSON.parse(r.SecretString ?? '{}');
  if (!json.secret_key) throw new Error('osb/dev/stripe has no secret_key');
  stripeKey = json.secret_key as string;
  return stripeKey;
}

export async function stripeApi(
  path: string,
  params?: Record<string, string>,
  method?: string,
  onBehalfOfAccount?: string,
): Promise<any> {
  const key = await stripeSecretKey();
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: method ?? (params ? 'POST' : 'GET'),
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(onBehalfOfAccount ? { 'Stripe-Account': onBehalfOfAccount } : {}),
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const json: any = await res.json();
  if (json.error) throw new Error(`stripe ${path}: ${json.error.message}`);
  return json;
}

/** The v2 API takes JSON, so it gets its own thin caller. */
export async function stripeApiV2(
  path: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const key = await stripeSecretKey();
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: {
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'Stripe-Version': '2026-07-29.dahlia',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json();
  if (json.error) {
    throw new Error(`stripe ${path}: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json;
}

/**
 * A pre-verified v2 Recipient account: transfers-active without anyone
 * walking the hosted onboarding. Everything here is a documented Stripe test
 * value; the terms-of-service attestation is the one field stripe_transfers
 * waits on, and address_full_match is Stripe's own always-verifies line 1.
 * (stripe_balance.payouts stays restricted — it wants a bank account and an
 * identity document — and that is fine: the settlement never pays out, it
 * transfers into the recipient's Stripe balance.)
 */
export async function createPreVerifiedSeller(label: string): Promise<string> {
  const acct = await stripeApiV2('/v2/core/accounts', {
    display_name: `OpenSwitchboard e2e seller ${label}`,
    contact_email: `testsuite+seller-${label}@openswitchboard.ai`,
    dashboard: 'none',
    defaults: {
      currency: 'aud',
      responsibilities: { fees_collector: 'application', losses_collector: 'application' },
      profile: {
        business_url: 'https://openswitchboard.ai',
        product_description: `OpenSwitchboard e2e seller ${label}`,
      },
    },
    identity: {
      country: 'AU',
      entity_type: 'individual',
      attestations: {
        terms_of_service: {
          account: { date: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ip: '203.0.113.10' },
        },
      },
      individual: {
        given_name: 'Testa',
        surname: 'Seller',
        email: `testsuite+seller-${label}@openswitchboard.ai`,
        date_of_birth: { day: 1, month: 1, year: 1901 },
        phone: '+61400000000',
        address: {
          line1: 'address_full_match',
          city: 'Sydney',
          state: 'NSW',
          postal_code: '2000',
          country: 'AU',
        },
      },
    },
    configuration: {
      recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } },
    },
    include: ['configuration.recipient'],
  });
  const status = acct.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers
    ?.status;
  if (status !== 'active') {
    throw new Error(
      `test seller ${acct.id} cannot receive transfers: stripe_transfers is ${status} ` +
        `(${JSON.stringify(acct.configuration?.recipient?.capabilities)})`,
    );
  }
  return acct.id as string;
}

// ---------------------------------------------------------------------------
// Envelope-encrypted attachment of the connected account to the seller row.
// ---------------------------------------------------------------------------
let dbArns: { resourceArn: string; secretArn: string } | undefined;
async function arns() {
  if (!dbArns) {
    const [cluster, secret] = await Promise.all([
      ssm.send(new GetParameterCommand({ Name: `/osb/${ENV_NAME}/db/cluster-arn` })),
      ssm.send(new GetParameterCommand({ Name: `/osb/${ENV_NAME}/db/secret-arn` })),
    ]);
    dbArns = { resourceArn: cluster.Parameter!.Value!, secretArn: secret.Parameter!.Value! };
  }
  return dbArns;
}

export async function attachStripeAccount(accountId: string, stripeAcctId: string): Promise<void> {
  const a = await arns();
  const r = await rdsData.send(
    new ExecuteStatementCommand({
      ...a,
      database: 'osb',
      sql: 'SELECT data_key_enc FROM accounts WHERE id = :id::uuid',
      parameters: [{ name: 'id', value: { stringValue: accountId } }],
    }),
  );
  const blob = r.records?.[0]?.[0]?.blobValue;
  if (!blob) throw new Error(`no data_key_enc for account ${accountId}`);
  const wrapped = Buffer.from(blob as Uint8Array);
  const dk = await kms.send(
    new DecryptCommand({
      CiphertextBlob: wrapped,
      EncryptionContext: { account_id: accountId, env: ENV_NAME },
    }),
  );
  if (!dk.Plaintext) throw new Error('KMS returned no plaintext data key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(dk.Plaintext), iv);
  const ct = Buffer.concat([cipher.update(stripeAcctId, 'utf8'), cipher.final()]);
  const enc = Buffer.concat([iv, cipher.getAuthTag(), ct]);
  await rdsData.send(
    new ExecuteStatementCommand({
      ...a,
      database: 'osb',
      sql: `UPDATE accounts SET stripe_account_id_enc = :b, stripe_account_created_at = now()
            WHERE id = :id::uuid`,
      parameters: [
        { name: 'id', value: { stringValue: accountId } },
        { name: 'b', value: { blobValue: enc } },
      ],
    }),
  );
}

/** Is a visible match for `selector` in any frame of the page right now? */
async function anyFrameHasVisible(page: Page, selector: string): Promise<boolean> {
  for (const f of page.frames()) {
    if (await f.locator(selector).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

/**
 * The first visible match for `selector` in any frame, waiting up to
 * `timeout`. When none turns up, the error names every frame and the fields in
 * it, and a picture of the page goes to e2e-screenshots/, so a page Stripe
 * redraws says how it now looks.
 */
async function visibleInAnyFrame(page: Page, selector: string, timeout: number): Promise<Locator> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const f of page.frames()) {
      const l = f.locator(selector).first();
      if (await l.isVisible().catch(() => false)) return l;
    }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(500);
  }
  const { mkdirSync } = await import('node:fs');
  mkdirSync('e2e-screenshots', { recursive: true });
  await page.screenshot({ path: `e2e-screenshots/checkout-missing-${Date.now()}.png`, fullPage: true }).catch(() => {});
  const perFrame: string[] = [];
  for (const f of page.frames()) {
    const ids = await f
      .locator('input, select, button')
      .evaluateAll((els) =>
        els.map((el) => `${el.tagName.toLowerCase()}#${el.id}[${el.getAttribute('name') ?? ''}]`).join(' '),
      )
      .catch(() => '(unreadable)');
    if (ids) perFrame.push(`${f.url().slice(0, 80)} :: ${ids}`);
  }
  throw new Error(`no visible ${selector} on the checkout page after ${timeout}ms. It had:\n${perFrame.join('\n')}`);
}

/**
 * Pay a real hosted Checkout Session, in a browser, with a Stripe test card.
 *
 * There is no API that completes a Checkout Session — the session's
 * PaymentIntent does not even exist until someone starts paying on the page —
 * and checkout.session.completed is the event that funds a settlement. So the
 * suite drives the page the buyer would drive, on the session the server
 * itself created, and everything downstream is the real thing.
 *
 * The card is 4000 0000 0000 0077: it succeeds and puts the money straight
 * into the platform's AVAILABLE balance, so the release transfer that follows
 * has funds to draw on inside one test run.
 */
export async function payHostedCheckout(url: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Since November 2026 the hosted page draws its fields inside Stripe's own
    // frames (the email box is #linkAuthentication-emailInput in one, the card
    // in another), where they used to sit on the page itself with plain ids.
    // So every field is looked for in every frame, by the old id and the new
    // names alike, and a field that never turns up says what the page had.
    const field = (selector: string, timeout = 60_000) => visibleInAnyFrame(page, selector, timeout);
    await (await field('#email, #linkAuthentication-emailInput, input[name="email"]')).fill(
      'testsuite+buyer@openswitchboard.ai',
    );
    // Wallets and delayed methods come and go on this page; the card option
    // is an accordion row (or a radio) that may already be open.
    const CARD_NUMBER = '#cardNumber, input[name="number"], #Field-numberInput';
    if (!(await anyFrameHasVisible(page, CARD_NUMBER))) {
      const choice = await field(
        '#payment-method-accordion-item-title-card, button[data-testid="card-accordion-item-button"], input[type="radio"][value="card"], [role="radio"]:has-text("Card"), :text-is("Card")',
        15_000,
      ).catch(() => undefined);
      await choice?.click({ force: true });
    }
    await (await field(CARD_NUMBER)).fill('4000000000000077');
    await (await field('#cardExpiry, input[name="expiry"], #Field-expiryInput')).fill(
      `12${String(new Date().getFullYear() + 3).slice(2)}`,
    );
    await (await field('#cardCvc, input[name="cvc"], #Field-cvcInput')).fill('123');
    await field('#billingName, input[name="name"], #Field-nameInput', 3_000)
      .then((l) => l.fill('Bella Buyer'))
      .catch(() => {});
    // The page picks the billing country from where the browser is. A runner
    // in another country is asked for that country's postcode, and 6160 is an
    // Australian one. The test buyer is in Australia wherever the suite runs.
    await field('#billingCountry, select[name="country"], #Field-countryInput', 3_000)
      .then((l) => l.selectOption('AU'))
      .catch(() => {});
    await field('#billingPostalCode, input[name="postalCode"], #Field-postalCodeInput', 3_000)
      .then((l) => l.fill('6160'))
      .catch(() => {});
    // "Save my information for faster checkout" asks for a phone number and
    // blocks the form until it gets one. A test buyer saves nothing.
    const saveForLater = await field('#enableStripePass, input[name="enableStripePass"]', 2_000).catch(
      () => undefined,
    );
    if (saveForLater) await saveForLater.uncheck({ force: true }).catch(() => {});
    // The main Pay button, and never the Link one beside the email box
    // (pay_with_link_arrow), which opens a Link window instead of paying.
    await (
      await field(
        '[data-testid="hosted-payment-submit-button"], button.SubmitButton, button[type=submit]:not([name="pay_with_link_arrow"])',
      )
    ).click();
    // Stripe sends the buyer on to the success_url once the payment lands.
    // Where that goes afterwards (a sign-in redirect, say) is the counter's
    // business; leaving checkout.stripe.com is the signal that matters.
    try {
      await page.waitForURL((u) => !u.host.endsWith('checkout.stripe.com'), {
        timeout: 120_000,
        waitUntil: 'commit',
      });
    } catch (e) {
      // A payment that never leaves the page says nothing on its own (11
      // November 2026: eleven tests timed out here for a week with no word of
      // why). Keep what the page was showing: a picture for the run's
      // artifacts, and the words on it in the error itself.
      const { mkdirSync } = await import('node:fs');
      mkdirSync('e2e-screenshots', { recursive: true });
      await page
        .screenshot({ path: `e2e-screenshots/checkout-stuck-${Date.now()}.png`, fullPage: true })
        .catch(() => {});
      const words = await page
        .locator('body')
        .innerText({ timeout: 5_000 })
        .then((t) => t.replace(/\s+/g, ' ').slice(0, 1500))
        .catch(() => '(the page could not be read)');
      // The form itself lives in Stripe's frames, so their words are what say
      // why a payment did not go (a decline, a missing field, a check).
      const inFrames: string[] = [];
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        const t = await f
          .locator('body')
          .innerText({ timeout: 2_000 })
          .then((x) => x.replace(/\s+/g, ' ').trim().slice(0, 400))
          .catch(() => '');
        if (t) inFrames.push(`${f.url().split('?')[0].slice(0, 70)}: ${t}`);
      }
      // Since 14 November 2026 Stripe's hosted page can put a human check
      // (hCaptcha) in front of an automated browser. The suite does not answer
      // or dodge those; it says plainly that this is why the payment stopped.
      const askedForAHuman = page
        .frames()
        .some((f) => /hcaptcha/.test(f.url()) && inFrames.some((t) => t.includes('hcaptcha') && /Verify/.test(t)));
      throw new Error(
        `${askedForAHuman ? 'STRIPE ASKED FOR A HUMAN CHECK (hCaptcha) before taking the test payment; the suite does not answer those. ' : ''}${(e as Error).message}\nThe checkout page was showing: ${words}\nIn its frames: ${inFrames.join(' | ')}`,
      );
    }
  } finally {
    await browser.close();
  }
}

/**
 * Make sure the platform has enough AVAILABLE balance in this currency for a
 * release transfer. Test-mode card money lands as pending unless the charge
 * used the bypass card, and a first run on a fresh sandbox has nothing at all.
 */
export async function ensurePlatformBalance(minMinor: number, ccy: string): Promise<void> {
  const currency = ccy.toLowerCase();
  const bal = await stripeApi('/v1/balance');
  const have = (bal.available ?? []).find((b: any) => b.currency === currency)?.amount ?? 0;
  if (have >= minMinor) return;
  await stripeApi('/v1/payment_intents', {
    amount: String(Math.max(minMinor - have, minMinor)),
    currency,
    confirm: 'true',
    payment_method: 'pm_card_bypassPending',
    description: 'OpenSwitchboard test harness: platform balance top-up',
    'automatic_payment_methods[enabled]': 'true',
    'automatic_payment_methods[allow_redirects]': 'never',
  });
}

/** A tiny valid 1x1 PNG for evidence uploads. */
export function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB' +
      'h6FO1AAAAABJRU5ErkJggg==',
    'base64',
  );
}
