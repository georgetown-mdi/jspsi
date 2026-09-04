import { envSchema } from "env-schema";

import type { EnvSchemaOpt, JSONSchemaType } from "env-schema";

/**
 * Memoized env loader parameterized on the caller's `TEnv` env shape and its
 * schema. Each config module supplies only its `Env` interface and schema
 * object; the load/default-and-cache behavior lives here once.
 */
export class ConfigManager<TEnv> {
  // Declared and assigned rather than taken as a `private readonly` constructor
  // parameter property: apps/web/vite.config.ts reaches this module through
  // serverConfig.ts, and the paths that evaluate that config with no transform
  // in front of them -- Vite's `configLoader: "native"`, a plain `node` import
  // -- hand it to Node's strip-only type stripping, which refuses a parameter
  // property outright. Checked by scripts/check-web-config-native-load.mjs.
  private readonly schema: JSONSchemaType<TEnv>;

  config: TEnv | null;

  constructor(schema: JSONSchemaType<TEnv>) {
    this.schema = schema;
    this.config = null;
  }

  async load(configOptions: EnvSchemaOpt<TEnv> = {}) {
    if (!this.config) {
      configOptions.schema = configOptions.schema || this.schema;
      this.config = await envSchema(configOptions);
    }

    return this.config;
  }
}
