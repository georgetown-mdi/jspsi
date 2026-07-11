import { ConfigManager as BaseConfigManager } from "./configManager";

import type { JSONSchemaType } from "env-schema";

import type { LogLevel } from "loglevel";

interface Env {
  PORT: number;
  LOG_LEVEL: keyof LogLevel;
  TEST_SESSION: boolean;
  /**
   * Feature gate and data root for the server-side job API. When unset the job
   * API is off: every job route returns 404 and no CLI child is spawned, which
   * keeps the API dark in a hosted deployment. When set, per-job workdirs are
   * created under this resolved directory.
   */
  JOB_DATA_ROOT: string;
  /**
   * Bearer token for the job API. When set (non-empty), every job route requires
   * `Authorization: Bearer <token>` with a constant-time comparison. When empty,
   * the API is unauthenticated -- permitted only on a loopback bind (a non-loopback
   * bind with the API enabled and no token is a fail-closed startup error).
   */
  JOB_API_TOKEN: string;
}

const schema: JSONSchemaType<Env> = {
  type: "object",
  required: ["PORT"],
  properties: {
    PORT: {
      type: "number",
      default: 3000,
    },
    LOG_LEVEL: {
      type: "string",
      default: "INFO",
    },
    TEST_SESSION: {
      type: "boolean",
      default: false,
    },
    JOB_DATA_ROOT: {
      type: "string",
      default: "",
    },
    JOB_API_TOKEN: {
      type: "string",
      default: "",
    },
  },
};

class ConfigManager extends BaseConfigManager<Env> {
  constructor() {
    super(schema);
  }
}

export { ConfigManager };
