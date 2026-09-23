---
title: "Holding the Hosted Environment's Inbound Rules"
---

# Holding the hosted environment's inbound rules in OpenTofu

_Status: decided and written, 2026-09-22; not yet run against the live
account. This note records how the OpenTofu root under
[`infra/hosted/`](../../infra/hosted/README.md) holds the inbound rules of the
project's own Elastic Beanstalk environments, and the two alternatives weighed
against it. The operational steps -- adopting the live resources, applying,
reading a plan for drift, and the first run -- are in
[`infra/hosted/README.md`](../../infra/hosted/README.md). See
[docs/notes/README.md](README.md)._

## The posture to hold

One security group per instance, admitting `:443` from Cloudflare's published
ranges and nothing else inbound, and holding after a `rebuild-environment` or a
platform update as well as after a configuration deployment.

By default Elastic Beanstalk creates a security group of its own for each
environment's instances, owned by the environment's CloudFormation stack, and a
rebuild or a platform update recreates it from the platform's template. A rule
list the root does not own cannot be held by it.

## The decision taken

The root sets the option `DisableDefaultEC2SecurityGroup` to `true` on both
environments. The platform then creates no group of its own, and the group the
root declares in `security_group.tf` -- owned by the root, with inline rules
that make its inbound list exclusive -- is the only one attached.

Because the choice is an option setting, it is part of the environment
configuration, which a rebuild replays; a revoke made outside the
configuration is not replayed.

The group the root adopts is the one both environments already attach, so
adopting it changes no id either instance uses.

## Alternatives, and why they were not taken

### Look the platform's group up and attach rules to it

A data source finds the platform's group, and
`aws_vpc_security_group_ingress_rule` resources add rules to it. That can add
rules to a group but cannot remove one it did not create, and a rebuild gives
the group a new id and a fresh rule set that no apply has seen.

### Import the platform's group into the root's state

Inline rules on an imported group would make its list exclusive, so an apply
removes any rule not declared in the root. But the group then has two owners,
and after a rebuild the state names a group that no longer exists: holding the
posture needs a re-import and an apply after every rebuild, and between the two
the group is the platform's.
