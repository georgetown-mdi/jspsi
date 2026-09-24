# The single home of the relay's image pin.
#
# Everything else in this directory -- the Quadlet unit, install.sh, verify.sh --
# names the locally built `localhost/psilink-relay:installed` tag, so this digest
# has exactly one copy and a base move is exactly one edit.
#
# coturn/coturn:4.18.0, pinned to its multi-arch index digest, so a build
# resolves one exact image on either architecture. Registry-qualified, because
# podman on Fedora refuses a short name it cannot prompt to resolve. A base bump
# is a deliberate digest update, not an automatic float; the docker ecosystem
# entry for /infra/relay in .github/dependabot.yml is what raises one, and
# scripts/relay-turn-secret-schema.test.mjs holds this comment's version to the
# tag and drives the new image's secrets table against relay_table.py.
#
# The fallback if the community image stops publishing: this file grows a build
# from a pinned coturn source tag -- a builder stage fetching that tag's release
# tarball under a committed checksum and configuring it against the distribution
# OpenSSL -- rather than floating onto another publisher's image.
FROM docker.io/coturn/coturn:4.18.0@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3
