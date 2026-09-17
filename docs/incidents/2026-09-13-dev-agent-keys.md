# Two dev agent keys committed to the public repo (13 September 2026)

## What happened

Commit `1924688e` (13 September 2026) added `bilby-fixed.json` and
`nagatha-fresh.json` to the repository. Both were credential files for
dev test agents: an account id, an email, a six-digit PIN, an agent key
(`osb_ak_…`) and a key id. Commit `ee5250fa` (14 September) removed them
from tracking and added them to `.gitignore`. History was not rewritten,
so the blobs remain readable to anyone who fetches the repository.

## What was done

- 14 September: both accounts were wiped on dev; both keys were sent to
  dev and to production and rejected (HTTP 401). The two findings were
  listed in `.gitleaksignore` with that justification.
- 17 September: the security audit re-checked both keys against
  `mcp.openswitchboard.ai` and `mcp-dev.openswitchboard.ai` by POSTing an
  MCP `initialize` with each as a bearer token. All four answers were
  HTTP 401. Recorded here so the check no longer rests on a commit
  message.
- 17 September: a gitleaks rule for the `osb_ak_` prefix was added to
  every repository's CI, so a key of this shape is caught by its own
  pattern rather than by luck.

## What remains

- The two files still exist on the developer's machine with the same
  values. They are ignored by git. Regenerate them with the dev reset
  script the next time dev is reset so no file on disk matches a public
  blob.
- History rewrite: decided against, 17 September 2026. The keys are dead and
  what remains readable is two revoked strings, two wiped account ids, a test
  email and a test PIN. (An earlier history clean-up ran on 9 September, four
  days before this commit, so it did not cover it.)
