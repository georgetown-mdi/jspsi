import { posix } from "node:path";

import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The standalone runner's operator surface: where it listens, what it mounts,
 * and the readiness endpoint it answers beside the signaling mount.
 *
 * Separate from `standalone.ts`, which builds a server and listens at import
 * time, so both halves can be driven from a test without a broker process:
 * {@link resolveStandaloneOptions} is a pure function of an argument vector and
 * an environment map, and {@link createStandaloneRequestHandler} is the plain
 * HTTP half of the runner, which the signaling upgrade path never reaches.
 */

/** Bind address the runner uses when neither the flag nor the environment names
 * one. Loopback, so a broker started for a test or a local trial is reachable
 * only from the machine that started it; a deployment states an address. */
export const DEFAULT_BIND_HOST = "127.0.0.1";

/** Port the runner uses when neither the flag nor the environment names one:
 * `0` asks the operating system for an ephemeral port, which is what the ready
 * line on stdout exists to report. */
export const DEFAULT_BIND_PORT = 0;

/** Mount the signaling server sits under when `--path` names none. */
export const DEFAULT_MOUNT_PATH = "/api";

/** Realm key the signaling server accepts when `--key` names none. It is the
 * PeerJS protocol's well-known default, not a credential. */
export const DEFAULT_REALM_KEY = "peerjs";

/** Environment variable holding the bind address, for a supervised service
 * configured from a unit file rather than a command line. */
export const BIND_HOST_ENV = "PSILINK_BROKER_HOST";

/** Environment variable holding the port. */
export const BIND_PORT_ENV = "PSILINK_BROKER_PORT";

/** The readiness endpoint's own segment, joined onto the signaling mount. It
 * sits beside the WebSocket endpoint rather than at the root so one route rule
 * in front of the broker covers both. */
export const READINESS_SEGMENT = "health";

/** What a ready broker answers on the readiness endpoint. A fixed line: the
 * probe reports that this process is listening and mounted, and reporting
 * anything further would put rendezvous metadata on an unauthenticated
 * endpoint. */
export const READINESS_BODY = "ready\n";

/** Highest port a listener can be asked for. */
const MAX_PORT = 65_535;

/** Flags {@link resolveStandaloneOptions} reads. Anything else on the command
 * line is a refusal rather than an ignored token, so a mistyped flag does not
 * leave the runner silently listening on the defaults. */
const FLAG_NAMES = ["host", "port", "path", "key"] as const;

type FlagName = (typeof FLAG_NAMES)[number];

/**
 * A refusal to start: an option the runner cannot act on.
 *
 * Its message composes the offending value RAW; the runner escapes the rendered
 * chain once where it writes it (CONTRIBUTING.md, Operator-facing escaping).
 */
export class StandaloneOptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandaloneOptionError";
  }
}

/** Where the runner listens and what it serves there. */
export interface StandaloneOptions {
  /** Address passed to `listen`, resolved by Node rather than parsed here. */
  host: string;
  /** Port passed to `listen`; `0` yields an ephemeral one. */
  port: number;
  /** Mount the signaling server is built under. */
  path: string;
  /** Realm key the signaling server accepts. */
  key: string;
  /** Request path the readiness probe answers on, derived from {@link path}. */
  readinessPath: string;
}

function isFlagName(name: string): name is FlagName {
  return (FLAG_NAMES as ReadonlyArray<string>).includes(name);
}

/**
 * Read the runner's flags from an argument vector (`process.argv.slice(2)`).
 *
 * Each flag takes the token after it. A repeat is refused the way the CLI
 * refuses one, since the second value would silently win; a token that is not a
 * known flag is refused because this runner has no positionals for one to be.
 */
function readFlags(argv: ReadonlyArray<string>): Map<FlagName, string> {
  const values = new Map<FlagName, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const name = token.startsWith("--") ? token.slice(2) : "";
    if (!isFlagName(name))
      throw new StandaloneOptionError(`Unknown argument: ${token}`);
    if (values.has(name))
      throw new StandaloneOptionError(`--${name} may be given only once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new StandaloneOptionError(`--${name} requires a value`);
    values.set(name, value);
    index += 1;
  }
  return values;
}

/** The value for one setting and the name to report it under, taking the flag
 * ahead of the environment: a flag is the more specific of the two
 * instructions, and it is what a unit file's operator overrides by hand. */
function selectValue(
  flagValue: string | undefined,
  flagName: FlagName,
  envValue: string | undefined,
  envName: string,
): { value: string; source: string } | undefined {
  if (flagValue !== undefined)
    return { value: flagValue, source: `--${flagName}` };
  if (envValue !== undefined && envValue.trim() !== "")
    return { value: envValue, source: envName };
  return undefined;
}

function parsePort(raw: string, source: string): number {
  const trimmed = raw.trim();
  const port = /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (Number.isNaN(port) || port > MAX_PORT)
    throw new StandaloneOptionError(
      `${source} must be a whole number from 0 to ${MAX_PORT}; got ${JSON.stringify(raw)}`,
    );
  return port;
}

function requireNonEmpty(raw: string, source: string): string {
  const trimmed = raw.trim();
  if (trimmed === "")
    throw new StandaloneOptionError(`${source} must not be empty`);
  return trimmed;
}

/** Characters a mount may not hold. A request target's path ends at `?` or `#`,
 * so a mount holding one names a path no request can reach; a `%` is matched
 * only by its own spelling, since the handler decodes nothing. */
const MOUNT_REFUSED_CHARACTERS = /[?#%]/;

/**
 * The mount the signaling server is built under, from the `--path` value or the
 * default.
 *
 * Held to a literal path, so the readiness endpoint derived from it is a literal
 * child of the literal mount: one route rule written for the mount in front of
 * the broker then covers the probe as well. A mount that would leave the probe
 * unreachable, or put it outside the mount an operator wrote, is refused rather
 * than started on.
 *
 * @throws StandaloneOptionError naming `--path`.
 */
function resolveMountPath(givenPath: string | undefined): string {
  if (givenPath === undefined) return DEFAULT_MOUNT_PATH;
  const mountPath = requireNonEmpty(givenPath, "--path");
  if (!mountPath.startsWith("/"))
    throw new StandaloneOptionError(
      `--path must begin with "/"; got ${JSON.stringify(givenPath)}`,
    );
  if (MOUNT_REFUSED_CHARACTERS.test(mountPath))
    throw new StandaloneOptionError(
      `--path must not contain "?", "#" or "%"; got ${JSON.stringify(givenPath)}`,
    );
  if (mountPath.includes("//"))
    throw new StandaloneOptionError(
      `--path must not contain an empty segment; got ${JSON.stringify(givenPath)}`,
    );
  // A single trailing slash is the same mount written two ways, so it is
  // normalized away rather than refused; the root mount is that slash and keeps
  // it.
  const mount =
    mountPath.length > 1 && mountPath.endsWith("/")
      ? mountPath.slice(0, -1)
      : mountPath;
  const segments = mount === "/" ? [] : mount.slice(1).split("/");
  if (segments.some((segment) => segment === "." || segment === ".."))
    throw new StandaloneOptionError(
      `--path must not contain a "." or ".." segment; got ${JSON.stringify(givenPath)}`,
    );
  return mount;
}

/**
 * Resolve where the runner listens and what it serves, from an argument vector
 * and an environment map. A flag beats the environment, and the defaults are
 * loopback on an ephemeral port.
 *
 * The address itself is not parsed here: `listen` resolves a hostname and an
 * address alike, and an address it cannot bind raises an `error` the runner
 * reports. What is checked is what would otherwise fail silently -- a port that
 * is not a port, a blank value, and a mount that would strand the readiness
 * endpoint or move it out from under itself ({@link resolveMountPath}).
 *
 * @throws StandaloneOptionError on any of those, naming the flag or the
 * environment variable the value came from.
 */
export function resolveStandaloneOptions(
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): StandaloneOptions {
  const flags = readFlags(argv);

  const hostSetting = selectValue(
    flags.get("host"),
    "host",
    env[BIND_HOST_ENV],
    BIND_HOST_ENV,
  );
  const portSetting = selectValue(
    flags.get("port"),
    "port",
    env[BIND_PORT_ENV],
    BIND_PORT_ENV,
  );

  const mountPath = resolveMountPath(flags.get("path"));

  return {
    host:
      hostSetting === undefined
        ? DEFAULT_BIND_HOST
        : requireNonEmpty(hostSetting.value, hostSetting.source),
    port:
      portSetting === undefined
        ? DEFAULT_BIND_PORT
        : parsePort(portSetting.value, portSetting.source),
    path: mountPath,
    key: requireNonEmpty(flags.get("key") ?? DEFAULT_REALM_KEY, "--key"),
    readinessPath: posix.join(mountPath, READINESS_SEGMENT),
  };
}

/** The path of a request URL, without the query a probe may append. Compared
 * as it arrived: nothing is percent-decoded, so only the endpoint's own
 * spelling reaches it. */
function requestPathname(url: string | undefined): string {
  if (url === undefined) return "";
  const queryAt = url.search(/[?#]/);
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

/**
 * The runner's plain-HTTP handler: the readiness probe, and a refusal for
 * everything else.
 *
 * The probe answers `GET` and `HEAD` on `readinessPath` once this process is
 * listening. The handler is installed and the signaling server mounted before
 * `listen` is called, so an answer here means the broker is accepting
 * connections and its upgrade route is attached -- which is the whole of what
 * the answer states.
 *
 * Every other request is refused rather than 404'd silently against a route
 * that might exist: the broker handles WebSocket upgrades and this one
 * endpoint, and nothing else is part of any wire it serves.
 */
export function createStandaloneRequestHandler(
  readinessPath: string,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const isProbe =
      requestPathname(request.url) === readinessPath &&
      (request.method === "GET" || request.method === "HEAD");
    if (!isProbe) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : READINESS_BODY);
  };
}
