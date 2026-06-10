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

Do once:
```sh
docker buildx create --use --name multiarch-builder
docker buildx inspect --bootstrap
```

Do every time:
```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t vdorie/psi-link:latest \
  --push .

docker buildx stop multiarch-builder
```

## To build for testing

Before pushing to Docker hub:

```sh
docker image rm -f vdorie/psi-link:latest
docker build -t vdorie/psi-link:latest .
```

## Testing container

This runs an SFTP server on localhost that can be used for testing. After starting it, you can connect via `sftp://usera:usera@localhost:2222/psi` and `sftp://userb:userb@localhost:2222/psi` (2222 is the default port; a worktree set up by `make-worktree` gets its own port -- see `apps/cli/test/container/.env`). Files are "transfered" in `apps/cli/test/container/sftp/srv`.

### If on Mac OS or other ARM

No extra step is needed. `atmoz/sftp` publishes `linux/amd64` only, and the compose file pins that image by digest, so on an ARM machine (Apple Silicon) Docker runs it under emulation automatically. Expect a harmless `platform (linux/amd64) does not match ... host platform (linux/arm64)` warning.

### Regular usage

Do once:

```sh
sh apps/cli/test/container/setup.sh
```

Do every time:

```sh
npm run test:container:up -w apps/cli
```

To stop:

```sh
npm run test:container:down -w apps/cli
```

These wrap `docker compose` with the right `--env-file` and run from the
checkout root; prefer them over a raw `docker compose` call, which skips the env
file and so ignores this checkout's project name and port.

Connection examples:

```sh
run dev -w apps/cli -- \
  sftp://usera:usera@localhost:2222/psi \
  test_data/fake_data_1.csv \
  usera_output.csv
```

```sh
run dev -w apps/cli -- \
  sftp://userb:userb@localhost:2222/psi \
  test_data/fake_data_2.csv \
  userb_output.csv
```

## Running tests

```sh
npm test -w apps/cli
```
