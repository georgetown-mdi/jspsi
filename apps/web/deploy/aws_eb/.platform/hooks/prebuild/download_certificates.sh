#!/bin/bash
set -euo pipefail
# Installs the TLS certificate that .platform/nginx/conf.d/https.conf serves
# from /etc/pki/tls/certs.
#
# It runs at the PREBUILD stage because Elastic Beanstalk starts the proxy with
# the new configuration before the postdeploy stage runs: nginx validates
# ssl_certificate against /etc/pki/tls/certs/server.crt at that point, so a
# certificate installed any later is too late. On an instance that has no
# certificate on disk yet -- a fresh one, as after a platform-version upgrade
# replaces the environment's instances -- nginx refuses the configuration with
# `cannot load certificate "/etc/pki/tls/certs/server.crt"` and every
# deployment fails at "start proxy with new configuration" (measured
# 2026-09-03).
#
# An application deployment and a configuration-only deployment run separate
# hook trees, so this script is deployed twice, byte-identical, as
# .platform/hooks/prebuild/download_certificates.sh and
# .platform/confighooks/prebuild/download_certificates.sh. Edit both copies
# together.

echo "Downloading SSL certificates"

TOKEN=$(
    curl -s \
        -X PUT "http://169.254.169.254/latest/api/token" \
        -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"
)
AWS_REGION=$(
    curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
        http://169.254.169.254/latest/meta-data/placement/region
)
AWS_ACCOUNT_ID=$(
    curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
        http://169.254.169.254/latest/dynamic/instance-identity/document \
    | sed -n -E -e 's/^.*accountId[^0-9]*([0-9]+)[^0-9]*$/\1/p'
)

BUCKET_NAME="elasticbeanstalk-${AWS_REGION}-${AWS_ACCOUNT_ID}"

mkdir -p /etc/pki/tls/certs

sudo aws s3 cp s3://${BUCKET_NAME}/cert/privatekey.pem /etc/pki/tls/certs/server.key
sudo chmod 400 /etc/pki/tls/certs/server.key

sudo aws s3 cp s3://${BUCKET_NAME}/cert/public.crt /etc/pki/tls/certs/server.crt
sudo chmod 400 /etc/pki/tls/certs/server.crt
