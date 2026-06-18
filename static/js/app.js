/**
 * TxtLlmHub — SPA Event Handlers & Orchestration
 * [SPA改造] 新增 switchPage、统一 setProvider/checkLLM
 * Depends on: utils.js, state.js, api.js, render.js
 */

// ── Constants ──
var NL = '\n';
var _exportGroups = null;

// ── SPA 页面切换 ──
var _currentPage = 'translate';
var _tagInited = false;

function switchPage(page) {
  if (page === _currentPage) return;
  _currentPage = page;

  // 显示/隐藏页面容器
  var pt = document.getElementById('page-translate');
  var pp = document.getElementById('page-tag');
  if (pt) pt.style.display = page === 'translate' ? '' : 'none';
  if (pp) pp.style.display = page === 'tag' ? '' : 'none';

  // 显示/隐藏工具栏右侧按钮
  var tr = document.getElementById('translateToolbarRight');
  var tg = document.getElementById('tagToolbarRight');
  if (tr) tr.style.display = page === 'translate' ? '' : 'none';
  if (tg) tg.style.display = page === 'tag' ? '' : 'none';

  // 导航高亮
  var navT = document.getElementById('navTranslate');
  var navG = document.getElementById('navTag');
  if (navT) navT.className = page === 'translate' ? 'nav-link active' : 'nav-link';
  if (navG) navG.className = page === 'tag' ? 'nav-link active' : 'nav-link';

  // 更新 hash（不触发 hashchange）
  if (window.location.hash !== '#' + page) {
    history.pushState(null, '', '#' + page);
  }

  // 分词页懒初始化
  if (page === 'tag' && !_tagInited) {
    _tagInited = true;
    tagInit();
  }

  // 切换时刷新 LLM 状态
  checkLLM();
}

// ── Search Handlers ──
function onPreviewSearch() {
  var q = $('previewSearch').value;
  state.previewQuery = q;
  if (q) {
    var visible = new Set();
    state.lines.forEach(function (l) {
      if (matches(l.original, q) || matches(l.translation, q) || matches(l.new_translation, q)) visible.add(l.index);
    });
    var fresh = new Set();
    state.previewChecked.forEach(function (i) { if (visible.has(i)) fresh.add(i); });
    state.previewChecked = fresh;
  }
  updateSearchUI('previewSearchWrap', 'previewSearchCount', q);
  renderPreview();
}

function clearPreviewSearch() {
  $('previewSearch').value = '';
  onPreviewSearch();
}

function onCompareSearch() {
  var q = $('compareSearch').value;
  state.compareQuery = q;
  if (q) {
    var visible = new Set();
    state.lines.forEach(function (l) {
      if ((l.new_translation || l.error) && (matches(l.original, q) || matches(l.translation, q) || matches(l.new_translation, q) || matches(l.error, q))) {
        visible.add(l.index);
      }
    });
    var fresh = new Set();
    state.compareChecked.forEach(function (i) { if (visible.has(i)) fresh.add(i); });
    state.compareChecked = fresh;
  }
  updateSearchUI('compareSearchWrap', 'compareSearchCount', q);
  renderCompare();
}

function clearCompareSearch() {
  $('compareSearch').value = '';
  onCompareSearch();
}

// ── Single-line Translation ──
async function translateOne(index, e) {
  var line = state.lines[index];
  if (!line || state.translating) return;
  var btn = e.target;
  btn.disabled = true;
  btn.textContent = '...';
  enterTranslatingState();
  await translateOneCore(index);
  exitTranslatingState();
  $('btnExport').disabled = !state.lines.some(function (l) { return l.new_translation; });
}

// ── Batch Translation: Preview-selected ──
async function translatePreviewSelected() {
  if (state.translating) return;
  var indices = getCheckedPreviewIndices();
  if (indices.length === 0) { showToast('请先勾选预览条目'); return; }
  enterTranslatingState();
  var psBtn = document.getElementById('btnTranslatePreviewSel');
  if (psBtn) psBtn.disabled = true;
  clearLog();
  var items = indices.map(function (idx) { return state.lines[idx]; });
  var mode = state.translateMode;
  log('开始批量' + (mode === 'polish' ? '润色' : '翻译') + '勾选条目，共' + items.length + '行，并发' + (parseInt($('concurrency').value) || 3));
  var result = await translateBatchItems(items);
  var wasAborted = result.wasAborted;
  exitTranslatingState();
  $('btnExport').disabled = (items.filter(function (it) { return it.new_translation && !it.error; }).length === 0);
  if (!wasAborted) showToast('翻译完成：成功' + (items.length - result.errors) + '行' + (result.errors ? '，失败' + result.errors + '行' : ''));
}

// ── Batch Translation: All / Retry ──
async function translateAll() {
  var wasTranslating = state.translating;
  if (wasTranslating) {
    state.abort = true;
    log('正在暂停当前任务，为重新翻译全部让路...');
    while (state.translating) { await new Promise(function(r) { setTimeout(r, 50); }); }
    log('当前任务已暂停，开始翻译全部');
  }
  state.abort = false; state.translating = true;
  $('btnTranslateAll').disabled = true;
  $('btnRetryFailed').disabled = true;
  $('btnStop').disabled = false;
  $('btnExport').disabled = true;
  _startRuntime();
  var mode = state.translateMode;
  var isResume = state._resumeMode;
  state._resumeMode = false;
  if (!isResume) {
    var modeChanged = state._lastTranslateMode && state._lastTranslateMode !== mode;
    state._lastTranslateMode = mode;
    if (modeChanged) {
      for (var mi = 0; mi < state.lines.length; mi++) {
        if (!state.lines[mi].error) state.lines[mi].new_translation = '';
      }
    }
    if (!wasTranslating) clearLog();
  }
  var checkedFiles = getCheckedFileNames();
  var pending = state.lines.filter(function (l) {
    if (l.new_translation) return false;
    if (!l._file) return true;
    return checkedFiles.indexOf(l._file) >= 0;
  });
  if (pending.length === 0) { showToast('所有行已翻译'); finish(); return; }
  $('translateHint').style.display = 'none';
  if (wasTranslating && !isResume) clearLog();
  log('开始' + (isResume ? '继续' : '批量') + (mode === 'polish' ? '润色' : '翻译') + '，共' + pending.length + '行，并发' + (parseInt($('concurrency').value) || 5));
  await translateBatchItems(pending);
  var wasAborted = state.abort;
  finish();

  if (wasTranslating && !wasAborted) {
    state._resumeMode = true;
    log('恢复之前的翻译任务...');
    translateAll();
  }
}

async function retryFailed() {
  var failed = state.lines.filter(function (l) { return l.error; });
  if (failed.length === 0) { showToast('没有失败的行'); return; }
  if (state.translating) {
    state.abort = true;
    log('正在停止当前任务，为重试失败行让路...');
    while (state.translating) { await new Promise(function(r) { setTimeout(r, 50); }); }
    log('当前任务已停止，开始重试失败行');
  }
  for (var fi = 0; fi < failed.length; fi++) { failed[fi].error = ''; failed[fi].new_translation = ''; failed[fi].keepOld = false; }
  state.abort = false; state.translating = true;
  $('btnTranslateAll').disabled = true;
  $('btnRetryFailed').disabled = true;
  $('btnStop').disabled = false;
  $('btnExport').disabled = true;
  _startRuntime();
  clearLog();
  log('重试失败行，共' + failed.length + '行，并发' + (parseInt($('concurrency').value) || 3));
  var result = await translateBatchItems(failed);
  var wasAborted = result.wasAborted;
  exitTranslatingState();
  var ok = failed.filter(function (l) { return l.new_translation && !l.error; }).length;
  var err = failed.filter(function (l) { return l.error; }).length;
  $('btnExport').disabled = (ok === 0);
  log('重试结束: 成功' + ok + '行' + (err ? ', 失败' + err + '行' : ''));
  if (!wasAborted) showToast('重试完成：成功' + ok + '行' + (err ? '，失败' + err + '行' : ''));
}

async function retrySelected() {
  var checked = getCheckedRows();
  if (checked.length === 0) { showToast('未选中任何条目'); return; }
  var wasTranslating = state.translating;
  if (wasTranslating) {
    state.abort = true;
    log('正在暂停当前任务，为重译选中条目让路...');
    while (state.translating) { await new Promise(function(r) { setTimeout(r, 50); }); }
    log('当前任务已暂停，开始重译选中条目');
  }
  for (var ci = 0; ci < checked.length; ci++) { checked[ci].error = ''; checked[ci].new_translation = ''; checked[ci].keepOld = false; }
  state.abort = false; state.translating = true;
  $('btnTranslateAll').disabled = true;
  $('btnRetryFailed').disabled = true;
  $('btnStop').disabled = false;
  $('btnExport').disabled = true;
  _startRuntime();
  if (!wasTranslating) clearLog();
  log('重译选中条目，共' + checked.length + '行，并发' + (parseInt($('concurrency').value) || 5));
  var result = await translateBatchItems(checked);
  var wasAborted = result.wasAborted;
  exitTranslatingState();
  var ok = checked.filter(function (l) { return l.new_translation && !l.error; }).length;
  var err = checked.filter(function (l) { return l.error; }).length;
  $('btnExport').disabled = (ok === 0);
  log('重译结束: 成功' + ok + '行' + (err ? ', 失败' + err + '行' : ''));
  if (!wasAborted && !wasTranslating) showToast('重译完成：成功' + ok + '行' + (err ? '，失败' + err + '行' : ''));

  if (wasTranslating && !wasAborted) {
    state._resumeMode = true;
    log('恢复之前的翻译任务...');
    translateAll();
  }
}

function clearAllTranslations() {
  if (state.lines.length === 0) { showToast('没有可清除的条目'); return; }
  var wasTranslating = state.translating;
  var before = state.lines.length;
  state.lines = state.lines.filter(function (l) {
    return !(l.new_translation || l.error || l.keepOld);
  });
  var removed = before - state.lines.length;
  if (removed === 0) { showToast('没有可清除的条目'); return; }
  rebuildIndicesAndCheckboxes();
  state.previewQuery = '';
  state.compareQuery = '';
  $('previewSearch').value = '';
  $('compareSearch').value = '';
  updateSearchUI('previewSearchWrap', 'previewSearchCount', '');
  updateSearchUI('compareSearchWrap', 'compareSearchCount', '');
  clearLog();
  if (wasTranslating) log('任务进行中：清除已翻译条目，进行中的翻译将继续完成');
  renderPreview();
  renderCompare();
  updateRetryButton();
  $('btnExport').disabled = true;
  if (state.lines.length === 0) {
    $('btnTranslateAll').disabled = true;
    $('btnClearAll').disabled = true;
    $('translateHint').style.display = 'block';
    $('fileInfo').innerHTML = '';
    state.fileNames = [];
  }
  log('清除 ' + removed + ' 条（剩余 ' + state.lines.length + ' 条）');
  showToast('已清除 ' + removed + ' 条');
}

function stopTranslate() {
  state.abort = true;
  $('btnStop').disabled = true;
  $('btnStop').textContent = '停止中...';
  showToast('正在停止，当前块完成后将不再发起新请求');
}

function finish() {
  var wasAborted = state.abort;
  exitTranslatingState();
  updateTranslateAllButton();
  var ok = state.lines.filter(function (l) { return l.new_translation && !l.error; }).length;
  var err = state.lines.filter(function (l) { return l.error; }).length;
  updateRetryButton();
  $('btnExport').disabled = (ok === 0);
  log('翻译结束: 成功' + ok + '行' + (err ? ', 失败' + err + '行' : ''));
  if (!wasAborted) showToast('翻译完成：成功' + ok + '行' + (err ? '，失败' + err + '行' : ''));
}

// ── Retry One ──
async function retryOne(index, e) {
  var line = state.lines[index];
  if (!line) return;
  var wasTranslating = state.translating;
  if (wasTranslating) {
    state.abort = true;
    log('正在暂停当前任务，为单行重译让路...');
    while (state.translating) { await new Promise(function(r) { setTimeout(r, 50); }); }
    log('当前任务已暂停，开始单行重译');
  }
  var btn = e.target;
  btn.disabled = true;
  btn.textContent = '...';
  line.keepOld = false;
  line.error = '';
  line.new_translation = '';
  enterTranslatingState();
  await translateOneCore(index);
  exitTranslatingState();
  $('btnExport').disabled = !state.lines.some(function (l) { return l.new_translation; });
  log('[' + (index + 1) + '] 单行重译完成');

  if (wasTranslating) {
    state._resumeMode = true;
    log('恢复之前的翻译任务...');
    translateAll();
  }
}

// ── Copy & Delete Selected ──
function copySelectedRows() {
  var rows = getCheckedRows();
  if (rows.length === 0) {
    var allChecks = document.querySelectorAll('.row-check');
    rows = Array.from(allChecks).map(function (cb) { return state.lines[parseInt(cb.dataset.index)]; }).filter(Boolean);
  }
  if (rows.length === 0) { showToast('无可复制的行'); return; }
  var text = rows.map(function (l) {
    var t = l.new_translation && l.new_translation !== ' ' ? l.new_translation : (l.translation || '');
    return t ? l.original + '=' + t : l.original;
  }).join(NL);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { showToast('已复制 ' + rows.length + ' 行'); });
  } else {
    fallbackCopy(text);
    showToast('已复制 ' + rows.length + ' 行');
  }
}

function deleteSelectedRows() {
  var rows = getCheckedRows();
  if (rows.length === 0) { showToast('请先勾选要删除的条目'); return; }
  var indices = [];
  for (var i = 0; i < rows.length; i++) { indices.push(rows[i].index); }
  indices.sort(function (a, b) { return b - a; });
  for (var di = 0; di < indices.length; di++) {
    state.lines.splice(indices[di], 1);
    state.compareChecked.delete(indices[di]);
    state.previewChecked.delete(indices[di]);
  }
  rebuildIndicesAndCheckboxes();
  state.previewQuery = '';
  state.compareQuery = '';
  $('previewSearch').value = '';
  $('compareSearch').value = '';
  updateSearchUI('previewSearchWrap', 'previewSearchCount', '');
  updateSearchUI('compareSearchWrap', 'compareSearchCount', '');
  clearLog();
  renderPreview();
  renderCompare();
  updateRetryButton();
  $('btnExport').disabled = true;
  if (state.lines.length === 0) {
    $('btnTranslateAll').disabled = true;
    $('btnClearAll').disabled = true;
    $('translateHint').style.display = 'block';
    $('fileInfo').innerHTML = '';
    state.fileNames = [];
  }
  log('删除 ' + indices.length + ' 条（剩余 ' + state.lines.length + ' 条）');
  showToast('已删除 ' + indices.length + ' 条');
}

function copyRow(index) {
  var l = state.lines[index];
  if (!l) return;
  var t = l.new_translation && l.new_translation !== ' ' ? l.new_translation : (l.translation || '');
  var text = t ? l.original + '=' + t : l.original;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () { showToast('已复制'); });
  } else {
    fallbackCopy(text);
    showToast('已复制');
  }
}

// ── Inline Translation Editing ──
function editTranslation(index, evt) {
  if (state.translating) return;
  var line = state.lines[index];
  if (!line || line.error) return;
  evt.stopPropagation();
  var td = evt.currentTarget;
  if (td.querySelector('textarea')) return;
  var orig = line.new_translation;
  td.innerHTML = '<textarea class="inline-edit" data-index="' + index + '" rows="1">' + escHtml(orig) + '</textarea>';
  var ta = td.querySelector('textarea');
  requestAnimationFrame(function () { autoResizeTA(ta); });
  ta.focus();
  ta.select();
  ta.addEventListener('blur', function () { commitEditTA(ta, index); });
  ta.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEditTA(ta, index); }
    if (e.key === 'Escape') { line.new_translation = orig; renderCompare(); }
  });
  ta.addEventListener('input', function () { autoResizeTA(ta); });
}

function commitEditTA(ta, index) {
  var val = ta.value.trim();
  var line = state.lines[index];
  if (line && val) { line.new_translation = val; line.error = ''; log('[' + (index + 1) + '] 手动编辑'); }
  renderCompare();
  renderPreview();
}

function autoResizeTA(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// ── Clear / Keep Translations ──
function clearNewWithoutOld() {
  if (state.translating) return;
  var count = 0;
  for (var i = 0; i < state.lines.length; i++) {
    var l = state.lines[i];
    if (!l.translation && l.new_translation && l.new_translation !== ' ') {
      l.new_translation = ' ';
      l.error = '';
      l.keepOld = false;
      count++;
    }
  }
  if (count === 0) { showToast('没有可清空的词条'); return; }
  renderCompare();
  renderPreview();
  updateRetryButton();
  $('btnExport').disabled = false;
  log('清空 ' + count + ' 条无旧译文的词条');
  showToast('已清空 ' + count + ' 条');
}

function keepOld(index) {
  var line = state.lines[index];
  if (!line) return;
  if (!line.translation) { showToast('无旧译文可保留'); return; }
  line.keepOld = true;
  line.new_translation = line.translation;
  line.error = '';
  log('[' + (index + 1) + '] 保留原译文');
  renderCompare();
  renderPreview();
  updateRetryButton();
  $('btnExport').disabled = false;
}

// ── Click-to-copy Original ──
function copyOriginal(e) {
  e.stopPropagation();
  var text = e.currentTarget.textContent;
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function () {
      showToast('已复制: ' + text.substring(0, 40));
    }).catch(function () {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

// ── Export ──
function exportCheckedRows() {
  var rows = getCheckedRows();
  if (rows.length === 0) { showToast('请先勾选要导出的条目'); return; }
  var groups = new Map();
  for (var i = 0; i < rows.length; i++) {
    var l = rows[i];
    var fname = l._file || (state.fileNames[0] || 'output');
    if (!groups.has(fname)) groups.set(fname, []);
    groups.get(fname).push(l);
  }
  if (groups.size <= 1) {
    doExportSingle(groups);
    return;
  }
  _exportGroups = groups;
  $('exportOptions').classList.add('visible');
}

function exportFile() {
  var rows = getCheckedRows();
  if (rows.length === 0) {
    rows = state.lines;
  }
  if (rows.length === 0) { showToast('没有可导出的译文'); return; }
  var groups = new Map();
  for (var i = 0; i < rows.length; i++) {
    var l = rows[i];
    var fname = l._file || (state.fileNames[0] || 'output');
    if (!groups.has(fname)) groups.set(fname, []);
    groups.get(fname).push(l);
  }
  if (groups.size <= 1) {
    doExportSingle(groups);
    return;
  }
  _exportGroups = groups;
  $('exportOptions').classList.add('visible');
}

function cancelExport() {
  $('exportOptions').classList.remove('visible');
  _exportGroups = null;
}

function doExportSingle(groups) {
  var entry = groups.entries().next().value;
  var fname = entry[0];
  var groupLines = entry[1];
  var content = buildFileContent(groupLines);
  var outName = fname + '.retranslated.txt';
  triggerDownload(outName, content);
  log('导出: ' + outName + ' (' + groupLines.length + '行)');
  showToast('已导出 ' + outName + ' (' + groupLines.length + '行)');
}

function exportSeparate() {
  var groups = _exportGroups;
  if (!groups) return;
  var entries = Array.from(groups.entries());
  var totalLines = 0;
  function downloadNext(i) {
    if (i >= entries.length) {
      log('分别导出: ' + entries.length + ' 个文件, ' + totalLines + '行');
      showToast('已分别导出 ' + entries.length + ' 个文件');
      cancelExport();
      return;
    }
    var fname = entries[i][0];
    var groupLines = entries[i][1];
    var content = buildFileContent(groupLines);
    triggerDownload(fname + '.retranslated.txt', content);
    totalLines += groupLines.length;
    setTimeout(function () { downloadNext(i + 1); }, 250);
  }
  downloadNext(0);
}

function exportGrouped() {
  var groups = _exportGroups;
  if (!groups) return;
  var parts = [];
  var totalLines = 0;
  var entries = Array.from(groups.entries());
  for (var gi = 0; gi < entries.length; gi++) {
    var fname = entries[gi][0];
    var groupLines = entries[gi][1];
    var okCount = groupLines.filter(function (l) { return l.new_translation && !l.error; }).length;
    parts.push('# === ' + fname + ' (' + groupLines.length + '行' + (okCount ? ', 已翻译' + okCount + '行' : '') + ') ===');
    var content = buildFileContent(groupLines);
    parts.push(content);
    parts.push('');
    totalLines += groupLines.length;
  }
  var content = parts.join(NL).trimEnd();
  var outName = (state.fileNames[0] || 'output') + '.retranslated.txt';
  triggerDownload(outName, content);
  log('合并导出: ' + outName + ' (' + groups.size + '个分组, ' + totalLines + '行)');
  showToast('已导出 ' + outName);
  cancelExport();
}

function buildFileContent(groupLines) {
  return groupLines.map(function (l) {
    var t = l.new_translation && l.new_translation !== ' ' ? l.new_translation : (l.translation || '');
    return t ? l.original + '=' + t : l.original;
  }).join(NL);
}

function triggerDownload(filename, fcontent) {
  var blob = new Blob([fcontent], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Grid Resize (Drag Handle) ──
(function () {
  var grid = document.querySelector('.main-grid');
  var hit = document.getElementById('resize-hit');
  if (!grid || !hit) return;
  var MIN_RATIO = 0.18;
  var MAX_RATIO = 0.82;
  var colRatio = 0.5, rowRatio = 0.5;
  var dragging = false;
  var gridRect = null;

  function clamp(v) { return Math.max(MIN_RATIO, Math.min(MAX_RATIO, v)); }

  function apply() {
    grid.style.gridTemplateColumns = colRatio + 'fr ' + (1 - colRatio) + 'fr';
    grid.style.gridTemplateRows = rowRatio + 'fr ' + (1 - rowRatio) + 'fr';
    var gr = grid.getBoundingClientRect();
    var P = 14, G = 14;
    var freeW = gr.width - 2 * P - G, freeH = gr.height - 2 * P - G;
    var gapX = P + colRatio * freeW + G / 2;
    var gapY = P + rowRatio * freeH + G / 2;
    hit.style.left = (gapX + hit.offsetWidth / 2 - 14) + 'px';
    hit.style.top = (gapY + hit.offsetHeight / 2 + 40) + 'px';
  }
  requestAnimationFrame(function () { requestAnimationFrame(apply); });

  function onDown(e) {
    e.preventDefault();
    dragging = true;
    gridRect = grid.getBoundingClientRect();
    hit.classList.add('dragging');
    document.body.style.cursor = 'move';
    document.body.style.userSelect = 'none';
  }

  function onMove(e) {
    if (!dragging) return;
    if (!gridRect) gridRect = grid.getBoundingClientRect();
    var P = 14, G = 14;
    var freeW = gridRect.width - 2 * P - G, freeH = gridRect.height - 2 * P - G;
    colRatio = clamp((e.clientX - gridRect.left - P - G / 2) / freeW);
    rowRatio = clamp((e.clientY - gridRect.top - P - G / 2) / freeH);
    requestAnimationFrame(apply);
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    gridRect = null;
    hit.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  function onDblClick() { colRatio = 0.5; rowRatio = 0.5; apply(); }

  hit.addEventListener('mousedown', onDown);
  hit.addEventListener('dblclick', onDblClick);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  window.addEventListener('resize', apply);
  window.addEventListener('load', function () { requestAnimationFrame(function () { apply(); }); });
})();

// ── Event Listener Setup ──
(function () {
  var dropZone = $('dropZone');
  var fileInput = $('fileInput');

  if (dropZone && fileInput) {
    dropZone.addEventListener('dragover', function (e) { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', function () { dropZone.classList.remove('drag-over'); });
    dropZone.addEventListener('click', function () { fileInput.click(); });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      var files = e.dataTransfer.files;
      if (files && files.length > 0) processFiles(files);
    });
    fileInput.addEventListener('change', function () {
      var files = fileInput.files;
      if (files && files.length > 0) processFiles(files);
    });
  }

  // Deferred init (all modules loaded)
  setTimeout(function () { initPreviewRowLimit(); }, 0);
})();
