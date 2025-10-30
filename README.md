PSI Link
========

***Secure record linkage and data transfer using private set intersection.***

This repository contains two applications, a web-based one that allows peer-to-peer exchanges and a command line one that uses SFTP as an intermediary.

## Web App Quickstart

1. Install Node.js and NPM
   * On a Mac: Install [Homebrew](https://brew.sh/) and execute `brew install node`
   * On Alpine Linux: `apk add nodejs npm`
   * On other Linux variants, see [here](https://nodejs.org/en/download/package-manager/all).
2. Run `npm install . -w packages/base-lib -w apps/web`
3. Run `npm run -w packages/base-lib build`
4. Run `npm run -w apps/web dev`
5. Visit [http://localhost:3000](http://localhost:3000)

See [apps/web](apps/web) for more details.

## CLI App Quickstart

This app has a pre-built Docker image that can be used.

To link a file:

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Within the Docker terminal (or in a Windows/Mac/Linux terminal window), run:  
```sh
docker pull vdorie/psi-link:latest
docker run \
  -it --rm \
  --mount type=bind,src=PATH_TO_DATA_FILE,dst=/work \
  vdorie/psi-link:latest \
  sftp://SFTP_USER:SFTP_PASSWORD@SFTP_HOST:SFTP_PORT/SFTP_PATH \
  /work/NAME_OF_DATA_FILE
```  
Replacing each of the following:
   * `PATH_TO_DATA_FILE` - relative of absolute path on your host machine where the file you wish to transfer is
   * `SFTP_USER`, `SFTP_PASSWORD`, `SFTP_HOST`, `SFTP_PORT` - standard SFTP connection information
   * `SFTP_PATH` - path from root on the SFTP server where both parties can read and write; the exchange will happen here
   * `NAME_OF_DATA_FILE`

The only content accessible to the container will be that in `PATH_TO_DATA_FILE`, so you are recommended to make a new directory and place it in the file you wish to transfer.

For more information, see [apps/cli](apps/cli/).
