import { ConfigManager as BaseConfigManager } from "./configManager";

import type { JSONSchemaType } from "env-schema";

import type { LogLevel } from "loglevel";

interface Env {
  PORT: number;
  LOG_LEVEL: keyof LogLevel;
  TEST_SESSION: boolean;
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
  },
};

class ConfigManager extends BaseConfigManager<Env> {
  constructor() {
    super(schema);
  }
}

export { ConfigManager };
