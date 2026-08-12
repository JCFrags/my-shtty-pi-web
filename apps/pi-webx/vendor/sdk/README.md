# WebX SDK runtime

These JavaScript and declaration files are the package-local runtime build of `packages/sdk/src`.

Regenerate them from the repository root:

```sh
pnpm exec tsc -p packages/sdk/tsconfig.json \
  --rootDir packages/sdk/src \
  --outDir apps/pi-webx/vendor/sdk \
  --noEmit false --declaration true --sourceMap false
```

The singular Pi package includes this code. It does not use a workspace or file dependency at runtime.
