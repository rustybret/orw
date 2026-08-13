#!/usr/bin/env bash
set -euo pipefail

# pack-arcus.sh — Package @cortexkit/orw for Arcus
# distribution (rustybret/arcus).
#
# Produces:
#   1. dist-arcus/<npm-pack-tarball>.tgz  — the plugin archive (npm-pack
#      shaped: everything nested under a `package/` prefix)
#   2. dist-arcus/arcus-manifest.json     — a conforming manifest per
#      manifests/schema.json in rustybret/arcus, with asset.url/sha256 left
#      as placeholders. The cloudhome BuildKit arcus-release-upload job
#      stamps both from the real uploaded artifact — never precompute a
#      hash of a not-yet-uploaded file.
#
# Usage:
#   ./scripts/pack-arcus.sh [outdir]   (default: dist-arcus)

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)

# Resolve OUTDIR to an absolute path without requiring it to exist yet.
if [ -n "${1:-}" ]; then
  case "$1" in
    /*) OUTDIR="$1" ;;
    *)  OUTDIR="$(cd -- "$REPO_ROOT" && pwd -P)/$1" ;;
  esac
else
  OUTDIR="$REPO_ROOT/dist-arcus"
fi

mkdir -p "$OUTDIR"

echo "=== Arcus Package Build: orw ==="

echo "-> Installing dependencies..."
cd "$REPO_ROOT"
bun install

echo "-> Running checks..."
bun run typecheck

echo "-> Packaging @cortexkit/orw..."
TARBALL=$(npm pack --pack-destination="$OUTDIR" 2>/dev/null | tail -n 1)

TARBALL_PATH="$OUTDIR/$TARBALL"
VERSION=$(node -e "console.log(require('./package.json').version)")
MANIFEST_FILE="$OUTDIR/arcus-manifest.json"

cat <<EOF > "$MANIFEST_FILE"
{
  "\$schema": "https://raw.githubusercontent.com/rustybret/arcus/main/manifests/schema.json",
  "name": "opencode-release-watch",
  "version": "$VERSION",
  "description": "OpenCode Release Watch (orw) automation tool",
  "harness": "opencode",
  "plugin": {
    "type": "opencode-plugin",
    "name": "@cortexkit/orw",
    "version": "$VERSION",
    "asset": {
      "filename": "$TARBALL",
      "url": "PENDING_UPLOAD_URL",
      "sha256": "PENDING_BUILD_HASH",
      "strip_components": 1
    },
    "entrypoints": {}
  }
}
EOF

echo ""
echo "  Archive:  $TARBALL_PATH"
echo "  Manifest: $MANIFEST_FILE"
echo ""
echo "  BuildKit env for k8s/base/ops/buildkit/jobs/arcus-release-upload.yaml:"
echo "    ARCUS_ASSET_PATH=dist-arcus/$TARBALL"
echo "    ARCUS_MANIFEST_PATH=manifests/orw/v$VERSION.json"
echo "    ARCUS_MANIFEST_SRC=dist-arcus/arcus-manifest.json"
echo ""
