#!/bin/sh
# Builds dist/tymlee.pkg, the macOS installer for the terminal app (run on a
# Mac; .github/workflows/release-cli.yml does it for each release).
#
# 1. node build.js bundles the app into dist/tymlee.cjs.
# 2. For Apple silicon and Intel Macs, a copy of the official Node.js binary
#    (the same version as the node running this) gets the app injected
#    (build/sea.sh); lipo joins them into one universal binary, signed
#    ad hoc (not with an Apple Developer ID).
# 3. pkgbuild wraps it in an installer that puts it at /usr/local/bin/tymlee.
set -eu
cd "$(dirname "$0")/.."
VERSION="$(node -p 'require("../public/core.js").VERSION')"
NODE_VERSION="$(node --version)"
WORK="dist/pkg-work"
rm -rf "$WORK" && mkdir -p "$WORK/root/usr/local/bin"

node build.js
for ARCH in arm64 x64; do
  NAME="node-$NODE_VERSION-darwin-$ARCH"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$NAME.tar.gz" | tar -xz -C "$WORK"
  build/sea.sh "$WORK/$NAME/bin/node" "$WORK/tymlee-$ARCH"
done
lipo -create "$WORK/tymlee-arm64" "$WORK/tymlee-x64" -output "$WORK/root/usr/local/bin/tymlee"
chmod 755 "$WORK/root/usr/local/bin/tymlee"
codesign --sign - --force "$WORK/root/usr/local/bin/tymlee"
"$WORK/root/usr/local/bin/tymlee" --version | grep -qx "$VERSION"

pkgbuild --root "$WORK/root" --identifier date.tymlee.cli --version "$VERSION" \
  --install-location / "$WORK/tymlee-component.pkg"
productbuild --package "$WORK/tymlee-component.pkg" dist/tymlee.pkg
echo "built dist/tymlee.pkg (tymlee $VERSION, node $NODE_VERSION, universal)"
