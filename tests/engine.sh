#!/bin/bash
# Тесты движка convert.sh на сгенерированных файлах.
# Работает на macOS и Linux (нужен ffmpeg; части на sips/textutil проверяются только на macOS).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E="${MORPH_ENGINE:-$ROOT/src/convert.sh}"   # можно проверить движок внутри собранного .app
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
pass=0; fail=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  {
  printf '  \033[31m✗\033[0m %s\n      %s\n' "$1" "$2"; fail=$((fail+1))
  # в GitHub Actions — ещё и аннотация, её видно на странице запуска
  [ -n "${GITHUB_ACTIONS:-}" ] && printf '::error title=%s::%s\n' "$1" "$(printf '%s' "$2" | tr '\n' ' ' | cut -c1-400)"
  return 0
}
run()  { bash "$E" "$@" 2>/dev/null | tail -n 1; }
# expect <название> <OK|SAME|ERR> <аргументы движка...>
expect() {
  local name="$1" want="$2"; shift 2
  local out; out="$(run "$@")"
  if [ "${out%%	*}" = "$want" ]; then
    if [ "$want" = OK ]; then
      local f; f="$(printf '%s' "$out" | cut -f2)"
      [ -e "$f" ] && ok "$name" || bad "$name" "файл не найден: $f"
    else ok "$name"; fi
  else bad "$name" "$out"; fi
  LAST="$out"
}
dims() { ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$1"; }
has_audio() { [ -n "$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$1")" ]; }

command -v ffmpeg >/dev/null || { echo "нужен ffmpeg"; exit 1; }
echo "Готовлю тестовые файлы в $W"
ffmpeg -loglevel error -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -t 3 -c:v libx264 -crf 8 -c:a aac -b:a 320k "$W/clip.mov"
ffmpeg -loglevel error -f lavfi -i testsrc2=size=480x270:rate=15 -t 2 "$W/anim.gif"
ffmpeg -loglevel error -f lavfi -i sine=frequency=440 -t 4 "$W/tone.wav"
ffmpeg -loglevel error -f lavfi -i testsrc2=size=1600x1200 -frames:v 1 "$W/pic.png"
echo "hello morph" > "$W/notes.txt"
mkdir -p "$W/folder/inner" && cp "$W/notes.txt" "$W/folder/inner/"

echo "Видео"
expect "MOV → сжать"            OK "$W/clip.mov" same 60 0 0 "$W/o"
expect "MOV → WEBM"             OK "$W/clip.mov" webm 50 0 0 "$W/o"
expect "MOV → H.265"            OK "$W/clip.mov" mp4hevc 60 0 0 "$W/o"
expect "MOV → MP4 480p без звука" OK "$W/clip.mov" mp4 60 480 1 "$W/o/small"
f="$(printf '%s' "$LAST" | cut -f2)"
[ "$(dims "$f")" = "480,270" ] && ok "  размер 480×270" || bad "  размер" "$(dims "$f")"
has_audio "$f" && bad "  звук убран" "дорожка осталась" || ok "  звук убран"
expect "MOV → GIF"              OK "$W/clip.mov" gif 50 0 0 "$W/o"
expect "MOV → MP3"              OK "$W/clip.mov" mp3 60 0 0 "$W/o"

echo "GIF"
expect "GIF → сжать 240px"      OK "$W/anim.gif" same 30 240 0 "$W/o"
f="$(printf '%s' "$LAST" | cut -f2)"
[ "$(dims "$f" | cut -d, -f1)" = "240" ] && ok "  ширина 240" || bad "  ширина" "$(dims "$f")"
expect "GIF → MP4"              OK "$W/anim.gif" mp4 60 0 0 "$W/o"
expect "GIF → WEBP"             OK "$W/anim.gif" webp 60 0 0 "$W/o"

echo "Аудио"
for t in mp3 m4a flac ogg opus wav aiff; do expect "WAV → ${t}" OK "$W/tone.wav" "$t" 60 0 0 "$W/o"; done
expect "WAV → сжать (M4A)"      OK "$W/tone.wav" same 60 0 0 "$W/o"

echo "Картинки"
expect "PNG → сжать"            OK "$W/pic.png" same 60 0 0 "$W/o"
expect "PNG → WEBP 800px"       OK "$W/pic.png" webp 60 800 0 "$W/o"
f="$(printf '%s' "$LAST" | cut -f2)"
[ "$(dims "$f")" = "800,600" ] && ok "  размер 800×600" || bad "  размер" "$(dims "$f")"

echo "Обрезка и кадрирование"
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" | cut -d. -f1; }
f="$(MORPH_TRIM=0.5:2.5 bash "$E" "$W/clip.mov" mp4 60 0 0 "$W/edit" 2>/dev/null | tail -n1 | cut -f2)"
[ "$(dur "$f")" = "2" ] && ok "видео: обрезка 0.5–2.5 с → 2 с" || bad "видео: обрезка" "$(dur "$f") ($f)"
f="$(MORPH_CROP=404:720:438:0 bash "$E" "$W/clip.mov" mp4 60 0 0 "$W/edit" 2>/dev/null | tail -n1 | cut -f2)"
[ "$(dims "$f")" = "404,720" ] && ok "видео: кадр 9:16 → 404×720" || bad "видео: кадрирование" "$(dims "$f")"
f="$(MORPH_TRIM=1:3 bash "$E" "$W/tone.wav" mp3 60 0 0 "$W/edit" 2>/dev/null | tail -n1 | cut -f2)"
[ "$(dur "$f")" = "2" ] && ok "аудио: обрезка → 2 с" || bad "аудио: обрезка" "$(dur "$f")"
f="$(MORPH_TRIM=0.5:1.5 MORPH_CROP=200:200:10:10 bash "$E" "$W/anim.gif" same 60 0 0 "$W/edit" 2>/dev/null | tail -n1 | cut -f2)"
[ "$(dims "$f")" = "200,200" ] && ok "GIF: обрезка + кадр 200×200" || bad "GIF: правка" "$(dims "$f") ($f)"
f="$(MORPH_CROP=600:600:100:50 bash "$E" "$W/pic.png" webp 70 0 0 "$W/edit" 2>/dev/null | tail -n1 | cut -f2)"
[ "$(dims "$f")" = "600,600" ] && ok "картинка: кадр 600×600 → WEBP" || bad "картинка: кадрирование" "$(dims "$f")"
out="$(MORPH_TRIM=3:1 bash "$E" "$W/clip.mov" mp4 60 0 0 "$W/edit" 2>/dev/null | tail -n1)"
[ "${out%%	*}" = ERR ] && ok "обрезка с концом раньше начала → ошибка" || bad "проверка обрезки" "$out"
out="$(MORPH_CROP='1;rm' bash "$E" "$W/clip.mov" mp4 60 0 0 "$W/edit" 2>/dev/null | tail -n1)"
[ "${out%%	*}" = ERR ] && ok "мусор в рамке кадра → ошибка" || bad "проверка кадра" "$out"

echo "Прочее"
expect "TXT → ZIP"              OK "$W/notes.txt" zip 60 0 0 "$W/o"
expect "Папка → ZIP"            OK "$W/folder" zip 60 0 0 "$W/o"
expect "TXT → сжать (не меньше)" SAME "$W/notes.txt" same 60 0 0 "$W/o"
expect "PNG → MP3 (запрещено)"  ERR "$W/pic.png" mp3 60 0 0 "$W/o"
expect "нет файла"              ERR "$W/nope.mov" mp4 60 0 0 "$W/o"
expect "кривая папка вывода"    ERR "$W/clip.mov" mp4 60 0 0 "/proc/morph-nope"
expect "имя не перезаписывается" OK "$W/clip.mov" webm 50 0 0 "$W/o"
case "$LAST" in *"(morph)"*) ok "  получил суффикс (morph)";; *) bad "  суффикс" "$LAST";; esac

if [ "$(uname)" = Darwin ]; then
  echo "macOS: картинки, документы, PDF"
  expect "PNG → JPG"              OK "$W/pic.png" jpg 70 0 0 "$W/o"
  JPG="$(printf '%s' "$LAST" | cut -f2)"
  expect "PNG → HEIC"             OK "$W/pic.png" heic 60 0 0 "$W/o"
  expect "PNG → TIFF 640px"       OK "$W/pic.png" tiff 60 640 0 "$W/o"
  expect "JPG → сжать"            OK "$JPG" same 30 0 0 "$W/o"
  expect "PNG → PDF"              OK "$W/pic.png" pdf 60 0 0 "$W/o"
  PDF="$(printf '%s' "$LAST" | cut -f2)"
  expect "PDF → PNG по страницам" OK "$PDF" png 60 0 0 "$W/o"
  expect "PDF-скан → TXT (нет текста)" ERR "$PDF" txt 60 0 0 "$W/o"
  expect "TXT → DOCX"             OK "$W/notes.txt" docx 60 0 0 "$W/o"
  DOCX="$(printf '%s' "$LAST" | cut -f2)"
  expect "DOCX → RTF"             OK "$DOCX" rtf 60 0 0 "$W/o"
  expect "DOCX → PDF"             OK "$DOCX" pdf 60 0 0 "$W/o"
fi

echo "Остановка"
ffmpeg -loglevel error -f lavfi -i testsrc2=size=1920x1080:rate=30 -t 20 -c:v libx264 -preset ultrafast "$W/long.mp4"
mkdir -p "$W/stop"
bash "$E" "$W/long.mp4" webm 90 0 0 "$W/stop" >/dev/null 2>&1 & P=$!
sleep 2; kill -TERM $P; pkill -TERM -P $P; wait $P 2>/dev/null
[ -z "$(ls -A "$W/stop")" ] && ok "недоделанный файл удалён" || bad "остановка" "$(ls "$W/stop")"

echo
echo "Итого: $pass ок, $fail ошибок"
[ "$fail" -eq 0 ]
