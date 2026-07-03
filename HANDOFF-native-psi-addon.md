# Handoff: native N-API PSI addon (board item 199653275)

You are picking up the native-addon half of a PSI performance task. This branch
(`psi-backend-selector`) already contains the toolchain-independent integration
work, done inside this repo's dev container. Your job is the part that needs a
Bazel + C++ build toolchain and per-OS CI, which that container could not
provide. This document is self-contained: it restates everything you need
without the originating conversation or the (private) project board.

You have, or should obtain, two repos:

- **psilink** (this repo) -- check out the `psi-backend-selector` branch. It is
  based on `staging`.
- **openmined-psi fork** -- the vendored PSI engine. A snapshot lives in this
  repo at `scratch/OpenMinedPSI` (Bazel project, no toolchain installed there).
  The shipped artifact is vendored at
  `lib/openmined-psi.js-2.0.6-seclink.1.tgz` and consumed as
  `@openmined/psi.js` (version `2.0.6-seclink.1`, the "seclink" fork).

## 1. Why this work exists

PSI linkage throughput is bound by elliptic-curve scalar multiplications over
NIST P-256. The current engine is a 32-bit WebAssembly build of
private-join-and-compute (via the OpenMined psi.js fork); WASM is 32-bit, so
OpenSSL/BoringSSL's optimized 64-bit-limb / assembly P-256 paths never engage.
Measured per scalar multiplication: ~345us in WASM vs ~54us native (node v26,
OpenSSL 3.6.2) -- about 6.4x, single-threaded. Large datasets run in node, not
the browser, so a native node addon plus per-core parallelism should turn the
large-roster case from multi-minute into seconds.

Hard constraint: **no new cryptographic primitive.** The addon MUST wrap the
same private-join-and-compute library, the same NIST P-256 curve, and the same
wire format as the WASM build. Interop with the existing WASM browser build is a
requirement -- a web peer on WASM and a node peer on the native addon must
produce identical results. A reimplementation that changed the curve or wire
format would break web<->node exchanges.

## 2. What is already done on this branch (do not redo)

A backend selector and the integration seam, wired and tested, with WASM as the
default-correct fallback. Behavior is currently unchanged (WASM everywhere)
because no addon exists yet.

- `packages/core/src/psiBackend.ts` -- `loadPsiBackend(loaders, options)`.
  Under node it prefers a native backend and falls back to WASM when no prebuild
  is present or the native loader throws; in the browser it always returns WASM.
  Loaders are injected, so core imports nothing at runtime. Exported from
  `packages/core/src/main.ts`.
- `apps/cli/src/psiBackend.ts` -- `loadCliPsiBackend()` wires the node WASM
  loader plus the native seam (see section 3). `apps/cli/src/protocol.ts` calls
  it where it used to call `await PSI()`.
- `apps/web/src/components/ExchangeView.tsx` -- routes the browser through
  `loadPsiBackend` with `isNode: false` (always WASM). Behavior preserved.
- `packages/core/test/psiBackend.test.ts` -- selector unit tests (native
  selected when a prebuild loads; falls back on null; falls back on throw;
  browser never consults the native loader; node default detection).
- `packages/core/test/vectors/psi-engine-wire-vectors.json` +
  `generate-psi-engine-wire-vectors.mjs` +
  `packages/core/test/psiEngineWireVectors.test.ts` -- the byte-for-byte interop
  contract (section 6).

Verified on this branch: `npm run typecheck && npm run lint && npm run format`;
`npm run test` (core 2071, cli 1058, web 586); `npm run test:browser -w
apps/web` (307, includes a live exchange through the selector).

## 3. The seam you plug into

The ONLY place the native backend attaches:

    apps/cli/src/psiBackend.ts  ->  loadNativePsiAddon()

Today it is:

```ts
async function loadNativePsiAddon(): Promise<PSILibrary | null> {
  return null;
}
```

Replace the body so it resolves a `PSILibrary` when a prebuild exists for the
running platform, and `null` when none does (so an unbuilt platform still falls
back to WASM). Do NOT throw for "not built" -- return `null`. A throw is
tolerated (the selector treats it as unavailable and falls back) but should be
reserved for genuinely broken loads. Keep everything else in the selection path;
it is already tested.

`PSILibrary` is defined at
`@openmined/psi.js/implementation/psi.d.ts`. Your addon (or a thin JS adapter
over it) must expose the same shape that `packages/core/src/participant.ts`
consumes:

- `library.server.createWithNewKey(revealIntersection)` and
  `library.server.createFromKey(keyBytes, revealIntersection)` returning a
  `Server` with `createSetupMessage(fpr, numClientInputs, inputs,
  dataStructure, sortingPermutation)`, `processRequest(request)`,
  `getPrivateKeyBytes()`, `delete()`.
- `library.client.createWithNewKey/createFromKey(...)` returning a `Client`
  with `createRequest(inputs)`, `getAssociationTable(setup, response)`,
  `getIntersection(...)`, `getPrivateKeyBytes()`, `delete()`.
- `library.dataStructure.Raw` (this protocol only ever uses the Raw structure).
- `library.serverSetup.deserializeBinary(bytes)` -> a `ServerSetup` with
  `serializeBinary()` and `getRaw()`.
- `library.request.deserializeBinary(bytes)` -> `Request` with
  `serializeBinary()`.
- `library.response.deserializeBinary(bytes)` -> `Response` with
  `serializeBinary()`.

The protocol calls `createSetupMessage(0.0, -1, values, dataStructure.Raw,
permutation)` with reveal-intersection enabled. The permutation array is filled
by the engine (it sorts inputs before encrypting; entry i is the original input
index of the value now in sorted slot i).

## 4. Your task -- acceptance criteria

1. A native addon exposing the four operations (createSetupMessage,
   createRequest, processRequest, getAssociationTable) is selected automatically
   under node when a prebuild is present, and WASM is used in the browser and on
   any node platform with no prebuild. (The selector already does this; you
   supply the addon and wire `loadNativePsiAddon`.)
2. Each native operation is byte-for-byte interoperable with the WASM build: a
   setup/request produced by one backend is accepted and processed by the other,
   and a full linkage round between a native-backend node peer and a WASM-backend
   browser peer produces identical association results.
3. Per-element EC work is parallelized across available cores on the node path
   (section 7).
4. Cross-platform prebuilds for Windows, macOS, and Linux. **Windows is
   required** -- the triggering incident was a Windows node user. Prebuilds must
   avoid requiring a compiler on the end user's machine.
5. Existing PSI behavior is unchanged when the addon is unavailable (the WASM
   fallback path stays default-correct).

## 5. Environment / toolchain you need (NOT available in the psilink dev container)

- **Bazel 8.2.1** (the openmined-psi fork pins it in `.bazelversion`; use
  bazelisk). The fork is a Bazel module (`MODULE.bazel`).
- A C++ toolchain per target, plus the deps Bazel fetches (BoringSSL/OpenSSL,
  protobuf, abseil). There is currently NO N-API / node-addon target in the
  fork's `private_set_intersection/` tree -- the C++ engine is under
  `private_set_intersection/cpp/` (psi_client, psi_server, package,
  datastructure), with c/go/javascript(WASM)/python/rust bindings but no node
  addon. Adding the N-API target is the bulk of the work.
- Node-API tooling: `node-addon-api` (or Node-API C), and `prebuildify` /
  `node-gyp-build` or equivalent for prebuilds.
- CI runners for **Windows, macOS, and Linux** (e.g. GitHub Actions matrix) to
  produce and ship the prebuilds. The psilink dev container is a single
  Linux/arm64 box, so Windows and macOS prebuilds cannot be produced there.
- Node 26+ with OpenSSL 3.x (that is the source of the ~6x native-EC gain).

The build/packaging environment is malleable (see `scratch/OpenMinedPSI/
CLAUDE.local.md`): base-image and native-toolchain choices should be made on
interop and code grounds, not treated as fixed.

## 6. The byte-for-byte interop contract (use this)

`packages/core/test/vectors/psi-engine-wire-vectors.json` pins the exact
serialized bytes the vendored WASM engine emits for all four operations, under
two fixed private keys and fixed inputs. The commutative cipher is deterministic
for a fixed key and fixed inputs (EC point H(x)^k, no per-message nonce), so
these bytes are stable; this was verified by regenerating twice.

Use it as your target: build a Server/Client from the pinned keys via
`createFromKey`, run the four operations on the pinned inputs, and require your
addon to reproduce `setupMessageHex`, `requestHex`, `responseHex`,
`sortingPermutation`, and `associationTable` exactly. If your native output
diverges from these bytes, that is a real interop finding (most likely EC point
compression/encoding or protobuf field ordering) -- resolve it so node<->web
exchanges stay compatible; do not "fix" it by editing the vectors.

`packages/core/test/psiEngineWireVectors.test.ts` already asserts the WASM
engine reproduces the vectors. Add the native-side equivalent. Regenerate the
fixture only if the vendored engine legitimately changes:
`node packages/core/test/vectors/generate-psi-engine-wire-vectors.mjs && npm run
format` (the generator emits one array element per line; `format` applies the
repo's compact JSON layout).

Related: item 207302520 tracks consolidating the resolved intersection/
association KATs (a different anchor -- resolved projections, not raw wire
bytes). See open question (e).

## 7. Parallelization + threading caveat (required, easy to get wrong)

Parallelize the per-element loops by **sharding the input across worker
threads, each thread owning its own cipher/context scratch.** The
private-join-and-compute cipher holds a single shared `BN_CTX`/`Context` that is
**NOT thread-safe**. The secret key is shared across shards; the scratch context
must be per-thread. Do NOT share one cipher instance across threads.

Open sub-decisions left to you: shard sizing, and fixed thread pool vs
work-stealing (bounded by Ncores). The ~Ncores speedup estimate assumes shards
run independently with no shared mutable EC state, which holds only if each
thread owns its own scratch.

Expected payoff is a HYPOTHESIS to benchmark, not a guarantee: ~6x from native
EC plus ~Ncores from threading, roughly 20-40x combined on the node path.
Validate with `scripts/single-pass-bench.mjs` (see section 9). The browser stays
on WASM at current performance.

## 8. Tests to add

- Backend selection is already covered (`packages/core/test/psiBackend.test.ts`).
  If you add real prebuild resolution, add a test that exercises it where a
  prebuild is present on the running platform.
- Native-side byte-for-byte reproduction of
  `psi-engine-wire-vectors.json` for each of the four operations.
- A **parity test**: a native-backend party and a WASM-backend party complete a
  full linkage round with matching association results. This was deferred here
  because it needs the addon; it is yours to add.

## 9. scripts/single-pass-bench.mjs cleanup (delegated, conditional)

`scripts/single-pass-bench.mjs` is the single-pass PSI measurement program.
When you finish, check whether either of these consumers is still open: item
206154573 ("Derive the single-pass frame cap from exchanged record counts...")
and item 206377899 ("Reduce PSI backend peak memory..."). If NEITHER remains
open, delete `scripts/single-pass-bench.mjs` and remove every reference to it
(in `docs/spec/PROTOCOL.md` and any board item). If either remains open, leave
it in place for the last consumer to remove. (Ask the psilink maintainer for the
current status of those two items; you likely cannot see the board.)

## 10. Security-review considerations

No new cryptographic primitive is introduced (same curve, same wire format), so
no primitive-level review is triggered. But per this repo's Dependency Policy
(`CONTRIBUTING.md`), `@openmined/psi.js` is a cryptographic dependency and
changes to how that crypto is built and shipped -- a new native build, a new
addon package, prebuilt binaries fetched or vendored -- are security-relevant and
need maintainer/security review before merge. The sharding also shares one secret
key across threads; call that out for review. Flag these explicitly in your PR;
do not assume "no new primitive" clears the whole change.

## 11. Open questions -- decide these first

(a) **Fork-vs-upstream / package layout.** Build the N-API target inside the
existing `@openmined/psi.js` "seclink" fork's Bazel tree (alongside the WASM
target), or as a separate native package? Tradeoffs: co-locating in the fork
keeps the WASM and native builds on one source of truth for the wire format
(lowest divergence risk) but grows the fork and its release; a separate package
is cleaner to version and ship but must track the same C++ source to stay
byte-compatible. Recommendation: build the N-API target in the fork so both
backends derive from one wire-format source, and ship the prebuilt addon either
inside the same `@openmined/psi.js` package or as an `optionalDependencies`
sibling it resolves. Confirm with the maintainer before committing to a layout.

(b) **Prebuild strategy + matrix.** Vendored, fetched at install, or built in CI;
and the exact OS/arch/node-ABI target set beyond "Windows, macOS, Linux". This
is an Operations decision (likely a separate board-10 task). Recommendation:
prebuildify + a GitHub Actions matrix producing per-platform prebuilds resolved
by `node-gyp-build`, so no end-user compiler is needed; decide arch (x64 +
arm64) and the node-ABI range with the maintainer.

(c) **Threading granularity.** Shard sizing and fixed pool vs work-stealing
(section 7). Implementation-level; measure and choose. No external input needed.

(d) **Does byte-for-byte interop actually hold?** The vectors will tell you. If
native P-256 point encoding (compression) or protobuf serialization differs from
the WASM build, reconcile it rather than changing the vectors. Treat a
divergence as a design finding, not a test to relax.

(e) **Interop vectors vs item 207302520.** That item consolidates the resolved
intersection/association KATs (resolved projections). This branch's
`psi-engine-wire-vectors.json` pins raw wire bytes -- a different anchor. Decide
with the maintainer whether the two should share a generator/directory or stay
separate. Not a blocker for your work.

## 12. Verify locally (psilink repo)

```sh
# after pulling the branch; only if package-lock.json changed vs your last sync:
npm ci
npm run build -w packages/core        # apps import core from dist/
npm run typecheck && npm run lint && npm run format
npm run test                          # all workspaces, unit
npm run test:browser -w apps/web      # when you touch the web PSI path
```

Regenerate the interop vectors only on a legitimate engine change:

```sh
node packages/core/test/vectors/generate-psi-engine-wire-vectors.mjs && npm run format
```

## 13. Key references

- Selector: `packages/core/src/psiBackend.ts`; seam:
  `apps/cli/src/psiBackend.ts` (`loadNativePsiAddon`); consumers:
  `apps/cli/src/protocol.ts`, `apps/web/src/components/ExchangeView.tsx`.
- Engine consumer (the four ops in context):
  `packages/core/src/participant.ts`.
- Interop contract: `packages/core/test/vectors/psi-engine-wire-vectors.json`
  (+ generator and `psiEngineWireVectors.test.ts`).
- PSI engine source: `scratch/OpenMinedPSI/private_set_intersection/cpp/`;
  Bazel at `scratch/OpenMinedPSI/MODULE.bazel`, `.bazelversion` (8.2.1); local
  build notes in `scratch/OpenMinedPSI/CLAUDE.local.md`.
- Vendored artifact: `lib/openmined-psi.js-2.0.6-seclink.1.tgz`
  (`@openmined/psi.js`, `2.0.6-seclink.1`).
- Conventions you must follow: `CONTRIBUTING.md` (code/commit/PR/dependency
  policy) and `CLAUDE.md`.
- Board items: 199653275 (this native-addon task), 208313503 (the integration
  slice already on this branch), 206154573 / 206377899 (single-pass-bench
  consumers, section 9), 207302520 (KAT consolidation, open question e).

Delete this file before opening the final PR, or fold anything still relevant
into the PR description.
