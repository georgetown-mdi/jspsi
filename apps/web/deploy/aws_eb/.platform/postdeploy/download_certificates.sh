#!/bin/bash

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
