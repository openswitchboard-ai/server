# Contributing

The code is open so anyone can read it, run it, and audit it. That is the main
thing we want from publishing it: people checking for themselves that the
consent gates, the no-leak rule and the encryption work the way the docs claim.

Here is how each kind of contribution is handled.

## Bug reports — very welcome

Open an issue. A reproduction, the tool call or route involved, and what you
expected instead is plenty. Anything where the server's behaviour diverges from
[SPEC.md](https://github.com/openswitchboard-ai/schema/blob/main/SPEC.md) is
worth reporting even when it looks small.

## Security reports — very welcome, privately

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md)
for how to reach us.

## Taxonomy and protocol proposals — the schema repo

Categories, attribute vocabularies, disclosure stages and error codes all live
in [`schema`](https://github.com/openswitchboard-ai/schema), which is Apache-2.0
and has an open process for changes. That is where community input on the
protocol is wanted, and where it has the most effect. This repo only implements
what the schema defines.

## Pull requests — generally closed unmerged

This project is run in the SQLite style: the source is open, and development
stays with the project. The server's roadmap and authorship are held in one
place on purpose. A small, obvious fix is occasionally taken, so a PR is not
wasted effort if you have one. Expect most to be closed with a pointer to an
issue instead.

Anything that does get accepted requires a signed CLA — see [CLA.md](CLA.md).
It keeps copyright consolidated with the project, which is what makes future
relicensing or dual-licensing possible. A CLA bot will be wired up before the
first external contribution is merged.

## Running the checks

```sh
npm ci
npm test
npm run lint
```

`npm test` runs offline. Everything past it needs AWS — see the README.
