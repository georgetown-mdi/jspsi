#!/bin/bash
# Format (once) and fill the image-cache volume from tarballs streamed in over
# SSH. Run on the restricted CLI box while the volume is attached to it, before
# the restrictive network ACL is applied.
#
# The volume is the reason a cycle does not spend four hundred megabytes of
# upload on every ephemeral services box: it is created once, filled once, and
# attached to each new instance. A real deployment would pull from a registry or
# boot a baked image instead; both are unavailable to this credential
# (ec2:CreateImage and every registry-hosting service are denied).
set -euo pipefail
DEV="${1:?usage: seed-cache.sh <device>}"
sudo mkdir -p /mnt/imgcache
if ! sudo blkid "$DEV" >/dev/null 2>&1; then
  echo "### formatting $DEV ext4"
  sudo mkfs.ext4 -F -L psilink-spike-cache "$DEV"
fi
mountpoint -q /mnt/imgcache || sudo mount "$DEV" /mnt/imgcache
sudo chown "$USER" /mnt/imgcache
df -h /mnt/imgcache
ls -l /mnt/imgcache
