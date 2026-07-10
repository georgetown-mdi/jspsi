import { envSchema } from "env-schema";

import type { EnvSchemaOpt, JSONSchemaType } from "env-schema";

/**
 * Memoized env loader parameterized on the caller's `TEnv` env shape and its
 * schema. Each config module supplies only its `Env` interface and schema
 * object; the load/default-and-cache behavior lives here once.
 */
export class ConfigManager<TEnv> {
  config: TEnv | null;

  constructor(private readonly schema: JSONSchemaType<TEnv>) {
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
