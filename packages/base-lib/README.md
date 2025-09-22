```sh
npm run build
npm pack
```

If desired to remove `rollup-plugin-dts`, create a file `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": true,
    "outDir": "dist/types"
  },
  "include": ["src"]
}
```

And add these lines to `package.json`:

```json
{
  "scripts": {
    "build:types": "tsc -p tsconfig.build.json",
    "prepublishOnly": "npm run build && npm run build:types"
  }
}
```

## Running tests

```sh
npm run -w packages/base-lib test
```