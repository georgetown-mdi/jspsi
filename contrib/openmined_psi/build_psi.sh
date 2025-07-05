#!/bin/bash

docker build --output type=local,dest=$(pwd) .

# to be able to access the build environment:
#   docker build --target=psi-build -t psi:latest .
#   docker run -it --rm psi:latest

# to clean build cache:
#   docker buildx prune --all
