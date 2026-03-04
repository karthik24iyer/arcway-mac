#!/bin/bash
set -e

RESOURCES_DIR="ClaudeRemote/Resources"
NODE_VERSION="20.18.2"   # LTS
SERVICE_SRC="../arcway-backend"

mkdir -p "$RESOURCES_DIR/service"

# Download Node.js universal binary if not present
if [ ! -f "$RESOURCES_DIR/node" ]; then
    echo "Downloading Node.js $NODE_VERSION..."
    TMPDIR=$(mktemp -d)

    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz" -o "$TMPDIR/node-arm64.tar.gz"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-x64.tar.gz"  -o "$TMPDIR/node-x64.tar.gz"

    tar -xf "$TMPDIR/node-arm64.tar.gz" -C "$TMPDIR"
    tar -xf "$TMPDIR/node-x64.tar.gz"  -C "$TMPDIR"

    lipo -create \
        "$TMPDIR/node-v$NODE_VERSION-darwin-arm64/bin/node" \
        "$TMPDIR/node-v$NODE_VERSION-darwin-x64/bin/node"  \
        -output "$RESOURCES_DIR/node"

    chmod +x "$RESOURCES_DIR/node"
    rm -rf "$TMPDIR"
    echo "Node.js bundled at $RESOURCES_DIR/node"
else
    echo "Node.js already bundled, skipping download."
fi

# Copy service files
echo "Copying claude-remote-service..."
rm -rf "$RESOURCES_DIR/service"
mkdir -p "$RESOURCES_DIR/service"
cp -r "$SERVICE_SRC/src"    "$RESOURCES_DIR/service/"
cp -r "$SERVICE_SRC/config" "$RESOURCES_DIR/service/"
cp    "$SERVICE_SRC/package.json" "$RESOURCES_DIR/service/"
[ -f "$SERVICE_SRC/package-lock.json" ] && cp "$SERVICE_SRC/package-lock.json" "$RESOURCES_DIR/service/" || true

# Install production dependencies using the bundled node (ensures ABI compatibility for native addons like node-pty)
BUNDLED_NODE="$(pwd)/$RESOURCES_DIR/node"
TMPBIN=$(mktemp -d)
ln -s "$BUNDLED_NODE" "$TMPBIN/node"
cd "$RESOURCES_DIR/service"
rm -rf node_modules
PATH="$TMPBIN:$PATH" npm install --omit=dev --no-fund --no-audit
# npm doesn't preserve execute bits on prebuilt native binaries
find . -path "*/prebuilds/*" \( -name "*.node" -o -name "spawn-helper" \) -exec chmod +x {} \;
cd -
rm -rf "$TMPBIN"

echo "Bundle complete. DMG size will be ~$(du -sh $RESOURCES_DIR | cut -f1)."
