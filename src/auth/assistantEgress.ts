/**
 * Which assistant platform, if any, a caller's address belongs to.
 *
 * WHY THIS EXISTS (6 November 2026). When somebody adds the switchboard as a
 * connector in Claude or ChatGPT, it is the platform's own servers that call
 * /oauth/register, not the person's machine. Every person on that platform
 * therefore arrives from the same small set of addresses, and the ordinary
 * per-IP registration cap (5 an hour) would let five people connect in an
 * hour and turn everybody after them away. Registrations from these addresses
 * get their own, much larger cap instead (abuseLimit.ts,
 * platformClientRegistrationLimiter). They are still capped: anybody with an
 * account on the platform can make it register, so the cap is what bounds the
 * rows a loop could make.
 *
 * Nothing else is loosened. The address only picks which registration cap
 * applies; signing in, consent and every tool call are the same for everyone.
 *
 * SOURCES.
 * - Anthropic: the outbound ranges on
 *   https://platform.claude.com/docs/en/api/ip-addresses (read 2026-11-06).
 *   Short and published by hand there, so written by hand here.
 * - OpenAI: https://openai.com/chatgpt-connectors.json, regenerated into
 *   openaiConnectorEgress.ts by scripts/refresh-assistant-egress.ts.
 * A range that goes stale only means those callers fall back to the ordinary
 * cap; refresh both before a directory listing goes live and now and then
 * after.
 */
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { OPENAI_CONNECTOR_EGRESS } from './openaiConnectorEgress.js';

export type AssistantPlatform = 'anthropic' | 'openai';

export const ANTHROPIC_OUTBOUND: readonly string[] = [
  '160.79.104.0/21',
  '153.61.208.0/20',
];

function blockListOf(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/');
    const prefix = Number(bits);
    if (isIPv4(addr)) list.addSubnet(addr, prefix, 'ipv4');
    else if (isIPv6(addr)) list.addSubnet(addr, prefix, 'ipv6');
    else throw new Error(`assistantEgress: not a CIDR: ${c}`);
  }
  return list;
}

const LISTS: Array<[AssistantPlatform, BlockList]> = [
  ['anthropic', blockListOf(ANTHROPIC_OUTBOUND)],
  ['openai', blockListOf(OPENAI_CONNECTOR_EGRESS)],
];

/** The platform whose published outbound ranges hold `ip`, or undefined. */
export function assistantPlatformOf(ip: string | undefined): AssistantPlatform | undefined {
  if (!ip) return undefined;
  // An IPv4 address seen through a dual-stack socket arrives as ::ffff:a.b.c.d.
  const bare = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  const family = isIPv4(bare) ? 'ipv4' : isIPv6(bare) ? 'ipv6' : undefined;
  if (!family) return undefined;
  for (const [platform, list] of LISTS) {
    if (list.check(bare, family)) return platform;
  }
  return undefined;
}
