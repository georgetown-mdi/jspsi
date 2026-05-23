PSI-Link currently consists of a core library and two applications that build off of it.

# Core library

The core library:
- Wraps OpenMined PSI into a PSI primitive that operates over a generic connection-style object.
- Implements synchronization of participants over a file-based transport (SFTP or locally-mounted directory).
- Has user-defined linkage keys.
- Has user-defined data standardization.
- Implements a one-to-one PPRL for a set of realized linkage keys and a object that can conduct a PSI primitive.
- Infers metadata, linkage keys, and standardization based on input columns.
- Contains file transport abstractions (`FileTransportClient`, `FileSyncConnection`) used by both the SFTP and file-drop channels.
- Prepares data payloads.

# Web Application

The web application:
- Is a React website using TanStack Router.
- Interfaces with the core library to perform a PSI link and generates a result data file.
- It has a built-in PeerJS server to handle coordinating peer-to-peer connections and uses PeerJS's DataConnections to send messages.
- Is deployed to AWS Elastic Beanstalk.
- It enables parties to invite each other to perform exchanges over WebRTC by single-use, ephemeral links that are tracked by a backend server based on a session id.
  - Inviting party gets a session id from the server and can wait for a server-sent-event that their partner has arrived.
  - Invited party uses PeerJS server to obtain a peer id, which it posts to the backend under the session id.
  - Backend server then sends peer id to inviting party.

# Command Line Application

The command line application:
- Is a NodeJS script built into a Docker container that can conduct scheduled exchanges over SFTP.
- Uses Docker for its ability to harden containers, limiting file-system access out of the box and having the possibility to restrict network endpoints.
- Interfaces with the core library to perform a PSI link and generates a result data file.
- Users can conduct zero-setup exchanges or execute recurring exchanges using config files.
- Does not yet have WebRTC capability, as PeerJS needs to be tricked into running on NodeJS.

# Planned functionality

## MVP

- PAKE authentication
- AEAD encryption for PAKE authenticated SFTP connections
- Invite and accept for CLI
- Path way to migrate from zero-setup to recurring exchange for CLI
- ~~File system as a connection type~~ (done: `filedrop` channel)
- Web application

## Version 1.0

- PSI-C
- SSH as a channel
- Splitting standardized fields, e.g. last names over `-`
- Parallelizing encryption
- Many-to-X linkages
- Asymmetric output

## Version 1.1

- Synchronous protocol execution
- Provisioning of services
- Deployment guides for services
