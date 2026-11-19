/**
 * THE REHEARSAL'S OWN ANTHROPIC API KEY, READ FROM A FILE, NEVER PRINTED.
 *
 * Since 18 November 2026 the rehearsal speaks to Claude on the organisation's
 * Claude API credits by default: the simulated humans (human.ts) and the
 * Claude Code drivers (drivers/claudeCode.ts). Until then both went through
 * Bedrock and were billed to the AWS account behind the run's AWS_PROFILE.
 *
 * The key lives in a 0600 file (REHEARSAL_ANTHROPIC_KEY_FILE, default
 * ~/.osb-rehearsal-anthropic-key) that a person puts there; nothing here
 * creates, logs or writes it. No file, and the run goes through Bedrock as
 * before and says so once. REHEARSAL_BEDROCK=1 sends everything through
 * Bedrock even with a key.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The key, or undefined where there is none or the run asked for Bedrock. */
export function rehearsalAnthropicKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.REHEARSAL_BEDROCK === '1') return undefined;
  const file = env.REHEARSAL_ANTHROPIC_KEY_FILE ?? join(homedir(), '.osb-rehearsal-anthropic-key');
  if (!existsSync(file)) return undefined;
  const key = readFileSync(file, 'utf8').trim();
  return key || undefined;
}

let warned = false;
/** One line, once a run, when a Claude call is about to go to Bedrock for want of a key. */
export function warnBedrockOnce(what: string): void {
  if (warned || process.env.REHEARSAL_BEDROCK === '1') return;
  warned = true;
  console.warn(
    `rehearsal: no Anthropic key file (REHEARSAL_ANTHROPIC_KEY_FILE or ~/.osb-rehearsal-anthropic-key); ` +
      `${what} goes through Bedrock, billed to the AWS account`,
  );
}
