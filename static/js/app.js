/**
 * TxtLlmHub — 事件处理与流程编排
 * SPA 页面切换、搜索、翻译控制、导出、网格拖拽、行内编辑
 * Depends on: utils.js, state.js, api.js, render.js
 */


import { $, escHtml, showToast, log, naturalCompare, fallbackCopy } from './utils.js';
import { state, rebuildIndicesAndCheckboxes, PRESET_PROMPTS, 
          updateTranslateAllButton, updateRetryButton, updateExportCheckedButton,
          getLLMParams, getApiConfig } from './state.js';
import { processFiles } from './api.js';
import { renderInternal, getCheckedFileNames, renderPreview, renderCompare, updateSearchUI,
          updateCompareRow, updatePreviewLine, updatePreviewSelectAllVisibility,
          getCheckedPreviewIndices, getCheckedRows, onPreviewCheck,
          updateSelectAllPreview, updateSelectAllCompare } from './render.js';
import { translateOneCore, translateBatchItems,
          enterTranslatingState, exitTranslatingState,
          renderFileList } from './api.js';
// ── Constants ──
var NL = '\n';
var _exportGroups = null;

// ── 页面切换 ──
var _currentPage = 'translate';
var _tagInited = false;
var _dedupInited = false;

function switchPage(page) {
  if (page === _currentPage) return;
  _currentPage = page;

  // 显示/隐藏页面容器
  var pt = document.getElementById('page-translate');
  var pp = document.getElementById('page-tag');
  var pd = document.getElementById('page-dedup');
  if (pt) pt.style.display = page === 'translate' ? '' : 'none';
  if (pp) pp.style.display = page === 'tag' ? '' : 'none';
  if (pd) pd.style.display = page === 'dedup' ? '' : 'none';

  // 显示/隐藏工具栏右侧按钮
  var tr = document.getElementById('translateToolbarRight');
  var tg = document.getElementById('tagToolbarRight');
  if (tr) tr.style.display = page === 'translate' ? '' : 'none';
  if (tg) tg.style.display = page === 'tag' ? '' : 'none';

  // 导航高亮
  var navT = document.getElementById('navTranslate');
  var navG = document.getElementById('navTag');
  var navD = document.getElementById('navDedup');
  if (navT) navT.className = page === 'translate' ? 'nav-link active' : 'nav-link';
  if (navG) navG.className = page === 'tag' ? 'nav-link active' : 'nav-link';
  if (navD) navD.className = page === 'dedup' ? 'nav-link active' : 'nav-link';

  // 更新 hash（不触发 hashchange）
  if (window.location.hash !== '#' + page) {
    history.pushState(null, '', '#' + page);
  }

  // 分词页懒初始化
  if (page === 'tag' && !_tagInited) {
    _tagInited = true;
    tagInit();
  }

  // 去重页懒初始化
  if (page === 'dedup' && !_dedupInited) {
    _dedupInited = true;
    if (typeof dedupInit === 'function') dedupInit();
  }

  // 切换时刷新 LLM 状态
  checkLLM();
}

// ── 搜索 ──
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

// ── 单条翻译 ──
async function translateOne(index, e) {
  var line = state.lines[index];
  if (!line || state.translating) return;
  var btn = e.target;
  btn.disabled = true;
  btn.textContent = '...';
  state.translating = true;
  state.abort = false;
  await translateOneCore(index);
  state.translating = false;
  state.abort = false;
  // 全量刷新对比表和预览（re-render 后旧 btn 引用可能已 stale）
  renderPreview();
  renderCompare();
  $('btnExport').disabled = !state.lines.some(function (l) { return l.new_translation; });
  updateTranslateAllButton();
  updateRetryButton();
}

// ── 批量翻译：勾选条目 ──
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
  log('开始批量' + (mode === 'polish' ? '润色' : '翻译') + '勾选条目，共' + items.length + '行，并发' + (parseInt($('concurrency').value) || 5));
  var result = await translateBatchItems(items);
  var wasAborted = result.wasAborted;
  exitTranslatingState();
  $('btnExport').disabled = (items.filter(function (it) { return it.new_translation && !it.error; }).length === 0);
  if (!wasAborted) showToast('翻译完成：成功' + (items.length - result.errors) + '行' + (result.errors ? '，失败' + result.errors + '行' : ''));
}

// ── 批量翻译：全部/重试 ──
async function translateAll() {
  if (state.translating) return;
  if (state.lines.length === 0) { showToast('没有可翻译的内容'); return; }

  var checkedFiles = getCheckedFileNames();
  var pending = state.lines.filter(function (l) {
    if (l.new_translation || l.error) return false;
    if (!l._file) return true;
    return checkedFiles.indexOf(l._file) >= 0;
  });
  var hasCompleted = state.lines.some(function (l) { return l.new_translation && !l.error; });

  // 所有条目已完成 → 重新翻译全部
  if (pending.length === 0 && hasCompleted) {
    for (var i = 0; i < state.lines.length; i++) {
      var l = state.lines[i];
      l.new_translation = '';
      l.error = '';
      l.keepOld = false;
      l.truncated = false;
      l.warning = '';
      l.degraded = false;
    }
    pending = state.lines.slice();
  }

  if (pending.length === 0) { showToast('所有行已翻译'); return; }

  clearLog();
  enterTranslatingState();
  state.translateStarted = true;
  updateTranslateAllButton();
  $('btnRetryFailed').disabled = true;
  $('btnExport').disabled = true;
  $('translateHint').style.display = 'none';

  var mode = state.translateMode;
  log('开始' + (mode === 'polish' ? '润色' : '翻译') + '，共' + pending.length + '行，并发' + (parseInt($('concurrency').value) || 5));
  var result = await translateBatchItems(pending);

  exitTranslatingState();
  // 全部完成时清除 started 标志
  var stillPending = state.lines.filter(function (l) { return !l.new_translation && !l.error; }).length;
  if (stillPending === 0) state.translateStarted = false;
  updateTranslateAllButton();
  var ok = state.lines.filter(function (l) { return l.new_translation && !l.error; }).length;
  var err = state.lines.filter(function (l) { return l.error; }).length;
  $('btnExport').disabled = (ok === 0);
  log('翻译结束：成功' + ok + '行' + (err ? '，失败' + err + '行' : ''));
  if (!result.wasAborted) {
    showToast('翻译完成：成功' + ok + '行' + (err ? '，失败' + err + '行' : ''));
  } else {
    showToast('翻译已暂停，未完成条目保留');
  }
}

async function retryFailed() {
  var failed = state.lines.filter(function (l) { return l.error; });
  if (failed.length === 0) { showToast('没有失败的行'); return; }
  var wasTranslating = state.translating;
  if (wasTranslating) {
    state.abort = true;
    log('正在停止当前任务，为重试失败行让路...');
    while (state.translating) { await new Promise(function(r) { setTimeout(r, 50); }); }
    log('当前任务已停止，开始重试失败行');
  }
  for (var fi = 0; fi < failed.length; fi++) { failed[fi].error = ''; failed[fi].new_translation = ''; failed[fi].keepOld = false; }
  clearLog();
  enterTranslatingState();
  state.translateStarted = true;
  $('btnRetryFailed').disabled = true;
  $('btnExport').disabled = true;
  log('重试失败行，共' + failed.length + '行，并发' + (parseInt($('concurrency').value) || 5));
  var result = await translateBatchItems(failed);
  var wasAborted = result.wasAborted;
  var stillPending = state.lines.filter(function (l) { return !l.new_translation && !l.error; }).length;
  if (stillPending === 0) state.translateStarted = false;
  exitTranslatingState();
  var ok = failed.filter(function (l) { return l.new_translation && !l.error; }).length;
  var err = failed.filter(function (l) { return l.error; }).length;
  $('btnExport').disabled = (ok === 0);
  log('重试结束: 成功' + ok + '行' + (err ? ', 失败' + err + '行' : ''));
  if (!wasAborted) showToast('重试完成：成功' + ok + '行' + (err ? '，失败' + err + '行' : ''));
  if (wasTranslating && !wasAborted) {
    log('继续未完成的任务...');
    translateAll();
  }
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
  if (!wasTranslating) clearLog();
  enterTranslatingState();
  state.translateStarted = true;
  $('btnRetryFailed').disabled = true;
  $('btnExport').disabled = true;
  log('重译选中条目，共' + checked.length + '行，并发' + (parseInt($('concurrency').value) || 5));
  var result = await translateBatchItems(checked);
  var wasAborted = result.wasAborted;
  var stillPending = state.lines.filter(function (l) { return !l.new_translation && !l.error; }).length;
  if (stillPending === 0) state.translateStarted = false;
  exitTranslatingState();
  var ok = checked.filter(function (l) { return l.new_translation && !l.error; }).length;
  var err = checked.filter(function (l) { return l.error; }).length;
  $('btnExport').disabled = (ok === 0);
  log('重译结束: 成功' + ok + '行' + (err ? ', 失败' + err + '行' : ''));
  if (!wasAborted) showToast('重译完成：成功' + ok + '行' + (err ? '，失败' + err + '行' : ''));
  if (wasTranslating && !wasAborted) {
    log('继续未完成的任务...');
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
  state.translateStarted = false;
  updateTranslateAllButton();
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
  showToast('正在停止，当前块完成后不再发起新请求');
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
  state.translating = true;
  state.abort = false;
  await translateOneCore(index);
  state.translating = false;
  state.abort = false;
  btn.disabled = false;
  btn.textContent = '重译';
  $('btnExport').disabled = !state.lines.some(function (l) { return l.new_translation; });
  updateTranslateAllButton();
  updateRetryButton();
  log('[' + (index + 1) + '] 单行重译完成');
  // 如果之前有任务在跑，重译完后继续
  if (wasTranslating) {
    log('继续未完成的任务...');
    translateAll();
  }
}

// ── 复制/删除选中行 ──
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

// ── 行内编辑 ──
function editTranslation(index, evt) {
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
    if (e.key === 'Escape') { line.new_translation = orig; ta.remove(); renderInternal.compareDirty = false; renderPreview(); renderCompare(); }
  });
  ta.addEventListener('input', function () { autoResizeTA(ta); });
}

function commitEditTA(ta, index) {
  var val = ta.value.trim();
  var line = state.lines[index];
  if (line && val) { line.new_translation = val; line.error = ''; log('[' + (index + 1) + '] 手动编辑'); }
  ta.remove();
  renderInternal.compareDirty = false;
  updateCompareRow(index);
  updatePreviewLine(index);
}

function autoResizeTA(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

// ── 清除/保留译文 ──
function clearNewWithoutOld() {
  var affected = [];
  for (var i = 0; i < state.lines.length; i++) {
    var l = state.lines[i];
    if (!l.translation && l.new_translation && l.new_translation !== ' ') {
      l.new_translation = ' ';
      l.error = '';
      l.keepOld = false;
      affected.push(i);
    }
  }
  if (affected.length === 0) { showToast('没有可清空的词条'); return; }
  renderPreview();
  renderCompare();
  updateRetryButton();
  $('btnExport').disabled = false;
  log('清空 ' + affected.length + ' 条无旧译文的词条');
  showToast('已清空 ' + affected.length + ' 条');
}

function keepOld(index) {
  var line = state.lines[index];
  if (!line) return;
  if (!line.translation) { showToast('无旧译文可保留'); return; }
  line.keepOld = true;
  line.new_translation = line.translation;
  line.error = '';
  log('[' + (index + 1) + '] 保留原译文');
  // 全量刷新以避免 DOM 引用变 stale
  renderPreview();
  renderCompare();
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

// ── 导出 ──
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
  _exportGroups = groups;
  if (groups.size <= 1) {
    // 单文件也显示选择，让用户自行决定
    $('exportOptions').classList.add('visible');
    return;
  }
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
  cancelExport();
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
  // 清理文件名中的特殊字符
  filename = filename.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_');
  var blob = new Blob([fcontent], { type: 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── 网格拖拽调整 ──
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
    var hr = hit.parentElement.getBoundingClientRect();
    var P = 14, G = 14;
    var freeW = gr.width - 2 * P - G, freeH = gr.height - 2 * P - G;
    var gapX = P + colRatio * freeW + G / 2;
    var gapY = P + rowRatio * freeH + G / 2;
    hit.style.left = (gapX + (gr.left - hr.left)) + 'px';
    hit.style.top = (gapY + (gr.top - hr.top)) + 'px';
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

// ── 事件监听初始化 ──
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

  // 延迟初始化（所有模块已加载）
  setTimeout(function () { initPreviewRowLimit(); }, 0);

  // ── Document-level: click-outside-to-close ──
  document.addEventListener('click', function (e) {
    // 导出选项下拉框：点击外部关闭
    var exportOpts = $('exportOptions');
    if (exportOpts && exportOpts.classList.contains('visible')) {
      if (!e.target.closest('#exportOptions') && !e.target.closest('[onclick*="exportFile"]') && !e.target.closest('[onclick*="exportCheckedRows"]')) {
        cancelExport();
      }
    }
  });

  // ── Document-level: Escape 键关闭弹窗 ──
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      // 关闭确认弹窗（showConfirm 已有独立处理，此处仅处理未被 showConfirm 管理的情况）
      var confirm = $('confirmModal');
      if (confirm && confirm.style.display === 'flex' && !window._showConfirmActive) {
        confirm.style.display = 'none';
      }
      // 关闭标签编辑弹窗
      var tagEdit = document.getElementById('tagEditModal');
      if (tagEdit && tagEdit.style.display === 'flex') {
        tagEdit.style.display = 'none';
      }
      // 关闭标签管理弹窗
      var tagAdmin = document.getElementById('tagAdminModal');
      if (tagAdmin && tagAdmin.style.display === 'flex') {
        tagAdmin.style.display = 'none';
      }
      // 关闭导出选项
      var exportOpts = $('exportOptions');
      if (exportOpts && exportOpts.classList.contains('visible')) {
        cancelExport();
      }
    }
  });

  // ── 确认弹窗：点击遮罩关闭 ──
  var confirmModal = $('confirmModal');
  if (confirmModal) {
    confirmModal.addEventListener('click', function (e) {
      if (e.target === confirmModal) {
        confirmModal.style.display = 'none';
      }
    });
  }
})();

// ── Module exports ──
export { switchPage, onPreviewSearch, clearPreviewSearch, onCompareSearch, clearCompareSearch, translateOne, translatePreviewSelected, translateAll, retryFailed, retrySelected, clearAllTranslations, stopTranslate, retryOne, copySelectedRows, deleteSelectedRows, copyRow, editTranslation, commitEditTA, autoResizeTA, clearNewWithoutOld, keepOld, copyOriginal, exportCheckedRows, exportFile, cancelExport, doExportSingle, exportSeparate, exportGrouped, buildFileContent, triggerDownload };

// ── Window bindings (HTML onclick compat) ──
window.switchPage = switchPage;
window.onPreviewSearch = onPreviewSearch;
window.clearPreviewSearch = clearPreviewSearch;
window.onCompareSearch = onCompareSearch;
window.clearCompareSearch = clearCompareSearch;
window.translateOne = translateOne;
window.translatePreviewSelected = translatePreviewSelected;
window.translateAll = translateAll;
window.retryFailed = retryFailed;
window.retrySelected = retrySelected;
window.clearAllTranslations = clearAllTranslations;
window.stopTranslate = stopTranslate;
window.retryOne = retryOne;
window.copySelectedRows = copySelectedRows;
window.deleteSelectedRows = deleteSelectedRows;
window.copyRow = copyRow;
window.editTranslation = editTranslation;
window.commitEditTA = commitEditTA;
window.autoResizeTA = autoResizeTA;
window.clearNewWithoutOld = clearNewWithoutOld;
window.keepOld = keepOld;
window.copyOriginal = copyOriginal;
window.exportCheckedRows = exportCheckedRows;
window.exportFile = exportFile;
window.cancelExport = cancelExport;
window.doExportSingle = doExportSingle;
window.exportSeparate = exportSeparate;
window.exportGrouped = exportGrouped;
window.buildFileContent = buildFileContent;
window.triggerDownload = triggerDownload;
