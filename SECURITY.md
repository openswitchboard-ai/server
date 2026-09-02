# Security

## Reporting a vulnerability

Email **info@openswitchboard.ai**. Please do not open a public issue for a
security problem.

Useful things to include: what you found, how to reproduce it, which host or
route you were touching, and what an attacker could get out of it. A rough
proof-of-concept helps more than a polished one.

You should get a human reply within a few days. We will tell you what we found,
what we are doing about it, and when the fix ships. If you want credit in the
release note, say so and we will add it. There is no bug bounty yet.

## Scope

In scope: this repository, and the hosted deployment of it at
`mcp.openswitchboard.ai` and `my.openswitchboard.ai`.

Especially interesting, because the whole design rests on them:

- Anything that discloses a counterparty's budget ceiling or reserve floor.
- Anything that returns stage-3 data (first name, locality) without both humans'
  recorded opt-in.
- Anything that reaches `accepted-by-human` through an agent-facing API.
- Anything that lets an MCP bearer token act on the human pages, or a human
  session act on `/mcp`.
- Anything that gets a card into the index without passing screening.
- Anything that reads plaintext of an encrypted field without writing the
  consent-log audit line.

Out of scope: findings from automated scanners with no demonstrated impact,
missing headers with no exploit path, rate limits on unauthenticated endpoints,
and social engineering of the operators.

## Testing rules

Test against your own accounts only. Registration on the hosted network is
closed until launch, so most testing will be against your own deployment of this
code. Do not run load or denial-of-service tests against the hosted service, and
stop as soon as you can see that a bug is real — please do not go digging through
other people's data to prove it.
