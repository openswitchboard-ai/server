/**
 * The SNS envelope's own signature, checked the documented way.
 *
 * The SES event queue is fed through SNS with raw message delivery, so in the
 * ordinary course the SQS body IS the SES event and there is no envelope to
 * check. But the worker unwraps an envelope if one appears — a subscription
 * attribute can be changed, and a regression that silently dropped every
 * suppression event would be worse than one that was noisy about it — and an
 * envelope that arrives unchecked is a message anybody who can reach the queue
 * can write. A forged Permanent bounce would suppress an address; a forged
 * complaint would suppress a whole account's mail.
 *
 * So: when the body carries an envelope, it carries a signature, and the
 * signature is checked before anything in it is believed.
 *
 * THE CHECK, as Amazon documents it:
 *   1. build the canonical string from the fields of that message type, in the
 *      documented order, each as "name\nvalue\n";
 *   2. fetch the signing certificate from SigningCertURL — which must be an
 *      https URL on sns.<region>.amazonaws.com (or the China and GovCloud
 *      spellings), because an attacker who chooses the certificate chooses the
 *      answer;
 *   3. verify with SHA1 for SignatureVersion 1 and SHA256 for version 2.
 *
 * Certificates are cached by URL for the life of the process: SNS rotates them
 * rarely, and a fetch per message would be a fetch per message an attacker
 * could ask for.
 *
 * No dependency was added for this. The published `sns-validator` package is a
 * thin wrapper over exactly the steps above, and it carries its own transitive
 * tree into an image that sends mail; twenty lines here are easier to read than
 * a dependency, and they are the lines that matter.
 */
import { createVerify } from 'node:crypto';
import { get } from 'node:https';

export interface SnsEnvelope {
  Type?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  [k: string]: unknown;
}

/** The fields that go into the canonical string, per message type, in order. */
const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];
const SUBSCRIPTION_FIELDS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
];

/**
 * An https URL on an SNS host and nowhere else. Checked with the URL parser
 * rather than a regular expression over the raw string: "https://sns.us-west-2.
 * amazonaws.com.evil.example/x" matches a careless pattern and is not an
 * Amazon host, and `hostname` is the field that settles it.
 */
export function isSnsCertUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname);
}

function canonicalString(msg: SnsEnvelope): string | undefined {
  const fields =
    msg.Type === 'Notification'
      ? NOTIFICATION_FIELDS
      : msg.Type === 'SubscriptionConfirmation' || msg.Type === 'UnsubscribeConfirmation'
        ? SUBSCRIPTION_FIELDS
        : undefined;
  if (!fields) return undefined;
  let out = '';
  for (const f of fields) {
    const v = (msg as any)[f];
    // Absent optional fields (Subject) are left out entirely, which is what
    // Amazon's own canonicalisation does.
    if (v === undefined || v === null) continue;
    out += `${f}\n${String(v)}\n`;
  }
  return out;
}

const certs = new Map<string, Promise<string>>();

function fetchCert(url: string): Promise<string> {
  const cached = certs.get(url);
  if (cached) return cached;
  const p = new Promise<string>((resolve, reject) => {
    const req = get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`signing certificate fetch returned ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy(new Error('signing certificate is implausible'));
      });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('signing certificate fetch timed out')));
    req.on('error', reject);
  });
  // A failed fetch is not cached: the next message tries again rather than
  // inheriting one bad afternoon for the life of the process.
  p.catch(() => certs.delete(url));
  certs.set(url, p);
  return p;
}

/**
 * True when this envelope's signature checks out. False for anything else:
 * an unknown message type, a certificate URL that is not Amazon's, a fetch
 * that failed, a signature that does not verify.
 */
export async function verifySnsSignature(msg: SnsEnvelope): Promise<boolean> {
  if (typeof msg.Signature !== 'string') return false;
  if (!isSnsCertUrl(msg.SigningCertURL)) return false;
  const canonical = canonicalString(msg);
  if (canonical === undefined) return false;
  const algorithm = msg.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
  let pem: string;
  try {
    pem = await fetchCert(msg.SigningCertURL as string);
  } catch {
    return false;
  }
  try {
    const v = createVerify(algorithm);
    v.update(canonical, 'utf8');
    v.end();
    return v.verify(pem, msg.Signature, 'base64');
  } catch {
    return false;
  }
}
