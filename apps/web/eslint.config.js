// eslint.config.js
import pluginRouter from '@tanstack/eslint-plugin-router'
import { tanstackConfig } from '@tanstack/eslint-config'

export default [
  ...tanstackConfig,
  ...pluginRouter.configs['flat/recommended'],
  {
    rules: {
      'sort-imports':
      [
        "error",
        {
          "allowSeparatedGroups": true
        }
      ]
    }
  }
  // Any other config...
]
