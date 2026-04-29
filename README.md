PSI Link
========

***Secure record linkage and data transfer using private set intersection.***

This repository contains two applications, a web-based one that allows peer-to-peer exchanges and a command line one that uses SFTP as an intermediary.

# Web App Quickstart

1. Install Node.js and NPM
   * On a Mac: Install [Homebrew](https://brew.sh/) and execute `brew install node`
   * On Alpine Linux: `apk add nodejs npm`
   * On other Linux variants, see [here](https://nodejs.org/en/download/package-manager/all).
2. Run `npm install . -w packages/base-lib -w apps/web`
3. Run `npm run -w packages/base-lib build`
4. Run `npm run -w apps/web dev`
5. Visit [http://localhost:3000](http://localhost:3000)

See [apps/web](apps/web) for more details.

# CLI App Quickstart

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
  NAME_OF_DATA_FILE NAME_OF_OUTPUT_FILE
```  
Replacing each of the following:
   * `PATH_TO_DATA_FILE` - relative or absolute path on your host machine where the file you wish to transfer is
   * `SFTP_USER`, `SFTP_PASSWORD`, `SFTP_HOST`, `SFTP_PORT` - standard SFTP connection information
   * `SFTP_PATH` - path from the *root* of the SFTP server where both parties can read and write; the exchange will happen here
   * `NAME_OF_DATA_FILE`, `NAME_OF_OUTPUT_FILE`

The only content accessible to the container will be that in `PATH_TO_DATA_FILE`, so you are recommended to make a new directory and place it in the file you wish to transfer.

The output file will contain the association-table mapping between each partners' data. It is formatted a csv with columns `our_row_id` and `their_row_id`. Each is a 0-based index into each dataset, giving the correspondence between rows in each dataset.

For more information, see [apps/cli](apps/cli/).

# CLI App

## SFTP parameters

### Passwords

Special characters in passwords can be interpretted incorrectly by your shell. To avoid this, encase the whole connection string in single-quotation marks or escape the problematic characters. As example exchange running from the current directory (indicated by mounting `$PWD`):

```sh
docker run -it --rm --mount type=bind,src=$PWD,dst=/work vdorie/psi-link:latest \ 
   'sftp://user:passw!rd@example.org/psi' input.csv output.csv
```

or

```sh
docker run -it --rm --mount type=bind,src=$PWD,dst=/work vdorie/psi-link:latest \ 
   sftp://user:passw\!rd@example.org/psi input.csv output.csv
```

### Command line flags

Connection parameters can also be specified individually as command line flags to the script. Among others, they include:
   * `--server-port` - port number of the server
   * `--server-username` - username for authentication
   * `--server-password` - password for password-based user authentication; use `@path` to read from file
   * `--server-private-key` - buffer or string that contains a private key for either key-based or hostbased user authentication (OpenSSH format); use `@path` to read from file`
   * `--server-passphrase` - for an encrypted private key, this is the passphrase used to decrypt it; use `@path` to read from file

`@path`s specify that the value should be read from a file. For example, to have the script read a password from the file `passwd` in the working directory, run:

```sh
docker run -it --rm --mount type=bind,src=$PWD,dst=/work vdorie/psi-link:latest \
  sftp://user@example.org/psi \
  --server-password=@passwd \
  input.csv output.csv
```

## Windows

### Windows Subsystem for Linux

Docker for Windows requires that the Windows Subsystem for Linux be installed. Docker will ask you to install this the first time it starts up.

### Docker terminal

To execute commands, launch a terminal from within Docker Desktop by clicking on the `>_` icon on the lower-right of the application's status bar.

## Paths and invocation

The path is given to Docker using standard Windows-style back-slashes. One exception is at the very end of the string - a trailing back-slash can cause Docker to fail to understand the end of the string.

Additionally, the line-continuation markers given in the examples (the `\` at the end of each line) above do not parse correctly. Put commands all on one line instead. For example:

```sh
docker run -it --rm --mount type=bind,src='C:\Users\me\Documents\psi-link',dst=/work vdorie/psi-link:latest sftp://user:password@example.org/psi input.csv output.csv
```

## Docker run background

The `docker run` command above contains two parts. The first part includes instructions purely for Docker, telling it what to run and how:

```sh
docker run -it --rm --mount type=bind,src=PATH_TO_DATA_FILE,dst=/work vdorie/psi-link:latest
```

This instructs Docker to:
   * *Run* a container
      * In *i*nterative mode, opening a pseudo-*t*erminal
      * *R*e*m*oving the container when finished
      * *Mount*ing a path on the host computer inside the container, where it can be read from and written to
   * Use the *latest* tag of the *vdorie/psi-link* image as the container

The second part is the invocation of the psi-link script and includes any command line options you wish to use. In the above example it is:

```sh
sftp://SFTP_USER:SFTP_PASSWORD@SFTP_HOST:SFTP_PORT/SFTP_PATH /work/NAME_OF_DATA_FILE /work/NAME_OF_OUTPUT_FILE
```

However, you can place anything here you wish. For example, to get help for the script execute:

```sh
docker run -it --rm vdorie/psi-link:latest --help
```

Anything you want to pass to the script goes to the right of `vdorie/psi-link:latest`.
