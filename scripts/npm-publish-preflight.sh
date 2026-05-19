#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGES=(
  "local-otel-workbench"
)

echo "== npm identity =="
if npm whoami; then
  echo
else
  echo "Not logged in. Run 'npm login' before the real publish."
  echo
fi

echo "== package-name availability =="
for package_name in "${PACKAGES[@]}"; do
  if npm view "$package_name" name version --json >/tmp/local-otel-npm-view.json 2>/tmp/local-otel-npm-view.err; then
    echo "TAKEN: $package_name"
    cat /tmp/local-otel-npm-view.json
    exit 1
  fi
  if grep -q "E404" /tmp/local-otel-npm-view.err; then
    echo "available: $package_name"
  else
    echo "Unable to confirm $package_name:"
    cat /tmp/local-otel-npm-view.err
    exit 1
  fi
done
echo

echo "== repo release dry-run =="
pnpm release:dry-run
echo

echo "== npm publish dry-run =="
pnpm --filter local-otel-workbench publish --dry-run --access public --no-git-checks
echo

echo "Preflight complete. Real publish command:"
echo "  pnpm --filter local-otel-workbench publish --access public"
