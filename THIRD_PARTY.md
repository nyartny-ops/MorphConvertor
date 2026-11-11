# Сторонние компоненты

| Компонент | Как используется | Лицензия |
|---|---|---|
| [FFmpeg](https://ffmpeg.org) | Видео, аудио, GIF, WebP. Релизные сборки содержат статический ffmpeg от [Martin Riedl](https://ffmpeg.martin-riedl.de) (с x264, x265 и др.) | GPL-2.0-or-later — исходники: [ffmpeg.org/download](https://ffmpeg.org/download.html), сборочные скрипты: [ffmpeg.martin-riedl.de](https://ffmpeg.martin-riedl.de) |
| [gifsicle](https://www.lcdf.org/gifsicle/) | Необязательно: усиленное сжатие GIF, если установлен | GPL-2.0 |
| [LibreOffice](https://www.libreoffice.org) | Необязательно: таблицы, презентации, PDF из документов, если установлен | MPL-2.0 |
| sips, textutil, PDFKit, afconvert | Встроены в macOS | — |

ffmpeg не входит в исходный код репозитория — он скачивается при сборке и запускается как отдельная программа.
