/**
 * This browser's own relay: the TURN and STUN urls an operator sets for their
 * side of a WebRTC exchange, kept in localStorage and so held per origin -- the
 * hosted app and a console each keep their own. The urls follow core's
 * `connection.turn` / `connection.stun` grammar. No credential is stored: each
 * run mints its own from the exchange's shared secret (`buildIceServers` in
 * `./rendezvous.ts`).
 */

import { z } from "zod";

import {
  StunUrlSchema,
  TurnUrlSchema,
  getLogger,
  maxCodeUnits,
  parseBoundedJson,
} from "@psilink/core";

import type { RelayLocator } from "./rendezvous";

const log = getLogger("ownRelaySetting");

/** The localStorage key the setting is written under. */
const STORAGE_KEY = "psilink-own-relay";

/** The stored value's schema version; a value under any other is refused. */
const SETTING_VERSION = 1;

/** How many urls each list holds at most. */
export const MAX_RELAY_URLS = 8;

/** How long one url may be, in UTF-16 code units. */
const MAX_RELAY_URL_LENGTH = 1024;

const TurnListSchema = z
  .array(TurnUrlSchema.check(maxCodeUnits(MAX_RELAY_URL_LENGTH)))
  .max(MAX_RELAY_URLS);
const StunListSchema = z
  .array(StunUrlSchema.check(maxCodeUnits(MAX_RELAY_URL_LENGTH)))
  .max(MAX_RELAY_URLS);

const StoredOwnRelaySchema = z
  .strictObject({
    version: z.literal(SETTING_VERSION),
    turn: TurnListSchema,
    stun: StunListSchema,
  })
  .refine((value) => value.turn.length + value.stun.length > 0, {
    message: "a stored relay names no url",
  });

/** How reading the stored setting turned out. */
export type OwnRelayRead =
  /** Nothing is stored, or storage is unreachable: no relay. */
  | { kind: "none" }
  | { kind: "set"; relay: RelayLocator }
  /** A value is stored that this build refuses; no relay is used. */
  | { kind: "unreadable" };

/** This context's localStorage, or `undefined` where it has none or refuses
 * access (server rendering, storage disabled). */
function storage(): Storage | undefined {
  try {
    const store: Storage | undefined = globalThis.localStorage;
    return store;
  } catch {
    return undefined;
  }
}

/** Read the stored own relay. */
export function readOwnRelaySetting(): OwnRelayRead {
  let raw: string | null | undefined;
  try {
    raw = storage()?.getItem(STORAGE_KEY);
  } catch {
    return { kind: "none" };
  }
  if (raw === null || raw === undefined) return { kind: "none" };
  try {
    const parsed = StoredOwnRelaySchema.parse(parseBoundedJson(raw));
    return { kind: "set", relay: { turn: parsed.turn, stun: parsed.stun } };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * Store `relay` as this browser's own relay, or remove the setting when it
 * names no url.
 *
 * @throws if `relay` fails the url grammar or the list bounds, or storage
 *   refuses the write.
 */
export function writeOwnRelaySetting(relay: RelayLocator): void {
  const store = storage();
  if (store === undefined)
    throw new Error("this browser's storage is not available");
  if (relay.turn.length + relay.stun.length === 0) {
    store.removeItem(STORAGE_KEY);
    return;
  }
  const value = StoredOwnRelaySchema.parse({
    version: SETTING_VERSION,
    turn: [...relay.turn],
    stun: [...relay.stun],
  });
  store.setItem(STORAGE_KEY, JSON.stringify(value));
}

/** A refusal of the entered text: why, and the 1-based line it is about when
 * it is about one line. */
export interface RelayUrlProblem {
  line?: number;
  message: string;
}

/** What {@link parseRelayUrlLines} made of one list's text. */
export type RelayUrlLines =
  | { ok: true; urls: Array<string> }
  | { ok: false; problems: Array<RelayUrlProblem> };

/**
 * Read one url per line from `text` under the `turn` or `stun` grammar,
 * skipping blank lines. Every refused line is reported, with core's own
 * message for it.
 */
export function parseRelayUrlLines(
  text: string,
  kind: "turn" | "stun",
): RelayUrlLines {
  const schema = (kind === "turn" ? TurnUrlSchema : StunUrlSchema).check(
    maxCodeUnits(MAX_RELAY_URL_LENGTH),
  );
  const urls: Array<string> = [];
  const problems: Array<RelayUrlProblem> = [];
  text.split(/\r?\n/).forEach((entry, index) => {
    if (entry.trim() === "") return;
    const result = schema.safeParse(entry);
    if (result.success) urls.push(result.data);
    else
      problems.push({
        line: index + 1,
        message: result.error.issues[0]?.message ?? "not a valid url",
      });
  });
  if (problems.length > 0) return { ok: false, problems };
  if (urls.length > MAX_RELAY_URLS)
    return {
      ok: false,
      problems: [{ message: `enter at most ${MAX_RELAY_URLS} urls` }],
    };
  return { ok: true, urls };
}

/**
 * The relay a run's peer connection gathers against: the one the invitation
 * names when it names one, else this browser's own setting, else none. A
 * stored setting this build cannot read is no relay, and is logged.
 */
export function relayForRun(
  invitationRelay?: RelayLocator,
  readOwn: () => OwnRelayRead = readOwnRelaySetting,
): RelayLocator | undefined {
  if (invitationRelay !== undefined) return invitationRelay;
  const own = readOwn();
  if (own.kind === "unreadable")
    log.warn(
      "the stored relay setting could not be read, so this run uses no relay; " +
        "set it again in Relay settings",
    );
  return own.kind === "set" ? own.relay : undefined;
}
