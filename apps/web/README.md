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

## Running tests

```sh
npm run -w apps/web test
```
