import tseslint from "typescript-eslint";
import webConfig from "./apps/web/eslint.config.js";

function scopeToDir(dir, configs) {
  return configs.map((config) => {
    if (config.ignores && !config.files) return config;
    const files = config.files
      ? config.files.map((f) => `${dir}/${f}`)
      : [`${dir}/**/*.{ts,tsx,js,jsx}`];
    return { ...config, files };
  });
}

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "apps/web/eslint.config.js"],
  },
  {
    files: ["packages/**/*.{ts,tsx}", "apps/cli/**/*.{ts,tsx}"],
    extends: tseslint.configs.recommended,
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  ...scopeToDir("apps/web", webConfig),
);
