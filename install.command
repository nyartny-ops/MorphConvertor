#!/bin/bash
# Установка Morph из исходников: двойной клик в Finder или `bash install.command` в Терминале.
# Ничего не нужно компилировать руками — всё делают встроенные в macOS утилиты.
cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

DEST="/Applications"; [ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
BUILD="$(mktemp -d)"

osascript -e 'tell application id "io.github.morph.converter" to quit' >/dev/null 2>&1
osascript -e 'tell application "Morph" to quit' >/dev/null 2>&1

say "Собираю Morph"
bash "$ROOT/scripts/build.sh" --out "$BUILD" --ffmpeg "${MORPH_FFMPEG:-auto}" || { echo "Сборка не удалась"; exit 1; }

say "Устанавливаю в $DEST"
rm -rf "$DEST/Morph.app"
ditto "$BUILD/Morph.app" "$DEST/Morph.app"
rm -rf "$BUILD"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST/Morph.app" >/dev/null 2>&1

if ! command -v gifsicle >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
  read -r -t 20 -p "Поставить gifsicle через Homebrew для ещё более сильного сжатия GIF? [y/N] " yn
  case "$yn" in y|Y) brew install gifsicle;; esac
fi
if [ ! -d /Applications/LibreOffice.app ] && [ ! -d "$HOME/Applications/LibreOffice.app" ]; then
  echo "Для XLSX/PPTX и лучших PDF из Word можно поставить бесплатный LibreOffice: https://www.libreoffice.org"
fi

open "$DEST/Morph.app"
say "Готово. Morph в $DEST — файлы можно перетаскивать прямо на иконку в Dock."
