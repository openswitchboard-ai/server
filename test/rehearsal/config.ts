/**
 * Everything the suite needs from the outside, read in one place, and the one
 * secret it fetches for itself.
 *
 * DEV ONLY, AND IT REFUSES TO BE ANYTHING ELSE. Every URL here is checked for
 * `-dev` before a run starts. This harness deep-cleans two assistants, mints
 * accounts and withdraws every card those accounts own; pointed at prod it
 * would be an outage.
 *
 * NOTHING HERE IS EVER PRINTED. The rate-limit bypass token is read from SSM
 * inside the process and put straight into process.env for
 * integration/helpers.ts to pick up; it is never logged, never written to a
 * report, and never passed on a command line.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export const MCP_URL = process.env.OSB_BASE_URL ?? 'https://mcp-dev.openswitchboard.ai';
export const COUNTER_URL = process.env.OSB_COUNTER_URL ?? 'https://my-dev.openswitchboard.ai';
export const ENV_NAME = process.env.OSB_TEST_ENV ?? 'dev';
export const REGION = process.env.AWS_REGION ?? 'us-east-1';

/** The CloudWatch group the name-only tool-call lines land in. */
export const TOOL_LOG_GROUP = process.env.OSB_TOOL_LOG_GROUP ?? `/osb/${ENV_NAME}/server`;

/**
 * The model the simulated humans speak with: the same cheap Haiku-class id the
 * screening path uses (test/localsmoke.ts pins it, src/intake/checks/modelScreen.ts
 * calls it). Overridable, because the id moves and nobody should edit a scenario
 * file to keep up with it.
 */
export const HUMAN_MODEL_ID =
  process.env.REHEARSAL_HUMAN_MODEL ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/** The Secrets Manager secret the transcript scorer's key lives in. */
export const JEV_SECRET = process.env.REHEARSAL_JEV_SECRET ?? `osb/${ENV_NAME}/jev`;

/** The OpenClaw box, and the deep-clean script installed on it. */
export const DEEP_CLEAN = '~/osb-deep-clean.sh';
export const AGENT_HOMES = {
  nagatha: { dir: '.openclaw', unit: 'openclaw-gateway', profile: '', port: 18789 },
  bilby: { dir: '.openclaw-bilby', unit: 'openclaw-gateway-bilby', profile: '--profile bilby', port: 18790 },
} as const;

/** How long a run will wait for the screening verdict and then the matcher. */
export const SCREEN_WAIT_MS = Number(process.env.REHEARSAL_SCREEN_WAIT_MS ?? 240_000);
/** The founder's own three minutes: the pair must exist within this of posting. */
export const MEET_WAIT_MS = Number(process.env.REHEARSAL_MEET_WAIT_MS ?? 180_000);
/** Neutral nudges per side, per stage, before a stage gives up. */
export const ROUND_CAP = Number(process.env.REHEARSAL_ROUND_CAP ?? 8);
/** The gap between nudges, so two assistants are not talked over. */
export const GAP_MS = Number(process.env.REHEARSAL_GAP_MS ?? 20_000);

/**
 * HOW LONG ONE SIDE OF ONE STAGE MAY TAKE, IN WALL-CLOCK TIME.
 *
 * ROUND_CAP counts turns, not minutes, and the two are not the same thing: an
 * assistant that holds the line on a press for fifty seconds and then does it
 * again spends five minutes inside ONE round. On 20 September 2026 a run sat
 * in that loop for thirty minutes — the assistant waiting, its human never
 * pressing, nothing moving either way — and nothing in the suite was counting.
 *
 * Running out of this is a FAILURE and not a void: the rig did not break, an
 * assistant spent half an hour getting nowhere, and that is a finding about
 * the assistant rather than about us. A person watching would have stopped it
 * long before, and the suite should too.
 */
export const STAGE_BUDGET_MS = Number(process.env.REHEARSAL_STAGE_BUDGET_MS ?? 480_000);
/** And the whole run, so six patient stages cannot add up to an afternoon. */
export const RUN_BUDGET_MS = Number(process.env.REHEARSAL_RUN_BUDGET_MS ?? 2_700_000);

/** The neutral nudge. It says nothing about springs, prices or what to do. */
export const NUDGE = 'anything new?';

export function assertDev(): void {
  for (const [what, url] of [
    ['OSB_BASE_URL', MCP_URL],
    ['OSB_COUNTER_URL', COUNTER_URL],
  ] as const) {
    if (!/-dev\./.test(url)) {
      throw new Error(
        `refusing to run: ${what} is ${url}, which is not a dev host. ` +
          'The rehearsal suite deep-cleans two assistants and withdraws every card the ' +
          'accounts it makes own; it may only ever point at dev.',
      );
    }
  }
  if (ENV_NAME !== 'dev') {
    throw new Error(`refusing to run: OSB_TEST_ENV is ${ENV_NAME}, not dev.`);
  }
}

/**
 * The rate-limit bypass token, fetched from SSM and put into the environment
 * where integration/helpers.ts reads it.
 *
 * WHY IT IS NEEDED. Every run signs two humans in by email code, and the
 * sign-in path is rate limited per address and per source. A series of six runs
 * without the bypass spends the allowance in the first two and then fails on
 * the door rather than on anything it set out to measure.
 *
 * Returns only whether it found one. The value itself never leaves this
 * function except into process.env.
 */
export async function loadRatelimitBypass(): Promise<boolean> {
  if (process.env.OSB_RATELIMIT_BYPASS) return true;
  try {
    const ssm = new SSMClient({ region: REGION });
    const p = await ssm.send(
      new GetParameterCommand({ Name: `/osb/${ENV_NAME}/ratelimit-bypass`, WithDecryption: true }),
    );
    const v = p.Parameter?.Value;
    if (!v) return false;
    process.env.OSB_RATELIMIT_BYPASS = v;
    return true;
  } catch {
    // A missing parameter is not fatal: the run simply spends the ordinary
    // allowance. The reason is not printed, because it can quote the name.
    return false;
  }
}
