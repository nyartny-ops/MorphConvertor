#!/bin/bash
# Собирает Morph.app из исходников. Работает только на macOS (нужен osacompile).
#
#   scripts/build.sh [--out DIR] [--ffmpeg auto|universal|none]
#
#   --out      куда положить Morph.app (по умолчанию ./dist)
#   --ffmpeg   auto      — ffmpeg под архитектуру этого Mac (по умолчанию)
#              universal — arm64 + x86_64 в одном файле (для релизов)
#              none      — без ffmpeg (видео/аудио/GIF будут брать ffmpeg из Homebrew, если он есть)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"
OUT="$ROOT/dist"
FF_MODE="auto"
VERSION="${MORPH_VERSION:-$(tr -d ' \n' < "$ROOT/VERSION")}"
CACHE="${MORPH_CACHE:-$HOME/Library/Caches/Morph}"
FF_URL="https://ffmpeg.martin-riedl.de/redirect/latest/macos/%s/release/ffmpeg.zip"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --ffmpeg) FF_MODE="$2"; shift 2;;
    -h|--help) sed -n '2,10p' "$0"; exit 0;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2;;
  esac
done

step() { printf '\033[1m→ %s\033[0m\n' "$*"; }
[ "$(uname)" = Darwin ] || { echo "Сборка возможна только на macOS" >&2; exit 1; }

APP="$OUT/Morph.app"
R="$APP/Contents/Resources"
P="$APP/Contents/Info.plist"
PB=/usr/libexec/PlistBuddy
mkdir -p "$OUT" "$CACHE"

step "Компилирую интерфейс (osacompile) → $APP"
rm -rf "$APP"
osacompile -l JavaScript -s -o "$APP" "$SRC/main.js"

step "Копирую ресурсы"
cp "$SRC/convert.sh" "$SRC/pdftool.js" "$SRC/ui.html" "$SRC/radial.html" "$R/"
chmod +x "$R/convert.sh"
cp "$SRC/Morph.icns" "$R/applet.icns"
rm -f "$R/Assets.car"

step "Настраиваю Info.plist (версия $VERSION)"
plist_set() {  # ключ тип значение
  $PB -c "Set :$1 $3" "$P" >/dev/null 2>&1 || $PB -c "Add :$1 $2 $3" "$P"
}
$PB -c "Delete :CFBundleIconName" "$P" >/dev/null 2>&1 || true
plist_set CFBundleIconFile string applet
plist_set CFBundleName string Morph
plist_set CFBundleDisplayName string Morph
plist_set CFBundleIdentifier string io.github.morph.converter
plist_set CFBundleShortVersionString string "$VERSION"
plist_set CFBundleVersion string "$VERSION"
plist_set LSMinimumSystemVersion string 12.0
plist_set NSHumanReadableCopyright string "Morph — конвертер и сжатие файлов"
$PB -c "Delete :CFBundleDocumentTypes" "$P" >/dev/null 2>&1 || true
$PB -c "Add :CFBundleDocumentTypes array" "$P"
$PB -c "Add :CFBundleDocumentTypes:0 dict" "$P"
$PB -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string Файл" "$P"
$PB -c "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer" "$P"
$PB -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate" "$P"
$PB -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes array" "$P"
$PB -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string public.item" "$P"
$PB -c "Add :CFBundleDocumentTypes:0:LSItemContentTypes:1 string public.folder" "$P"

fetch_ffmpeg() {  # $1 = arm64|amd64 → печатает путь к бинарнику
  local arch="$1" dst="$CACHE/ffmpeg-$1"
  if [ -x "$dst" ] && "$dst" -version >/dev/null 2>&1; then echo "$dst"; return 0; fi
  local tmp; tmp="$(mktemp -d)"
  # shellcheck disable=SC2059
  if curl -fsSL --retry 3 -o "$tmp/ff.zip" "$(printf "$FF_URL" "$arch")" && unzip -q -o "$tmp/ff.zip" -d "$tmp/x" && [ -f "$tmp/x/ffmpeg" ]; then
    mv "$tmp/x/ffmpeg" "$dst"; chmod +x "$dst"; xattr -c "$dst" 2>/dev/null || true
    rm -rf "$tmp"; echo "$dst"; return 0
  fi
  rm -rf "$tmp"; return 1
}

mkdir -p "$R/bin"
case "$FF_MODE" in
  none) step "ffmpeg: пропускаю";;
  auto)
    step "ffmpeg для $(uname -m)"
    case "$(uname -m)" in arm64) A=arm64;; *) A=amd64;; esac
    if f="$(fetch_ffmpeg $A)"; then cp "$f" "$R/bin/ffmpeg"
    else echo "  ! не удалось скачать ffmpeg — видео/аудио/GIF будут работать только с ffmpeg из Homebrew"; fi;;
  universal)
    step "ffmpeg universal (arm64 + x86_64)"
    a="$(fetch_ffmpeg arm64)"; x="$(fetch_ffmpeg amd64)"
    lipo -create "$a" "$x" -output "$R/bin/ffmpeg"
    lipo -info "$R/bin/ffmpeg";;
  *) echo "--ffmpeg: auto|universal|none" >&2; exit 2;;
esac

step "Подписываю (ad-hoc)"
[ -f "$R/bin/ffmpeg" ] && codesign --force -s - "$R/bin/ffmpeg" >/dev/null 2>&1 || true
xattr -cr "$APP" 2>/dev/null || true
codesign --force --deep -s - "$APP"
codesign --verify --deep "$APP" && echo "  подпись в порядке"

step "Готово: $APP"
