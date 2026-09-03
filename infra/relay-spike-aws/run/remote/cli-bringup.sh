#!/bin/bash
# One-time bring-up of the restricted CLI box: wait for docker, load the party
# image from the attached image-cache volume (or from an uploaded tarball), and
# prove the image it needs is really there. Run once by fixture-up.sh, before the
# restrictive network ACL is applied -- the apt work cloud-init does needs the
# open network.
#
# SPIKE_IMAGES is the caller's list of <cache file>=<image tag> pairs. The same
# list ships the tarballs, so the file name and the tag cannot drift apart, and
# the docker image inspect at the end is what turns a delivery that missed into
# a failed bring-up rather than five failed exchanges.
set -euo pipefail
D=/opt/spike
CACHE_DEV="${SPIKE_CACHE_DEV:-}"
SPIKE_IMAGES="${SPIKE_IMAGES:-party.tar=psi-link:spike-party}"
say() { printf '### %s %s\n' "$(date -u +%FT%TZ)" "$*"; }
read -r -a IMAGES <<< "$SPIKE_IMAGES"

say "waiting for docker"
for _ in $(seq 1 120); do
  if sudo docker info >/dev/null 2>&1; then break; fi
  sleep 2
done
sudo docker info >/dev/null 2>&1 || { sudo cloud-init status --long || true; exit 1; }

if [ -n "$CACHE_DEV" ]; then
  sudo mkdir -p /mnt/imgcache
  mountpoint -q /mnt/imgcache || sudo mount "$CACHE_DEV" /mnt/imgcache
  for spec in "${IMAGES[@]}"; do
    t="/mnt/imgcache/${spec%%=*}"
    if [ ! -f "$t" ]; then
      say "the image cache holds no $t"
      ls -l /mnt/imgcache || true
      exit 1
    fi
    say "docker load < $t"; sudo docker load -i "$t" >/dev/null
  done
else
  for t in "$D"/images/*.tar.gz; do
    [ -f "$t" ] || continue
    say "docker load < $t"; gunzip -c "$t" | sudo docker load >/dev/null
  done
fi

MISSING=""
for spec in "${IMAGES[@]}"; do
  tag="${spec#*=}"
  sudo docker image inspect "$tag" >/dev/null 2>&1 || MISSING="$MISSING $tag"
done
if [ -n "$MISSING" ]; then
  say "NOT LOADED, so no exchange on this box could run:$MISSING"
  sudo docker image ls --format '{{.Repository}}:{{.Tag}}'
  ls -l /mnt/imgcache 2>/dev/null || true
  exit 1
fi

sudo docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}'
mkdir -p "$D/work"
say "restricted CLI box ready, images verified:$(printf ' %s' "${IMAGES[@]}")"
