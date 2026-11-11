// Morph — PDF-помощник на PDFKit (JavaScript for Automation, встроен в macOS).
// osascript -l JavaScript pdftool.js <compress|pages|text|doc2pdf> <in> <out> <quality> [jpg|png]
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('Quartz');

function fileURL(p) { return $.NSURL.fileURLWithPath(p); }

function openPDF(p) {
  var d = $.PDFDocument.alloc.initWithURL(fileURL(p));
  if (!d || d.isNil()) throw new Error('не открывается PDF');
  return d;
}

function jpegData(nsimage, q) {
  var rep = $.NSBitmapImageRep.imageRepWithData(nsimage.TIFFRepresentation);
  return rep.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG,
    $.NSDictionary.dictionaryWithObjectForKey($(q), 'NSImageCompressionFactor'));
}

function pageImage(page, dpi) {
  var b = page.boundsForBox($.kPDFDisplayBoxMediaBox);
  var w = b.size.width, h = b.size.height;
  var rot = page.rotation;
  if (rot === 90 || rot === 270) { var t = w; w = h; h = t; }
  var s = dpi / 72;
  return { img: page.thumbnailOfSizeForBox({ width: Math.round(w * s), height: Math.round(h * s) }, $.kPDFDisplayBoxMediaBox), w: w, h: h };
}

// 1) системный фильтр «Уменьшить размер файла» (как в Просмотре)
function compressQuartz(doc, out) {
  var path = '/System/Library/Filters/Reduce File Size.qfilter';
  if (!$.NSFileManager.defaultManager.fileExistsAtPath(path)) return false;
  var f = $.QuartzFilter.quartzFilterWithURL(fileURL(path));
  if (!f || f.isNil()) return false;
  return doc.writeToURLWithOptions(fileURL(out), $.NSDictionary.dictionaryWithObjectForKey(f, 'QuartzFilter'));
}

// 2) растеризация страниц в JPEG — сильное сжатие для сканов
function compressRaster(doc, out, q) {
  var dpi = 60 + q;                       // 70..160 dpi
  var jq = Math.min(0.92, q / 100 + 0.1);
  var nd = $.PDFDocument.alloc.init;
  var n = doc.pageCount;
  for (var i = 0; i < n; i++) {
    var r = pageImage(doc.pageAtIndex(i), dpi);
    var img = $.NSImage.alloc.initWithData(jpegData(r.img, jq));
    img.setSize({ width: r.w, height: r.h });
    var p = null;
    try {
      p = $.PDFPage.alloc.initWithImageOptions(img, $.NSDictionary.dictionaryWithObjectsForKeys(
        $([$(jq), $(true)]),
        $([$.PDFPageImageInitializationOptionCompressionQuality, $.PDFPageImageInitializationOptionUpscaleIfSmaller])));
    } catch (e) { p = null; }
    if (!p || p.isNil()) p = $.PDFPage.alloc.initWithImage(img);
    nd.insertPageAtIndex(p, nd.pageCount);
  }
  return nd.writeToFile(out);
}

function fsize(p) {
  var a = $.NSFileManager.defaultManager.attributesOfItemAtPathError(p, null);
  return (a && !a.isNil()) ? Number(a.fileSize) : 0;
}

function run(argv) {
  var mode = argv[0], inp = argv[1], out = argv[2], q = parseInt(argv[3] || '70', 10), fmt = argv[4] || 'png';
  var fm = $.NSFileManager.defaultManager;

  if (mode === 'compress') {
    var doc = openPDF(inp);
    var tmpA = out + '.a.pdf', tmpB = out + '.b.pdf';
    var cands = [];
    if (q >= 40) { try { if (compressQuartz(doc, tmpA)) cands.push(tmpA); } catch (e) {} }
    if (q < 85) { try { if (compressRaster(doc, tmpB, q)) cands.push(tmpB); } catch (e) {} }
    if (cands.length === 0) throw new Error('не удалось сжать');
    // при высоком качестве предпочитаем вариант с живым текстом
    var best = cands[0];
    if (cands.length > 1 && q < 60 && fsize(cands[1]) < fsize(cands[0])) best = cands[1];
    if (cands.length > 1 && q >= 60 && fsize(cands[0]) > fsize(inp) && fsize(cands[1]) < fsize(inp)) best = cands[1];
    fm.moveItemAtPathToPathError(best, out, null);
    cands.forEach(function (c) { if (c !== best) fm.removeItemAtPathError(c, null); });
    return 'ok';
  }

  if (mode === 'pages') {
    var d = openPDF(inp);
    var dpi = q >= 80 ? 200 : (q >= 50 ? 150 : 110);
    var cnt = d.pageCount;
    var pad = String(cnt).length;
    for (var i = 0; i < cnt; i++) {
      var r = pageImage(d.pageAtIndex(i), dpi);
      var num = String(i + 1); while (num.length < pad) num = '0' + num;
      var data;
      if (fmt === 'jpg') data = jpegData(r.img, Math.min(0.95, q / 100));
      else data = $.NSBitmapImageRep.imageRepWithData(r.img.TIFFRepresentation).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      data.writeToFileAtomically(out + '/стр ' + num + '.' + fmt, true);
    }
    return 'ok';
  }

  if (mode === 'text') {
    var t = openPDF(inp).string;
    var s = (t && !t.isNil()) ? t : $('');
    s.writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, null);
    return 'ok';
  }

  if (mode === 'doc2pdf') {
    var attr = $.NSAttributedString.alloc.initWithURLOptionsDocumentAttributesError(fileURL(inp), $({}), null, null);
    if (!attr || attr.isNil()) throw new Error('не читается документ');
    var pageW = 595, pageH = 842, m = 50;
    var tv = $.NSTextView.alloc.initWithFrame($.NSMakeRect(0, 0, pageW - 2 * m, pageH));
    tv.textStorage.setAttributedString(attr);
    tv.setVerticallyResizable(true);
    tv.sizeToFit;
    var info = $.NSPrintInfo.sharedPrintInfo.copy;
    info.setPaperSize({ width: pageW, height: pageH });
    info.setTopMargin(m); info.setBottomMargin(m); info.setLeftMargin(m); info.setRightMargin(m);
    info.setHorizontalPagination($.NSPrintingPaginationModeFit !== undefined ? $.NSPrintingPaginationModeFit : 0);
    info.setVerticallyCentered(false);
    info.setJobDisposition($.NSPrintSaveJob);
    info.dictionary.setObjectForKey(fileURL(out), $.NSPrintJobSavingURL);
    var op = $.NSPrintOperation.printOperationWithViewPrintInfo(tv, info);
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    if (!op.runOperation) throw new Error('печать в PDF не удалась');
    return 'ok';
  }
  throw new Error('неизвестный режим');
}
