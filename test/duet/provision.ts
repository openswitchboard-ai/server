/**
 * ONE-TIME INFRA for the duet eval (Part 1). Creates the two human accounts the
 * run needs, mints an agent key for each, and puts a first name + area on each
 * shared profile so a stage-3 opt-in has something to disclose.
 *
 *   RUN_DUET_PROVISION=1 AWS_PROFILE=openswitchboard AWS_REGION=us-east-1 \
 *     OSB_RATELIMIT_BYPASS=<ssm /osb/dev/ratelimit-bypass> \
 *     npx tsx test/duet/provision.ts
 *
 * Everything it produces lands in realism-reports/.duet-actors.json (gitignored,
 * 0600). Re-running with an existing file is refused unless --force is passed,
 * so a stray re-run cannot orphan a pair of accounts on dev.
 *
 * It does NOT touch either box. Wiring the keys into the two OpenClaw homes is
 * test/duet/box.ts, which the run does at start-up (and undoes at teardown).
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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

async function main(): Promise<number> {
  if (process.env.RUN_DUET_PROVISION !== '1') {
    console.log('refusing to run: set RUN_DUET_PROVISION=1 (this creates real accounts on dev).');
    return 2;
  }
  if (existsSync(ACTORS_FILE) && !process.argv.includes('--force')) {
    console.log(`${ACTORS_FILE} already exists; pass --force to provision a new pair.`);
    return 2;
  }
  // Names carry a run suffix so a re-provision never collides with the last
  // pair's cards on the shared dev board, and so the identity-leak scan has a
  // string that can only have come from this run.
  const suffix = randomBytes(2).toString('hex');
  const priya = await make('priya', `Priya${suffix}`, 'Canberra');
  const marlowe = await make('marlowe', `Marlowe${suffix}`, 'Canberra');
  const actors: DuetActors = { priya, marlowe, provisionedAt: new Date().toISOString() };
  writeActors(actors);
  console.log(`\nwrote ${ACTORS_FILE}`);
  console.log(`  priya   ${priya.accountId}  ${priya.firstName}`);
  console.log(`  marlowe ${marlowe.accountId}  ${marlowe.firstName}`);
  return 0;
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(e);
  process.exit(1);
});
