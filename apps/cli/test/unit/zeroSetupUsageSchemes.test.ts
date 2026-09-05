import { afterEach, expect, test, vi } from "vitest";

import { buildCli } from "../../src/cliParser";
import { channelFromURL } from "../../src/connectionFromUrl";
import { captureProcessExit } from "../exitCapture";

// The zero-setup usage line is the only place an operator is told which URL
// schemes the command takes, and it is read against the same parser that
// decides -- so it is asserted against channelFromURL rather than against a
// copy of itself: a scheme the command refuses must not appear there, and every
// scheme it does name must map to a channel a zero-setup exchange can run.

afterEach(() => {
  vi.restoreAllMocks();
});

// The rendered `--help` text yargs writes through console.log, with
// process.exit trapped so the help short-circuit stops there instead of tearing
// down the runner.
async function helpText(): Promise<string> {
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  captureProcessExit();
  try {
    await buildCli(["--help"]).parseAsync();
  } catch (err) {
    if (!(err instanceof Error) || err.message !== "exit:0") throw err;
  }
  return printed.join("\n");
}

// The schemes the usage line names, in the order it names them.
function advertisedSchemes(help: string): string[] {
  const line = /^\s*URL\s+server URL \(([^)]*)\)\s*$/m.exec(help);
  if (line === null)
    throw new Error(
      `the zero-setup usage has no "URL  server URL (...)" line:\n${help}`,
    );
  return [...line[1].matchAll(/[a-z]+:\/\//g)].map((match) => match[0]);
}

test("the zero-setup usage names the URL schemes the command accepts", async () => {
  const schemes = advertisedSchemes(await helpText());
  expect(schemes.length).toBeGreaterThan(0);
  for (const scheme of schemes) {
    // A scheme this command cannot run is a scheme it must not advertise: a
    // zero-setup exchange has no shared secret, so it refuses webrtc (exit 64),
    // and an unknown scheme throws out of channelFromURL.
    expect(channelFromURL(new URL(`${scheme}host/path`))).not.toBe("webrtc");
  }
});

test("the zero-setup usage advertises no scheme the command refuses", async () => {
  const schemes = advertisedSchemes(await helpText());
  for (const refused of ["ws://", "wss://"]) {
    expect(channelFromURL(new URL(`${refused}host/path`))).toBe("webrtc");
    expect(schemes).not.toContain(refused);
  }
});
