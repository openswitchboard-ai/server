/**
 * TOOL DESCRIPTIONS PER FAMILY OF ASSISTANT (founder, November 2026).
 *
 * The descriptions in tools.ts were tuned over months so that assistants use
 * the switchboard correctly, and they stay the baseline every assistant gets.
 * Different assistants read the same words differently, though: ChatGPT's own
 * safety check reads instructions in a tool description as an attempt to
 * steer it and warns the person. So a family of assistant can carry its own
 * wording for any tool, without the others changing.
 *
 * WHAT KEEPS THE COPIES HONEST. An override is kept only for the tools a
 * family actually words differently; every other tool falls back to the
 * baseline. Each override records a short hash of the baseline text it was
 * written against, and a unit test fails when the baseline moves under it,
 * so a fix to the baseline cannot quietly miss a family. Rewrite the
 * override (or delete it) and update its hash.
 *
 * WHICH FAMILY. From the OAuth client the session's token belongs to: the
 * host its redirect goes to (the part no client can choose for itself) first,
 * then the name it registered under. An agent key, or anything unrecognised,
 * is the default family and gets the baseline.
 */
import { createHash } from 'node:crypto';
import { getPool } from '../db.js';

export type ClientFamily = 'default' | 'chatgpt' | 'claude' | 'gemini' | 'openclaw';

export interface DescriptionOverride {
  /** baselineHash() of the tools.ts description this was written against. */
  baseline: string;
  description: string;
}

export const DESCRIPTION_OVERRIDES: Record<Exclude<ClientFamily, 'default'>, Record<string, DescriptionOverride>> = {
  chatgpt: {},
  claude: {},
  gemini: {},
  openclaw: {},
};

/** The short hash an override records for the baseline it was written against. */
export function baselineHash(description: string): string {
  return createHash('sha256').update(description).digest('hex').slice(0, 12);
}

/** The family a registered client belongs to. Pure, so it can be tested. */
export function familyOf(clientName: string, redirectUris: string[]): ClientFamily {
  const hosts = redirectUris.map((u) => {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return '';
    }
  });
  const on = (...domains: string[]) =>
    hosts.some((h) => domains.some((d) => h === d || h.endsWith(`.${d}`)));
  if (on('chatgpt.com', 'openai.com')) return 'chatgpt';
  if (on('claude.ai', 'claude.com', 'anthropic.com')) return 'claude';
  if (on('gemini.google.com')) return 'gemini';
  const name = clientName.toLowerCase();
  if (/\bchatgpt\b|\bopenai\b|\bcodex\b/.test(name)) return 'chatgpt';
  if (/\bclaude\b/.test(name)) return 'claude';
  if (/\bgemini\b|\bantigravity\b/.test(name)) return 'gemini';
  if (/\bopenclaw\b/.test(name)) return 'openclaw';
  return 'default';
}

// A client's name and redirects never change after registration, so the
// answer is kept for the life of the process. Bounded, because anyone can
// register a client.
const cache = new Map<string, ClientFamily>();
const CACHE_MAX = 5000;

/** The family of the client this session's token belongs to. Never throws. */
export async function familyForClient(clientId: string | null): Promise<ClientFamily> {
  if (!clientId) return 'default';
  const hit = cache.get(clientId);
  if (hit) return hit;
  try {
    const r = await getPool().query('SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id = $1', [
      clientId,
    ]);
    const row = r.rows[0];
    const family = row
      ? familyOf(String(row.client_name ?? ''), Array.isArray(row.redirect_uris) ? row.redirect_uris.map(String) : [])
      : 'default';
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(clientId, family);
    return family;
  } catch {
    return 'default';
  }
}
