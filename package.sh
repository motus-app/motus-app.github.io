#!/bin/bash
# Packages the freeware downloads into web/downloads and rewrites downloads/config.js.
#   bash web/package.sh
#   (zips are committed in web/downloads and served by GitHub Pages; BASE_URL can point elsewhere)
# macOS: universal Motus.app from target/release (x86_64) and target/aarch64-apple-darwin/release
# (lipo; falls back to whichever exists). Windows: target/x86_64-pc-windows-gnu/release
# (MinGW cross build) or WIN_DIR. Linux: LINUX_DIR (e.g. built on the Vast box).
# Missing platforms show "Coming soon".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"; OUT="$WEB/downloads"; REL="$ROOT/target/release"; ARM="$ROOT/target/aarch64-apple-darwin/release"
WIN_DIR="${WIN_DIR:-$ROOT/target/x86_64-pc-windows-gnu/release}"
VER=$(grep -m1 '^version' "$ROOT/app/Cargo.toml" | cut -d'"' -f2)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"

common() { # $1 = destination folder
  mkdir -p "$1/examples"
  cp "$ROOT/README.md" "$ROOT/LICENSE-MIT" "$ROOT/LICENSE-APACHE" "$1/"
  cp "$ROOT/examples/"*.motus "$1/examples/" 2>/dev/null || true
  cp "$ROOT/cases/bangkok/"*.motus "$1/examples/" 2>/dev/null || true
}
human() { awk -v b="$1" 'BEGIN{ printf (b > 1048576 ? "%.1f MB" : "%.0f kB"), (b > 1048576 ? b/1048576 : b/1024) }'; }
entries=()
add() { # os file meta
  local f="$OUT/$2" sha size
  sha=$(shasum -a 256 "$f" | cut -d' ' -f1); size=$(human "$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")")
  entries+=("    $1: { url: \"${BASE_URL:-downloads}/$2\", size: \"$size\", meta: \"$3\", sha256: \"$sha\" }")
}

# ---- macOS: Motus.app (window + motus-cli) in a zip
mac_bin() { # name -> universal (or single-arch) binary at $TMP/mac/name
  mkdir -p "$TMP/mac"; local a=() ; for d in "$REL" "$ARM"; do [ -x "$d/$1" ] && a+=("$d/$1"); done
  [ ${#a[@]} -eq 0 ] && return 1
  if [ ${#a[@]} -gt 1 ]; then lipo -create "${a[@]}" -output "$TMP/mac/$1"; else cp "${a[0]}" "$TMP/mac/$1"; fi
}
if mac_bin motus; then
  APP="$TMP/Motus-$VER-macos/Motus.app"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$TMP/mac/motus" "$APP/Contents/MacOS/motus"
  mac_bin motus-cli && cp "$TMP/mac/motus-cli" "$APP/Contents/MacOS/motus-cli"
  IS="$TMP/motus.iconset"; mkdir -p "$IS"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ROOT/app/assets/icon.png" --out "$IS/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$ROOT/app/assets/icon.png" --out "$IS/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$IS" -o "$APP/Contents/Resources/motus.icns"
  cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Motus</string>
  <key>CFBundleDisplayName</key><string>Motus</string>
  <key>CFBundleIdentifier</key><string>th.ac.kmutt.motus</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundleExecutable</key><string>motus</string>
  <key>CFBundleIconFile</key><string>motus</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF
  xattr -cr "$APP"; codesign --force --deep -s - "$APP" 2>/dev/null || true
  common "$TMP/Motus-$VER-macos"
  ARCH=$(lipo -archs "$TMP/mac/motus")
  case "$ARCH" in *x86_64*arm64*|*arm64*x86_64*) TAG=universal; META="Universal (Apple silicon + Intel)";;
    arm64) TAG=arm64; META="Apple silicon";; *) TAG=x86_64; META="Intel (x86_64)";; esac
  NAME="Motus-$VER-macos-$TAG.zip"
  rm -f "$OUT"/Motus-*-macos-*.zip
  (cd "$TMP" && ditto -c -k --norsrc --keepParent "Motus-$VER-macos" "$OUT/$NAME")
  add mac "$NAME" "$META · macOS 11+"
fi

# ---- Windows
if [ -f "$WIN_DIR/motus.exe" ]; then
  D="$TMP/Motus-$VER-windows"; mkdir -p "$D"; cp "$WIN_DIR/motus.exe" "$D/"; [ -f "$WIN_DIR/motus-cli.exe" ] && cp "$WIN_DIR/motus-cli.exe" "$D/"; common "$D"
  rm -f "$OUT/Motus-$VER-windows-x86_64.zip"
  (cd "$TMP" && zip -qr "$OUT/Motus-$VER-windows-x86_64.zip" "Motus-$VER-windows")
  add win "Motus-$VER-windows-x86_64.zip" "x86_64 · Windows 10+"
fi

# ---- Linux
if [ -n "${LINUX_DIR:-}" ] && [ -x "$LINUX_DIR/motus" ]; then
  D="$TMP/Motus-$VER-linux"; mkdir -p "$D"; cp "$LINUX_DIR"/motus "$LINUX_DIR"/motus-cli "$D/" 2>/dev/null || true; common "$D"
  (cd "$TMP" && tar czf "$OUT/Motus-$VER-linux-x86_64.tar.gz" "Motus-$VER-linux")
  add linux "Motus-$VER-linux-x86_64.tar.gz" "x86_64 · glibc 2.31+"
fi

(cd "$OUT" && shasum -a 256 Motus-* > SHA256SUMS.txt 2>/dev/null || true)
{
  echo "// Written by web/package.sh. Missing platforms show \"Coming soon\"."
  echo "window.MOTUS_DOWNLOADS = {"
  echo "  version: \"$VER\","
  echo "  files: {"
  ( IFS=$'\n'; echo "${entries[*]-}" | sed '$!s/$/,/' )
  echo "  },"
  echo "};"
} > "$OUT/config.js"
cat "$OUT/config.js"
