---
title: "Getting Support"
---

# Getting support

PSI-Link is open-source software maintained on a best-effort basis. This page describes where to direct different kinds of questions.

## I think I found a security vulnerability

Do not open a public issue. Follow the private reporting process in [SECURITY.md](SECURITY.md).

## I found a bug or have a feature request

Open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues). Please include:

- The PSI-Link version (the Docker image tag or `package.json` version)
- The transport channel (`webrtc`, `sftp`, or `filedrop`)
- The operating system and version
- A minimal reproducing case, if possible
- Relevant log output, with any sensitive values redacted

## I need help running an exchange

Start with the documentation:

- [docs/CLI.md](docs/CLI.md) for command-line usage, configuration files, and recovery procedures
- [docs/EXCHANGE_SPEC.md](docs/EXCHANGE_SPEC.md) for the full configuration file reference
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for operating supporting services
- [README.md](README.md) for the Docker quickstart

If your question is not answered there, open a [GitHub issue](https://github.com/georgetown-mdi/jspsi/issues) and tag it with `question`. We do not yet operate a separate discussion forum or mailing list.

<!-- TODO: link a community discussion channel (GitHub Discussions, mailing list, or similar) once one is established. -->

## I am evaluating PSI-Link for my agency

Compliance and security reviewers should start with [docs/COMPLIANCE.md](docs/COMPLIANCE.md) and [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md). The [role-based reading guide](docs/README.md#role-based-reading-guide) points each reviewer audience to the most relevant documents.

For evaluation questions that the documentation does not answer, open a GitHub issue tagged `evaluation`. Maintainers will respond on a best-effort basis.

<!-- TODO: document a commercial support or paid-engagement option, if one becomes available. -->

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code conventions, and the pull request process.

## Response expectations

PSI-Link is maintained by a small team. Bug reports and security reports are prioritized over feature requests and evaluation questions. There is no service-level agreement; the timelines in [SECURITY.md](SECURITY.md) apply only to confirmed security vulnerabilities.
