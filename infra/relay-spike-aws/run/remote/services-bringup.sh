#!/bin/bash
# Bring the services box up, over SSH, after the instance is reachable.
#
# The instance carries three addresses because coturn and nginx both want 443:
#   SPIKE_IP_TURN   primary private address of the first interface -- coturn
#   SPIKE_IP_WEB    secondary private address of that same interface -- nginx
#   SPIKE_IP_PROXY  the second interface, in the restricted subnet -- the
#                   class-B inspecting proxy's next-hop address
# t4g.micro allows two interfaces and two IPv4 addresses per interface, measured
# with `aws ec2 describe-instance-types`, so that plan is exactly at the limit.
#
# The REDIRECT rules match on the SECOND interface only. Class A reaches the
# services directly on the first interface and is not intercepted; class B is
# routed to the second interface by a VPC route and is. The route table is the
# discriminator, so these rules are installed once and never switched.
set -euo pipefail
D=/opt/spike
: "${SPIKE_IP_TURN:?}" "${SPIKE_IP_WEB:?}" "${SPIKE_IP_PROXY:?}"
: "${SPIKE_TURN_HOST:?}" "${SPIKE_WEB_HOST:?}"
CACHE_DEV="${SPIKE_CACHE_DEV:-}"
# <cache file>=<image tag> pairs, from the same list that shipped the tarballs.
SPIKE_IMAGES="${SPIKE_IMAGES:-services-hosted.tar=psi-link:spike-hosted services-coturn.tar=coturn/coturn:latest services-nginx.tar=nginx:alpine}"
read -r -a IMAGES <<< "$SPIKE_IMAGES"

say() { printf '### %s %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Private key material arrives by scp with whatever mode the copy applied, which
# nothing had ever read back. Set it and prove it: a mode that is only asserted
# is not a mode.
say "securing the key material this box was handed"
sudo chmod 711 "$D/certs"
sudo chmod 644 "$D"/certs/*.crt
sudo chmod 600 "$D"/certs/*.key "$D/turnserver.conf"
# coturn's image runs as uid 65534 (driven: docker run --rm --entrypoint id
# coturn/coturn:latest), nginx as root, and the proxy as uid 1000, which is this
# host's ubuntu user. A 600 file owned by ubuntu is unreadable to coturn, which
# then silently falls back to its defaults, so its two files are owned by that uid.
sudo chown 65534 "$D/turnserver.conf" "$D/certs/turn.key"
BADMODE="$(stat -c '%a %n' "$D"/certs/*.key "$D/turnserver.conf" | awk '$1 != "600"')"
if [ -n "$BADMODE" ]; then
  echo "key material is not mode 600 after chmod:"
  printf '%s\n' "$BADMODE"
  exit 1
fi
stat -c '%a %U %n' "$D"/certs/*.key "$D/turnserver.conf"

# The instance has no user-data: it launches with no public address, so nothing
# can install a package until its elastic address is attached. Docker therefore
# arrives here, offline from the cache volume when the fixture seeded one and
# over the network otherwise. Which path ran is printed, because the offline one
# is most of the difference between a five-minute cycle and a seven-minute one.
DOCKER_START=$(date -u +%s)
if ! sudo docker info >/dev/null 2>&1; then
  if [ -n "$CACHE_DEV" ]; then
    sudo mkdir -p /mnt/imgcache
    mountpoint -q /mnt/imgcache || sudo mount -o ro "$CACHE_DEV" /mnt/imgcache
  fi
  if [ -n "$CACHE_DEV" ] && [ -d /mnt/imgcache/deb ] && ls /mnt/imgcache/deb/*.deb >/dev/null 2>&1; then
    say "installing docker offline from the cache volume"
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-download /mnt/imgcache/deb/*.deb >/dev/null 2>&1 \
      || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y /mnt/imgcache/deb/*.deb >/dev/null
  else
    say "no seeded packages: installing docker over the network"
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io >/dev/null
  fi
  sudo systemctl enable --now docker
fi
for _ in $(seq 1 60); do
  if sudo docker info >/dev/null 2>&1; then break; fi
  sleep 2
done
sudo docker info >/dev/null 2>&1 || { echo "docker never came up"; exit 1; }
DOCKER_END=$(date -u +%s)
say "docker ready in $((DOCKER_END - DOCKER_START))s"
echo "TIMING docker-install $((DOCKER_END - DOCKER_START))"

say "loading images"
LOAD_START=$(date -u +%s)
if [ -n "$CACHE_DEV" ]; then
  sudo mkdir -p /mnt/imgcache
  mountpoint -q /mnt/imgcache || sudo mount -o ro "$CACHE_DEV" /mnt/imgcache
  for spec in "${IMAGES[@]}"; do
    t="/mnt/imgcache/${spec%%=*}"
    if [ ! -f "$t" ]; then
      say "the image cache holds no $t"
      ls -l /mnt/imgcache || true
      exit 1
    fi
    say "docker load < $t"
    sudo docker load -i "$t" >/dev/null
  done
else
  for t in "$D"/images/*.tar.gz; do
    [ -f "$t" ] || continue
    say "docker load < $t"
    gunzip -c "$t" | sudo docker load >/dev/null
  done
fi
LOAD_END=$(date -u +%s)
say "images loaded in $((LOAD_END - LOAD_START))s"
echo "TIMING image-load $((LOAD_END - LOAD_START))"
sudo docker image ls --format '{{.Repository}}:{{.Tag}} {{.Size}}'

# The load is not the delivery: a tarball that arrived under the wrong name, or
# under none, loads nothing and says so only here.
MISSING=""
for spec in "${IMAGES[@]}"; do
  tag="${spec#*=}"
  sudo docker image inspect "$tag" >/dev/null 2>&1 || MISSING="$MISSING $tag"
done
if [ -n "$MISSING" ]; then
  say "NOT LOADED, so no service on this box could start:$MISSING"
  ls -l /mnt/imgcache 2>/dev/null || true
  exit 1
fi

# The interface holding the primary address, and the one in the restricted
# subnet. Nitro names these enX0/enX1 rather than eth0/eth1, so both are found by
# address rather than assumed.
IF_MAIN=$(ip -o -4 addr show | awk -v a="$SPIKE_IP_TURN/" '$4 ~ a {print $2; exit}')
[ -n "$IF_MAIN" ] || { echo "no interface carries $SPIKE_IP_TURN"; ip -o -4 addr show; exit 1; }
# The proxy interface is identified by the MAC address AWS reports for the
# interface that was attached, not by a name: docker0 and any veth would both
# match a name-shaped guess, and Nitro's naming is not fixed.
IF_PROXY=""
if [ -n "${SPIKE_PROXY_MAC:-}" ]; then
  IF_PROXY=$(ip -o link show | awk -v m="$SPIKE_PROXY_MAC" '$0 ~ m {sub(":$","",$2); print $2; exit}')
fi
if [ -z "$IF_PROXY" ]; then
  for path in /sys/class/net/en*; do
    [ -e "$path" ] || continue
    n=$(basename "$path")
    if [ "$n" = "$IF_MAIN" ]; then continue; fi
    IF_PROXY="$n"
    break
  done
fi
say "main interface $IF_MAIN, proxy interface ${IF_PROXY:-none}"

ip -o -4 addr show dev "$IF_MAIN" | grep -q "$SPIKE_IP_WEB/" \
  || sudo ip addr add "$SPIKE_IP_WEB/24" dev "$IF_MAIN"

if [ -n "${IF_PROXY:-}" ]; then
  sudo ip link set "$IF_PROXY" up
  ip -o -4 addr show dev "$IF_PROXY" | grep -q "$SPIKE_IP_PROXY/" \
    || sudo ip addr add "$SPIKE_IP_PROXY/24" dev "$IF_PROXY"
  # A class-B packet arrives on the proxy interface addressed to a service
  # address on the main one, and its reply leaves by whichever interface the
  # route picks. Loose reverse-path filtering is what lets the kernel accept it.
  sudo sysctl -qw net.ipv4.conf.all.rp_filter=0
  sudo sysctl -qw "net.ipv4.conf.$IF_PROXY.rp_filter=0"
  sudo iptables -t nat -C PREROUTING -i "$IF_PROXY" -p tcp -d "$SPIKE_IP_TURN" --dport 443 -j REDIRECT --to-port 8010 2>/dev/null \
    || sudo iptables -t nat -A PREROUTING -i "$IF_PROXY" -p tcp -d "$SPIKE_IP_TURN" --dport 443 -j REDIRECT --to-port 8010
  sudo iptables -t nat -C PREROUTING -i "$IF_PROXY" -p tcp -d "$SPIKE_IP_WEB" --dport 443 -j REDIRECT --to-port 8020 2>/dev/null \
    || sudo iptables -t nat -A PREROUTING -i "$IF_PROXY" -p tcp -d "$SPIKE_IP_WEB" --dport 443 -j REDIRECT --to-port 8020
  say "destination NAT for the inspecting proxy installed on $IF_PROXY"
  sudo iptables -t nat -S PREROUTING
fi

say "starting coturn, the web app, nginx and the inspecting proxy"
sudo docker rm -f spike-turn spike-web spike-front spike-proxy >/dev/null 2>&1 || true
sudo docker run -d --name spike-turn --network host --restart unless-stopped \
  -v "$D/turnserver.conf:/etc/coturn/turnserver.conf:ro" -v "$D/certs:/etc/coturn/certs:ro" \
  coturn/coturn:latest -c /etc/coturn/turnserver.conf >/dev/null
sudo docker run -d --name spike-web --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -e PORT=3000 -e NITRO_HOST=0.0.0.0 \
  psi-link:spike-hosted serve >/dev/null
sudo docker run -d --name spike-front --network host --restart unless-stopped \
  -v "$D/nginx.conf:/etc/nginx/nginx.conf:ro" -v "$D/certs:/etc/nginx/certs:ro" \
  nginx:alpine >/dev/null
sudo docker run -d --name spike-proxy --network host --restart unless-stopped \
  -e "SPIKE_DIR=$D" -e "SPIKE_IP_TURN=$SPIKE_IP_TURN" -e "SPIKE_IP_WEB=$SPIKE_IP_WEB" \
  -e "SPIKE_TURN_HOST=$SPIKE_TURN_HOST" -e "SPIKE_WEB_HOST=$SPIKE_WEB_HOST" \
  -v "$D:$D:ro" --entrypoint node psi-link:spike-hosted "$D/intercept.mjs" >/dev/null

# Both addresses must answer TLS before the caller calls phase 3 done: an
# exchange started against a half-open services box measures the wrong thing.
say "waiting for TLS on both addresses"
for target in "$SPIKE_IP_TURN" "$SPIKE_IP_WEB"; do
  ok=false
  for _ in $(seq 1 60); do
    if echo | openssl s_client -connect "$target:443" -servername "$SPIKE_TURN_HOST" >/dev/null 2>&1; then
      ok=true; break
    fi
    sleep 2
  done
  $ok || { echo "TLS never answered on $target:443"; sudo docker ps -a; sudo docker logs spike-turn 2>&1 | tail -30; sudo docker logs spike-front 2>&1 | tail -30; exit 1; }
  say "TLS answering on $target:443"
done
SERVICES_END=$(date -u +%s)
echo "TIMING services-start-to-tls $((SERVICES_END - LOAD_END))"
say "services up"
