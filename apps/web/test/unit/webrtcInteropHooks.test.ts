import { readFileSync } from "node:fs";

import { afterEach, describe, expect, test, vi } from "vitest";

import { dialAsAcceptor, listenAsInviter } from "../../src/psi/rendezvous.js";
import { authenticateExchange } from "../../src/psi/authenticateExchange.js";
import { openPeerMessageConnection } from "../../src/psi/peerMessageConnection.js";
import { useAcceptorExchange } from "../../src/bench/useAcceptorExchange.js";
import { useInviterExchange } from "../../src/bench/useInviterExchange.js";
import { waitForIncomingConnection } from "../../src/psi/waitForConnection.js";

import type * as PsilinkCore from "@psilink/core";
import type {
  HandshakeRole,
  InvitationToken,
  LinkageTerms,
  MessageConnection,
  PreparedExchange,
  PsiBackendSelection,
  RendezvousRole,
  WebRTCEndpoint,
} from "@psilink/core";
import type { AcceptorLaunch } from "../../src/bench/useAcceptorExchange.js";
import type { DataConnection } from "peerjs";
import type { GeneratedInvitation } from "../../src/psi/invitation.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";
import type Peer from "peerjs";

/**
 * The handshake role each ONE-SHOT web flow hands the key exchange, taken from
 * the key exchange's own arguments.
 *
 * The side-to-role table itself is pinned against the shared interop vectors in
 * webrtcInterop.test.ts, but a correct table read on the wrong key still fails
 * on the wire, and a web-to-web test cannot catch it -- a swapped key moves both
 * ends together. So each flow is driven here through its own hook; the CLI's
 * matching call sites are driven against the same fixture in apps/cli's suite,
 * and the managed re-run is covered the same way in managedRunDriver.test.ts.
 *
 * Everything below the hook is mocked at the transport boundaries the browser
 * suite owns -- the rendezvous, the inbound wait, the message connection,
 * and the handshake. The handshake mock rejects: the role is recorded by then,
 * and a rejection ends the run without a PSI exchange to stand up.
 */

interface InteropVectors {
  inputs: { sharedSecret: string };
  rendezvous: {
    sides: Array<{
      side: RendezvousRole;
      handshakeRole: HandshakeRole;
    }>;
  };
  signaling: { endpoint: WebRTCEndpoint };
  invitation: { token: InvitationToken };
}

const vectors = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/core/test/vectors/webrtc-interop-vectors.json",
      import.meta.url,
    ),
    { encoding: "utf8" },
  ),
) as InteropVectors;

const sideVector = (side: RendezvousRole) => {
  const found = vectors.rendezvous.sides.find((s) => s.side === side);
  if (found === undefined) throw new Error(`no vector for side ${side}`);
  return found;
};

/**
 * A one-render harness for a React hook. The unit project runs on `node` with no
 * DOM to mount a component in, and these hooks need none: each starts its run
 * from an effect and reports through callbacks, never through a re-render, so a
 * single render plus a flush of the effects it queued reaches the whole path
 * under test. State written by the run goes into the slots below and is never
 * read back here -- the rendered surface is the browser project's subject.
 *
 * Only the four hooks these two flows use are substituted; anything else falls
 * through to React's own, which has no dispatcher outside a renderer.
 *
 * Hoisted because the `react` mock factory below is lifted above the file's
 * declarations.
 */
const reactHarness = vi.hoisted(() => {
  const slots: Array<{ current: unknown }> = [];
  const effects: Array<() => unknown> = [];
  let cursor = 0;
  const slotFor = (initial: () => unknown): { current: unknown } => {
    const box = slots[cursor] ?? { current: initial() };
    slots[cursor] = box;
    cursor += 1;
    return box;
  };
  const resolveInitial = (initial: unknown): unknown =>
    typeof initial === "function" ? (initial as () => unknown)() : initial;
  return {
    hooks: {
      useState: (initial: unknown) => {
        const box = slotFor(() => resolveInitial(initial));
        const setState = (next: unknown) => {
          box.current =
            typeof next === "function"
              ? (next as (previous: unknown) => unknown)(box.current)
              : next;
        };
        return [box.current, setState];
      },
      useRef: (initial: unknown) => slotFor(() => initial),
      useMemo: (factory: () => unknown) => slotFor(factory).current,
      useEffect: (effect: () => unknown) => {
        effects.push(effect);
      },
    },
    render<T>(hook: () => T): T {
      slots.length = 0;
      effects.length = 0;
      cursor = 0;
      const rendered = hook();
      for (const effect of effects.splice(0)) effect();
      return rendered;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...reactHarness.hooks };
});

vi.mock("@openmined/psi.js/psi_wasm_web", () => ({
  default: () => Promise.resolve({}),
}));
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<typeof PsilinkCore>();
  const stubLinkageTerms: LinkageTerms = {
    version: "1.0.0",
    date: "2026-01-01",
    algorithm: "psi",
    linkageStrategy: "single-pass",
    output: { expectsOutput: false, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [],
    linkageKeys: [],
  };
  return {
    ...actual,
    loadPsiBackend: vi.fn(() =>
      Promise.resolve({
        library: {} as PSILibrary,
        backend: "wasm",
      } satisfies PsiBackendSelection),
    ),
    // The rows and terms are not this file's subject, so the prepared exchange
    // is a stand-in and the stage tree built from it is empty.
    prepareForExchange: vi.fn(
      () =>
        ({
          metadata: [],
          linkageTerms: stubLinkageTerms,
          dataset: new actual.StandardizedDataset([], []),
          rawRows: [],
          rowCount: 0,
        }) satisfies PreparedExchange,
    ),
    describeExchangeStages: vi.fn(() => []),
  };
});
vi.mock("../../src/bench/acceptorExchange.js", () => ({
  prepareAcceptorExchange: vi.fn(() => ({})),
}));
vi.mock("../../src/psi/rendezvous.js", () => ({
  listenAsInviter: vi.fn(),
  dialAsAcceptor: vi.fn(),
}));
vi.mock("../../src/psi/waitForConnection.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  waitForIncomingConnection: vi.fn(),
}));
vi.mock("../../src/psi/peerMessageConnection.js", () => ({
  openPeerMessageConnection: vi.fn(),
}));
vi.mock("../../src/psi/authenticateExchange.js", () => ({
  authenticateExchange: vi.fn(),
  hasRecoveryHint: vi.fn(() => false),
}));

const mockedAuthenticate = vi.mocked(authenticateExchange);
const mockedListen = vi.mocked(listenAsInviter);
const mockedDial = vi.mocked(dialAsAcceptor);
const mockedWaitForIncoming = vi.mocked(waitForIncomingConnection);
const mockedOpen = vi.mocked(openPeerMessageConnection);

/** The peer, channel, and message connection the mocked transport hands the
 * flow, and the handshake failure that ends the run once the role is recorded. */
function scriptTransport(): { mc: MessageConnection } {
  const peer = { disconnect: vi.fn(), destroy: vi.fn() };
  const conn = { once: vi.fn(), off: vi.fn(), close: vi.fn() };
  const mc = {
    close: vi.fn(() => Promise.resolve()),
  } as unknown as MessageConnection;
  mockedListen.mockResolvedValue(peer as unknown as Peer);
  mockedWaitForIncoming.mockResolvedValue(conn as unknown as DataConnection);
  mockedDial.mockResolvedValue([
    peer as unknown as Peer,
    conn as unknown as DataConnection,
  ]);
  mockedOpen.mockResolvedValue(mc);
  mockedAuthenticate.mockRejectedValue(new Error("handshake refused"));
  return { mc };
}

/** Only the fields the inviter flow reads on the browser path: the secret and
 * expiry it authenticates with, and the terms/rows its prepare stands in for. */
const MINTED = {
  linkageTerms: vectors.invitation.token.linkageTerms,
  sharedSecret: vectors.inputs.sharedSecret,
  expires: vectors.invitation.token.expires,
  rawRows: [],
  columns: [],
} as unknown as GeneratedInvitation;

/** Only the fields the acceptor flow reads on the browser path: the accepted
 * invitation whose endpoint routes it to WebRTC, and the token it authenticates
 * with. */
const LAUNCH = {
  invitation: {
    token: vectors.invitation.token,
    endpoint: vectors.signaling.endpoint,
  },
  acceptorName: "Interop Fixture Acceptor",
  rawRows: [],
  columns: [],
  edits: { metadata: {} },
  inputSource: { kind: "workFile", name: "input.csv" },
} as unknown as AcceptorLaunch;

// Both hooks route a run's failure to a dev-gated console.error, and the
// refused handshake is how this file leaves the run rather than what it asserts.
vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the handshake role each one-shot web flow takes", () => {
  test("the inviter flow authenticates in the vector's inviter role", async () => {
    const inviter = sideVector("inviter");
    const { mc } = scriptTransport();

    reactHarness.render(() =>
      useInviterExchange({
        invitation: MINTED,
        inviterName: "Interop Fixture Party",
        channel: "browser",
        inputSource: undefined,
        sftpConfigured: false,
      }),
    );

    await vi.waitFor(() => expect(mockedAuthenticate).toHaveBeenCalled());
    expect(mockedAuthenticate).toHaveBeenCalledWith(
      mc,
      inviter.handshakeRole,
      MINTED.sharedSecret,
      MINTED.expires,
    );
  });

  test("the acceptor flow authenticates in the vector's acceptor role", async () => {
    const acceptor = sideVector("acceptor");
    const { mc } = scriptTransport();

    reactHarness.render(() => useAcceptorExchange({ launch: LAUNCH }));

    await vi.waitFor(() => expect(mockedAuthenticate).toHaveBeenCalled());
    expect(mockedAuthenticate).toHaveBeenCalledWith(
      mc,
      acceptor.handshakeRole,
      vectors.invitation.token.sharedSecret,
      vectors.invitation.token.expires,
    );
  });
});
