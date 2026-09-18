# vendor/photodna

OpenSwitchboard uses PhotoDNA technology licensed by Microsoft at no cost.

The two files that belong in this directory are not in this repository and
never will be. They are Microsoft confidential, licensed to OpenSwitchboard
under the PhotoDNA licence, and that licence does not let us redistribute them.
Anyone forking this repository has to obtain their own licence from Microsoft
before any of this can run; nothing here will work without it, and the server
says so at boot and carries on.

## What goes here

From the PhotoDNA EdgeHashGeneration SDK, version <sdk-version>, the `webassembly`
directory:

| file | SHA-256 |
| --- | --- |
| `photoDnaEdgeHash.js` | `<sdk-file-sha256>` |
| `photoDnaEdgeHash.wasm` | `<sdk-file-sha256>` |

Those two checksums are Microsoft's own published values, and they are also
embedded in `src/safety/photodna.ts`. The loader reads both files at boot and
refuses to run either one whose digest does not match, so a swapped or
truncated file turns the check off rather than quietly hashing with something
nobody licensed. A third file ships in the same directory of the SDK
(`photoDnaEdgeHashS.js`, the browser worker wrapper); it is not used here and
does not belong in this directory.

## How they get onto a deployed task

They are not in the image because they are not in git. A private per-account
bucket holds them, the deploy workflow copies them into this directory just
before `cdk deploy`, and the Docker build takes whatever is here. A deploy that
cannot find them warns and carries on: the server then reports PhotoDNA off,
and every photo still goes through the rest of the checks.

The `.gitignore` in the repository root ignores everything in this directory
except this file. Copying the two files here to run the hashing tests locally
is expected and safe; `git status` will not show them.
