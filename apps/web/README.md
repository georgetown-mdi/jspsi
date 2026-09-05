# PSI Link Web App

The browser-based PSI-Link app: two parties run a peer-to-peer exchange over WebRTC using ephemeral invitation links.

## Quickstart

Node and NPM must be installed. From the repository root, run:

1. `npm install . -w packages/core -w apps/web`
2. `npm run -w packages/core build`

## Development

Start the development server:

```sh
npm run -w apps/web dev
```

Then visit [http://localhost:3000](http://localhost:3000).

## Source layout

`src/` holds three products and the layers below them. Each `@`-prefixed alias in
the list is registered in `vite.config.ts` (`srcAliases`) and `nitro.config.ts`
(`serverAliases`); `tsconfig.json` resolves them through its `@*` catch-all.

| Path             | Alias         | What it holds                                                                       |
| ---------------- | ------------- | ----------------------------------------------------------------------------------- |
| `src/exchange/`  | `@exchange`   | The one-off exchange: the invite, accept, direct and verify screens and their models |
| `src/recurring/` | `@recurring`  | The recurring-exchange manager: the saved list, the managed run surface, schedules   |
| `src/console/`   | `@console`    | What only the console build renders: the mount file pickers, SFTP authoring, the server-job settings cards |
| `src/psi/`       | `@psi`        | The protocol and run models, React-free, with a subdirectory per feature below      |
| `src/components/`| `@components` | React pieces more than one product renders                                          |
| `src/jobs/`      | `@jobs`       | The console server's job machinery, behind the API routes                           |
| `src/utils/`     | `@utils`      | Configuration and generic helpers                                                    |
| `src/styles/`    | `@styles`     | The design tokens and the stylesheet the screens share                              |
| `src/routes/`    |               | Route entries, which compose the products                                            |

`src/psi/` keeps the exchange itself at its top level and gives each feature
beside it a subdirectory: `managed/` (the recurring-exchange records, store,
schedule and runs), `jobClient/` (the browser's client of the console server's
job API), `transport/` (WebRTC rendezvous, the peer connection and its waits),
`authoring/` (invitation authoring) and `workers/` (the CSV, coverage and PSI
workers with their controllers).

The direction runs one way: `src/psi` and `src/components` sit below the three
product directories and must not import from them, which is what keeps the
headless scheduled runner -- it enters through `src/psi` -- out of the screens'
graph. An ESLint `no-restricted-imports` ban in `eslint.config.js` enforces it,
and `scripts/eslint-web-layer-direction.test.mjs` drives the ban itself. A module
two layers need belongs in `src/psi` when it is React-free and in
`src/components` when it is not. Between the products the graph is not
constrained: the recurring manager reuses the exchange's run surface, and the
exchange screens render the console's cards under the console build's own gate.

## Generated route tree

`src/routeTree.gen.ts` is written by the TanStack Router codegen, which the `tanstackStart` plugin in `vite.config.ts` runs whenever anything loads that config -- the dev server, a build, or a vitest run.
It is checked in deliberately: typecheck, lint, build, and the test suites all read it, so a fresh clone works with no generation step in front of them.

Adding, renaming, or removing a route file therefore changes two files.
Refresh the generated one with any web tooling, or with the cheapest invocation on its own, and commit the result alongside the route:

```sh
npm exec --workspace apps/web -- vitest list --project unit
```

`npm run check:routetree` guards the checked-in copy, on every pull request and locally.
It regenerates with the generator the lockfile pins, compares byte for byte, and restores the working-tree copy either way, so a stale file fails the build instead of resurfacing as an unrelated modification in a branch that touched no route.

## Erasable syntax in the config's import graph

`vite.config.ts` is evaluated with no transform in front of it by Vite's `configLoader: "native"` and by a plain `node` import, both of which hand it to Node's strip-only type stripping.
That erases type annotations and nothing else, so a TypeScript construct needing code generated for it -- a constructor parameter property, an `enum`, a non-`declare` `namespace`, an `import x = require(...)` alias -- is refused outright with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.

The refusal is a parse error in whichever module carries the construct, so it applies to everything the config imports, transitively -- including the app source it reaches (`src/utils/serverConfig.ts`, `src/httpServer.ts`).
Write erasable syntax there: a parameter property becomes a field declaration plus an assignment in the constructor body.
Nothing else holds those modules to it, and typecheck, lint, and `vite build` all run a real TypeScript transform and so see none of it.

```sh
npm run check:web-config-native-load
```

That guards the property, on every pull request and locally.
It drives both load paths for real, and calibrates each against a control fixture first, so a loader that stopped being strip-only fails rather than passing silently.

## Running tests

```sh
npm run -w apps/web test
```
