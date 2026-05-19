#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
mkdir -p dist-packages
pnpm --filter local-otel-workbench pack --pack-destination "$ROOT/dist-packages"
