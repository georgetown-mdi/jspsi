import type { ProvidedContext } from "vitest";

import { selectedBackend, startSelectedSftpServer } from "./index";

// Structural slice of vitest's globalSetup context: only `provide` is used, and
// typing it inline keeps this robust to where vitest re-exports the full context
// type across versions.
interface GlobalSetupContext {
  provide<T extends keyof ProvidedContext & string>(
    key: T,
    value: ProvidedContext[T],
  ): void;
}

// Vitest globalSetup for the `integration` project: starts the selected SFTP
// test server before the suite, hands its connection details and served
// directory to the test workers through `provide`, and stops it on teardown, so
// `npm run test:integration` is self-contained. Only the integration project
// references this file, so the unit project (and `npm run test`) never starts a
// server.
export default async function setup({
  provide,
}: GlobalSetupContext): Promise<() => Promise<void>> {
  const server = await startSelectedSftpServer();
  provide("sftpServer", server.handle);
  console.log(
    `[sftp-test-server] ${selectedBackend()} backend listening on ` +
      `${server.handle.host}:${server.handle.port}`,
  );
  return async () => {
    await server.stop();
  };
}
