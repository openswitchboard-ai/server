/**
 * One way to ask Claude a question: the Claude API first, Bedrock behind it.
 *
 * The three screens (intake/checks/modelScreen.ts, both shapes, and
 * intake/checks/messageSafety.ts) used to call Haiku on Bedrock directly. The
 * organisation now has Claude API credits, so the same model is asked through
 * the Claude API, with the same system prompt, the same turns and the same
 * prefilled brace, and Bedrock answers whenever that cannot: no key yet, the
 * API out of reach or overloaded, or the credits run out. A screen never fails
 * for want of the cheaper road while the old one is open.
 *
 * WHAT FALLS BACK, AND WHAT DOES NOT. A connection that never completed, a
 * timeout, a 429, any 5xx (529 overloaded among them), a key the API refuses
 * (401, 403), a billing error (402) and a 400 that says the credit balance is
 * too low all go to Bedrock, with one warning line. Any other 400 is a request
 * the switchboard built wrong; Bedrock would read the same body the same way,
 * so it is thrown as it is, and the screen's caller redelivers as before.
 *
 * THE KEY. A plain string in Secrets Manager, named by ANTHROPIC_KEY_SECRET in
 * ANTHROPIC_KEY_REGION. It is read once and held for five minutes, and so is
 * its absence, so a key created after the task started is picked up without
 * a restart and a missing one costs one lookup every five minutes, not one
 * per screen. The key is never logged, and nor is anything that carries it.
 */
import Anthropic from '@anthropic-ai/sdk';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { bedrock } from './aws.js';
import type { Config } from './config.js';

/** What a screen asks: the Messages API body, less the model. */
export interface ClaudeAsk {
  max_tokens: number;
  system: string;
  messages: Anthropic.MessageParam[];
}

/** How long a key, or its absence, is believed. */
export const KEY_TTL_MS = 5 * 60_000;

/** Everything the router reaches outside itself, so a test can stand in for each. */
export interface ClaudeDeps {
  /** The API key, or undefined where there is none to use. */
  loadKey(cfg: Config): Promise<string | undefined>;
  /** The answer's text through the Claude API. */
  direct(cfg: Config, key: string, ask: ClaudeAsk): Promise<string>;
  /** The answer's text through Bedrock. */
  bedrock(cfg: Config, ask: ClaudeAsk): Promise<string>;
  /** One line, as the rest of the server logs: JSON on stdout. */
  warn(fields: Record<string, unknown>): void;
}

/** The answer's text, from the Claude API where it can answer and Bedrock where it cannot. */
export async function askClaude(cfg: Config, ask: ClaudeAsk, deps: ClaudeDeps = defaultDeps): Promise<string> {
  // No secret named is a deployment that chose Bedrock: nothing to warn about.
  if (!cfg.anthropicKeySecret) return deps.bedrock(cfg, ask);
  let key: string | undefined;
  try {
    key = await deps.loadKey(cfg);
  } catch (e) {
    deps.warn({ event: 'claude-api-fallback', reason: 'key-unreadable', error: errorName(e) });
    return deps.bedrock(cfg, ask);
  }
  if (!key) {
    deps.warn({ event: 'claude-api-fallback', reason: 'no-key' });
    return deps.bedrock(cfg, ask);
  }
  try {
    return await deps.direct(cfg, key, ask);
  } catch (e) {
    const reason = fallbackReason(e);
    if (!reason) throw e;
    deps.warn({
      event: 'claude-api-fallback',
      reason,
      ...(e instanceof Anthropic.APIError && e.status !== undefined ? { status: e.status } : {}),
    });
    return deps.bedrock(cfg, ask);
  }
}

/** Why an error from the Claude API sends the ask to Bedrock, or undefined where it does not. */
export function fallbackReason(e: unknown): string | undefined {
  // Connection errors carry no status; a timeout is one of them.
  if (e instanceof Anthropic.APIConnectionError) return 'unreachable';
  if (!(e instanceof Anthropic.APIError) || e.status === undefined) return undefined;
  if (e.status === 429) return 'rate-limited';
  if (e.status >= 500) return e.status === 529 ? 'overloaded' : 'server-error';
  if (e.status === 401 || e.status === 403) return 'key-refused';
  if (e.status === 402) return 'billing';
  // The API answers a spent balance with a 400 whose message says so; there is
  // no type of its own to read, so the words are what there is.
  if (e.status === 400 && /credit balance/i.test(e.message)) return 'credit-balance';
  return undefined;
}

/** The error's class name and nothing else: a message can quote a request. */
function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/** Every block's text, joined, read as the screens always read Bedrock's answer. */
const textOf = (content: { text?: string }[] | undefined): string =>
  content?.map((c) => c.text ?? '').join('') ?? '';

// ---------------------------------------------------------------------------
// The real roads.
// ---------------------------------------------------------------------------

let keyCache: { value: string | undefined; at: number } | undefined;
let clientCache: { key: string; client: Anthropic } | undefined;
let keyClient: SecretsManagerClient | undefined;

async function loadKeyFromSecret(cfg: Config): Promise<string | undefined> {
  if (keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.value;
  keyClient ??= new SecretsManagerClient({ region: cfg.anthropicKeyRegion });
  let value: string | undefined;
  try {
    const r = await keyClient.send(new GetSecretValueCommand({ SecretId: cfg.anthropicKeySecret }));
    value = r.SecretString?.trim() || undefined;
  } catch (e) {
    // Not created yet reads as no key, and is believed for the same five
    // minutes. Anything else (no permission, Secrets Manager down) is thrown
    // and asked again next time.
    if ((e as { name?: string })?.name !== 'ResourceNotFoundException') throw e;
  }
  keyCache = { value, at: Date.now() };
  return value;
}

async function askDirect(cfg: Config, key: string, ask: ClaudeAsk): Promise<string> {
  if (clientCache?.key !== key) {
    // One retry inside the SDK, then Bedrock: a screen waiting out the SDK's
    // default two retries and ten-minute timeout is a posting nobody sees.
    clientCache = { key, client: new Anthropic({ apiKey: key, maxRetries: 1, timeout: 30_000 }) };
  }
  const r = await clientCache.client.messages.create({ model: cfg.anthropicModel, ...ask });
  return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

async function askBedrock(cfg: Config, ask: ClaudeAsk): Promise<string> {
  const r = await bedrock.send(
    new InvokeModelCommand({
      modelId: cfg.bedrockModelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', ...ask }),
    }),
  );
  return textOf(JSON.parse(new TextDecoder().decode(r.body)).content);
}

export const defaultDeps: ClaudeDeps = {
  loadKey: loadKeyFromSecret,
  direct: askDirect,
  bedrock: askBedrock,
  warn: (fields) => console.warn(JSON.stringify(fields)),
};
