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

## Running tests

```sh
npm run -w apps/web test
```
