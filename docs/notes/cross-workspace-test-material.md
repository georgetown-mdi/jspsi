---
title: "Where cross-workspace test material lives"
---

# Where cross-workspace test material lives

_Status: decided and built. psilink first decided to add no dedicated home,
naming the conditions that would reopen the question; one of them then fired,
and the home exists as `packages/testkit` -- private, unpublished, consumed as
raw TypeScript -- holding what `@psilink/core/testing` cannot. This note records
the constraints that shaped both decisions, what fired the trigger and what the
second decision was measured against, what each piece of test-only material
inside `packages/core/src` is, and the alternatives weighed and not adopted. See
[docs/notes/README.md](README.md)._

This is design rationale. Nothing here binds an implementation; the operational
rule a contributor follows is the one in
[TESTING.md](../TESTING.md#shared-test-material), and this note does not restate
it.

## The question

A helper that only tests use, and that more than one workspace's test tree
needs, has exactly one channel: `@psilink/core/testing`, a subpath export of the
published `@psilink/core` package. That channel has two properties.

- It cannot take a dependency `packages/core` does not declare in its own
  `dependencies`. A root devDependency is out of reach from it.
- Everything it holds is built into `dist/testing.*` and published, because core
  ships its whole `dist`.

So a helper two workspaces need either moves into `packages/core/src` and ships
with the package, or -- if it needs a root devDependency -- cannot use the
channel at all. The question is whether psilink builds a home with neither
property, and if not, what would make it build one.

## The first decision, and what it rested on

Build no new home. `@psilink/core/testing` remains the single cross-workspace
channel for test-only material, test-only material shipping in `dist/testing.*`
is accepted as the steady state, and nothing moves. The reopen condition is a
line in [TESTING.md](../TESTING.md#shared-test-material) rather than a promise
here, because the failure mode this decision guards against is the whole
question being retaken from scratch by whoever next hits one of the constraints
below.

That decision turned on there being no inhabitant: every approach was measured
working, and what none of them had was a helper that needed it.

## The second decision: the home exists

An inhabitant arrived -- the WebRTC inbound frame fixture set, which the CLI's
reassembler and the web app's PeerJS wrap must both be held to, and which is
built with the real `peerjs-js-binarypack` packer. It fires two of the reopen
conditions at once: it is a third piece of test-only material that would move
into `packages/core/src` purely for reach, and it needs a dependency
`packages/core` does not declare. So `packages/testkit` was built, in the
minimal form alternative C describes: private, no build script, no `dist`,
nothing published, an `exports` map onto `./src/*.ts`, and one explicit subpath
per subject.

Two costs the first decision anticipated turned out to be already paid or
smaller than recorded. The root `build` script is `npm run build --workspaces
--if-present`, so a workspace declaring no `build` script no longer fails it.
And adding the workspace touched no tsconfig, no rollup config, no eslint
config, and no vitest config: `package-lock.json` gains the two entries npm
writes for a workspace link, and each consuming app declares the dependency.

The junk-drawer risk the first decision named is answered by the admission rule
in [TESTING.md](../TESTING.md#shared-test-material) rather than by the package's
existence: material enters only when a second workspace's test tree needs it AND
it cannot take the `@psilink/core/testing` channel. Nothing migrated -- the
existing subjects of that channel meet its condition and stay on it.

### What constraint 1 does when the dependency is bundleable

The `typescript` case fails the core build loudly. `peerjs-js-binarypack` does
not: measured on this repository, an import of it from
`packages/core/src/testing.ts` builds green and inlines a copy of the packer
into the published `dist/testing.esm.js` (119,902 bytes to 130,260, with no
import of the package left in the output). That is the same constraint operating
silently instead of loudly, and it is worse in one respect -- the repository
exact-pins that packer because the wire encoding it produces is a compatibility
surface, and vendoring a second copy of it into a published bundle puts that pin
one build away from meaning nothing. A helper needing a dependency core does not
declare therefore takes the testkit whether or not the build would tolerate
inlining it.

## The constraints, and where they bite

Each is a property of configuration this repository already has, so each is
re-derivable rather than taken on trust.

1. **Rollup externals.** `makeExternal` in `packages/core/rollup.config.ts`
   builds the external set from `packages/core/package.json`'s `dependencies`
   alone. `typescript` is a root devDependency and is in no workspace's
   `dependencies`, so an import of it from `src/testing.ts` makes rollup inline
   the compiler, and the CJS interop fails the core build outright (`"default"
   is not exported by .../typescript/lib/typescript.js`). The constraint is the
   dependency, not the file's location: moving the helper elsewhere inside
   `packages/core` does not lift it. A loud failure is the lucky case -- a
   dependency rollup can bundle is inlined into the published output instead,
   which is what the second decision measured.
2. **The project-reference redirect.** `apps/web/tsconfig.json` references
   `packages/core` as a composite project, so a web file importing a `.ts` that
   belongs to core's project is redirected to a per-file declaration output the
   rollup build never emits -- TS6305. It fires only for a consumer OUTSIDE
   `packages/core`, which is why a helper shared between two of core's own tests
   never meets it.
3. **The include list.** `packages/core/tsconfig.json` is `composite: true` over
   `src/**/*.ts` and `test/**/*.ts`, so a core file importing a `.ts` outside
   that list fails with TS6307.

Constraints 2 and 3 are exhaustive over locations inside the repository's own
project graph: a file is either in core's file list, and trapped by 2 for a
consumer outside core, or outside it, and trapped by 3 for core itself. A file
resolved through `node_modules` is in neither -- TS6307 does not reach a
`node_modules` resolution, and no composite redirect exists for a package that
publishes no declarations. That exemption is what every candidate home below
turns on.

## What the first decision rested on

**The case that raised the question resolved without a channel.** Two
compiler-API walks over declared type positions -- one behind the linkage-term
consent classification, one behind the invitation summary's brand types -- sit
in `packages/core/test` and share one helper,
`packages/core/test/utils/declaredPositions.ts`. That helper imports
`typescript` freely: it is inside core's file list, and no consumer outside core
imports it, so constraints 1 and 2 do not apply to it. The demand that would
have paid for a cross-workspace home was satisfied by a same-workspace refactor.

**No other duplication is pulling.** `apps/cli/test` and `apps/web/test` share
no helper between them. Every piece of test material that crosses a workspace
boundary crosses it through `@psilink/core/testing`, which serves its consumers
today -- the CLI's unit and integration suites and the web browser suite.

**The approaches that lift the constraints change shared build configuration.**
Dropping web's project reference to core, and splitting core's tsconfig so its
tests leave the composite declaration graph, both alter how a workspace
typechecks against core repository-wide. Changing that to deduplicate test
scaffolding, with no scaffolding currently waiting to be deduplicated, buys
nothing and risks a build surface every workspace depends on.

**The approach that changes no shared build configuration would be built
empty.** A test-only workspace consumed as raw `.ts` works -- see the
alternatives below -- but no helper exists today that needs it, and the existing
cross-workspace subjects reach their consumers through a channel that serves
them. A package defined by where it may be imported
from rather than by what it holds accretes, and the moment to draw its bright
line is the moment it has a first inhabitant -- which is also the moment
the line can be drawn against a real example rather than an imagined one.

**The accepted cost is unmeasured, not absent.** Test-only material published to
consumers in `dist/testing.*` is a real cost: it enlarges the package surface
and puts fixtures in front of anyone reading core's exports. Nothing measures it
-- there is no package-size budget and no consumer has raised it -- so it is
accepted rather than priced, and its arrival on the trigger list below is what
turns it back into a live question.

The second decision overtook exactly two of these: the two apps' test trees
acquired material they both need, and the approach that would have been built
empty acquired its inhabitant. The rest still hold, which is why the home is
narrow rather than a general test-scaffolding package.

## The test-only material inside `packages/core/src`

Nothing moved when the home was built, and the admission rule is why: each of
these can take the `@psilink/core/testing` channel, so the fact that a second
channel now exists is not a reason to migrate it. What would move one is a
decision about core's export map, or the shipped `dist/testing.*` surface being
priced -- not this note.

- `linkageTermConsentCoverage.ts` -- test-only. A classification of every
  linkage term by whether it bears on consent, plus the probes that hold the
  consent summary to it. Coupled to core's own types, consumed by core's tests
  and by the web browser suite. It imports nothing core does not declare, so it
  stays on the channel that serves it, and it ships.
- `displayEscapingFixtures.ts` -- test-only. Hostile-input fixtures (control
  characters, bidirectional overrides, confusable donors) shared by core's tests
  and the web browser suite. Same handling, and the clearer shape of the
  cost: a fixture wanted on two surfaces reaches them by living in a published
  package.
- The helpers `testing.ts` defines -- `sortAssociationTable`,
  `withCapturedLogs`, `installCapturedLogsInterceptor`, and the `LogEntry`
  shape -- test-only. No product code calls them.
- `computeKexKeys`, re-exported from `kex.ts` -- NOT test-only, and it does not
  move whatever is decided later. It is product code `runKex` calls; only its
  exposure is test-scoped, so that the browser cross-implementation suite can
  drive the checked-in known-answer vectors through the browser build. A test
  home is the wrong place for it: what it needs is a decision about core's
  export map, not about where tests keep their fixtures.

## What the export-map decision did to this channel

The open question below named one event that would move a subject off this
channel or onto it: a decision about core's export map that has to rule on
whether `./testing` stays a public subpath. That decision has since been taken.
Core's main entry was a barrel of `export *` lines, so what the package
published was whatever its modules happened to export; the barrel is now a named
list, and `./testing` stays a public subpath beside it.

The ruling moved names in both directions. Core's own known-answer vector
generators are plain Node scripts, so they read the built package rather than
the source tree beside them, and the wire pieces they compose their documents
from -- the index-table and single-pass reply codecs, the terms envelope, the
standardized key iterable -- were reachable only because the barrel published
everything. A caller runs an exchange rather than composing a table encoding, so
none of them belongs on the main entry; they are on `./testing`, which states
what they are. `withSuppressedLogs` went the other way: nothing called it, so it
is deleted rather than published.

`reconcileHostKeyFingerprints` is on the channel for the same reason
`computeKexKeys` is, and is the second inhabitant of that class: product code
whose only consumers outside `packages/core` are the two apps' test trees, each
holding the divergence warning it composes to that app's own display budget,
while the exchange itself calls it from `runExchange` and hands the caller the
result.

A third class followed: the constants only a test reads. The file-sync
envelope's framing bytes and the AEAD envelope's version marker, the terminal
frame's drain timeout, the invitation and CSV input bounds, the WebRTC
pre-scan's per-kind weights, and the two display markers are each enforced or
written by core itself, and what a caller does is send a message, decode an
invitation, or read rendered text. They moved to `./testing`, where each app's
suite builds a frame or drives a bound at its edge, and the capabilities their
neighbours on the main entry publish -- the codecs, the parsers, the display
renderers -- stayed.

One subject arrived that is neither a fixture nor a codec:
`withNoListedFanOutFunctions`, the lever that stands a listed fan-out producer
in for an unlisted one. It rewrites module state, so it carries a build
condition the other subjects do not -- both published entry points must reach
one copy of the module holding that state, which is why they build together with
a shared chunk rather than as two independent bundles.

## Alternatives weighed

- **Drop web's project reference to core.** One line out of
  `apps/web/tsconfig.json` lifts constraint 2, and the repository typechecks
  green without it. Cost: it changes how the web app typechecks against core
  everywhere, permanently, to serve test scaffolding -- and it leaves constraint
  1 standing, so a shared helper needing `typescript` is no closer.
- **A test-only workspace consumed as raw `.ts`.** ADOPTED, as
  `packages/testkit`. A `packages/*` package that is private, has no build and
  no `dist`, and whose `exports` map points at `./src/*.ts` is resolved through
  `node_modules` and therefore exempt from constraints 2 and 3. Core, the CLI
  test config, and web all typecheck a consumer of one, its source is inside
  each consumer's program rather than skipped, and it may import both a
  dependency core does not declare and `@psilink/core` types at once -- no
  project-reference cycle arises, because no project reference exists in either
  direction. Its standing costs: each consumer typechecks the shared source
  inside its own program, so an error there is reported once per consuming
  project rather than once globally, and it is a top-level package with an
  admission rule to hold. The cost the first decision recorded against it --
  the root `build` script failing on a workspace that declares no `build`
  script -- was already paid, that script being `--if-present`.
- **Split core's tsconfig.** Take `test/**/*.ts` out of
  `packages/core/tsconfig.json`'s `include` and add a non-composite
  `tsconfig.test.json` covering source and tests, the shape `apps/cli` already
  runs. Costs the root `typecheck` script a fourth invocation -- without it
  core's tests silently stop being typechecked in CI, so that edit is part of
  the change rather than an extra -- and moves core's tests out of the composite
  declaration graph.
- **A hand-written `.d.ts` beside a plain `.js`, outside core's include.**
  Exempt from every constraint at zero configuration cost, and rejected on its
  merits: it buys an untypechecked implementation behind a hand-maintained
  declaration, for material whose whole value is the precision of its failure
  mode.

## Escapes that do not work

Recorded so they are not re-tried. Against constraint 2:
`disableSourceOfProjectReferenceRedirect` on the web project, and a tsconfig
`paths` mapping, both leave TS6305 exactly as it was, because the redirect is
applied after resolution and keyed on project membership. A vitest
`resolve.alias` moves nothing, because `tsc` does not read it. Against
constraint 3, a type-only import does not exempt the file. Against constraint 1,
moving `typescript` into core's `devDependencies` changes nothing, because
`makeExternal` reads `dependencies` only.

## The composite and references wiring

`packages/core` is `composite: true`, and both `apps/cli/tsconfig.json` and
`apps/web/tsconfig.json` declare a reference to it, but nothing in this
repository runs `tsc --build`: the root `typecheck` script is separate `tsc -p`
invocations. Two arms are open -- adopt `tsc -b` so the wiring is exercised, or
remove the wiring as vestigial -- and this decision takes neither.

Removing it is a shared build-config change across three tsconfigs that buys
nothing visible: `npm run typecheck` is green with both references deleted, so
what the removal actually deletes is the TS6305 redirect, which fires only on
the cross-workspace import pattern this decision declines to introduce.
Adopting `tsc -b` is the larger change and cuts against the cost this whole
question is about: building core as a composite project emits declarations for
its included files into `outDir`, which for core is the `dist` it publishes, so
the arm that would resolve the redirect does it by enlarging the shipped
surface with core's test-file declarations.

Both arms wait on the same event: the wiring starts mattering when a
cross-workspace `.ts` import exists to be REDIRECTED. The testkit's arrival is
not that event, and the reason is the exemption above -- its source is reached
through `node_modules`, where no composite redirect exists, so `npm run
typecheck` is as green with it as without. An import that would exercise the
wiring is one reaching a `.ts` inside core's own file list, which is the shape
neither decision introduced.

## What is still open

The operational form of this, in the place a contributor meets it, is in
[TESTING.md](../TESTING.md#shared-test-material).

- The shipped `dist/testing.*` surface is still unpriced. The export-map ruling
  above settled whether `./testing` stays a public subpath without pricing what
  it ships, so what is left to price it is a consumer raising it, or a
  package-size or supply-chain review. Until then the material on that channel
  stays where it is.
- The composite/references arms above are untaken, and the testkit did not force
  them.
- The testkit's admission rule is held by review, not by a check. It has one
  subject; a second that does not meet the rule is how it starts becoming the
  junk drawer the first decision named.
