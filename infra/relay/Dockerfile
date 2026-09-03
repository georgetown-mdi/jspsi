# The single home of the relay's image pin.
#
# Everything else in this directory -- the Quadlet unit, install.sh, verify.sh --
# names the locally built `localhost/psilink-relay:installed` tag, so this digest
# has exactly one copy and a base move is exactly one edit.
#
# coturn/coturn:4.17.2, pinned to the multi-arch index digest (linux/amd64 and
# linux/arm64 among seven platforms) resolved from the Docker Hub registry API on
# 2026-09-03, so a build resolves one exact image on either architecture. A base
# bump is a deliberate digest update, not an automatic float; the docker
# ecosystem entry for /infra/relay in .github/dependabot.yml is what raises one.
#
# The fallback if the community image stops publishing: this file grows a build
# from a pinned coturn source tag -- a builder stage fetching that tag's release
# tarball under a committed checksum and configuring it against the distribution
# OpenSSL -- rather than floating onto another publisher's image.
FROM coturn/coturn:4.17.2@sha256:aa68aab64a3b929d57fc2924c98ea447bf996cf8dade2508e7b71eaf23f1f14e
