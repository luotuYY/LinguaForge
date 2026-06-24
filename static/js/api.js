/**
 * TxtLlmHub — API 层
 * 文件上传解析、手动输入、LLM 翻译调用、批量流式翻译、文件管理
 * Depends on: utils.js, state.js, render.js
 */


import { $, escHtml, showToast, log, clearLog, logChunk } from './utils.js';
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
        obj._file = '手动录入';
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
        obj._file = '手动录入';
        obj.index = i;
        return obj;
      });
      state.fileNames = ['手动录入'];
      state.files = [{ name: '手动录入', checked: true }];
      state.abort = false;
      state.translating = false;
      state.translateStarted = false;
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

// ── 批量流式翻译（分块发送，每块条数 = 并发数，块间可停止） ──

async function translateBatchItems(items) {
  var total = items.length;
  var concurrency = parseInt($('concurrency').value) || 5;
  var params = getLLMParams();
  var apiConfig = getApiConfig();
  var mode = state.translateMode;
  var apiUrl = mode === 'polish' ? '/api/translate-batch-polish' : '/api/translate-batch';

  // 按并发数分块
  var chunks = [];
  for (var ci = 0; ci < items.length; ci += concurrency) {
    chunks.push(items.slice(ci, ci + concurrency));
  }
  var totalChunks = chunks.length;

  setBatchUpdating(true);
  var done = 0, errors = 0;
  $('progressText').textContent = '进度: 0/' + total + ' · 并发' + concurrency + ' · 块0/' + totalChunks;
  log('开始' + (mode === 'polish' ? '润色' : '翻译') + '，共 ' + total + ' 行，并发 ' + concurrency + '，分 ' + totalChunks + ' 块');

  try {
    for (var chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      // 块间检查停止信号
      if (state.abort) {
        log('用户停止，已完成 ' + done + '/' + total + ' 行（' + chunkIdx + '/' + totalChunks + ' 块）');
        break;
      }

      var chunk = chunks[chunkIdx];
      logChunk(chunkIdx + 1, totalChunks, chunk.length, total, mode);

      var batchBody = Object.assign({ items: chunk, concurrency: concurrency }, params, apiConfig);
      var r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchBody)
      });

      if (!r.ok) {
        var errText = '';
        try { var ed = await r.json(); errText = ed.error || ''; } catch (ex) { errText = r.statusText; }
        for (var ci2 = 0; ci2 < chunk.length; ci2++) {
          chunk[ci2].error = errText || '翻译失败';
          chunk[ci2].new_translation = '';
        }
        errors += chunk.length;
        done += chunk.length;
        log('块 ' + (chunkIdx + 1) + ' 失败: ' + (errText || '请求错误'), 'err');
      } else {
        // 流式读取 NDJSON（后端逐条返回，前端逐条渲染）
        var reader = r.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        while (true) {
          var streamResult = await reader.read();
          if (streamResult.done) break;
          buf += decoder.decode(streamResult.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var li = 0; li < lines.length; li++) {
            var line = lines[li].trim();
            if (!line) continue;
            try {
              var res = JSON.parse(line);
              var pos = res.index;
              if (pos >= 0 && pos < chunk.length) {
                chunk[pos].new_translation = res.new_translation;
                chunk[pos].error = res.error || '';
                chunk[pos].truncated = !!res.truncated;
                chunk[pos].warning = res.warning || '';
                chunk[pos].degraded = !!res.degraded;
                if (res.error) errors++;
                done++;
                updateCompareRow(chunk[pos].index);
              }
            } catch (parseErr) {}
          }
          $('progressFill').style.width = (done / total * 100) + '%';
          var successCount = done - errors;
          $('progressText').textContent = '进度: ' + done + '/' + total + ' (成功' + successCount + ', 失败' + errors + ') · 块' + (chunkIdx + 1) + '/' + totalChunks;
        }
        // 处理 buffer 中残留的最后一行
        if (buf.trim()) {
          try {
            var lastRes = JSON.parse(buf.trim());
            var lastPos = lastRes.index;
            if (lastPos >= 0 && lastPos < chunk.length) {
              chunk[lastPos].new_translation = lastRes.new_translation;
              chunk[lastPos].error = lastRes.error || '';
              chunk[lastPos].truncated = !!lastRes.truncated;
              chunk[lastPos].warning = lastRes.warning || '';
              chunk[lastPos].degraded = !!lastRes.degraded;
              if (lastRes.error) errors++;
              done++;
              updateCompareRow(chunk[lastPos].index);
            }
          } catch (e2) {}
        }
      }

      // 更新进度
      $('progressFill').style.width = (done / total * 100) + '%';
      var successCount2 = done - errors;
      $('progressText').textContent = '进度: ' + done + '/' + total + ' (成功' + successCount2 + ', 失败' + errors + ') · 块' + (chunkIdx + 1) + '/' + totalChunks;
    }
  } catch (e) {
    for (var ci3 = 0; ci3 < items.length; ci3++) { if (!items[ci3].new_translation && !items[ci3].error) items[ci3].error = e.message; }
    errors += (items.length - done);
    log('异常: ' + e.message, 'err');
  }

  setBatchUpdating(false);
  renderPreview();
  renderCompare();
  return { done: done, errors: errors, wasAborted: state.abort };
}


// ── 文件列表管理 ──
function renderFileList() {
  var html = '';
  for (var i = 0; i < state.files.length; i++) {
    var f = state.files[i];
    var lineCount = state.lines.filter(function (l) { return l._file === f.name; }).length;
    html += '<div class="file-entry" draggable="true" data-file-index="' + i + '" ondragstart="onFileDragStart(event)" ondragover="onFileDragOver(event)" ondrop="onFileDrop(event)" ondragend="onFileDragEnd(event)">' +
      '<input type="checkbox" class="file-check" ' + (f.checked ? 'checked' : '') + ' onchange="toggleFile(' + i + ')" title="勾选后该文件内容会出现在预览和翻译中">' +
      '<span class="file-name">' + escHtml(f.name) + '</span>' +
      '<span class="file-count">' + lineCount + ' 行</span>' +
      '<span class="file-drag-handle" title="拖动排序">≡</span>' +
      '<span class="file-delete" onclick="deleteFile(' + i + '); event.stopPropagation()" title="删除此文件">🗑</span>' +
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
    if (state.lines[i]._file === fname) indices.push(i);
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
  var visible = state.lines.some(function (l) { return l._file && checkedNames.indexOf(l._file) >= 0; });
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
      if (state.lines[li]._file === fname) newLines.push(state.lines[li]);
    }
  }
  // 无文件归属的行追加到末尾
  for (var li2 = 0; li2 < state.lines.length; li2++) {
    if (!state.lines[li2]._file) newLines.push(state.lines[li2]);
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
    return state.lines.some(function (l) { return l._file === f.name; });
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
  if (line._file && !state.lines.some(function (l) { return l._file === line._file; })) {
    state.files = state.files.filter(function (f) { return f.name !== line._file; });
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
export { processFiles, loadManualInput, translateOneCore, enterTranslatingState, exitTranslatingState, translateBatchItems, renderFileList, deleteFile, toggleFile, onFileDragStart, onFileDragOver, onFileDragEnd, onFileDrop, resetSourceInput, deleteCheckedPreview, deletePreviewLine };

// ── Window bindings (HTML onclick compat) ──
window.processFiles = processFiles;
window.loadManualInput = loadManualInput;
window.translateOneCore = translateOneCore;
window.enterTranslatingState = enterTranslatingState;
window.exitTranslatingState = exitTranslatingState;
window.translateBatchItems = translateBatchItems;
window.renderFileList = renderFileList;
window.deleteFile = deleteFile;
window.toggleFile = toggleFile;
window.onFileDragStart = onFileDragStart;
window.onFileDragOver = onFileDragOver;
window.onFileDragEnd = onFileDragEnd;
window.onFileDrop = onFileDrop;
window.resetSourceInput = resetSourceInput;
window.deleteCheckedPreview = deleteCheckedPreview;
window.deletePreviewLine = deletePreviewLine;
