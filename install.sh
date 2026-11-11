#!/bin/bash
# Установка Morph одной командой:
#   curl -fsSL https://raw.githubusercontent.com/nyartny-ops/MorphConvertor/main/install.sh | bash
#
# Скачивает исходники, собирает Morph.app встроенной в macOS утилитой osacompile
# (Xcode не нужен), докачивает ffmpeg и кладёт приложение в «Программы».
# Всё тело — в функции, чтобы bash прочитал скрипт целиком до запуска.

main() {
  set -e
  local repo="nyartny-ops/MorphConvertor" ref="${MORPH_REF:-main}"
  [ "$(uname)" = Darwin ] || { echo "Morph работает только на macOS"; exit 1; }
  command -v osacompile >/dev/null || { echo "Не найден osacompile — нужна macOS 12+"; exit 1; }

  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  printf '\033[1m→ Скачиваю Morph (%s)\033[0m\n' "$ref"
  curl -fsSL "https://github.com/$repo/archive/$ref.tar.gz" | tar -xz -C "$tmp"
  local src; src="$(find "$tmp" -maxdepth 1 -type d -name 'MorphConvertor-*' | head -n 1)"
  [ -n "$src" ] || { echo "Не удалось распаковать архив"; exit 1; }

  # stdin занят самим скриптом (curl | bash) — вопросы установщика читаем с терминала
  if [ -r /dev/tty ]; then bash "$src/install.command" < /dev/tty
  else bash "$src/install.command" < /dev/null; fi
}

main "$@"
