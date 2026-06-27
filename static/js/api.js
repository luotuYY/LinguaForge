/**
 * LinguaForge — API 层
 * 文件上传解析、手动输入、LLM 翻译调用、批量流式翻译、文件管理
 * Depends on: utils.js, state.js, render.js
 */


import { $, escHtml, showToast, log, clearLog } from './utils.js';
import { state, rebuildIndicesAndCheckboxes, updateTranslateAllButton, updateManualBtn, updateRetryButton, getLLMParams, getApiConfig } from './state.js';
import { renderPreview, renderCompare, updateSearchUI, updateCompareRow, updatePreviewLine, setBatchUpdating, updatePreviewSelectAllVisibility, updateSelectAllPreview } from './render.js';
// ── 文件上传 ──
async function processFiles(files) {
  var txtFiles = Array.from(files).filter(function (f) { return f.name.endsWith('.txt'); });
  if (txtFiles.length === 0) { showToast('请选择 .txt 文件'); return; }
  var form = new FormData();
  for (var i = 0; i < txtFiles.length; i++) { form.append('file', txtFiles[i]); }
  try {
    var r = await fetch('/api/upload', { method: 'POST', body: form });
    if (!r.ok) { showToast('文件解析失败'); return; }
    var d = await r.json();
    var hasExisting = state.lines.length > 0;

    if (hasExisting) {
      // 追加模式：已有内容，新文件追加到末尾（同名跳过）
      var offset = state.lines.length;
      var addedFiles = 0, addedLines = 0;
      var newFileNames = d.files || [];
      var skippedNames = [];
      // 按文件分组新行
      var linesByFile = {};
      for (var li = 0; li < d.lines.length; li++) {
        var lf = d.lines[li].file || '';
        if (!linesByFile[lf]) linesByFile[lf] = [];
        linesByFile[lf].push(d.lines[li]);
      }
      for (var fi = 0; fi < newFileNames.length; fi++) {
        var fname = newFileNames[fi];
        if (state.fileNames.indexOf(fname) !== -1) {
          skippedNames.push(fname);
          continue;
        }
        state.fileNames.push(fname);
        state.files.push({ name: fname, checked: true });
        var fileLines = linesByFile[fname] || [];
        for (var fli = 0; fli < fileLines.length; fli++) {
          var obj = {};
          for (var k in fileLines[fli]) { obj[k] = fileLines[fli][k]; }
          obj.index = offset++;
          state.lines.push(obj);
          addedLines++;
        }
        addedFiles++;
      }
      if (skippedNames.length > 0) {
        log('跳过重复文件：' + skippedNames.join('、'), '', true);
      }
      log('追加 ' + addedFiles + ' 个文件 · +' + addedLines + ' 行（共 ' + state.lines.length + ' 行）', '', true);
    } else {
      // 首次加载：替换全部
      state.lines = d.lines.map(function (l, i) { var obj = {}; for (var k in l) { obj[k] = l[k]; } obj.index = i; return obj; });
      state.fileNames = d.files || [];
      state.files = (d.files || []).map(function (f) { return { name: f, checked: true }; });
      state.abort = false;
      state.translating = false;
      state.previewChecked.clear();
      state.previewQuery = '';
      state.compareQuery = '';
      $('previewSearch').value = '';
      $('compareSearch').value = '';
      updateSearchUI('previewSearchWrap', 'previewSearchCount', '');
      updateSearchUI('compareSearchWrap', 'compareSearchCount', '');
      clearLog();
      log('加载 ' + d.files.length + ' 个文件 · ' + d.count + ' 行', '', true);
    }

    renderFileList();
    state.translateStarted = false;
    state.previewPage = 1;
    state.comparePage = 1;
    updateTranslateAllButton();
    $('btnRetryFailed').disabled = true;
    $('btnExport').disabled = true;
    $('btnClearAll').disabled = false;
    renderPreview();
    renderCompare();
    updateManualBtn();
    $('translateHint').style.display = 'none';
    var toastMsg;
    if (hasExisting) {
      toastMsg = addedFiles > 0
        ? '已追加 ' + addedFiles + ' 个文件 · +' + addedLines + ' 行（共 ' + state.lines.length + ' 行）'
        : '所有文件已存在，未添加新内容';
    } else {
      toastMsg = '已加载 ' + d.files.length + ' 个文件 · ' + d.count + ' 行';
    }
    showToast(toastMsg);
  } catch (e) {
    showToast('上传失败: ' + e.message);
  }
}

// ── 手动输入 ──
async function loadManualInput() {
  var raw = $('manualInput').value.trim();
  if (!raw) { showToast('输入内容为空'); return; }
  try {
    var r = await fetch('/api/manual-input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: raw })
    });
    if (!r.ok) { showToast('解析失败'); return; }
    var d = await r.json();
    var hasExisting = state.lines.length > 0;
    if (hasExisting) {
      var offset = state.lines.length;
      var newLines = d.lines.map(function (l, i) {
        var obj = {};
        for (var k in l) { obj[k] = l[k]; }
        obj.new_translation = '';
        obj.file = '手动录入';
        obj.index = offset + i;
        return obj;
      });
      state.lines = state.lines.concat(newLines);
      if (state.fileNames.indexOf('手动录入') === -1) { state.fileNames.push('手动录入'); state.files.push({ name: '手动录入', checked: true }); }
      clearLog();
      renderFileList();
      $('btnClearAll').disabled = false;
      updateTranslateAllButton();
      renderPreview(); renderCompare();
      log('手动添加 ' + d.count + ' 行（共 ' + state.lines.length + ' 行）', '', true);
      showToast('已添加 ' + d.count + ' 行（共 ' + state.lines.length + ' 行）');
    } else {
      state.lines = d.lines.map(function (l, i) {
        var obj = {};
        for (var k in l) { obj[k] = l[k]; }
        obj.file = '手动录入';
        obj.index = i;
        return obj;
      });
      state.fileNames = ['手动录入'];
      state.files = [{ name: '手动录入', checked: true }];
      state.abort = false;
      state.translating = false;
      state.translateStarted = false;
    state.previewPage = 1;
    state.comparePage = 1;
      state.previewChecked.clear();
      state.previewQuery = '';
      state.compareQuery = '';
      $('previewSearch').value = '';
      $('compareSearch').value = '';
      updateSearchUI('previewSearchWrap', 'previewSearchCount', '');
      updateSearchUI('compareSearchWrap', 'compareSearchCount', '');
      clearLog();
      renderFileList();
      $('btnRetryFailed').disabled = true;
      $('btnExport').disabled = true;
      $('btnClearAll').disabled = false;
      updateTranslateAllButton();
      renderPreview(); renderCompare();
      $('translateHint').style.display = 'none';
      log('手动录入 ' + d.count + ' 行', '', true);
      showToast('已加载 ' + d.count + ' 行');
    }
    $('manualInput').value = '';
    updateManualBtn();
  } catch (e) {
    showToast('加载失败: ' + e.message);
  }
}

// ── 单条翻译 ──
async function translateOneCore(index) {
  var line = state.lines[index];
  if (!line) return;
  var mode = state.translateMode;
  var effectiveMode = (mode === 'polish' && (!line.translation || !line.translation.trim())) ? 'direct' : mode;
  log('[' + (line.index + 1) + '] ' + (effectiveMode === 'polish' ? '润色' : '翻译') + ' "' + line.original.substring(0, 30) + '..."');
  try {
    var params = getLLMParams();
    var apiConfig = getApiConfig();
    var url = effectiveMode === 'polish' ? '/api/translate-polish' : '/api/translate';
    var baseObj = effectiveMode === 'polish'
      ? { text: line.original, old_translation: line.translation || '' }
      : { text: line.original };
    var bodyObj = Object.assign(baseObj, params, apiConfig);
    var r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyObj) });
    var d = await r.json();
    if (r.ok) {
      line.new_translation = d.translation;
      line.error = '';
      line.truncated = !!d.truncated;
      line.warning = d.warning || '';
      line.degraded = !!d.degraded;
      var extra = line.truncated ? ' ⚠️截断' : (line.warning ? ' ⚠️' : (line.degraded ? ' ↓降级' : ''));
      log('[' + (line.index + 1) + '] → ' + d.translation.substring(0, 40) + extra, 'ok');
    } else {
      line.error = d.error || '未知错误';
      log('[' + (line.index + 1) + '] 错误: ' + line.error, 'err');
    }
  } catch (e) {
    line.error = e.message;
    log('[' + (line.index + 1) + '] 错误: ' + e.message, 'err');
  }
  updateCompareRow(index);
  updatePreviewLine(index);
}

// ── 翻译状态控制 ──
// ── Task Runtime Timer ──
var _taskStartTime = 0;
var _runtimeTimer = 0;

function _startRuntime() {
  _taskStartTime = Date.now();
  var rd = $('runtimeDisplay');
  rd.textContent = '00:00';
  rd.style.display = 'inline';
  _runtimeTimer = setInterval(function () {
    var elapsed = Math.floor((Date.now() - _taskStartTime) / 1000);
    var m = Math.floor(elapsed / 60);
    var s = elapsed % 60;
    rd.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }, 500);
}

function _stopRuntime() {
  clearInterval(_runtimeTimer);
  _runtimeTimer = 0;
  _taskStartTime = 0;
  $('runtimeDisplay').style.display = 'none';
}

function enterTranslatingState() {
  state.translating = true;
  state.abort = false;
  $('btnTranslateAll').disabled = true;
  $('btnStop').disabled = false;
  updatePreviewSelectAllVisibility();
  updateSelectAllPreview();
  _startRuntime();
}

function exitTranslatingState() {
  state.translating = false;
  state.abort = false;
  _stopRuntime();
  updateTranslateAllButton();
  $('btnClearAll').disabled = (state.lines.length === 0);
  $('btnStop').disabled = true;
  $('btnStop').textContent = '停止';
  updateRetryButton();
  updatePreviewSelectAllVisibility();
}

// ── 活跃请求控制器集（供 stopTranslate 取消所有进行中的请求） ──
var _activeBatchControllers = null;

function abortActiveRequests() {
  if (_activeBatchControllers) {
    _activeBatchControllers.forEach(function (ctrl) { ctrl.abort(); });
    _activeBatchControllers.clear();
    _activeBatchControllers = null;
  }
}

// ── 批量翻译（滑动窗口并发池：每个条目独立请求，即时可停止） ──
async function translateBatchItems(items) {
  var total = items.length;
  var concurrency = parseInt($('concurrency').value) || 5;
  var params = getLLMParams();
  var apiConfig = getApiConfig();
  var mode = state.translateMode;
  var url = mode === 'polish' ? '/api/translate-polish' : '/api/translate';

  setBatchUpdating(true);
  var done = 0, errors = 0;
  var activeControllers = new Set();
  _activeBatchControllers = activeControllers;
  var pending = items.slice();

  $('progressFill').style.width = '0%';
  $('progressText').textContent = '进度: 0/' + total + ' · 并发' + concurrency;
  log('开始' + (mode === 'polish' ? '润色' : '翻译') + '，共 ' + total + ' 行，并发 ' + concurrency + '（即时可停止）');

  await new Promise(function (resolve) {
    function launchNext() {
      if (state.abort || pending.length === 0) {
        if (activeControllers.size === 0) resolve();
        return;
      }

      var item = pending.shift();
      var controller = new AbortController();
      activeControllers.add(controller);

      var bodyObj = mode === 'polish'
        ? { text: item.original, old_translation: item.translation || '' }
        : { text: item.original };
      Object.assign(bodyObj, params, apiConfig);

      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
        signal: controller.signal,
      })
        .then(async function (res) {
          activeControllers.delete(controller);
          var d = await res.json();
          if (res.ok) {
            item.new_translation = d.translation;
            item.error = '';
            item.truncated = !!d.truncated;
            item.warning = d.warning || '';
            item.degraded = !!d.degraded;
            var extra = item.truncated ? ' ⚠️截断' : (item.degraded ? ' ↓降级' : '');
            log('[' + (item.index + 1) + '] → ' + d.translation.substring(0, 40) + extra, 'ok');
          } else {
            item.error = d.error || '未知错误';
            errors++;
            log('[' + (item.index + 1) + '] 错误: ' + item.error, 'err');
          }
          done++;
          updateCompareRow(item.index);
          updatePreviewLine(item.index);
          var sc = done - errors;
          $('progressFill').style.width = (done / total * 100) + '%';
          $('progressText').textContent = '进度: ' + done + '/' + total + ' (成功' + sc + ', 失败' + errors + ')';
          launchNext();
        })
        .catch(function (err) {
          activeControllers.delete(controller);
          if (err.name !== 'AbortError') {
            item.error = err.message;
            errors++;
            log('[' + (item.index + 1) + '] 错误: ' + err.message, 'err');
          }
          done++;
          updateCompareRow(item.index);
          updatePreviewLine(item.index);
          var sc = done - errors;
          $('progressFill').style.width = (done / total * 100) + '%';
          $('progressText').textContent = '进度: ' + done + '/' + total + ' (成功' + sc + ', 失败' + errors + ')';
          launchNext();
        });
    }

    for (var i = 0; i < Math.min(concurrency, total); i++) {
      launchNext();
    }
  });

  _activeBatchControllers = null;
  setBatchUpdating(false);
  renderPreview();
  renderCompare();
  var _okCount = done - errors;
  log((mode === 'polish' ? '润色' : '翻译') + '结束: ' + _okCount + '/' + total + ' 条成功' + (errors ? ' · ' + errors + ' 条失败' : ''), errors ? 'err' : 'ok');
  return { done: done, errors: errors, wasAborted: state.abort };
}


// ── 文件列表管理 ──
function renderFileList() {
  var html = '';
  for (var i = 0; i < state.files.length; i++) {
    var f = state.files[i];
    var lineCount = state.lines.filter(function (l) { return l.file === f.name; }).length;
    html += '<div class="file-entry" draggable="true" data-file-index="' + i + '" data-action="file-entry">' +
      '<input type="checkbox" class="file-check" ' + (f.checked ? 'checked' : '') + ' data-action="toggle-file" data-index="' + i + '" title="勾选后该文件内容会出现在预览和翻译中">' +
      '<span class="file-name">' + escHtml(f.name) + '</span>' +
      '<span class="file-count">' + lineCount + ' 行</span>' +
      '<span class="file-drag-handle" title="拖动排序">≡</span>' +
      '<span class="file-delete" data-action="delete-file" data-index="' + i + '" title="删除此文件">🗑</span>' +
    '</div>';
  }
  $('fileInfo').innerHTML = html || '<div class="empty-state">暂无来源文件</div>';
}

function deleteFile(index) {
  var f = state.files[index];
  if (!f) return;
  var fname = f.name;
  // 删除属于该文件的行
  var indices = [];
  for (var i = state.lines.length - 1; i >= 0; i--) {
    if (state.lines[i].file === fname) indices.push(i);
  }
  for (var di = 0; di < indices.length; di++) {
    state.previewChecked.delete(indices[di]);
    state.compareChecked.delete(indices[di]);
    state.lines.splice(indices[di], 1);
  }
  // 重建索引和复选框状态
  rebuildIndicesAndCheckboxes();
  // 删除文件条目
  state.files.splice(index, 1);
  state.fileNames = state.files.map(function (x) { return x.name; });
  // 清空搜索
  state.previewQuery = '';
  state.compareQuery = '';
  $('previewSearch').value = '';
  $('compareSearch').value = '';
  updateSearchUI('previewSearchWrap', 'previewSearchCount', '');
  updateSearchUI('compareSearchWrap', 'compareSearchCount', '');
  // 文件全部删除后清空所有
  if (state.files.length === 0) {
    state.lines = [];
    state.fileNames = [];
  }
  renderFileList();
  renderPreview();
  renderCompare();
  updateRetryButton();
  $('btnExport').disabled = !state.lines.some(function (l) { return l.new_translation; });
  if (state.lines.length === 0) {
    $('btnTranslateAll').disabled = true;
    $('btnClearAll').disabled = true;
    $('translateHint').style.display = 'block';
  }
  // 删除手动录入时清空输入框
  if (fname === '手动录入') {
    $('manualInput').value = '';
  }
  log('已删除文件: ' + fname);
}

function toggleFile(index) {
  var f = state.files[index];
  if (!f) return;
  f.checked = !f.checked;
  var checkedNames = state.files.filter(function (x) { return x.checked; }).map(function (x) { return x.name; });
  var visible = state.lines.some(function (l) { return l.file && checkedNames.indexOf(l.file) >= 0; });
  renderFileList();
  $('btnTranslateAll').disabled = !visible;
  renderPreview();
  renderCompare();
}

// ── File Drag Reorder ──
var _dragSrcIndex = -1;

function onFileDragStart(e) {
  _dragSrcIndex = parseInt(e.target.closest('.file-entry').dataset.fileIndex);
  e.dataTransfer.effectAllowed = 'move';
  e.target.closest('.file-entry').classList.add('dragging');
}

function onFileDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  var entry = e.target.closest('.file-entry');
  if (entry) entry.classList.add('drag-over');
}

function onFileDragEnd(e) {
  var entries = document.querySelectorAll('.file-entry');
  for (var i = 0; i < entries.length; i++) {
    entries[i].classList.remove('dragging', 'drag-over');
  }
}

function onFileDrop(e) {
  e.preventDefault();
  var entry = e.target.closest('.file-entry');
  if (!entry) return;
  entry.classList.remove('drag-over');
  var dstIndex = parseInt(entry.dataset.fileIndex);
  if (_dragSrcIndex < 0 || _dragSrcIndex === dstIndex) return;

  // 按对象引用快照选中行（索引会变，不能用索引）
  var checkedPCLines = new Set();
  var checkedCCLines = new Set();
  state.lines.forEach(function (l) {
    if (state.previewChecked.has(l.index)) checkedPCLines.add(l);
    if (state.compareChecked.has(l.index)) checkedCCLines.add(l);
  });

  // 重排文件列表
  var item = state.files.splice(_dragSrcIndex, 1)[0];
  state.files.splice(dstIndex, 0, item);

  // 按新文件顺序重排 state.lines
  var newLines = [];
  for (var fi = 0; fi < state.files.length; fi++) {
    var fname = state.files[fi].name;
    for (var li = 0; li < state.lines.length; li++) {
      if (state.lines[li].file === fname) newLines.push(state.lines[li]);
    }
  }
  // 无文件归属的行追加到末尾
  for (var li2 = 0; li2 < state.lines.length; li2++) {
    if (!state.lines[li2].file) newLines.push(state.lines[li2]);
  }
  state.lines = newLines;

  // 重建索引
  for (var ri = 0; ri < state.lines.length; ri++) { state.lines[ri].index = ri; }

  // 从快照恢复选中状态（按对象引用，重排后不变）
  state.previewChecked.clear();
  state.compareChecked.clear();
  state.lines.forEach(function (l) {
    if (checkedPCLines.has(l)) state.previewChecked.add(l.index);
    if (checkedCCLines.has(l)) state.compareChecked.add(l.index);
  });

  renderFileList();
  renderPreview();
  renderCompare();
  log('已调整文件顺序');
}

// ── Reset Source Input ──
function resetSourceInput() {
  if (state.lines.length === 0) { showToast('来源输入已为空'); return; }
  state.lines = [];
  state.fileNames = [];
  state.files = [];
  state.previewChecked.clear();
  state.compareChecked.clear();
  state.previewQuery = '';
  state.compareQuery = '';
  $('previewSearch').value = '';
  $('compareSearch').value = '';
  updateSearchUI('previewSearchWrap', 'previewSearchCount', '');
  updateSearchUI('compareSearchWrap', 'compareSearchCount', '');
  renderFileList();
  renderPreview();
  renderCompare();
  state.translateStarted = false;
    state.previewPage = 1;
    state.comparePage = 1;
  updateTranslateAllButton();
  $('btnRetryFailed').disabled = true;
  $('btnClearAll').disabled = true;
  $('btnExport').disabled = true;
  $('translateHint').style.display = 'block';
  clearLog();
  log('来源输入已重置');
  showToast('来源输入已重置');
}

// ── Preview Delete ──
function deleteCheckedPreview() {
  var indices = [];
  state.lines.forEach(function (l) {
    if (state.previewChecked.has(l.index)) indices.push(l.index);
  });
  if (indices.length === 0) { showToast('请先勾选预览条目'); return; }
  indices.sort(function (a, b) { return b - a; });
  for (var i = 0; i < indices.length; i++) {
    state.lines.splice(indices[i], 1);
    state.previewChecked.delete(indices[i]);
    state.compareChecked.delete(indices[i]);
  }
  // 重建索引和复选框状态
  rebuildIndicesAndCheckboxes();
  // 删除空文件条目
  state.files = state.files.filter(function (f) {
    return state.lines.some(function (l) { return l.file === f.name; });
  });
  state.fileNames = state.files.map(function (f) { return f.name; });
  renderFileList();
  renderPreview();
  renderCompare();
  updateRetryButton();
  if (state.lines.length === 0) {
    $('btnTranslateAll').disabled = true;
    $('btnClearAll').disabled = true;
    $('translateHint').style.display = 'block';
  }
  log('删除 ' + indices.length + ' 条预览条目');
  showToast('已删除 ' + indices.length + ' 条');
}

function deletePreviewLine(index, e) {
  if (e) e.stopPropagation();
  var line = state.lines[index];
  if (!line) return;
  state.lines.splice(index, 1);
  state.previewChecked.delete(index);
  state.compareChecked.delete(index);
  rebuildIndicesAndCheckboxes();
  // 删除文件条目 if no lines remain
  if (line.file && !state.lines.some(function (l) { return l.file === line.file; })) {
    state.files = state.files.filter(function (f) { return f.name !== line.file; });
    state.fileNames = state.files.map(function (f) { return f.name; });
  }
  renderFileList();
  renderPreview();
  renderCompare();
  updateRetryButton();
  if (state.lines.length === 0) {
    $('btnTranslateAll').disabled = true;
    $('btnClearAll').disabled = true;
    $('translateHint').style.display = 'block';
  }
  log('[' + (index + 1) + '] 已删除');
}

// ── Module exports ──
export { processFiles, loadManualInput, translateOneCore, enterTranslatingState, exitTranslatingState, translateBatchItems, abortActiveRequests, renderFileList, deleteFile, toggleFile, onFileDragStart, onFileDragOver, onFileDragEnd, onFileDrop, resetSourceInput, deleteCheckedPreview, deletePreviewLine };

// ── Window bindings (HTML onclick compat) ──
