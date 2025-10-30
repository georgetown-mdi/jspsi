## Quickstart

Node and NPM must be installed.

From the repository root, run:

1. `npm i . -w packages/base-lib -w apps/cli`
2. `npm run -w packages/base-lib build`

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

## Testing container

This runs an SFTP server on localhost that can be used for testing. After starting it, you can connect via `sftp://usera:usera@localhost:2222/psi` and `sftp://userb:userb@localhost:2222/psi`. Files are "transfered" in `packages/base-lib/test/container/sftp/srv`.

### If on Mac OS or other ARM

Do once:

```sh
DOCKER_DEFAULT_PLATFORM=linux/arm64 docker compose -f apps/cli/test/container/compose.yaml build
```

### Regular usage

Do once:

```sh
sh apps/cli/test/container/setup.sh
```

Do every time:

```sh
docker compose -f apps/cli/test/container/compose.yaml up -d
```

To stop:

```sh
docker compose -f apps/cli/test/container/compose.yaml down
```

Connection examples:

```sh
npm run -w apps/cli dev \
  sftp://usera:usera@localhost:2222/psi \
  ../../fake_data_1.csv \
  usera_output.csv
```

```sh
npm run -w apps/cli dev \
  sftp://userb:userb@localhost:2222/psi \
  ../../fake_data_2.csv \
  userb_output.csv
```

## Running tests

```sh
npm run -w apps/cli test
```
