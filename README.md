PSI-Link
========

PSI-Link is an open-source tool that lets two organizations find the records they have in common -- and optionally exchange data about those shared records -- without either organization revealing anything about the records they do not share. It performs privacy-preserving record linkage (PPRL) using a cryptographic protocol called private set intersection (PSI).

## Key features

- **Match without disclosure.** Each party keeps its full dataset private; the protocol reveals only which records the two parties have in common.
- **Optional data exchange for matched records.** Beyond identifying matches, parties can share selected columns (for example, program enrollment dates or contact information) for shared records only.
- **Configurable matching.** Records are matched on linkage keys built from identifier fields such as name, date of birth, or SSN, with built-in data cleaning and standardization so both parties' data is compared consistently.
- **No third party holds your data.** The web app exchanges data directly between the two parties' browsers; the command line app uses an SFTP server or file drop that you control.
- **A record of every exchange.** Each completed exchange produces a local record of what was shared, which you can retain for disclosure documentation.

## Example use cases

- A county HMIS administrator and a Medicaid agency identify clients enrolled in both systems and exchange fields such as renewal dates or case manager contact information -- for shared clients only.
- Two service providers with a data sharing agreement determine which clients they serve in common without disclosing their full caseloads to each other.
- An agency IT team runs a recurring, scheduled exchange with a partner as part of a monthly data pipeline, using the command line app.

## Two ways to use this tool

1. **Web app** -- runs in your browser with a guided, step-by-step interface. Your data files are read and processed locally in the browser; nothing is uploaded. Best for first-time and occasional exchanges, or for evaluating the tool. See the [Web App Quickstart](#web-app-quickstart).
2. **Docker container (command line app)** -- a containerized command line application that connects through an SFTP server or file drop. Best for recurring or automated exchanges, or for IT teams integrating linkage into existing data processes. See the [CLI App Quickstart](#cli-app-quickstart).

Both applications implement the same protocol and can be mixed: a first exchange set up in the web app can be exported and automated later with the command line app.

## Test data

This repository includes two synthetic datasets you can use to try the tool without touching real records: [`test_data/fake_data_1.csv`](test_data/fake_data_1.csv) and [`test_data/fake_data_2.csv`](test_data/fake_data_2.csv). Each contains fabricated names, SSNs, and dates of birth, with partial overlap between the two files, so you can run a complete practice exchange -- one party uses each file.

# Web App Quickstart

1. Clone this repository: `git clone https://github.com/georgetown-mdi/jspsi.git` and `cd` into it
2. Install Node.js and NPM
   * On a Mac: Install [Homebrew](https://brew.sh/) and execute `brew install node`
   * On Alpine Linux: `apk add nodejs npm`
   * On other Linux variants, see [here](https://nodejs.org/en/download/package-manager/all).
3. Run `npm install . -w packages/core -w apps/web`
4. Run `npm run -w packages/core build`
5. Run `npm run -w apps/web dev`
6. Visit [http://localhost:3000](http://localhost:3000)

To try it out, use the files in [`test_data/`](test_data/) as each party's input.

See [apps/web](apps/web) for more details.

# CLI App Quickstart

This app has a pre-built Docker image that can be used.

To link a file:

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Within the Docker terminal (or in a Windows/Mac/Linux terminal window), run:  
```sh
docker pull vdorie/psi-link:latest
docker run \
  --rm --mount type=bind,src=WORK_PATH,dst=/work \
  vdorie/psi-link:latest \
  sftp://SFTP_USER:SFTP_PASSWORD@SFTP_HOST:SFTP_PORT/SFTP_PATH \
  INPUT_FILE OUTPUT_FILE
```  
Replacing each of the following:
   * `WORK_PATH` - relative or absolute path to a directory on your machine that contains your input file. The container can only read and write inside this directory, and the output file is written here. Example: `/Users/me/psi-exchange` (Mac/Linux) or `C:\Users\me\psi-exchange` (Windows).
   * `SFTP_USER`, `SFTP_PASSWORD`, `SFTP_HOST`, `SFTP_PORT` - standard SFTP connection information: the account username and password, the server address, and the port (usually `22`; if you use the default you can omit `:SFTP_PORT`).
   * `SFTP_PATH` - path from the **root** of the SFTP server to a directory that both parties can read and write; the exchange happens through files placed here. Example: `/exchanges/county-a-county-b`.
   * `INPUT_FILE` - your data file: a CSV with identifier columns (such as name, date of birth, or SSN) and, optionally, columns with data to share with the other party for matched records. A relative path is resolved inside `WORK_PATH`. Example: `clients.csv`.
   * `OUTPUT_FILE` - name for the results file. Unless an absolute path is specified, the output file is written in `WORK_PATH`. Example: `matches.csv`.

A complete example, run from `/Users/me/psi-exchange` containing `clients.csv`:

```sh
docker run \
  --rm --mount type=bind,src=/Users/me/psi-exchange,dst=/work \
  vdorie/psi-link:latest \
  'sftp://exchange_user:password123@sftp.example.org/exchanges/county-a-county-b' \
  clients.csv matches.csv
```

Because the only content accessible to the container is what is in `WORK_PATH`, we recommend making a new directory and placing the file you wish to link in it.

The output file is a CSV giving the linkage between the two parties' records. See [Output](docs/spec/PROTOCOL.md#output) for the exact column layout and naming rules.

To practice before using real data, the repository provides two synthetic input files in [`test_data/`](test_data/); each party uses one.

For more information, see [apps/cli](apps/cli/).

# Podman

[Podman](https://podman.io/) can be used as a drop-in replacement for Docker. The only change needed is to replace calls to the `docker` executable with calls to `podman`.

# CLI App

## SFTP parameters

### Passwords

Special characters in passwords can be interpreted incorrectly by your shell. To avoid this, encase the whole connection string in single-quotation marks or escape the problematic characters. As an example of an exchange running from the current directory (indicated by mounting `$PWD`, or **p**rinting the **w**orking **d**irectory):

```sh
docker run --rm --mount type=bind,src=$PWD,dst=/work vdorie/psi-link:latest \ 
   'sftp://user:passw!rd@example.org/psi' input.csv output.csv
```

or

```sh
docker run --rm --mount type=bind,src=$PWD,dst=/work vdorie/psi-link:latest \ 
   sftp://user:passw\!rd@example.org/psi input.csv output.csv
```

### Command line flags

Connection parameters can also be specified individually as command line flags to the script. Among others, they include:
   * `--server-port` - port number of the server
   * `--server-username` - username for authentication
   * `--server-password` - password for password-based user authentication; use `@path` to read from file
   * `--server-private-key` - an SSH private key (OpenSSH format) for key-based (publickey) authentication; use `@path` to read from file
   * `--server-private-key-passphrase` - for an encrypted private key, this is the passphrase used to decrypt it; use `@path` to read from file

Using `@path`s specifies that the value should be read from a file. For example, to have the script read a password from the file `passwd` in the working directory, run:

```sh
docker run --rm --mount type=bind,src=$PWD,dst=/work vdorie/psi-link:latest \
  sftp://user@example.org/psi \
  --server-password=@passwd \
  input.csv output.csv
```

Note that because Docker prevents the container from accessing any path on your host system that isn't explicitly mounted, if you wish to use a pre-existing private key the program cannot access `~/.ssh` by default. In that case, either add a read-only mount to the key folder or copy the key to the working directory.

## Windows

### Windows Subsystem for Linux

Docker for Windows requires that the Windows Subsystem for Linux be installed. Docker will ask you to install this the first time it starts up.

### Docker terminal

To execute commands, launch a terminal from within Docker Desktop by clicking on the `>_` icon on the lower-right of the application's status bar.

## Paths and invocation

Paths can be given to Docker using standard Windows-style back-slashes. One exception is at the very end of the string - a trailing back-slash can cause Docker to fail to understand the end of the string. It is safe to remove it as it will still be treated as a directory.

Additionally, the line-continuation markers given in the examples (the `\` at the end of each line) above do not parse correctly. Put commands all on one line instead. For example:

```sh
docker run --rm --mount type=bind,src='C:\Users\me\Documents\psi-link',dst=/work vdorie/psi-link:latest sftp://user:password@example.org/psi input.csv output.csv
```

## Docker run background

The `docker run` command has two parts. The first is the Docker invocation, which mounts `WORK_PATH` at `/work` so the container can read your input and write the output there (see Docker's own docs for [`--rm`](https://docs.docker.com/reference/cli/docker/container/run/#rm) and [`--mount`](https://docs.docker.com/reference/cli/docker/container/run/#mount)):

```sh
docker run --rm --mount type=bind,src=WORK_PATH,dst=/work vdorie/psi-link:latest
```

The second part is the invocation of the psi-link script and includes any command line options you wish to use. In the first example above it is:

```sh
sftp://SFTP_USER:SFTP_PASSWORD@SFTP_HOST:SFTP_PORT/SFTP_PATH INPUT_FILE OUTPUT_FILE
```

However, you can place anything here you wish to pass on to the program. For example, to have it print all of its options, execute:

```sh
docker run --rm vdorie/psi-link:latest --help
```

# Documentation

The full documentation set lives in [docs/](docs/README.md) and covers the protocol, threat model, exchange specification, deployment, and operations. The role-based reading guide there points each audience (program officers, security reviewers, IT staff, contributors, partner agencies) to the most relevant documents.

Repository-level resources:

- [CONTRIBUTING.md](CONTRIBUTING.md) - development setup, code conventions, and pull request process
- [SECURITY.md](SECURITY.md) - vulnerability reporting and supported versions
- [SUPPORT.md](SUPPORT.md) - bug reports, questions, and evaluation help
- [CHANGELOG.md](CHANGELOG.md) - release history
