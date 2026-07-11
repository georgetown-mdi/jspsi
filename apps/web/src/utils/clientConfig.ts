import { ConfigManager as BaseConfigManager } from "./configManager";

import type { JSONSchemaType } from "env-schema";

import type { LogLevel } from "loglevel";

/**
 * The deployment this build targets. `hosted` is the public browser-only
 * deployment: the server never receives a file and only coordinates peers.
 * `console` is the single-party appliance, whose same-origin job API runs a
 * filedrop exchange server-side. The value is fixed at build time from
 * `VITE_DEPLOYMENT_PROFILE`; it decides the file-assurance copy, the transport
 * chooser's filedrop copy, and whether a filedrop channel routes to the
 * server-job driver.
 */
export type DeploymentProfile = "hosted" | "console";

interface Env {
  PEERJS_DEBUG_LEVEL: number;
  LOG_LEVEL: keyof LogLevel;
  DEPLOYMENT_PROFILE: DeploymentProfile;
}

const schema: JSONSchemaType<Env> = {
  type: "object",
  required: [],
  properties: {
    PEERJS_DEBUG_LEVEL: {
      // Errors only (1), not warnings (2): PeerJS's warning-level logs
      // interpolate remote peer ids into the browser console, and those ids are
      // rendezvous addresses derived from the invitation secret -- the app keeps
      // them out of its own default logs (see psi/rendezvous.ts), so the PeerJS
      // logger must not reintroduce them. Raise via the PEERJS_DEBUG_LEVEL env
      // var when diagnosing connection issues.
      type: "number",
      default: 1,
    },
    LOG_LEVEL: {
      type: "string",
      default: "INFO",
    },
    DEPLOYMENT_PROFILE: {
      // `hosted` (the default) is the public browser-only deployment: the
      // server never receives a file, so the browser-only file-assurance copy
      // holds and every filedrop/sftp transport saves an exchange file. A
      // deployment whose server legitimately runs exchanges (the console
      // appliance) opts in via VITE_DEPLOYMENT_PROFILE=console, which drops
      // that assurance copy and routes a filedrop channel to the server-job
      // driver.
      type: "string",
      enum: ["hosted", "console"],
      default: "hosted",
    },
  },
};

class ConfigManager extends BaseConfigManager<Env> {
  constructor() {
    super(schema);
  }
}

/**
 * The VITE_-prefixed build-time values as the plain `data` env-schema reads,
 * matching the derivation client.tsx and fileAssurance.ts use. `import.meta.env`
 * has no `process.env` in a real browser, so the values arrive explicitly here
 * rather than through env-schema's default env reading.
 */
function viteEnvData(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(import.meta.env)
      .filter(([key]) => key.startsWith("VITE_"))
      .map(([key, value]) => [key.substring(5), value]),
  );
}

const configManager = new ConfigManager();
const config = await configManager.load({ env: false, data: viteEnvData() });

/** This build's {@link DeploymentProfile}, resolved once from the config. */
export function deploymentProfile(): DeploymentProfile {
  return config.DEPLOYMENT_PROFILE;
}

/** Whether this build targets the console appliance ({@link DeploymentProfile}
 * `console`), whose server runs a filedrop exchange rather than the browser. */
export function isConsoleBuild(): boolean {
  return deploymentProfile() === "console";
}

export { ConfigManager };
