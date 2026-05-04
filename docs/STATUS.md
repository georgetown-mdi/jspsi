PSI-Link currently consists of a base library and two applications that build off of it.

# Base library

The base library:
* Wraps OpenMined PSI into a PSI primitive that operates over a generic connection-style object.
* Implements synchronization of participants over SFTP.
* Has hard-coded linkage keys.
* Implements a one-to-one PPRL for a set of realized linkage keys and a object that can conduct a PSI primitive.
* Also contains some SFTP abstractions.

# Web Application

The web application:
* Is a React website using TanStack Router.
* Interfaces with the base library to perform a PSI link and generates a result data file.
* It has a built-in PeerJS server to handle coordinating peer-to-peer connections and uses PeerJS's DataConnections to send messages.
* Is deployed to AWS Elastic Beanstalk.
* It enables parties to invite each other to perform exchanges over WebRTC by single-use, ephemeral links that are tracked by a backend server based on a session id.
  * Inviting party gets a session id from the server and can wait for a server-sent-event that their partner has arrived.
  * Invited party uses PeerJS server to obtain a peer id, which it posts to the backend under the session id.
  * Backend server then sends peer id to inviting party.

# Command Line Application

The command line application:
* Is a NodeJS script built into a Docker container that can conduct scheduled exchanges over SFTP.
* Uses Docker for its ability to harden containers, limiting file-system access out of the box and having the possibility to restrict network endpoints.
* Interfaces with the base library to perform a PSI link and generates a result data file.
* Does not yet have WebRTC capability, as PeerJS needs to be tricked into running on NodeJS.
