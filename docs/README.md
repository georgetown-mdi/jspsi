---
title: "PSI-Link Documentation"
---

# PSI-Link documentation

PSI-Link is a privacy-preserving record linkage (PPRL) tool that enables
partner agencies to identify shared members across administrative datasets
without revealing anything about the records they do not have in common. It
implements a private set intersection (PSI) protocol available both as a
browser-based web application and a containerized CLI, and is designed to work
within the policy and infrastructure constraints typical of government agencies.

## Role-based reading guide

| I am a... | Start with... | Then read... |
|-----------|--------------|--------------|
| Program officer evaluating the software | [DESIGN.md](DESIGN.md) | [SECURITY.md](SECURITY.md) |
| Security reviewer or auditor | [SECURITY.md](SECURITY.md) | [PROTOCOL.md](PROTOCOL.md) |
| IT professional operationalizing an exchange | [CLI.md](CLI.md) | [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md), [DEPLOYMENT.md](DEPLOYMENT.md) |
| Developer contributing to the project | [DESIGN.md](DESIGN.md) | [PROTOCOL.md](PROTOCOL.md), [COMMUNICATION.md](COMMUNICATION.md) |
| Partner agency setting up an exchange | [CLI.md](CLI.md) | [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) |

## Document inventory

- [DESIGN.md](DESIGN.md) - project overview, architecture, exchange specification summary, and high-level user journey
- [PROTOCOL.md](PROTOCOL.md) - PSI and PSI-C algorithms, linkage mechanics, datasets, and post-linkage steps
- [SECURITY.md](SECURITY.md) - threat model, authentication design, channel security, and key rotation
- [COMMUNICATION.md](COMMUNICATION.md) - channels, synchronization, error handling, and supporting services
- [EXCHANGE_SPEC.md](EXCHANGE_SPEC.md) - complete field-level reference for exchange specification files
- [CLI.md](CLI.md) - CLI commands, configuration files, invitation strings, and recovery
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating supporting services and Docker deployment of the CLI
