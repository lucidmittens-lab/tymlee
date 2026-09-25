#!/bin/sh
# Turns dist/tymlee.cjs into a single executable: a copy of a Node.js binary
# with the app injected (Node's "single executable applications").
#   build/sea.sh <node binary to copy> <output file>
# The node running this script must be the same version as the binary.
set -eu
cd "$(dirname "$0")/.."
NODE_BIN="$1"
OUT="$2"
cat > dist/sea-config.json <<JSON
{ "main": "dist/tymlee.cjs", "output": "dist/sea-prep.blob", "disableExperimentalSEAWarning": true, "useCodeCache": false, "useSnapshot": false }
JSON
node --experimental-sea-config dist/sea-config.json
cp "$NODE_BIN" "$OUT"
chmod u+w "$OUT"
if [ "$(uname)" = "Darwin" ]; then
  codesign --remove-signature "$OUT"
  npx --no-install postject "$OUT" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA
else
  npx --no-install postject "$OUT" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
fi
echo "built $OUT"
