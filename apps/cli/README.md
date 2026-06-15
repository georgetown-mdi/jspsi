## Quickstart

Node and NPM must be installed.

From the repository root, run:

1. `npm i . -w packages/core -w apps/cli`
2. `npm run -w packages/core build`

To connect:

```sh
npm run dev -w apps/cli sftp://USER:PASSWORD@HOST/PATH INPUT_FILE [OUTPUT_FILE]
```

To avoid using a password on the command line, place it in a plain-text file and execute:

```sh
npm run dev -w apps/cli --server-password=@PASSWORD_FILE sftp://USER@HOST/PATH INPUT_FILE 
```

Similarly, to use a private key:

```sh
npm run dev -w apps/cli --server-private-key=@PEM_FILE sftp://USER@HOST/PATH INPUT_FILE 
```

## To build for Docker Hub

Multi-platform images require a `docker-container`-driver buildx builder. Create
it once, but do NOT make it your default (no `--use`): a global default
`docker-container` builder breaks tools that build and then load a single image
into the local engine -- notably `devcontainer up`, which then hangs after the
build with no container created. Select the builder explicitly with `--builder`
on each deployment build instead, leaving your everyday default on the
engine-native `docker` driver.

Run these from the repository root (the Dockerfile lives there).

Do once (skip if `multiarch-builder` already exists; run `docker buildx rm
multiarch-builder` first to recreate):
```sh
docker buildx create --name multiarch-builder
docker buildx inspect --bootstrap multiarch-builder
```

Do every time:
```sh
docker buildx build --builder multiarch-builder \
  --platform linux/amd64,linux/arm64 \
  -t vdorie/psi-link:latest \
  --push .

docker buildx stop multiarch-builder
```

## To build for testing

Before pushing to Docker hub, from the repository root:

```sh
docker image rm -f vdorie/psi-link:latest
docker build -t vdorie/psi-link:latest .
```

## Running tests

Unit tests:

```sh
npm test -w apps/cli
```

The integration suite drives the real SFTP adapter against an SFTP server it
stands up itself -- in-process by default (an `ssh2.Server` on an ephemeral
loopback port), or a native OpenSSH `sshd` with `PSILINK_SFTP_BACKEND=native`.
The native backend can run hardened configurations (restricted crypto, rate
limits, an allowlist, a chroot jail) selected by `PSILINK_SFTP_NATIVE_PROFILE`.
It is self-managing (a vitest `globalSetup` starts the server before the suite
and stops it after):

```sh
npm run test:integration -w apps/cli
```

See [CONTRIBUTING.md](../../CONTRIBUTING.md#integration-tests) for details.
