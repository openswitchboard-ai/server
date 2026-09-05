/**
 * The two human accounts a duet run needs: created on dev, an agent key minted
 * for each, and a first name + area written onto each shared profile so a
 * stage-3 opt-in has something to disclose.
 *
 * A RUN CALLS THIS ITSELF, EVERY TIME. It used to be a one-time step whose
 * output the runs then shared, and that quietly broke the experiment: an
 * account remembers everything, so by the fourth run each agent connected,
 * read its own account's accumulated history — earlier listings, dozens of
 * interest events — and told its human the errand was already handled. Neither
 * posted, no database event was recorded, and the run deadlocked. Continuity
 * across sessions is a product feature and works exactly as intended; it is
 * simply not the thing this eval measures, which is two agents starting from
 * nothing. So every run provisions its own pair and the pair is disposable.
 *
 *   RUN_DUET_PROVISION=1 AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 \
 *     OSB_RATELIMIT_BYPASS=<ssm /osb/dev/ratelimit-bypass> \
 *     npx tsx test/duet/provision.ts
 *
 * Running it standalone is still supported — it is what `--reuse` on the run
 * consumes — and everything it produces lands in
 * realism-reports/.duet-actors.json (gitignored, 0600). Standalone re-running
 * with an existing file is refused unless --force is passed, so a stray manual
 * re-run cannot orphan a pair of accounts nobody meant to make.
 *
 * It does NOT touch either box. Wiring the keys into the two OpenClaw homes is
 * test/duet/box.ts, which the run does at start-up (and undoes at teardown).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  bootstrapActor,
  createAgentKey,
  setSharedProfile,
  readSharedProfilePage,
} from '../integration/helpers.js';
import { ACTORS_FILE, DuetActor, DuetActors, writeActors } from './actors.js';

async function make(
  side: DuetActor['side'],
  firstName: string,
  locality: string,
): Promise<DuetActor> {
  console.log(`provisioning ${side} ("${firstName}", ${locality}) on dev — this can take minutes…`);
  const a = await bootstrapActor(firstName, locality);
  console.log(`  account ${a.accountId}`);
  // The shared profile is what stage-3 discloses. bootstrapActor seeds the
  // account row with these, but the SHARED-profile page is a separate,
  // human-authored surface — write it explicitly so the opt-in has content.
  await setSharedProfile(a.jar, firstName, locality);
  const seen = await readSharedProfilePage(a.jar);
  if (seen.firstName !== firstName || seen.locality !== locality) {
    throw new Error(
      `${side}: shared profile did not stick (page shows "${seen.firstName}" / "${seen.locality}")`,
    );
  }
  const key = await createAgentKey(a.jar, a.pin, `duet-${side}-${randomBytes(3).toString('hex')}`);
  console.log(`  agent key ${key.token.slice(0, 14)}… (handle ${key.keyId.slice(0, 8)})`);
  return {
    side,
    firstName,
    locality,
    email: a.email,
    accountId: a.accountId,
    pin: a.pin,
    agentKey: key.token,
    agentKeyId: key.keyId,
    accessToken: a.accessToken,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Mint one run's pair. `runId` only labels the names; every account, key and
 * email is new whatever is passed.
 */
export async function provisionPair(runId?: string): Promise<DuetActors> {
  // Names carry a per-provision suffix so one run's cards never collide with
  // the last run's on the shared dev board, and so the identity-leak scan has
  // a string that can only have come from THIS run.
  const suffix = randomBytes(2).toString('hex');
  const priya = await make('priya', `Priya${suffix}`, 'Canberra');
  const marlowe = await make('marlowe', `Marlowe${suffix}`, 'Canberra');
  return { priya, marlowe, provisionedAt: new Date().toISOString(), runId };
}

async function main(): Promise<number> {
  if (process.env.RUN_DUET_PROVISION !== '1') {
    console.log('refusing to run: set RUN_DUET_PROVISION=1 (this creates real accounts on dev).');
    return 2;
  }
  if (existsSync(ACTORS_FILE) && !process.argv.includes('--force')) {
    console.log(`${ACTORS_FILE} already exists; pass --force to provision a new pair.`);
    return 2;
  }
  const actors = await provisionPair();
  const { priya, marlowe } = actors;
  writeActors(actors);
  console.log(`\nwrote ${ACTORS_FILE}`);
  console.log(`  priya   ${priya.accountId}  ${priya.firstName}`);
  console.log(`  marlowe ${marlowe.accountId}  ${marlowe.firstName}`);
  return 0;
}

// Only when this file IS the command. The run imports `provisionPair` from
// here, and an unguarded main() would fire on that import and exit the run
// before it had done anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
