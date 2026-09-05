/**
 * The 0.E sample set: one realistic render of every template (plus blind
 * variants where the distinction matters), shared by the screenshot renderer
 * and the [SAMPLE] send script. Fixture data is plainly fictitious.
 */
import {
  renderApproval,
  renderDigest,
  renderKillSwitch,
  renderRenewal,
  renderSecurityNotice,
  renderSummons,
  renderVerification,
  type EmailContent,
  type FooterLinks,
} from '../src/email/templates.js';

/** Human-pages origin for the env the samples are sent from. Links in a
 *  placement test must resolve on the domain the mail is From: iCloud and
 *  Gmail check, and a dead host (my-prod.…) or dev links in prod mail read
 *  as spam. */
export function humanOrigin(envName: string): string {
  return envName === 'prod'
    ? 'https://my.openswitchboard.ai'
    : `https://my-${envName}.openswitchboard.ai`;
}

export function sampleSet(envName = 'dev'): { name: string; content: EmailContent }[] {
  const COUNTER = humanOrigin(envName);
  const links: FooterLinks = {
    settingsUrl: `${COUNTER}/settings`,
    ledgerUrl: `${COUNTER}/ledger`,
    unsubUrl: `${COUNTER}/email/unsub?t=sample`,
  };
  const counterUrl = `${COUNTER}/`;
  return [
    {
      name: 'verification',
      content: renderVerification(
        { code: '480291', link: `${COUNTER}/verify?t=sample`, purpose: 'register' },
        links,
      ),
    },
    {
      name: 'approval',
      content: renderApproval(
        {
          link: `${COUNTER}/a/sample`,
          summary: 'An offer on your Garden tools match is waiting for your decision.',
          blind: false,
          counterUrl,
        },
        links,
      ),
    },
    {
      name: 'summons',
      content: renderSummons(
        { count: 1, categoryLabel: 'Garden tools', blind: false, counterUrl },
        links,
      ),
    },
    {
      name: 'summons-blind',
      content: renderSummons({ count: 1, blind: true, counterUrl }, links),
    },
    {
      name: 'digest',
      content: renderDigest(
        {
          cadence: 'weekly',
          blind: false,
          counterUrl,
          items: [
            { type: 'WANT', categoryLabel: 'Garden tools', newOpposite: 4, nearMisses: 2 },
            { type: 'HAVE', categoryLabel: 'Mountain bikes', newOpposite: 11, nearMisses: 0 },
            { type: 'WANT', categoryLabel: 'Keyboards & pianos', newOpposite: null, nearMisses: 1 },
          ],
        },
        links,
      ),
    },
    {
      name: 'renewal',
      content: renderRenewal(
        {
          blind: false,
          counterUrl,
          renewAllUrl: `${COUNTER}/renew?t=sample`,
          cards: [
            { type: 'WANT', categoryLabel: 'Garden tools', expiresAt: new Date(Date.now() + 4 * 86400e3), expiringSoon: true },
            { type: 'HAVE', categoryLabel: 'Mountain bikes', expiresAt: new Date(Date.now() + 41 * 86400e3), expiringSoon: false },
          ],
        },
        links,
      ),
    },
    {
      name: 'kill-switch-on',
      content: renderKillSwitch({ on: true, counterUrl }, links),
    },
    {
      name: 'kill-switch-off',
      content: renderKillSwitch({ on: false, counterUrl }, links),
    },
    {
      name: 'security-agent-authorized',
      content: renderSecurityNotice(
        { event: 'agent-authorized', agentName: 'Claude for Chores', counterUrl },
        links,
      ),
    },
    {
      name: 'security-pin-changed',
      content: renderSecurityNotice({ event: 'pin-changed', counterUrl }, links),
    },
  ];
}
