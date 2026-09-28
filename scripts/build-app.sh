#!/bin/sh
# Builds dist/Jarvis.app: a menu bar app with its own microphone permission that starts and
# looks after the brain. It carries its own copy of the brain and the Swift helpers; Node,
# whisper-server and claude stay where Homebrew and the Claude installer put them.
#
#   scripts/build-app.sh            build dist/Jarvis.app
#   scripts/build-app.sh --install  and copy it to /Applications
set -eu
cd "$(dirname "$0")/.."
# Assembled and signed outside the repo: ~/Documents may be synced by iCloud, which keeps adding
# Finder metadata that codesign rejects. The signed app is then copied to dist/.
STAGE=$(mktemp -d)
APP="$STAGE/Jarvis.app"
RES="$APP/Contents/Resources"
trap 'rm -rf "$STAGE"' EXIT
DATA="$HOME/Library/Application Support/Jarvis"

need() { command -v "$1" 2>/dev/null || { echo "Missing $1: $2" >&2; exit 1; }; }
NODE=$(need node "brew install node")
WHISPER=$(need whisper-server "brew install whisper-cpp")
CLAUDE=$(need claude "install Claude Code and run claude once")

echo "Building the Swift helpers and UI…"
(cd brain && npm run --silent build:native)

mkdir -p "$APP/Contents/MacOS" "$RES/jarvis/brain" "$RES/jarvis/native/bin"
cp native/bin/JarvisUI "$APP/Contents/MacOS/Jarvis"
cp native/bin/mic-capture native/bin/speak "$RES/jarvis/native/bin/"

echo "Copying the brain…"
cp -R brain/src brain/voice-rules.md brain/package.json brain/package-lock.json "$RES/jarvis/brain/"
(cd "$RES/jarvis/brain" && npm ci --omit=dev --no-audit --no-fund --silent)
# ONNX Runtime ships binaries for every platform; keep this Mac's.
find "$RES/jarvis/brain/node_modules/onnxruntime-node/bin/napi-v6" -mindepth 1 -maxdepth 1 ! -name darwin -exec rm -rf {} +
find "$RES/jarvis/brain/node_modules/onnxruntime-node/bin/napi-v6/darwin" -mindepth 1 -maxdepth 1 ! -name "$(uname -m)" -exec rm -rf {} +

# Where Node lives, and a PATH that finds whisper-server and claude: apps opened from
# Finder start with a bare PATH.
PATHS=$(printf '%s\n' "$(dirname "$NODE")" "$(dirname "$WHISPER")" "$(dirname "$CLAUDE")" /usr/bin /bin /usr/sbin /sbin | awk '!seen[$0]++' | paste -sd: -)
printf '{ "node": "%s", "path": "%s" }\n' "$NODE" "$PATHS" > "$RES/jarvis/app.json"

VERSION=$(git describe --tags --always 2>/dev/null || echo dev)
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ai.jarvis.app</string>
  <key>CFBundleName</key><string>Jarvis</string>
  <key>CFBundleDisplayName</key><string>Jarvis</string>
  <key>CFBundleExecutable</key><string>Jarvis</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Jarvis listens for "Hey Jarvis" on this Mac, then hears your request. Nothing is recorded or sent anywhere before the wake word.</string>
</dict>
</plist>
PLIST

echo "Drawing the icon…"
ICONSET="$STAGE/AppIcon.iconset"
mkdir -p "$ICONSET"
xcrun swift scripts/make-icon.swift "$ICONSET/icon_512x512@2x.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  [ $s = 512 ] || sips -z $d $d "$ICONSET/icon_512x512@2x.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"

# Models live with Jarvis's data; start from the ones already downloaded for the terminal
# version (APFS clones, so no extra space). Missing ones download on first start.
mkdir -p "$DATA/models"
if [ -d models ]; then cp -Rcn models/ "$DATA/models/" 2>/dev/null || true; fi

# Ad hoc signature: enough for this Mac. macOS asks for the microphone again after a rebuild.
xattr -cr "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

rm -rf dist/Jarvis.app
mkdir -p dist
ditto "$APP" dist/Jarvis.app
if [ "${1:-}" = "--install" ]; then
  rm -rf /Applications/Jarvis.app
  ditto "$APP" /Applications/Jarvis.app
  echo "Installed /Applications/Jarvis.app ($(du -sh "$APP" | cut -f1))"
else
  echo "Built dist/Jarvis.app ($(du -sh "$APP" | cut -f1)). Install it with scripts/build-app.sh --install."
fi
