#!/usr/bin/env bash
# Deploys the demo (pretend).
set -euo pipefail

build() {
  echo "building"
}

upload() {
  echo "uploading"
}

build
upload
git status
