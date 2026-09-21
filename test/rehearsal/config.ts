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
/**
 * PUT A PROFILE BACK TO ITS BASELINE rather than deleting its way there.
 *
 * The deep clean is surgical — named tables, named cron jobs, named skill
 * folders — and on 20 September 2026 one line of it began failing silently on
 * the second run of every series, taking the rest of the script with it under
 * `set -e`. Sessions and memory went un-wiped for about a dozen runs while the
 * log still read "gateway active, key probe 200".
 *
 * The restore lays down a tarball taken once from a profile we were happy
 * with. There is no list to fall out of step with what an assistant actually
 * writes, and no partial success. The deep clean stays on the box as the way
 * that baseline is MADE (run it, look at the profile, then osb-snapshot.sh).
 */
export const RESTORE = '~/osb-restore.sh';
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
 * HOW LONG THE SUITE WAITS FOR THE NEXT TURN TO ARRIVE.
 *
 * THIS NUMBER HAS MOVED THREE TIMES AND THE SHAPE WAS WRONG EVERY TIME. Eight
 * minutes on the stage, then twelve on the stage, then eight per side — and
 * each time a run died that had done nothing wrong. The last of them was a
 * seller working steadily through a NEEDS_DETAIL round and reading its human's
 * figure back, cut off mid-sentence at eight minutes because the exchanges
 * happened to be slow that afternoon.
 *
 * A wall clock cannot tell slow from stuck. The thing this was written to
 * catch — on 20 September 2026, a run that sat in a wait loop for half an hour
 * with nothing moving either way — is a STALL, and a stall is measured from
 * the last thing that happened, not from the start.
 *
 * So the clock now starts again every time an assistant says anything. Five
 * minutes without a single turn is a hang: the longest legitimate turn holds a
 * press wait of fifty seconds and a handful of tool calls, nowhere near this.
 * A run that is merely slow is left alone, which is the whole point, and the
 * half-hour wait loop still dies at five minutes rather than thirty.
 *
 * The other two bounds are unchanged and do the rest of the work: ROUND_CAP
 * stops a side ping-ponging for ever even while turns keep arriving, and
 * RUN_BUDGET_MS stops six patient stages adding up to an afternoon.
 */
export const STALL_BUDGET_MS = Number(process.env.REHEARSAL_STALL_BUDGET_MS ?? 300_000);
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
