## Quickstart

Install Node.js.
1. Mac: Install [Homebrew](https://brew.sh/) and execute `brew install node`
2. Run `npm install`
3. Run `npm run dev`
4. Visit [http://localhost:3000](http://localhost:3000)

## Testing container

Currently needed for SFTP tests.

### If on Mac OS or other ARM

Do once:

```sh
DOCKER_DEFAULT_PLATFORM=linux/arm64 docker compose -f test/container/compose.yaml build
```

### Regular usage

Do once:

```sh
sh test/container/setup.sh
```

Do every time:

```sh
docker compose -f test/container/compose.yaml up -d
```

To stop:

```sh
docker compose -f test/container/compose.yaml down
```
