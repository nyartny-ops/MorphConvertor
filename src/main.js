// Morph — конвертер и компрессор файлов для macOS.
// JavaScript for Automation: osacompile превращает этот файл в .app без Xcode.
// Окно — ui.html в WKWebView, круговое меню — radial.html в прозрачной панели, работа — convert.sh.
//
// Важно про мост JXA ↔ Objective-C:
//  • никаких блоков (completion handlers) — мост их ломает; поэтому приложение → окно
//    общается через файлы состояния, которые страницы опрашивают сами;
//  • никаких BOOL в собственных методах — на Intel и Apple Silicon у BOOL разные типы.
ObjC.import('Cocoa');
ObjC.import('WebKit');

var RES = $.NSBundle.mainBundle.resourcePath.js;
var ENGINE = RES + '/convert.sh';
var FM = $.NSFileManager.defaultManager;
var defaults = $.NSUserDefaults.standardUserDefaults;
var SA = Application.currentApplication();
SA.includeStandardAdditions = true;
var HOME = $.NSHomeDirectory().js;

var KINDS = {
  image: 'jpg jpeg jpe png heic heif webp tif tiff bmp avif jp2 psd ico icns tga cr2 cr3 nef arw dng raf orf rw2',
  gif: 'gif',
  video: 'mp4 mov m4v mkv webm avi wmv flv mpg mpeg 3gp ts mts m2ts vob ogv',
  audio: 'mp3 m4a aac wav flac ogg oga opus aif aiff wma amr caf m4r alac',
  pdf: 'pdf',
  doc: 'doc docx rtf rtfd txt text html htm odt md wordml webarchive',
  sheet: 'xls xlsx csv ods tsv',
  slides: 'ppt pptx odp pps ppsx'
};
var EXT2KIND = {};
Object.keys(KINDS).forEach(function (k) { KINDS[k].split(' ').forEach(function (e) { EXT2KIND[e] = k; }); });

var ui = {};
var items = [];
var nextId = 1;
var queue = [];
var current = null;
var outDir = '';      // активная папка сохранения ('' = рядом с оригиналом)
var savedDir = '';    // последняя выбранная папка — помним, даже если сейчас «рядом»
var timer = null;
var settings = { mode: 'compress', targets: {}, quality: 65, max: 0, mute: false, radial: true };
var lastPushed = '';
var editorSignal = null;   // {id, n} — попросить окно открыть редактор

// ---------- журнал: ~/Library/Logs/Morph.log ----------
var LOG = HOME + '/Library/Logs/Morph.log';
var IN_CI = (function () {
  try { var v = $.NSProcessInfo.processInfo.environment.objectForKey('MORPH_CI'); return !!(v && !v.isNil()); } catch (e) { return false; }
})();
function log(msg) {
  var line = new Date().toISOString() + '  ' + msg;
  if (IN_CI) { try { console.log(line); } catch (e) {} }
  try {
    FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(HOME + '/Library/Logs', true, $(), null);
    var prev = readText(LOG);
    if (prev.length > 200000) prev = prev.slice(-100000);
    $(prev + line + '\n').writeToFileAtomicallyEncodingError(LOG, true, $.NSUTF8StringEncoding, null);
  } catch (e) {}
}
function fatal(where, e) {
  var m = where + ': ' + (e && e.message ? e.message : String(e));
  log('ОШИБКА ' + m + (e && e.stack ? '\n' + e.stack : ''));
  if (IN_CI) return;
  try {
    var a = $.NSAlert.alloc.init;
    a.setMessageText($('Morph: ошибка'));
    a.setInformativeText($(m + '\n\nПодробности: ~/Library/Logs/Morph.log'));
    a.runModal;
  } catch (e2) {}
}

// ---------- утилиты ----------
function basename(p) { return p.replace(/\/+$/, '').split('/').pop(); }
function isDir(p) { var d = Ref(); return FM.fileExistsAtPathIsDirectory(p, d) && !!d[0]; }
function exists(p) { return FM.fileExistsAtPath(p); }
function isExec(p) { return FM.isExecutableFileAtPath(p); }
function fileSize(p) {
  var a = FM.attributesOfItemAtPathError(p, null);
  return (a && !a.isNil()) ? Number(a.fileSize) : 0;
}
function kindOf(p) {
  if (isDir(p)) return 'folder';
  var n = basename(p), i = n.lastIndexOf('.');
  if (i <= 0) return 'other';
  return EXT2KIND[n.slice(i + 1).toLowerCase()] || 'other';
}
function listFiles(dir) {
  var res = [], en = FM.enumeratorAtPath(dir), f;
  while ((f = en.nextObject) && !f.isNil() && res.length < 5000) {
    var rel = f.js;
    if (rel.split('/').some(function (s) { return s.charAt(0) === '.'; })) continue;
    var full = dir + '/' + rel;
    if (!isDir(full)) res.push(full);
  }
  return res;
}
function readText(p) {
  if (!exists(p)) return '';
  var s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null);
  return (s && !s.isNil()) ? s.js : '';
}
function writeFile(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}
function rm(p) { if (exists(p)) FM.removeItemAtPathError(p, null); }
function shortPath(p) { return p.indexOf(HOME) === 0 ? '~' + p.slice(HOME.length) : p; }
function tools() {
  var ff = [RES + '/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg'].some(isExec);
  var lo = ['/Applications/LibreOffice.app/Contents/MacOS/soffice', HOME + '/Applications/LibreOffice.app/Contents/MacOS/soffice'].some(isExec);
  return { ffmpeg: ff, lo: lo };
}
var TOOLS = null;

// синхронный запуск короткой команды (probe, кадр для превью)
function runSync(args) {
  try {
    var t = $.NSTask.alloc.init;
    t.setLaunchPath($('/bin/bash'));
    t.setArguments($(args));
    var pipe = $.NSPipe.pipe;
    t.setStandardOutput(pipe);
    t.setStandardError($.NSFileHandle.fileHandleWithNullDevice);
    t.launch;
    var data = pipe.fileHandleForReading.readDataToEndOfFile;
    t.waitUntilExit;
    var s = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    return (s && !s.isNil()) ? s.js : '';
  } catch (e) { log('runSync: ' + e.message); return ''; }
}

// ---------- файлы, видимые страницам ----------
var WEBDIR = HOME + '/Library/Application Support/Morph/web';
var LS_RE = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
function prepareWebDir() {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(WEBDIR + '/frames', true, $(), null);
  ['ui.html', 'radial.html'].forEach(function (f) {
    rm(WEBDIR + '/' + f);
    FM.copyItemAtPathToPathError(RES + '/' + f, WEBDIR + '/' + f, null);
  });
}

// ---------- состояние главного окна (state.js) ----------
var seq = 0, dragOn = false, toastMsg = null, toastId = 0;
function toast(text) { toastMsg = text; toastId++; push(); }
function push() {
  var st = {
    items: items.map(function (it) {
      return { id: it.id, name: it.name, path: it.path, kind: it.kind, size: it.size, status: it.status, info: it.info || '',
        a: it.a || 0, b: it.b || 0, outName: it.out ? basename(it.out) : '', progress: it.progress == null ? -1 : it.progress,
        target: it.target || null, mute: it.mute == null ? null : it.mute, trim: it.trim || null, crop: it.crop || null,
        meta: it.meta || null };
    }),
    outDir: outDir, savedDir: savedDir, savedDirShort: savedDir ? shortPath(savedDir) : '',
    running: !!current, tools: TOOLS || tools(), settings: settings,
    drag: dragOn, toast: toastMsg ? { id: toastId, text: toastMsg } : null,
    editor: editorSignal
  };
  var json = JSON.stringify(st).replace(LS_RE, ' ');
  if (json === lastPushed) return;
  lastPushed = json;
  seq++;
  try { writeFile(WEBDIR + '/state.js', 'window.morph && morph.state(' + json.replace(/^\{/, '{"seq":' + seq + ',') + ');'); }
  catch (e) { log('state: ' + e.message); }
}

function addPaths(paths, extra) {
  var known = {}, added = [];
  items.forEach(function (it) { known[it.path] = it; });
  paths.forEach(function (p) {
    var list = isDir(p) ? listFiles(p) : [p];
    list.forEach(function (f) {
      var it = known[f];
      if (it) {
        if (extra && it.status !== 'work') { Object.assign(it, extra); it.status = 'wait'; it.info = ''; added.push(it); }
        return;
      }
      it = { id: nextId++, path: f, name: basename(f), kind: kindOf(f), size: fileSize(f), status: 'wait' };
      if (extra) Object.assign(it, extra);
      items.push(it); known[f] = it; added.push(it);
    });
  });
  push();
  return added;
}

function saveSettings() {
  defaults.setObjectForKey($(JSON.stringify(settings)), 'settings2');
  defaults.setObjectForKey($(outDir), 'outDir');
  defaults.setObjectForKey($(savedDir), 'savedDir');
}
function loadSettings() {
  try {
    var s = defaults.stringForKey('settings2');
    if (s && !s.isNil()) settings = Object.assign(settings, JSON.parse(s.js));
  } catch (e) {}
  var o = defaults.stringForKey('outDir');
  outDir = (o && !o.isNil()) ? o.js : '';
  var sd = defaults.stringForKey('savedDir');
  savedDir = (sd && !sd.isNil()) ? sd.js : outDir;
  if (savedDir && !isDir(savedDir)) savedDir = '';
  if (outDir && !isDir(outDir)) outDir = '';
}

// ---------- метаданные и кадр для редактора ----------
function probe(it) {
  if (it.meta) return;
  var r = runSync([ENGINE, '--probe', it.path]).trim().split(/\s+/);
  it.meta = { dur: parseFloat(r[0]) || 0, w: parseInt(r[1], 10) || 0, h: parseInt(r[2], 10) || 0, frame: '' };
  if (it.kind === 'video' || it.kind === 'gif') {
    var ff = [RES + '/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/local/bin/ffmpeg'].filter(isExec)[0];
    if (ff) {
      var fr = WEBDIR + '/frames/' + it.id + '.jpg';
      var at = Math.min(1, it.meta.dur / 3).toFixed(2);
      runSync(['-c', '"$0" -hide_banner -loglevel error -y -ss "$1" -i "$2" -frames:v 1 -q:v 3 "$3"', ff, at, it.path, fr]);
      if (exists(fr)) it.meta.frame = 'frames/' + it.id + '.jpg?' + Date.now();
    }
  }
}

// ---------- очередь ----------
function targetFor(it) {
  if (it.target) return it.target;
  if (settings.mode !== 'convert') return 'same';
  return (settings.targets && settings.targets[it.kind]) || (it.kind === 'other' || it.kind === 'folder' ? 'zip' : 'same');
}

function ensureTimer() {
  if (!timer) timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.25, ui.ctrl, 'tick:', $(), true);
}
function start() {
  if (!items.some(function (it) { return it.status === 'wait'; })) {
    items.forEach(function (it) { if (it.status !== 'work') { it.status = 'wait'; it.info = ''; it.a = it.b = 0; it.out = ''; it.progress = null; } });
  }
  items.forEach(function (it) { if (it.status === 'wait' && queue.indexOf(it) < 0) queue.push(it); });
  saveSettings();
  ensureTimer();
  if (!current) next();
  else push();
}

function next() {
  if (!queue.length) {
    current = null;
    if (timer) { timer.invalidate; timer = null; }
    push();
    finishedBatch();
    return;
  }
  var it = queue.shift();
  if (items.indexOf(it) < 0 || it.status !== 'wait') { next(); return; }
  it.status = 'work'; it.info = ''; it.progress = null;
  var prog = $.NSTemporaryDirectory().js + 'morph_progress_' + it.id;
  rm(prog); rm(prog + '.dur');
  var mute = it.mute == null ? settings.mute : it.mute;
  var t = $.NSTask.alloc.init;
  t.setLaunchPath($('/bin/bash'));
  t.setArguments($([ENGINE, it.path, targetFor(it), String(it.quality || settings.quality), String(settings.max || 0), mute ? '1' : '0', outDir]));
  var env = $.NSProcessInfo.processInfo.environment.mutableCopy;
  env.setObjectForKey($(prog), 'MORPH_PROGRESS');
  if (it.trim) env.setObjectForKey($(it.trim[0].toFixed(3) + ':' + it.trim[1].toFixed(3)), 'MORPH_TRIM');
  if (it.crop) env.setObjectForKey($(it.crop.join(':')), 'MORPH_CROP');
  t.setEnvironment(env);
  var pipe = $.NSPipe.pipe;
  t.setStandardOutput(pipe);
  t.setStandardError($.NSFileHandle.fileHandleWithNullDevice);
  current = { it: it, task: t, pipe: pipe, prog: prog };
  try { t.launch; } catch (e) {
    it.status = 'err'; it.info = 'не запустился движок'; current = null; next(); return;
  }
  push();
}

function tick() {
  if (!current) return;
  var c = current, it = c.it;
  if (c.task.isRunning) {
    var dur = parseInt(readText(c.prog + '.dur'), 10);
    if (dur > 0) {
      var m = readText(c.prog).match(/out_time_(?:us|ms)=(\d+)/g);
      if (m) {
        var us = parseInt(m[m.length - 1].split('=')[1], 10);
        it.progress = Math.max(0, Math.min(0.99, us / dur));
      } else it.progress = 0;
    }
    push();
    return;
  }
  var data = c.pipe.fileHandleForReading.readDataToEndOfFile;
  var s = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  var out = (s && !s.isNil()) ? s.js : '';
  var p = (out.trim().split('\n').pop() || '').split('\t');
  if (p[0] === 'OK') { it.status = 'ok'; it.out = p[1]; it.a = Number(p[2]); it.b = Number(p[3]); }
  else if (p[0] === 'SAME') { it.status = 'same'; it.info = p[1]; }
  else { it.status = c.stopped ? 'wait' : 'err'; it.info = c.stopped ? '' : (p[1] || 'неизвестная ошибка'); }
  it.progress = null;
  rm(c.prog); rm(c.prog + '.dur');
  current = null;
  next();
}

function killChildren(pid) {
  try {
    var k = $.NSTask.alloc.init;
    k.setLaunchPath($('/usr/bin/pkill'));
    k.setArguments($(['-TERM', '-P', String(pid)]));
    k.launch; k.waitUntilExit;
  } catch (e) { log('pkill: ' + e.message); }
}
function stop() {
  queue = [];
  if (current && current.task.isRunning) {
    current.stopped = true;
    var pid = current.task.processIdentifier;
    current.task.terminate;   // движок ловит TERM и удаляет недоделанный файл
    killChildren(pid);        // а ffmpeg/sips завершаем сами
  }
}

function human(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' Б';
  var u = ['КБ', 'МБ', 'ГБ'], i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 2);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)).replace('.', ',') + ' ' + u[i];
}
// уведомление о файлах, отправленных через круговое меню
function finishedBatch() {
  var batch = items.filter(function (it) { return it.fromRadial && !it.notified && it.status !== 'wait' && it.status !== 'work'; });
  if (!batch.length) { try { $.NSSound.soundNamed('Glass').play; } catch (e) {} return; }
  var ok = 0, err = 0, a = 0, b = 0;
  batch.forEach(function (it) {
    it.notified = true;
    if (it.status === 'ok') { ok++; a += it.a; b += it.b; } else if (it.status === 'err') err++;
  });
  var title = ok ? ('Готово: ' + ok + ' ' + (ok === 1 ? 'файл' : (ok < 5 ? 'файла' : 'файлов'))) : 'Не получилось';
  var text = ok ? (human(a) + ' → ' + human(b) + (b < a ? ' · −' + Math.round((a - b) * 100 / a) + '%' : '')) : '';
  if (err) text += (text ? ' · ' : '') + 'ошибок: ' + err;
  try { SA.displayNotification(text || 'Подробности в окне Morph', { withTitle: 'Morph', subtitle: title }); }
  catch (e) { log('notify: ' + e.message); }
}

function reveal(paths) {
  var urls = paths.filter(exists).map(function (p) { return $.NSURL.fileURLWithPath(p); });
  if (urls.length) $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs($(urls));
}

// пути файлов из текущего (или только что завершённого) перетаскивания
var DPB = $.NSPasteboard.pasteboardWithName($('Apple CFPasteboard drag'));
function dragPaths() {
  var res = [];
  try {
    var urls = DPB.readObjectsForClassesOptions($([$.NSURL]), $({}));
    if (urls && !urls.isNil()) for (var i = 0; i < urls.count; i++) {
      var u = urls.objectAtIndex(i);
      if (u.isFileURL) res.push(u.path.js);
    }
  } catch (e) { log('dragPaths: ' + e.message); }
  return res;
}

function openEditor(it) {
  probe(it);
  editorSignal = { id: it.id, n: (editorSignal ? editorSignal.n : 0) + 1 };
  showWindow();
  push();
}

function handle(m) {
  switch (m.cmd) {
    case 'log': log('ui: ' + m.text); break;
    case 'jserr': log('ОШИБКА js: ' + m.text); break;
    case 'ready':
      log('интерфейс готов'); TOOLS = tools(); lastPushed = ''; push();
      // проверка в CI: показать круговое меню без реального перетаскивания
      if (IN_CI && !ui.ciRadial) { ui.ciRadial = true; $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1.0, ui.ctrl, 'ciRadial:', $(), false); }
      break;
    case 'settings': settings = Object.assign(settings, m.settings || {}); saveSettings(); updateStatusMenu(); break;
    case 'dropped': addPaths(dragPaths()); break;
    case 'add':
      try {
        var r = SA.chooseFile({ withPrompt: 'Выбери файлы для Morph', multipleSelectionsAllowed: true });
        addPaths([].concat(r).map(function (x) { return x.toString(); }));
      } catch (e) {}
      break;
    case 'addFolder':
      try {
        var fd = SA.chooseFolder({ withPrompt: 'Выбери папку — Morph возьмёт все файлы из неё' });
        addPaths([fd.toString().replace(/\/+$/, '')]);
      } catch (e) {}
      break;
    case 'chooseOut':
      try {
        var f = SA.chooseFolder({ withPrompt: 'Куда сохранять результаты?' });
        outDir = savedDir = f.toString().replace(/\/+$/, '');
        saveSettings();
      } catch (e) {}
      push();
      break;
    case 'useDir':
      if (savedDir && isDir(savedDir)) { outDir = savedDir; saveSettings(); push(); }
      else handle({ cmd: 'chooseOut' });
      break;
    case 'resetOut': outDir = ''; saveSettings(); push(); break;
    case 'remove':
      items = items.filter(function (it) { return it.id !== m.id || it.status === 'work'; }); push();
      break;
    case 'clear': items = items.filter(function (it) { return it.status === 'work'; }); push(); break;
    case 'start': if (m.settings) settings = Object.assign(settings, m.settings); start(); break;
    case 'stop': stop(); break;
    case 'reveal':
      items.forEach(function (it) { if (it.id === m.id && it.out) reveal([it.out]); });
      break;
    case 'revealAll':
      reveal(items.filter(function (it) { return it.out; }).map(function (it) { return it.out; }));
      break;
    case 'edit':
      items.forEach(function (it) { if (it.id === m.id) openEditor(it); });
      break;
    case 'applyEdit':
      items.forEach(function (it) {
        if (it.id !== m.id || it.status === 'work') return;
        it.trim = m.trim || null; it.crop = m.crop || null;
        it.target = m.target || null;
        it.status = 'wait'; it.info = ''; it.a = it.b = 0; it.out = '';
      });
      editorSignal = null;
      if (m.run) start(); else push();
      break;
    case 'closeEditor': editorSignal = null; push(); break;
    case 'radialDrop': radialDrop(m); break;
    case 'radialCancel': radialHideSoon(0.18); break;
  }
}

// ---------- круговое меню: Shift или ⌥ во время перетаскивания ----------
var SHIFT = 1 << 17, OPTION = 1 << 19;
var watch = { down: false, base: 0, active: false, shown: false, paths: [], n: 0, hideAt: 0 };
var RADIAL = 420;

function primaryKind(paths) {
  var k = null;
  for (var i = 0; i < paths.length; i++) {
    var ki = kindOf(paths[i]);
    if (ki === 'folder') ki = 'other';
    if (k === null) k = ki; else if (k !== ki) return 'mixed';
  }
  return k || 'other';
}
function radialState(open) {
  try { writeFile(WEBDIR + '/radial-state.js', 'window.radial && radial.state(' + JSON.stringify({ n: watch.n, open: open }) + ');'); } catch (e) {}
}
function buildRadial() {
  if (ui.radial) return;
  var p = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, RADIAL, RADIAL), 128, $.NSBackingStoreBuffered, false);
  p.setOpaque(false);
  p.setBackgroundColor($.NSColor.clearColor);
  p.setHasShadow(false);
  p.setLevel(101);                       // над окнами и Dock
  p.setCollectionBehavior(1 | 16 | 256); // все рабочие столы, вне Exposé, поверх полноэкранных
  p.setHidesOnDeactivate(false);
  p.setReleasedWhenClosed(false);
  var cfg = $.WKWebViewConfiguration.alloc.init;
  cfg.userContentController.addScriptMessageHandlerName(ui.ctrl, $('morph'));
  var w = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, RADIAL, RADIAL), cfg);
  try { w.setValueForKey($(false), 'drawsBackground'); } catch (e) {}
  p.setContentView(w);
  ui.radial = p; ui.radialWeb = w;
}
function radialShow(paths, mods) {
  buildRadial();
  watch.shown = true; watch.paths = paths; watch.n++; watch.hideAt = 0;
  var loc = $.NSEvent.mouseLocation;
  var x = loc.x - RADIAL / 2, y = loc.y - RADIAL / 2;
  var scr = $.NSScreen.screens;
  for (var i = 0; i < scr.count; i++) {
    var f = scr.objectAtIndex(i).frame;
    if (loc.x >= f.origin.x && loc.x <= f.origin.x + f.size.width && loc.y >= f.origin.y && loc.y <= f.origin.y + f.size.height) {
      x = Math.max(f.origin.x, Math.min(x, f.origin.x + f.size.width - RADIAL));
      y = Math.max(f.origin.y, Math.min(y, f.origin.y + f.size.height - RADIAL));
    }
  }
  // где курсор внутри панели (если её прижало к краю экрана)
  var cx = Math.round(loc.x - x), cy = Math.round(RADIAL - (loc.y - y));
  ui.radial.setFrameDisplay($.NSMakeRect(x, y, RADIAL, RADIAL), true);
  radialState(true);
  var q = '?k=' + primaryKind(paths) + '&c=' + paths.length + '&m=' + ((mods & OPTION) ? 'option' : 'shift') +
          '&n=' + watch.n + '&x=' + cx + '&y=' + cy;
  var url = $.NSURL.URLWithString($('file://' + encodeURI(WEBDIR + '/radial.html') + q));
  ui.radialWeb.loadFileURLAllowingReadAccessToURL(url, $.NSURL.fileURLWithPath(WEBDIR));
  ui.radial.orderFrontRegardless;
}
function radialHideSoon(sec) {
  radialState(false);
  watch.hideAt = Date.now() + sec * 1000;
}
function radialDrop(m) {
  var paths = watch.paths.length ? watch.paths : dragPaths();
  radialHideSoon(0.42);
  if (!paths.length) return;
  if (m.action === 'open') { addPaths(paths); showWindow(); return; }
  if (m.action === 'edit') {
    var added = addPaths(paths, { fromRadial: true });
    if (added.length) openEditor(added[0]);
    return;
  }
  var extra = { fromRadial: true, notified: false, target: m.target || 'same', mute: m.mute ? true : null, trim: null, crop: null };
  addPaths(paths, extra);
  start();
}
function dragTick() {
  try {
    if (watch.hideAt && Date.now() >= watch.hideAt) {
      watch.hideAt = 0; watch.shown = false; watch.paths = [];
      if (ui.radial) ui.radial.orderOut(null);
    }
    var cc = Number(DPB.changeCount);
    var pressed = (Number($.NSEvent.pressedMouseButtons) & 1) === 1;
    if (!pressed) {
      if (watch.down && watch.shown && !watch.hideAt) radialHideSoon(0.6); // отпустили мимо меню
      watch.down = false; watch.active = false; watch.base = cc;
      return;
    }
    watch.down = true;
    if (!watch.active && cc !== watch.base) watch.active = true;   // началось перетаскивание
    if (!settings.radial || !watch.active || watch.shown) return;
    var mods = Number($.NSEvent.modifierFlags);
    if (mods & (SHIFT | OPTION)) {
      var paths = dragPaths();
      if (paths.length) radialShow(paths, mods);
    }
  } catch (e) { log('dragTick: ' + e.message); }
}

// ---------- строка меню ----------
function updateStatusMenu() {
  if (!ui.menuRadial) return;
  ui.menuRadial.setState(settings.radial ? 1 : 0);
}
function buildStatusItem() {
  if (ui.status) return;
  try {
    var si = $.NSStatusBar.systemStatusBar.statusItemWithLength(-1);
    var img = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription($('arrow.triangle.2.circlepath'), $('Morph'));
    if (img && !img.isNil()) { img.setTemplate(true); si.button.setImage(img); } else si.button.setTitle($('Morph'));
    var menu = $.NSMenu.alloc.init;
    var add = function (title, sel, key) {
      var mi = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($(title), sel, $(key || ''));
      mi.setTarget(ui.ctrl); menu.addItem(mi); return mi;
    };
    add('Открыть Morph', 'showWindow:');
    menu.addItem($.NSMenuItem.separatorItem);
    ui.menuRadial = add('Меню по Shift / ⌥ при перетаскивании', 'toggleRadial:');
    menu.addItem($.NSMenuItem.separatorItem);
    add('Выйти из Morph', 'quitApp:', 'q');
    si.setMenu(menu);
    ui.status = si;
    updateStatusMenu();
  } catch (e) { log('строка меню: ' + e.message); }
}

// ---------- классы ObjC (только void-методы) ----------
var CTRL_METHODS = {
  'userContentController:didReceiveScriptMessage:': {
    types: ['void', ['id', 'id']],
    implementation: function (ucc, msg) {
      try { handle(ObjC.deepUnwrap(msg.body) || {}); }
      catch (e) { log('handle: ' + e.message); toast('Ошибка: ' + e.message); }
    }
  },
  'tick:': { types: ['void', ['id']], implementation: function () { try { tick(); } catch (e) { log('tick: ' + e.message); } } },
  'dragTick:': { types: ['void', ['id']], implementation: function () { dragTick(); } },
  'ciRadial:': { types: ['void', ['id']], implementation: function () {
    try { radialShow([RES + '/ui.html', RES + '/radial.html'], SHIFT); log('radial показано'); } catch (e) { log('ОШИБКА radial: ' + e.message); }
  } },
  'showWindow:': { types: ['void', ['id']], implementation: function () { showWindow(); } },
  'toggleRadial:': { types: ['void', ['id']], implementation: function () {
    settings.radial = !settings.radial; saveSettings(); updateStatusMenu(); lastPushed = ''; push();
  } },
  'quitApp:': { types: ['void', ['id']], implementation: function () {
    try { stop(); } catch (e) {}
    $.NSApplication.sharedApplication.terminate(null);
  } },
  'windowWillClose:': { types: ['void', ['id']], implementation: function () {
    // окно закрыли — Morph остаётся в фоне ради кругового меню (выход — ⌘Q или строка меню)
    log('окно закрыто, работаю в фоне');
  } },
  'appWillTerminate:': { types: ['void', ['id']], implementation: function () {
    log('приложение завершается');
    try { stop(); } catch (e) {}
  } }
};
try {
  ObjC.registerSubclass({ name: 'MorphController', protocols: ['WKScriptMessageHandler'], methods: CTRL_METHODS });
} catch (e) {
  ObjC.registerSubclass({ name: 'MorphController', methods: CTRL_METHODS });
}

// полоса сверху окна: тянуть окно, двойной клик — развернуть
ObjC.registerSubclass({
  name: 'MorphTitleStrip',
  superclass: 'NSView',
  methods: {
    'mouseDown:': { types: ['void', ['id']], implementation: function (ev) {
      try {
        if (Number(ev.clickCount) === 2) ui.window.performZoom(null);
        else ui.window.performWindowDragWithEvent(ev);
      } catch (e) { log('strip: ' + e.message); }
    } }
  }
});

// ---------- окно ----------
function showWindow() {
  if (!ui.window) { buildUI(); return; }
  ui.window.makeKeyAndOrderFront(null);
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
}

function buildUI() {
  if (ui.window) { showWindow(); return; }
  log('запуск, ресурсы: ' + RES);
  TOOLS = tools();
  loadSettings();
  prepareWebDir();
  ui.ctrl = $.MorphController.alloc.init;

  var W = 980, H = 680, TOP = 30;
  var mask = 1 | 2 | 4 | 8 | 32768; // titled, closable, mini, resizable, fullSizeContentView
  var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, W, H), mask, $.NSBackingStoreBuffered, false);
  win.setTitle($('Morph'));
  try {
    win.setTitlebarAppearsTransparent(true);
    win.setTitleVisibility(1);
    win.setAppearance($.NSAppearance.appearanceNamed($('NSAppearanceNameDarkAqua')));
  } catch (e) { log('оформление окна: ' + e.message); }
  win.setMinSize({ width: 860, height: 580 });
  win.setReleasedWhenClosed(false);
  win.setDelegate(ui.ctrl);
  win.setFrameAutosaveName($('MorphMain'));
  ui.window = win;
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(ui.ctrl, 'appWillTerminate:', $('NSApplicationWillTerminateNotification'), $());

  var root = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
  win.setContentView(root);
  try {
    var fx = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    fx.setMaterial(21); fx.setBlendingMode(0); fx.setState(1);
    fx.setAutoresizingMask(18);
    root.addSubview(fx);
  } catch (e) { log('фон окна: ' + e.message); }

  var cfg = $.WKWebViewConfiguration.alloc.init;
  cfg.userContentController.addScriptMessageHandlerName(ui.ctrl, $('morph'));
  var web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, W, H), cfg);
  try { web.setValueForKey($(false), 'drawsBackground'); } catch (e) { log('прозрачность: ' + e.message); }
  web.setAutoresizingMask(18);
  root.addSubview(web);
  ui.web = web;

  var strip = $.MorphTitleStrip.alloc.initWithFrame($.NSMakeRect(78, H - TOP, W - 78, TOP));
  strip.setAutoresizingMask(2 | 8);
  root.addSubview(strip);
  log('окно создано');

  push();
  // доступ на чтение ко всему диску — для предпросмотра видео и картинок в редакторе
  web.loadFileURLAllowingReadAccessToURL($.NSURL.fileURLWithPath(WEBDIR + '/ui.html'), $.NSURL.fileURLWithPath('/'));
  log('интерфейс загружается');

  win.center;
  win.makeKeyAndOrderFront(null);
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);

  buildStatusItem();
  // App Nap замедляет таймеры фоновых приложений — круговое меню появлялось бы с задержкой
  try { ui.activity = $.NSProcessInfo.processInfo.beginActivityWithOptionsReason(0x00EFFFFF, $('Morph следит за перетаскиванием для кругового меню')); }
  catch (e) { log('activity: ' + e.message); }
  ui.dragTimer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.04, ui.ctrl, 'dragTick:', $(), true);
}

// ---------- обработчики апплета ----------
function run() { try { buildUI(); } catch (e) { fatal('запуск', e); } }
function openDocuments(docs) {
  try { buildUI(); addPaths(docs.map(function (d) { return d.toString(); })); showWindow(); }
  catch (e) { fatal('открытие файлов', e); }
}
function reopen() { try { showWindow(); } catch (e) { fatal('окно', e); } }
