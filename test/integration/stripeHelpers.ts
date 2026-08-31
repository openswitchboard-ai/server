/**
 * Stripe-sandbox helpers for the settlement integration suite (phase 1.A).
 *
 * The suite runs against LIVE dev + the dev Stripe sandbox. Two shortcuts
 * keep it deterministic without softening anything real:
 *
 *  - The SELLER'S CONNECTED ACCOUNT is created pre-verified through Stripe's
 *    own test-mode API (application-collected requirements + Stripe's
 *    documented test values), instead of driving the hosted onboarding UI.
 *    Production sellers still onboard through the hosted account-link flow.
 *  - The BUYER'S PAYMENT is confirmed through the API with Stripe's test
 *    payment-method token (pm_card_visa) as a manual-capture destination
 *    charge carrying the settlement metadata — the same shape the server's
 *    Checkout Session produces — because a hosted Checkout page cannot be
 *    completed by API. The funded/released/refunded transitions still land
 *    exclusively via the real, signature-verified webhook on live dev.
 *
 * The seller's connected-account id is attached to the seller's account row
 * with the SAME envelope encryption the server uses (the harness holds
 * dev-scoped KMS access, like its existing RDS-Data observability).
 */
import { createCipheriv, randomBytes } from 'node:crypto';
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

/** Pre-verified, transfers-active connected account (Stripe test values). */
export async function createPreVerifiedSeller(label: string): Promise<string> {
  const acct = await stripeApi('/v1/accounts', {
    country: 'AU',
    'controller[fees][payer]': 'application',
    'controller[losses][payments]': 'application',
    'controller[stripe_dashboard][type]': 'none',
    'controller[requirement_collection]': 'application',
    'capabilities[transfers][requested]': 'true',
    business_type: 'individual',
    'business_profile[url]': 'https://openswitchboard.ai',
    'business_profile[mcc]': '5734',
    'business_profile[product_description]': `OpenSwitchboard e2e seller ${label}`,
    'individual[first_name]': 'Testa',
    'individual[last_name]': 'Seller',
    'individual[email]': 'testsuite+seller@openswitchboard.ai',
    'individual[phone]': '0000000000',
    'individual[dob][day]': '1',
    'individual[dob][month]': '1',
    'individual[dob][year]': '1901',
    'individual[address][line1]': 'address_full_match',
    'individual[address][city]': 'Sydney',
    'individual[address][state]': 'NSW',
    'individual[address][postal_code]': '2000',
    'individual[address][country]': 'AU',
    'tos_acceptance[date]': String(Math.floor(Date.now() / 1000)),
    'tos_acceptance[ip]': '203.0.113.10',
    'external_account[object]': 'bank_account',
    'external_account[country]': 'AU',
    'external_account[currency]': 'aud',
    'external_account[routing_number]': '000000',
    'external_account[account_number]': '000123456',
  });
  if (acct.capabilities?.transfers !== 'active') {
    throw new Error(`test seller ${acct.id} is not transfers-active: ${JSON.stringify(acct.capabilities)}`);
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

/**
 * Fund a settlement the way the server's Checkout Session would: a
 * manual-capture destination charge with the settlement metadata, confirmed
 * with Stripe's test payment-method token. Returns the PaymentIntent id.
 */
export async function fundSettlementByApi(
  settlementId: string,
  amountMinor: number,
  ccy: string,
  sellerAcct: string,
): Promise<string> {
  const pi = await stripeApi('/v1/payment_intents', {
    amount: String(amountMinor),
    currency: ccy.toLowerCase(),
    capture_method: 'manual',
    confirm: 'true',
    payment_method: 'pm_card_visa',
    'transfer_data[destination]': sellerAcct,
    application_fee_amount: '0',
    'metadata[osb_settlement_id]': settlementId,
    'metadata[osb_env]': ENV_NAME,
    'automatic_payment_methods[enabled]': 'true',
    'automatic_payment_methods[allow_redirects]': 'never',
  });
  if (pi.status !== 'requires_capture') {
    throw new Error(`funding PI ${pi.id} is ${pi.status}, expected requires_capture`);
  }
  return pi.id as string;
}

/** A tiny valid 1x1 PNG for evidence uploads. */
export function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB' +
      'h6FO1AAAAABJRU5ErkJggg==',
    'base64',
  );
}
