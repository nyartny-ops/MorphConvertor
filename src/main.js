// Morph — конвертер и компрессор файлов для macOS.
// JavaScript for Automation: osacompile превращает этот файл в .app без Xcode.
// Интерфейс — ui.html в WKWebView, работа — convert.sh.
ObjC.import('Cocoa');
ObjC.import('WebKit');

var RES = $.NSBundle.mainBundle.resourcePath.js;
var ENGINE = RES + '/convert.sh';
var FM = $.NSFileManager.defaultManager;
var defaults = $.NSUserDefaults.standardUserDefaults;
var SA = Application.currentApplication();
SA.includeStandardAdditions = true;

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
var settings = { mode: 'compress', targets: {}, quality: 65, max: 0, mute: false };
var lastPushed = '';

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
function rm(p) { if (exists(p)) FM.removeItemAtPathError(p, null); }
function shortPath(p) { var h = $.NSHomeDirectory().js; return p.indexOf(h) === 0 ? '~' + p.slice(h.length) : p; }
function tools() {
  var ff = [RES + '/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].some(isExec);
  var lo = ['/Applications/LibreOffice.app/Contents/MacOS/soffice', $.NSHomeDirectory().js + '/Applications/LibreOffice.app/Contents/MacOS/soffice'].some(isExec);
  return { ffmpeg: ff, lo: lo };
}
var TOOLS = null;

// ---------- связь с интерфейсом ----------
// Приложение → окно: без evaluateJavaScript (его completion-блок через мост JXA роняет WebKit).
// Пишем состояние в state.js рядом с ui.html, окно само подхватывает его несколько раз в секунду.
var WEBDIR = $.NSHomeDirectory().js + '/Library/Application Support/Morph/web';
var LS_RE = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');
var seq = 0, dragOn = false, toastMsg = null, toastId = 0;

function writeFile(path, text) {
  $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}
function prepareWebDir() {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(WEBDIR, true, $(), null);
  rm(WEBDIR + '/ui.html');
  FM.copyItemAtPathToPathError(RES + '/ui.html', WEBDIR + '/ui.html', null);
}
function toast(text) { toastMsg = text; toastId++; push(); }
function push() {
  var st = {
    items: items.map(function (it) {
      return { id: it.id, name: it.name, kind: it.kind, size: it.size, status: it.status, info: it.info || '',
        a: it.a || 0, b: it.b || 0, outName: it.out ? basename(it.out) : '', progress: it.progress == null ? -1 : it.progress };
    }),
    outDir: outDir, savedDir: savedDir, savedDirShort: savedDir ? shortPath(savedDir) : '',
    running: !!current, tools: TOOLS || tools(), settings: settings,
    drag: dragOn, toast: toastMsg ? { id: toastId, text: toastMsg } : null
  };
  var json = JSON.stringify(st).replace(LS_RE, ' ');
  if (json === lastPushed) return;
  lastPushed = json;
  seq++;
  try { writeFile(WEBDIR + '/state.js', 'window.morph && morph.state(' + json.replace(/^\{/, '{"seq":' + seq + ',') + ');'); }
  catch (e) { log('state: ' + e.message); }
}
function setDrag(on) { dragOn = on; push(); }

function addPaths(paths) {
  var known = {};
  items.forEach(function (it) { known[it.path] = 1; });
  paths.forEach(function (p) {
    var list = isDir(p) ? listFiles(p) : [p];
    list.forEach(function (f) {
      if (known[f]) return;
      known[f] = 1;
      items.push({ id: nextId++, path: f, name: basename(f), kind: kindOf(f), size: fileSize(f), status: 'wait' });
    });
  });
  push();
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

// ---------- очередь ----------
function targetFor(it) {
  if (settings.mode !== 'convert') return 'same';
  return (settings.targets && settings.targets[it.kind]) || (it.kind === 'other' || it.kind === 'folder' ? 'zip' : 'same');
}

function start() {
  if (current) return;
  if (!items.some(function (it) { return it.status === 'wait'; })) {
    items.forEach(function (it) { it.status = 'wait'; it.info = ''; it.a = it.b = 0; it.out = ''; it.progress = null; });
  }
  queue = [];
  items.forEach(function (it) { if (it.status === 'wait') queue.push(it); });
  saveSettings();
  if (!timer) timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.25, ui.ctrl, 'tick:', $(), true);
  next();
}

function next() {
  if (!queue.length) {
    current = null;
    if (timer) { timer.invalidate; timer = null; }
    push();
    try { $.NSSound.soundNamed('Glass').play; } catch (e) {}
    return;
  }
  var it = queue.shift();
  if (items.indexOf(it) < 0) { next(); return; }
  it.status = 'work'; it.info = ''; it.progress = null;
  var prog = $.NSTemporaryDirectory().js + 'morph_progress_' + it.id;
  rm(prog); rm(prog + '.dur');
  var t = $.NSTask.alloc.init;
  t.setLaunchPath($('/bin/bash'));
  t.setArguments($([ENGINE, it.path, targetFor(it), String(settings.quality), String(settings.max || 0), settings.mute ? '1' : '0', outDir]));
  var env = $.NSProcessInfo.processInfo.environment.mutableCopy;
  env.setObjectForKey($(prog), 'MORPH_PROGRESS');
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

function reveal(paths) {
  var urls = paths.filter(exists).map(function (p) { return $.NSURL.fileURLWithPath(p); });
  if (urls.length) $.NSWorkspace.sharedWorkspace.activateFileViewerSelectingURLs($(urls));
}

function handle(m) {
  switch (m.cmd) {
    case 'log': log('ui: ' + m.text); break;
    case 'ready': log('интерфейс готов'); try { ui.web.unregisterDraggedTypes; } catch (e) {} TOOLS = tools(); lastPushed = ''; push(); break;
    case 'settings': settings = Object.assign(settings, m.settings || {}); saveSettings(); break;
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
      if (!current) { items = items.filter(function (it) { return it.id !== m.id; }); push(); }
      break;
    case 'clear': if (!current) { items = []; push(); } break;
    case 'start': if (m.settings) settings = Object.assign(settings, m.settings); start(); break;
    case 'stop': stop(); break;
    case 'reveal':
      items.forEach(function (it) { if (it.id === m.id && it.out) reveal([it.out]); });
      break;
    case 'revealAll':
      reveal(items.filter(function (it) { return it.out; }).map(function (it) { return it.out; }));
      break;
  }
}

// ---------- журнал ошибок: ~/Library/Logs/Morph.log ----------
var LOG = $.NSHomeDirectory().js + '/Library/Logs/Morph.log';
var IN_CI = (function () {
  try { var v = $.NSProcessInfo.processInfo.environment.objectForKey('MORPH_CI'); return !!(v && !v.isNil()); } catch (e) { return false; }
})();
function log(msg) {
  var line = new Date().toISOString() + '  ' + msg;
  if (IN_CI) { try { console.log(line); } catch (e) {} }
  try {
    FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(LOG.replace(/\/[^\/]*$/, ''), true, $(), null);
    var prev = readText(LOG);
    if (prev.length > 200000) prev = prev.slice(-100000);
    $(prev + line + '\n').writeToFileAtomicallyEncodingError(LOG, true, $.NSUTF8StringEncoding, null);
  } catch (e) { if (IN_CI) { try { console.log('LOG FAIL: ' + e); } catch (e2) {} } }
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

// ---------- классы ObjC ----------
var CTRL_METHODS = {
  'userContentController:didReceiveScriptMessage:': {
    types: ['void', ['id', 'id']],
    implementation: function (ucc, msg) {
      try { handle(ObjC.deepUnwrap(msg.body) || {}); }
      catch (e) { log('handle: ' + e.message); toast('Ошибка: ' + e.message); }
    }
  },
  'tick:': { types: ['void', ['id']], implementation: function () { try { tick(); } catch (e) { log('tick: ' + e.message); } } },
  'windowWillClose:': { types: ['void', ['id']], implementation: function () {
    try { stop(); } catch (e) {}
    $.NSApplication.sharedApplication.terminate(null);
  } },
  'appWillTerminate:': { types: ['void', ['id']], implementation: function () {
    log('приложение завершается (WillTerminate)');
    try { stop(); } catch (e) {}
  } },
  'webTerminated:': { types: ['void', ['id']], implementation: function () {} }
};
try {
  ObjC.registerSubclass({ name: 'MorphController', protocols: ['WKScriptMessageHandler'], methods: CTRL_METHODS });
} catch (e) {
  log('protocols недоступны, регистрирую без них: ' + e.message);
  ObjC.registerSubclass({ name: 'MorphController', methods: CTRL_METHODS });
}

function dropped(sender) {
  var urls = sender.draggingPasteboard.readObjectsForClassesOptions($([$.NSURL]), $({}));
  var res = [];
  if (urls && !urls.isNil()) for (var i = 0; i < urls.count; i++) {
    var u = urls.objectAtIndex(i);
    if (u.isFileURL) res.push(u.path.js);
  }
  return res;
}

// контейнер окна принимает перетаскивание файлов (веб-виду приём отключаем).
// Типы методов должны совпасть с NSView, а они зависят от архитектуры:
// BOOL — 'bool' на Apple Silicon и 'char' на Intel, NSDragOperation — NSUInteger.
function dropMethods(T) {
  return {
    'draggingEntered:': { types: [T.op, ['id']], implementation: function () { setDrag(true); return 1; } },
    'draggingUpdated:': { types: [T.op, ['id']], implementation: function () { return 1; } },
    'draggingExited:': { types: ['void', ['id']], implementation: function () { setDrag(false); } },
    'prepareForDragOperation:': { types: [T.b, ['id']], implementation: function () { return T.yes; } },
    'performDragOperation:': { types: [T.b, ['id']], implementation: function (sender) {
      setDrag(false);
      var ok = false;
      try { var r = dropped(sender); addPaths(r); ok = r.length > 0; }
      catch (e) { log('drop: ' + e.message); }
      return ok ? T.yes : T.no;
    } }
  };
}
var DROP_CLASS = 'MorphDropView';
(function registerDropView() {
  var variants = [
    { op: 'unsigned long', b: 'bool', yes: true, no: false },
    { op: 'unsigned long long', b: 'bool', yes: true, no: false },
    { op: 'unsigned long', b: 'char', yes: 1, no: 0 },
    { op: 'unsigned long long', b: 'char', yes: 1, no: 0 }
  ];
  var errs = [];
  for (var k = 0; k < variants.length; k++) {
    try {
      ObjC.registerSubclass({ name: 'MorphDropView' + k, superclass: 'NSView', methods: dropMethods(variants[k]) });
      DROP_CLASS = 'MorphDropView' + k;
      return;
    } catch (e) { errs.push(e.message); }
  }
  // запасной вариант — без перетаскивания в окно (файлы можно кидать на иконку и через «Файлы»)
  log('перетаскивание недоступно: ' + errs.join(' / '));
  DROP_CLASS = 'NSView';
})();

// ---------- окно ----------
function buildUI() {
  if (ui.window) { ui.window.makeKeyAndOrderFront(null); return; }
  log('запуск, ресурсы: ' + RES);
  TOOLS = tools();
  loadSettings();
  ui.ctrl = $.MorphController.alloc.init;

  var W = 980, H = 680;
  var mask = 1 | 2 | 4 | 8 | 32768; // titled, closable, mini, resizable, fullSizeContentView
  var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, W, H), mask, $.NSBackingStoreBuffered, false);
  win.setTitle($('Morph'));
  try {
    win.setTitlebarAppearsTransparent(true);
    win.setTitleVisibility(1);
    win.setAppearance($.NSAppearance.appearanceNamed($('NSAppearanceNameDarkAqua')));
  } catch (e) { log('оформление окна: ' + e.message); }
  win.setMovableByWindowBackground(true);
  win.setMinSize({ width: 820, height: 560 });
  win.setReleasedWhenClosed(false);
  win.setDelegate(ui.ctrl);
  ui.window = win;
  $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(ui.ctrl, 'appWillTerminate:', $('NSApplicationWillTerminateNotification'), $());

  var root = $[DROP_CLASS].alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
  log('класс окна: ' + DROP_CLASS);
  root.registerForDraggedTypes($(['public.file-url', 'NSFilenamesPboardType']));
  win.setContentView(root);

  try {
    var fx = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
    fx.setMaterial(21); fx.setBlendingMode(0); fx.setState(1);
    fx.setAutoresizingMask(18);
    root.addSubview(fx);
  } catch (e) { log('фон окна: ' + e.message); }
  log('окно создано');

  var cfg = $.WKWebViewConfiguration.alloc.init;
  cfg.userContentController.addScriptMessageHandlerName(ui.ctrl, $('morph'));
  var web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, W, H), cfg);
  try { web.setValueForKey($(false), 'drawsBackground'); } catch (e) { log('прозрачность: ' + e.message); }
  web.setAutoresizingMask(18);
  web.unregisterDraggedTypes;
  root.addSubview(web);
  ui.web = web;
  log('веб-вид создан');

  // полоска сверху — за неё можно таскать окно
  var strip = $.NSView.alloc.initWithFrame($.NSMakeRect(0, H - 28, W, 28));
  strip.setAutoresizingMask(2 | 8);
  root.addSubview(strip);

  prepareWebDir();
  push();
  web.loadFileURLAllowingReadAccessToURL($.NSURL.fileURLWithPath(WEBDIR + '/ui.html'), $.NSURL.fileURLWithPath(WEBDIR));
  log('интерфейс загружается');

  win.center;
  win.makeKeyAndOrderFront(null);
  $.NSApplication.sharedApplication.activateIgnoringOtherApps(true);
}

// ---------- обработчики апплета ----------
function run() { try { buildUI(); } catch (e) { fatal('запуск', e); } }
function openDocuments(docs) {
  try { buildUI(); addPaths(docs.map(function (d) { return d.toString(); })); }
  catch (e) { fatal('открытие файлов', e); }
}
function reopen() { log('reopen'); try { buildUI(); } catch (e) { fatal('окно', e); } }

