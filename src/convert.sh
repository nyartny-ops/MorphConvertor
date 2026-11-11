#!/bin/bash
# Morph — движок конвертации одного файла.
# usage: convert.sh <input> <target|same> <quality 10-100> <maxside 0=orig> <mute 0|1> <outdir|"">
# правки (необязательно, через окружение):
#   MORPH_TRIM="начало:конец"  — секунды, для видео/аудио/GIF (конец можно не указывать)
#   MORPH_CROP="w:h:x:y"       — кадрирование в пикселях исходника, для видео/GIF/картинок
# stdout (одна строка):  OK<TAB>out<TAB>insize<TAB>outsize   |   SAME<TAB>msg   |   ERR<TAB>msg
# Совместим с bash 3.2 (стандартный в macOS).

IN="$1"; TARGET="$2"; Q="${3:-70}"; MAX="${4:-0}"; MUTE="${5:-0}"; OUTDIR="${6:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HERE/bin:/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:${PATH:-}:/usr/bin:/bin:/usr/sbin:/sbin"

# --probe <файл>: печатает "длительность_сек ширина высота" (размер — как на экране, с учётом поворота)
if [ "$1" = "--probe" ]; then
  FF="$(command -v ffmpeg)"; [ -n "$FF" ] || { echo "0 0 0"; exit 0; }
  info="$("$FF" -hide_banner -i "$2" 2>&1)"
  d="$(printf '%s' "$info" | sed -n 's/.*Duration: \([0-9]*\):\([0-9]*\):\([0-9.]*\).*/\1 \2 \3/p' | head -n 1 | awk '{printf "%.3f", $1*3600+$2*60+$3}')"
  wh="$(printf '%s' "$info" | grep -m1 'Video:' | grep -oE '[0-9]{2,5}x[0-9]{2,5}' | head -n 1)"
  w="${wh%x*}"; h="${wh#*x}"
  if printf '%s' "$info" | grep -Eq 'rotation of -?(90|270)'; then t="$w"; w="$h"; h="$t"; fi
  if [ -z "$wh" ] && command -v sips >/dev/null 2>&1; then   # HEIC/RAW, которые ffmpeg не читает
    w="$(sips -g pixelWidth "$2" 2>/dev/null | awk '/pixelWidth/{print $2}')"
    h="$(sips -g pixelHeight "$2" 2>/dev/null | awk '/pixelHeight/{print $2}')"
  fi
  echo "${d:-0} ${w:-0} ${h:-0}"; exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/morph.XXXXXX")" || { printf "ERR\tнет временной папки\n"; exit 1; }
trap 'rm -rf "$TMP"' EXIT
exec 2>"$TMP/err.log"
on_stop() {  # кнопка «Остановить»: убиваем детей и удаляем недоделанный файл
  trap - TERM INT
  pkill -TERM -P $$ 2>/dev/null
  [ -s "$TMP/curout" ] && rm -rf "$(cat "$TMP/curout")"
  printf 'ERR\tостановлено\n'; exit 143
}
trap on_stop TERM INT

die() {
  local tail=""
  [ -s "$TMP/err.log" ] && tail=" | $(tail -n 3 "$TMP/err.log" | tr '\n\t' '  ' | cut -c1-300)"
  printf 'ERR\t%s%s\n' "$*" "$tail"; exit 1
}
has() { command -v "$1" >/dev/null 2>&1; }

FFMPEG="$(command -v ffmpeg)"
GIFSICLE="$(command -v gifsicle)"
SOFFICE=""
for p in "/Applications/LibreOffice.app/Contents/MacOS/soffice" "$HOME/Applications/LibreOffice.app/Contents/MacOS/soffice"; do
  [ -x "$p" ] && SOFFICE="$p" && break
done
need_ff() { [ -n "$FFMPEG" ] || die "нужен ffmpeg — запусти установщик ещё раз (он скачает ffmpeg)"; }
need_lo() { [ -n "$SOFFICE" ] || die "для этого формата нужен бесплатный LibreOffice (libreoffice.org) — установи его в Программы"; }
ff() {
  if [ -n "${MORPH_PROGRESS:-}" ]; then "$FFMPEG" -hide_banner -nostdin -y -loglevel error -progress "$MORPH_PROGRESS" "$@"
  else "$FFMPEG" -hide_banner -nostdin -y -loglevel error "$@"; fi
}
ff_has_enc() { "$FFMPEG" -hide_banner -encoders 2>/dev/null | grep -q " $1 "; }

[ -e "$IN" ] || die "файл не найден"
case "$Q" in ''|*[!0-9]*) Q=70;; esac
[ "$Q" -lt 1 ] && Q=1; [ "$Q" -gt 100 ] && Q=100
case "$MAX" in ''|*[!0-9]*) MAX=0;; esac

name="$(basename "$IN")"
if [ -d "$IN" ]; then base="$name"; ext=""; else
  base="${name%.*}"; ext="$(printf '%s' "${name##*.}" | tr 'A-Z' 'a-z')"
  [ "$base" = "$name" ] && ext=""
  [ -z "$base" ] && base="$name"
fi
[ -n "$OUTDIR" ] || OUTDIR="$(dirname "$IN")"
mkdir -p "$OUTDIR" 2>/dev/null || die "не могу создать папку сохранения: $OUTDIR"
[ -w "$OUTDIR" ] || die "нет прав на запись в папку: $OUTDIR"

if [ -d "$IN" ]; then kind=folder; else
case "$ext" in
  jpg|jpeg|jpe|png|heic|heif|webp|tif|tiff|bmp|avif|jp2|psd|ico|icns|tga|cr2|cr3|nef|arw|dng|raf|orf|rw2) kind=image;;
  gif) kind=gif;;
  mp4|mov|m4v|mkv|webm|avi|wmv|flv|mpg|mpeg|3gp|ts|mts|m2ts|vob|ogv) kind=video;;
  mp3|m4a|aac|wav|flac|ogg|oga|opus|aif|aiff|wma|amr|caf|m4r|alac) kind=audio;;
  pdf) kind=pdf;;
  doc|docx|rtf|rtfd|txt|text|html|htm|odt|md|wordml|webarchive) kind=doc;;
  xls|xlsx|csv|ods|tsv) kind=sheet;;
  ppt|pptx|odp|pps|ppsx) kind=slides;;
  *) kind=other;;
esac
fi

# ---------- правки: обрезка по времени и кадрирование ----------
ORIG_IN="$IN"
EDIT=0; SEEK=""; VF_PRE=""; TDUR=""
if [ -n "${MORPH_TRIM:-}" ]; then
  ts="${MORPH_TRIM%%:*}"; te="${MORPH_TRIM#*:}"; [ "$te" = "$MORPH_TRIM" ] && te=""
  echo "$ts" | grep -Eq '^[0-9]+(\.[0-9]+)?$' || die "неверное начало обрезки: $ts"
  if [ -n "$te" ]; then
    echo "$te" | grep -Eq '^[0-9]+(\.[0-9]+)?$' || die "неверный конец обрезки: $te"
    TDUR="$(awk -v a="$ts" -v b="$te" 'BEGIN{d=b-a; if(d<=0) exit 1; printf "%.3f", d}')" || die "конец обрезки раньше начала"
    SEEK="-ss $ts -t $TDUR"
  else SEEK="-ss $ts"; fi
  EDIT=1
fi
if [ -n "${MORPH_CROP:-}" ]; then
  echo "$MORPH_CROP" | grep -Eq '^[0-9]+:[0-9]+:[0-9]+:[0-9]+$' || die "неверная рамка кадрирования: $MORPH_CROP"
  VF_PRE="crop=$MORPH_CROP,"; EDIT=1
fi

# длительность — для полоски прогресса в окне
if [ -n "${MORPH_PROGRESS:-}" ] && [ -n "$FFMPEG" ]; then
  case "$kind" in video|audio|gif)
    "$FFMPEG" -hide_banner -i "$IN" 2>&1 | sed -n 's/.*Duration: \([0-9]*\):\([0-9]*\):\([0-9.]*\).*/\1 \2 \3/p' | head -n 1 \
      | awk '{printf "%d\n", ($1*3600+$2*60+$3)*1000000}' > "$MORPH_PROGRESS.dur"
    [ -n "$TDUR" ] && awk -v d="$TDUR" 'BEGIN{printf "%d\n", d*1000000}' > "$MORPH_PROGRESS.dur";;
  esac
fi

# ---------- целевой формат ----------
COMPRESS=0
T="$TARGET"
if [ "$T" = "same" ]; then
  COMPRESS=1
  case "$kind" in
    image) case "$ext" in jpeg|jpe) T=jpg;; heif) T=heic;; tif) T=tiff;; png|jpg|heic|webp|tiff) T="$ext";; *) T=jpg;; esac;;
    gif) T=gif;;
    video) case "$ext" in mp4|mov|mkv|webm|m4v) T="$ext";; *) T=mp4;; esac;;
    audio) case "$ext" in mp3|m4a|ogg|opus) T="$ext";; aac|m4r) T=m4a;; *) T=m4a;; esac;;
    pdf) T=pdf;;
    folder|other|doc|sheet|slides) T=zip;;
  esac
fi
VCODEC=h264
[ "$T" = "mp4hevc" ] && { T=mp4; VCODEC=hevc; }
# правка — это всегда новый файл, сравнивать размер с оригиналом не нужно
[ "$EDIT" = 1 ] && COMPRESS=0

# ---------- имя результата ----------
outfile() {  # $1 = расширение
  local e="$1" o="$OUTDIR/$base.$1" n=2
  if [ "$COMPRESS" = 1 ] || [ "$EDIT" = 1 ] || [ -e "$o" ]; then o="$OUTDIR/$base (morph).$e"; fi
  while [ -e "$o" ]; do o="$OUTDIR/$base (morph $n).$e"; n=$((n+1)); done
  printf '%s' "$o" > "$TMP/curout"
  printf '%s' "$o"
}
fsize() { if [ -d "$1" ]; then du -sk "$1" | awk '{print $1*1024}'; else wc -c < "$1" | tr -d " "; fi; }

finish() {  # $1 = результат
  local o="$1"
  [ -e "$o" ] || die "результат не создан"
  local a b; a=$(fsize "$ORIG_IN"); b=$(fsize "$o")
  [ "$b" -gt 0 ] 2>/dev/null || { rm -rf "$o"; die "получился пустой файл"; }
  if [ "$COMPRESS" = 1 ] && [ "$b" -ge "$a" ] && [ "$o" != "$ORIG_IN" ]; then
    rm -rf "$o"
    printf 'SAME\tфайл уже оптимален — сжатие не уменьшило размер, оригинал не тронут\n'; exit 0
  fi
  printf 'OK\t%s\t%s\t%s\n' "$o" "$a" "$b"; exit 0
}

bad() { die "нельзя превратить .$ext в ${T}"; }

# ---------- параметры качества ----------
CRF=$(( 18 + (100 - Q) * 15 / 90 ))            # x264: 18..33
CRF265=$(( CRF + 4 ))
CRFVP9=$(( 24 + (100 - Q) * 22 / 90 ))          # vp9: 24..46
if   [ "$Q" -ge 90 ]; then BR=320; elif [ "$Q" -ge 75 ]; then BR=256; elif [ "$Q" -ge 60 ]; then BR=192
elif [ "$Q" -ge 40 ]; then BR=128; elif [ "$Q" -ge 20 ]; then BR=96; else BR=64; fi
if [ "$Q" -ge 80 ]; then ABR=192; elif [ "$Q" -ge 40 ]; then ABR=128; else ABR=96; fi
if [ "$Q" -ge 80 ]; then GCOL=256; GFPS=15; elif [ "$Q" -ge 50 ]; then GCOL=128; GFPS=12; else GCOL=64; GFPS=10; fi
GLOSSY=$(( (100 - Q) * 2 )); [ "$GLOSSY" -gt 200 ] && GLOSSY=200

# масштаб для ffmpeg: ограничение по длинной стороне, чётные размеры
vscale() {  # $1 = макс. сторона (0 = оригинал)
  if [ "${1:-0}" -gt 0 ]; then
    printf "scale='if(gte(iw,ih),min(%s,iw),-2)':'if(gte(iw,ih),-2,min(%s,ih))'" "$1" "$1"
  else
    printf "scale=trunc(iw/2)*2:trunc(ih/2)*2"
  fi
}
iscale() {  # для картинок/гифок (нечётные размеры допустимы)
  if [ "${1:-0}" -gt 0 ]; then
    printf "scale='if(gte(iw,ih),min(%s,iw),-1)':'if(gte(iw,ih),-1,min(%s,ih))'" "$1" "$1"
  else printf "null"; fi
}

audio_args() {  # кодек звука для видео-контейнера $1
  if [ "$MUTE" = 1 ]; then echo "-an"; return; fi
  case "$1" in
    webm) echo "-c:a libopus -b:a ${ABR}k";;
    *) echo "-c:a aac -b:a ${ABR}k";;
  esac
}

video_encode() {  # $1 = вход, $2 = выход, $3 = контейнер
  need_ff
  local vf; vf="${VF_PRE}$(vscale "$MAX")"
  case "$3" in
    webm)
      ff $SEEK -i "$1" -map 0:v:0 -map '0:a:0?' -vf "$vf" -c:v libvpx-vp9 -crf "$CRFVP9" -b:v 0 -row-mt 1 -deadline good -cpu-used 4 -pix_fmt yuv420p $(audio_args webm) "$2" || die "ошибка кодирования видео";;
    *)
      local venc
      if [ "$VCODEC" = hevc ]; then
        if ff_has_enc libx265; then venc="-c:v libx265 -crf $CRF265 -preset medium -tag:v hvc1"
        else venc="-c:v hevc_videotoolbox -q:v $Q -tag:v hvc1"; fi
      else
        if ff_has_enc libx264; then venc="-c:v libx264 -crf $CRF -preset medium"
        else venc="-c:v h264_videotoolbox -q:v $Q"; fi
      fi
      local extra=""; [ "$3" = mp4 ] || [ "$3" = mov ] || [ "$3" = m4v ] && extra="-movflags +faststart"
      ff $SEEK -i "$1" -map 0:v:0 -map '0:a:0?' -vf "$vf" $venc -pix_fmt yuv420p $(audio_args "$3") $extra "$2" || die "ошибка кодирования видео";;
  esac
}

to_gif() {  # $1 = вход (видео/гиф), $2 = выход
  need_ff
  local m="$MAX"; [ "$m" -eq 0 ] && [ "$kind" = video ] && m=640
  local fpsf="fps=$GFPS,"; [ "$kind" = gif ] && fpsf=""
  local sc=""; [ "$m" -gt 0 ] && sc="$(iscale "$m"):flags=lanczos,"
  ff $SEEK -i "$1" -vf "${fpsf}${VF_PRE}${sc}split[s0][s1];[s0]palettegen=max_colors=$GCOL:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 "$TMP/raw.gif" || die "ошибка создания GIF"
  if [ -n "$GIFSICLE" ]; then "$GIFSICLE" -O3 --lossy="$GLOSSY" -o "$2" "$TMP/raw.gif" || cp "$TMP/raw.gif" "$2"
  else cp "$TMP/raw.gif" "$2"; fi
}

audio_encode() {  # $1 вход, $2 выход, $3 формат
  if [ -z "$FFMPEG" ]; then  # запасной вариант на встроенном afconvert
    case "$3" in
      m4a) afconvert -f m4af -d aac -b $((BR*1000)) "$1" "$2" || die "afconvert";;
      wav) afconvert -f WAVE -d LEI16 "$1" "$2" || die "afconvert";;
      aiff) afconvert -f AIFF -d BEI16 "$1" "$2" || die "afconvert";;
      *) need_ff;;
    esac; return
  fi
  local a
  case "$3" in
    mp3)  a="-c:a libmp3lame -b:a ${BR}k";;
    m4a)  if ff_has_enc aac_at; then a="-c:a aac_at -b:a ${BR}k"; else a="-c:a aac -b:a ${BR}k"; fi;;
    ogg)  if ff_has_enc libvorbis; then a="-c:a libvorbis -b:a ${BR}k"; else a="-c:a libopus -b:a ${BR}k"; fi;;
    opus) local ob=$BR; [ "$ob" -gt 256 ] && ob=256; a="-c:a libopus -b:a ${ob}k";;
    flac) a="-c:a flac";;
    wav)  a="-c:a pcm_s16le";;
    aiff) a="-c:a pcm_s16be";;
  esac
  ff $SEEK -i "$1" -vn -map_metadata 0 $a "$2" || die "ошибка кодирования аудио"
}

# картинка -> PNG без экзотики (для ffmpeg). HEIC/RAW/PSD читает только sips.
img_src() {  # кладёт путь в $SRC
  case "$ext" in
    png|jpg|jpeg|jpe|bmp|tif|tiff|webp) SRC="$IN";;
    *) sips -s format png "$IN" --out "$TMP/src.png" >/dev/null || die "не удалось прочитать картинку"; SRC="$TMP/src.png";;
  esac
}
# sips -Z только уменьшает, если картинка больше лимита
sips_resize_args() {
  [ "$MAX" -gt 0 ] || return
  local w h; w=$(sips -g pixelWidth "$IN" 2>/dev/null | awk '/pixelWidth/{print $2}'); h=$(sips -g pixelHeight "$IN" 2>/dev/null | awk '/pixelHeight/{print $2}')
  [ -n "$w" ] && [ -n "$h" ] && { [ "$w" -gt "$MAX" ] || [ "$h" -gt "$MAX" ]; } && printf -- "-Z %s" "$MAX"
}

PDFTOOL="$HERE/pdftool.js"
pdftool() { /usr/bin/osascript -l JavaScript "$PDFTOOL" "$@" >/dev/null; }

lo_convert() {  # $1 = формат для LibreOffice, $2 = расширение результата, $3 = входной фильтр (необязательно)
  need_lo
  local inf=""; [ -n "${3:-}" ] && inf="--infilter=$3"
  "$SOFFICE" -env:UserInstallation=file://"$TMP/lo" --headless $inf --convert-to "$1" --outdir "$TMP/lo_out" "$IN" >/dev/null || die "LibreOffice не смог конвертировать"
  local r; r="$(ls "$TMP/lo_out/"* 2>/dev/null | head -n 1)"
  [ -n "$r" ] || die "LibreOffice не создал файл"
  local o; o="$(outfile "$2")"; mv "$r" "$o"; finish "$o"
}

# ---------- ZIP — для чего угодно ----------
if [ "$T" = zip ]; then
  o="$(outfile zip)"
  ditto -c -k --sequesterRsrc --keepParent "$IN" "$o" 2>/dev/null || (cd "$(dirname "$IN")" && zip -qr -9 "$o" "$name") || die "не удалось упаковать"
  finish "$o"
fi

# кадрирование картинки: сначала режем через ffmpeg в PNG, дальше — обычный путь
if [ "$kind" = image ] && [ -n "$VF_PRE" ]; then
  need_ff; img_src
  ff -i "$SRC" -vf "crop=$MORPH_CROP" -frames:v 1 "$TMP/cropped.png" || die "не удалось кадрировать"
  IN="$TMP/cropped.png"; ext=png
fi

case "$kind" in
# ============ КАРТИНКИ ============
image)
  o="$(outfile "$T")"
  case "$T" in
    jpg)
      if [ -n "$FFMPEG" ] && sips -g hasAlpha "$IN" 2>/dev/null | grep -q 'hasAlpha: yes'; then
        img_src; jq=$(( 2 + (100 - Q) * 29 / 90 ))
        ff -i "$SRC" -filter_complex "[0:v]format=rgba,split[a][b];[a]lutrgb=r=255:g=255:b=255:a=255[bg];[bg][b]overlay=format=auto,$(iscale "$MAX"),format=rgb24" -frames:v 1 -q:v "$jq" "$o" || die "ошибка JPG"
      else
        sips -s format jpeg -s formatOptions "$Q" $(sips_resize_args) "$IN" --out "$o" >/dev/null || die "sips"
      fi;;
    heic) sips -s format heic -s formatOptions "$Q" $(sips_resize_args) "$IN" --out "$o" >/dev/null || die "sips";;
    tiff) sips -s format tiff $(sips_resize_args) "$IN" --out "$o" >/dev/null || die "sips";;
    bmp)  sips -s format bmp $(sips_resize_args) "$IN" --out "$o" >/dev/null || die "sips";;
    pdf)  sips -s format pdf $(sips_resize_args) "$IN" --out "$o" >/dev/null || die "sips";;
    png)
      if [ -n "$FFMPEG" ] && [ "$Q" -lt 95 ]; then   # сжатие PNG с палитрой (как TinyPNG)
        if [ "$Q" -ge 60 ]; then c=256; elif [ "$Q" -ge 30 ]; then c=128; else c=64; fi
        img_src; ff -i "$SRC" -filter_complex "[0:v]$(iscale "$MAX"),split[a][b];[a]palettegen=max_colors=$c:reserve_transparent=1[p];[b][p]paletteuse=dither=sierra2_4a" -frames:v 1 "$o" || die "ошибка сжатия PNG"
      else
        sips -s format png $(sips_resize_args) "$IN" --out "$o" >/dev/null || die "sips"
      fi;;
    webp) need_ff; img_src; ff -i "$SRC" -vf "$(iscale "$MAX")" -c:v libwebp -quality "$Q" -frames:v 1 "$o" || die "ошибка WebP";;
    gif)  sips -s format gif $(sips_resize_args) "$IN" --out "$o" >/dev/null || die "sips";;
    *) rm -f "$o"; bad;;
  esac
  finish "$o";;

# ============ GIF ============
gif)
  o="$(outfile "$T")"
  case "$T" in
    gif)
      if [ -n "$GIFSICLE" ] && [ "$EDIT" = 0 ]; then
        rs=""; [ "$MAX" -gt 0 ] && rs="--resize-fit ${MAX}x${MAX}"
        "$GIFSICLE" -O3 --lossy="$GLOSSY" --colors "$GCOL" $rs -o "$o" "$IN" || die "gifsicle"
      else to_gif "$IN" "$o"; fi;;
    mp4|mov|mkv|webm) video_encode "$IN" "$o" "$T";;
    webp) need_ff; ff $SEEK -i "$IN" -vf "${VF_PRE}$(iscale "$MAX")" -c:v libwebp_anim -quality "$Q" -loop 0 "$o" 2>/dev/null || ff $SEEK -i "$IN" -vf "${VF_PRE}$(iscale "$MAX")" -c:v libwebp -quality "$Q" -loop 0 "$o" || die "ошибка WebP";;
    png|jpg) [ "$T" = jpg ] && f=jpeg || f=png; sips -s format "$f" "$IN" --out "$o" >/dev/null || die "sips";;
    *) rm -f "$o"; bad;;
  esac
  finish "$o";;

# ============ ВИДЕО ============
video)
  o="$(outfile "$T")"
  case "$T" in
    mp4|mov|mkv|m4v|webm) video_encode "$IN" "$o" "$T";;
    gif) to_gif "$IN" "$o";;
    mp3|m4a|wav|flac|ogg|opus|aiff) need_ff; audio_encode "$IN" "$o" "$T";;
    jpg|png) need_ff; ff ${SEEK:--ss 0} -i "$IN" -frames:v 1 -vf "${VF_PRE}$(iscale "$MAX")" "$o" || die "ошибка кадра";;
    *) rm -f "$o"; bad;;
  esac
  finish "$o";;

# ============ АУДИО ============
audio)
  case "$T" in mp3|m4a|wav|flac|ogg|opus|aiff) ;; *) bad;; esac
  o="$(outfile "$T")"; audio_encode "$IN" "$o" "$T"; finish "$o";;

# ============ PDF ============
pdf)
  case "$T" in
    pdf)
      o="$(outfile pdf)"
      best=""
      if has gs; then
        if [ "$Q" -ge 80 ]; then ps=/printer; elif [ "$Q" -ge 50 ]; then ps=/ebook; else ps=/screen; fi
        gs -q -dNOPAUSE -dBATCH -dSAFER -sDEVICE=pdfwrite -dCompatibilityLevel=1.5 -dPDFSETTINGS=$ps -sOutputFile="$TMP/gs.pdf" "$IN" && best="$TMP/gs.pdf"
      fi
      pdftool compress "$IN" "$TMP/pk.pdf" "$Q" || true
      if [ -s "$TMP/pk.pdf" ] && { [ -z "$best" ] || [ "$(fsize "$TMP/pk.pdf")" -lt "$(fsize "$best")" ]; }; then best="$TMP/pk.pdf"; fi
      [ -n "$best" ] || die "не удалось сжать PDF"
      mv "$best" "$o"; finish "$o";;
    jpg|png)
      o="$OUTDIR/$base (страницы)"; n=2; while [ -e "$o" ]; do o="$OUTDIR/$base (страницы $n)"; n=$((n+1)); done
      printf '%s' "$o" > "$TMP/curout"; mkdir -p "$o"; pdftool pages "$IN" "$o" "$Q" "$T" || die "не удалось разобрать PDF"
      finish "$o";;
    txt) o="$(outfile txt)"; pdftool text "$IN" "$o" "$Q" || die "не удалось извлечь текст"
         [ -s "$o" ] || { rm -f "$o"; die "в PDF нет текстового слоя — похоже, это скан"; }
         finish "$o";;
    docx|odt) lo_convert "$T" "$T" writer_pdf_import;;
    *) bad;;
  esac;;

# ============ ДОКУМЕНТЫ ============
doc)
  src="$IN"
  [ "$ext" = md ] && { cp "$IN" "$TMP/src.txt"; src="$TMP/src.txt"; }
  case "$T" in
    txt|html|rtf|rtfd|doc|docx|odt|wordml|webarchive)
      o="$(outfile "$T")"
      textutil -convert "$T" -output "$o" "$src" >/dev/null || { rm -rf "$o"; [ -n "$SOFFICE" ] && lo_convert "$T" "$T"; die "textutil не смог конвертировать"; }
      finish "$o";;
    pdf)
      [ -n "$SOFFICE" ] && lo_convert pdf pdf
      o="$(outfile pdf)"; pdftool doc2pdf "$src" "$o" "$Q" || die "не удалось сделать PDF (установи LibreOffice для лучшего результата)"
      finish "$o";;
    *) bad;;
  esac;;

# ============ ТАБЛИЦЫ / ПРЕЗЕНТАЦИИ ============
sheet)
  case "$T" in xlsx|ods|pdf|html) lo_convert "$T" "$T";; csv) lo_convert "csv:Text - txt - csv (StarCalc):44,34,76" csv;; xls) lo_convert "xls:MS Excel 97" xls;; *) bad;; esac;;
slides)
  case "$T" in pptx|odp|pdf) lo_convert "$T" "$T";; ppt) lo_convert "ppt:MS PowerPoint 97" ppt;; jpg|png) lo_convert "$T" "$T";; *) bad;; esac;;

folder) die "папки можно только упаковать в ZIP";;
*) die "неизвестный формат .$ext — можно только упаковать в ZIP";;
esac
