# @psilink/testkit

Test-only material that more than one workspace's test tree needs and that `@psilink/core/testing` cannot carry. Private, never published, no build step and no `dist`: its `exports` map points at `./src/*.ts`, so a consumer resolves the source through `node_modules` and typechecks it inside its own program.

Nothing here runs in production, and nothing here is a place to put a helper for tidiness. The admission rule -- a second workspace's test tree genuinely needs it AND it cannot take the `@psilink/core/testing` channel, one explicit subpath per subject -- is in [docs/TESTING.md](../../docs/TESTING.md#shared-test-material); the decision behind it, and the measurements it rests on, are in [docs/notes/cross-workspace-test-material.md](../../docs/notes/cross-workspace-test-material.md).

## Subjects

- `./loopbackTlsCert` -- a self-signed certificate for a loopback test server, minted by shelling out to `openssl` because Node has no certificate-issuing API, and `null` where this environment cannot mint one. The web signaling suites serve HTTPS with it and the CLI's live one-command acceptance leg terminates TLS in front of its broker with it. It reaches for `node:child_process`, so the `@psilink/core/testing` channel would put a shellout into a bundle the web app loads in a browser.
- `./webrtcInboundFrames` -- the labelled WebRTC inbound frames the CLI's reassembler and the web app's PeerJS wrap are both held to, with the pre-scan verdict each frame must draw. It is built with the real `peerjs-js-binarypack` packer, which `packages/core` declares as a devDependency rather than a dependency, so the `@psilink/core/testing` channel would inline a copy of that packer into core's published bundle.
