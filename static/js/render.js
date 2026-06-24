/**
 * TxtLlmHub — 渲染层
 * 预览列表、对比表格的 DOM 渲染，搜索 UI，复选框/排序状态管理
 * Depends on: utils.js, state.js
 */

import { $, escHtml, setHighlight, hl, matches, naturalCompare } from './utils.js';
import { state } from './state.js';
// ── 文件过滤 ──
function getCheckedFileNames() {
  return state.files.filter(function (f) { return f.checked; }).map(function (f) { return f.name; });
}


// ── 搜索 UI ──
function updateSearchUI(wrapId, countId, q) {
  var wrap = $(wrapId);
  var countEl = $(countId);
  if (q) {
    wrap.classList.add('active');
  } else {
    wrap.classList.remove('active');
    countEl.textContent = '';
  }
}

// ── 预览列表 ──
function renderPreview() {
  var q = state.previewQuery;
  setHighlight(q);
  var checkedFiles = getCheckedFileNames();
  var filtered = state.lines.filter(function (l) {
    return !l.file || checkedFiles.indexOf(l.file) >= 0;
  });
  var lines = filtered.slice();
  var limit = state.previewRowLimit || 2000;
  if (limit > 0 && lines.length > limit) {
    lines = lines.slice(0, limit);
  }
  var shown = 0;
  if (q) {
    lines = lines.filter(function (l) {
      return matches(l.original, q) || matches(l.translation, q) || matches(l.new_translation, q);
    });
  }
  shown = lines.length;
  if (state.lines.length === 0) {
    $('cardPreview').innerHTML = '<div class="empty-state">请先上传 txt 文件</div>';
  } else if (q && shown === 0) {
    $('cardPreview').innerHTML = '<div class="empty-state">无匹配结果</div>';
  } else {
    var previewHtml = '<div class="line-list">';
    lines.forEach(function (l) {
      previewHtml += '<div class="line-item">' +
        '<span class="line-num">' + (l.index + 1) + '</span>' +
        '<span class="line-text">' +
          '<span class="orig">' + hl(l.original) + '</span>' +
          (l.translation ? '<span class="sep">=</span><span class="tran">' + hl(l.translation) + '</span>' : '') +
          (l.new_translation ? '<span class="sep">\u2192</span><span style="color:var(--green)">' + hl(l.new_translation) + '</span>' : '') +
        '</span>' +
        '<span class="line-actions">' +
          '<button class="btn" onclick="deletePreviewLine(' + l.index + ', event)" title="删除此条目">🗑</button>' +
          '<button class="btn" onclick="translateOne(' + l.index + ', event)" ' + (state.translating ? 'disabled' : '') + '>译</button>' +
        '</span>' +
        '<span class="line-check-wrap">' +
          '<input type="checkbox" class="preview-check" data-index="' + l.index + '" onclick="onPreviewCheck(this)" ' + (state.previewChecked.has(l.index) ? 'checked' : '') + '>' +
        '</span>' +
      '</div>';
    });
    previewHtml += '</div>';
    $('cardPreview').innerHTML = previewHtml;
  }
  $('previewSearchCount').textContent = q
    ? shown + ' 条匹配'
    : filtered.length + ' 行';
  updatePreviewSelectAllVisibility();
  updateSelectAllPreview();
}

// ── 编辑保护：翻译进行中编辑 textarea 时不重建 DOM ──
const renderInternal = { compareDirty: false };

// ── 增量更新预览列表单条 ──
function updatePreviewLine(index) {
  var l = state.lines[index];
  if (!l) return;
  var item = document.querySelector('.line-item .preview-check[data-index="' + index + '"]');
  if (!item) return;
  var lineItem = item.closest('.line-item');
  if (!lineItem) return;
  lineItem.innerHTML =
    '<span class="line-num">' + (l.index + 1) + '</span>' +
    '<span class="line-text">' +
      '<span class="orig">' + hl(l.original) + '</span>' +
      (l.translation ? '<span class="sep">=</span><span class="tran">' + hl(l.translation) + '</span>' : '') +
      (l.new_translation ? '<span class="sep">\u2192</span><span style="color:var(--green)">' + hl(l.new_translation) + '</span>' : '') +
    '</span>' +
    '<span class="line-actions">' +
      '<button class="btn" onclick="deletePreviewLine(' + l.index + ', event)" title="删除此条目">🗑</button>' +
      '<button class="btn" onclick="translateOne(' + l.index + ', event)" ' + (state.translating ? 'disabled' : '') + '>译</button>' +
    '</span>' +
    '<span class="line-check-wrap">' +
      '<input type="checkbox" class="preview-check" data-index="' + l.index + '" onclick="onPreviewCheck(this)" ' + (state.previewChecked.has(l.index) ? 'checked' : '') + '>' +
    '</span>';
}

// ── 对比表格 ──
function toggleSort() {
  state.sortState = (state.sortState + 1) % 3;
  var labels = ['\u25BC', '\u25BCO', '\u25BCN'];
  var titles = ['按原文排序', '按新译文排序', '恢复原始顺序'];
  var btn = $('btnSort');
  if (btn) { btn.textContent = labels[state.sortState]; btn.title = titles[state.sortState]; }
  renderCompare();
}

function renderCompare() {
  // 编辑进行中：跳过重建，标记为待刷新
  if (document.querySelector('.compare-table .inline-edit')) {
    renderInternal.compareDirty = true;
    return;
  }
  // 批量翻译进行中：禁止全量重建，由 updateCompareRow() 增量处理
  if (_batchUpdating) return;
  renderInternal.compareDirty = false;
  var q = state.compareQuery;
  setHighlight(q);
  var rows = state.lines.filter(function (l) { return l.new_translation || l.error; });
  var shown = rows.length;
  if (q) {
    rows = rows.filter(function (l) {
      return matches(l.original, q) || matches(l.translation, q) || matches(l.new_translation, q) || matches(l.error, q);
    });
    shown = rows.length;
  }
  if (state.lines.every(function (l) { return !l.new_translation && !l.error; })) {
    $('cardCompare').innerHTML = '<div class="empty-state">翻译后将在此显示前后对比</div>';
  } else if (q && shown === 0) {
    $('cardCompare').innerHTML = '<div class="empty-state">无匹配结果</div>';
  } else {
    var curSort = state.sortState;
    if (curSort === 1) {
      rows.sort(function (a, b) { return naturalCompare(a.original, b.original); });
    } else if (curSort === 2) {
      rows.sort(function (a, b) { return naturalCompare(a.new_translation || '', b.new_translation || ''); });
    }
    var compareHtml = '<table class="compare-table"><thead><tr>' +
      '<th class="col-check"><input type="checkbox" id="selectAllCompare" onclick="toggleSelectAllCompare()" title="全选/取消筛选结果"></th>' +
      '<th class="col-orig">原文</th>' +
      '<th class="col-old">旧译文</th>' +
      '<th class="col-new">新译文 <button class="btn btn-sm" onclick="clearNewWithoutOld()" title="清空所有无旧译文词条的新译文" style="font-size:0.68rem;padding:1px 6px">清</button></th>' +
      '<th class="col-actions"></th>' +
    '</tr></thead><tbody>';
    rows.forEach(function (l) {
      var rowCls = (l.error ? 'row-error' : '') + (l.keepOld ? ' row-keep' : '');
      compareHtml += '<tr class="' + rowCls + '" data-row-index="' + l.index + '">' +
        '<td class="col-check"><input type="checkbox" class="row-check" data-index="' + l.index + '" onclick="onCompareCheck(this)" ' + (state.compareChecked.has(l.index) ? 'checked' : '') + '></td>' +
        '<td class="cell-copyable" onclick="copyOriginal(event)" title="点击复制">' + hl(l.original) + '</td>' +
        '<td>' + (l.translation ? hl(l.translation) : '\u2014') + '</td>' +
        '<td class="cell-editable" onclick="editTranslation(' + l.index + ',event)" title="' + (l.warning ? l.warning : '点击编辑') + '">' +
          (l.error ? '\u26A0' + escHtml(l.error) : l.new_translation === ' ' ? '<span class="cleared-mark">\u2014</span>' : hl(l.new_translation)) +
          (l.truncated ? ' <span title="响应被截断，翻译可能不完整" style="cursor:help">\u26A0\uFE0F</span>' : '') +
          (l.warning && !l.truncated ? ' <span title="' + escHtml(l.warning) + '" style="cursor:help;color:var(--yellow)">\u26A0\uFE0F</span>' : '') +
          (l.degraded ? ' <span title="无旧译文，已降级为直译" style="cursor:help;color:var(--text-muted)">↓</span>' : '') +
        '</td>' +
        '<td class="col-actions">' +
          '<button class="btn btn-sm" onclick="keepOld(' + l.index + ')" ' + (l.keepOld || !l.translation ? 'disabled' : '') + ' title="' + (!l.translation ? '无原译文可保留' : l.keepOld ? '已标记保留' : '用旧译文替换新译文') + '">' + (l.keepOld ? '已保留' : '保留译文') + '</button>' +
          '<button class="btn btn-sm" onclick="retryOne(' + l.index + ', event)">重译</button>' +
          '<button class="btn btn-sm" onclick="copyRow(' + l.index + ')" title="复制原文=译文">复制</button>' +
        '</td>' +
      '</tr>';
    });
    compareHtml += '</tbody></table>';
    $('cardCompare').innerHTML = compareHtml;
  }
  if (q) $('compareSearchCount').textContent = shown + ' 条匹配';
  updateSelectAllCompare();
}

// ── 预览复选框 ──
function updatePreviewSelectAllVisibility() {
  var master = document.getElementById('selectAllPreview');
  var btn = document.getElementById('btnTranslatePreviewSel');
  var hasLines = state.lines.length > 0;
  if (master) master.style.display = hasLines ? '' : 'none';
  if (btn) { btn.style.display = hasLines ? '' : 'none'; btn.disabled = state.translating; }
}

function onPreviewCheck(cb) {
  var idx = parseInt(cb.dataset.index);
  if (cb.checked) { state.previewChecked.add(idx); }
  else { state.previewChecked.delete(idx); }
  updateSelectAllPreview();
}

function toggleSelectAllPreview() {
  var master = document.getElementById('selectAllPreview');
  if (!master) return;
  var checks = document.querySelectorAll('.preview-check');
  checks.forEach(function (cb) {
    cb.checked = master.checked;
    var idx = parseInt(cb.dataset.index);
    if (master.checked) { state.previewChecked.add(idx); }
    else { state.previewChecked.delete(idx); }
  });
  // 更新翻译选中按钮状态
  var btn = document.getElementById('btnTranslatePreviewSel');
  if (btn) btn.disabled = !master.checked || state.translating;
}

function updateSelectAllPreview() {
  if (!state.lines.length) return;
  var q = state.previewQuery;
  var visible;
  if (q) {
    visible = state.lines.filter(function (l) {
      return matches(l.original, q) || matches(l.translation, q) || matches(l.new_translation, q);
    });
  } else {
    visible = state.lines;
    if (state.previewRowLimit > 0 && visible.length > state.previewRowLimit) {
      visible = visible.slice(0, state.previewRowLimit);
    }
  }
  if (!visible.length) return;
  var allIndices = new Set();
  visible.forEach(function (l) { allIndices.add(l.index); });
  var checked = 0;
  state.previewChecked.forEach(function (i) { if (allIndices.has(i)) checked++; });
  var master = document.getElementById('selectAllPreview');
  if (!master) return;
  master.checked = checked > 0 && checked === allIndices.size;
  master.indeterminate = checked > 0 && checked < allIndices.size;
  updateExportCheckedButton();
}

function getCheckedPreviewIndices() {
  return Array.from(state.previewChecked).sort(function (a, b) { return a - b; });
}

// ── 对比复选框 ──
function onCompareCheck(cb) {
  var idx = parseInt(cb.dataset.index);
  if (cb.checked) { state.compareChecked.add(idx); }
  else { state.compareChecked.delete(idx); }
  updateSelectAllCompare();
}

function toggleSelectAllCompare() {
  var master = document.getElementById('selectAllCompare');
  if (!master) return;
  var checks = document.querySelectorAll('.row-check');
  checks.forEach(function (cb) {
    cb.checked = master.checked;
    var idx = parseInt(cb.dataset.index);
    if (master.checked) { state.compareChecked.add(idx); }
    else { state.compareChecked.delete(idx); }
  });
  updateExportCheckedButton();
}

function updateSelectAllCompare() {
  var checkable = state.lines.filter(function (l) { return l.new_translation || l.error; });
  if (!checkable.length) return;
  var allIndices = new Set(checkable.map(function (l) { return l.index; }));
  var checked = 0;
  state.compareChecked.forEach(function (i) { if (allIndices.has(i)) checked++; });
  var master = document.getElementById('selectAllCompare');
  if (!master) return;
  master.checked = checked > 0 && checked === allIndices.size;
  master.indeterminate = checked > 0 && checked < allIndices.size;
  updateExportCheckedButton();
}

function getCheckedRows() {
  return state.lines.filter(function (l) { return state.compareChecked.has(l.index); });
}

// ── 预览行数限制 ──
function onPreviewRowLimitChange() {
  var sel = document.getElementById('previewRowLimit');
  var custom = document.getElementById('previewCustomLimit');
  if (!sel) return;
  var val = sel.value;
  if (val === '-2') {
    // 自定：隐藏下拉，显示输入框
    sel.style.display = 'none';
    if (custom) { custom.style.display = 'inline-block'; custom.focus(); }
    return;
  }
  if (val === '-1') {
    // 全部
    state.previewRowLimit = 0;
  } else {
    state.previewRowLimit = parseInt(val) || 2000;
  }
  if (custom) custom.style.display = 'none';
  if (sel) sel.style.display = 'inline-block';
  renderPreview();
}

function onPreviewCustomLimitChange() {
  var custom = document.getElementById('previewCustomLimit');
  if (!custom) return;
  var v = parseInt(custom.value);
  if (v > 0) {
    state.previewRowLimit = v;
    renderPreview();
  }
}

function initPreviewRowLimit() {
  var sel = document.getElementById('previewRowLimit');
  if (sel) sel.value = '2000';
  state.previewRowLimit = 2000;
}

// ── 增量追加单行到对比表（批量更新专用，不触发全量重建） ──
function _appendCompareRow(l) {
  var tbody;
  var table = document.querySelector('.compare-table');
  if (!table) {
    // 表格不存在，创建骨架
    $('cardCompare').innerHTML = '<table class="compare-table"><thead><tr>' +
      '<th class="col-check"><input type="checkbox" id="selectAllCompare" onclick="toggleSelectAllCompare()" title="全选/取消筛选结果"></th>' +
      '<th class="col-orig">原文</th>' +
      '<th class="col-old">旧译文</th>' +
      '<th class="col-new">新译文 <button class="btn btn-sm" onclick="clearNewWithoutOld()" title="清空所有无旧译文词条的新译文" style="font-size:0.68rem;padding:1px 6px">清</button></th>' +
      '<th class="col-actions"></th>' +
    '</tr></thead><tbody></tbody></table>';
    tbody = document.querySelector('.compare-table tbody');
  } else {
    tbody = table.querySelector('tbody');
    if (!tbody) { tbody = document.createElement('tbody'); table.appendChild(tbody); }
    // 已存在则跳过
    if (tbody.querySelector('tr[data-row-index="' + l.index + '"]')) return;
  }
  var rowCls = (l.error ? 'row-error' : '') + (l.keepOld ? ' row-keep' : '');
  var extra = '';
  if (l.truncated) extra += ' <span title="响应被截断，翻译可能不完整" style="cursor:help">\u26A0\uFE0F</span>';
  if (l.warning && !l.truncated) extra += ' <span title="' + escHtml(l.warning) + '" style="cursor:help;color:var(--yellow)">\u26A0\uFE0F</span>';
  if (l.degraded) extra += ' <span title="无旧译文，已降级为直译" style="cursor:help;color:var(--text-muted)">↓</span>';
  var newContent;
  if (l.error) { newContent = '\u26A0 ' + escHtml(l.error); }
  else if (l.new_translation === ' ') { newContent = '<span class="cleared-mark">\u2014</span>'; }
  else { newContent = hl(l.new_translation) + extra; }
  var tr = document.createElement('tr');
  tr.className = rowCls;
  tr.setAttribute('data-row-index', l.index);
  tr.innerHTML =
    '<td class="col-check"><input type="checkbox" class="row-check" data-index="' + l.index + '" onclick="onCompareCheck(this)"></td>' +
    '<td class="cell-copyable" onclick="copyOriginal(event)" title="点击复制">' + hl(l.original) + '</td>' +
    '<td>' + (l.translation ? hl(l.translation) : '\u2014') + '</td>' +
    '<td class="cell-editable col-new" onclick="editTranslation(' + l.index + ',event)" title="' + (l.warning || '点击编辑') + '">' + newContent + '</td>' +
    '<td class="col-actions">' +
      '<button class="btn btn-sm" onclick="keepOld(' + l.index + ')" ' + (l.keepOld || !l.translation ? 'disabled' : '') + ' title="' + (!l.translation ? '无原译文可保留' : l.keepOld ? '已标记保留' : '用旧译文替换新译文') + '">' + (l.keepOld ? '已保留' : '保留译文') + '</button>' +
      '<button class="btn btn-sm" onclick="retryOne(' + l.index + ', event)">重译</button>' +
      '<button class="btn btn-sm" onclick="copyRow(' + l.index + ')" title="复制原文=译文">复制</button>' +
    '</td>';
  tbody.appendChild(tr);
}

// ── 增量更新单行（翻译进行中避免全量重建） ──
function updateCompareRow(index) {
  var l = state.lines[index];
  if (!l) return;
  // 批量更新期间：行存在则增量更新，不存在则追加单行
  if (_batchUpdating) {
    var row = document.querySelector('.compare-table tbody tr[data-row-index="' + index + '"]');
    if (!row) { _appendCompareRow(l); return; }
    if (row.querySelector('.inline-edit')) return;
    row.className = (l.error ? 'row-error' : '') + (l.keepOld ? ' row-keep' : '');
    var newCell = row.querySelector('.col-new');
    if (newCell && !newCell.querySelector('.inline-edit')) {
      if (l.error) {
        newCell.innerHTML = '\u26A0 ' + escHtml(l.error);
      } else if (l.new_translation === ' ') {
        newCell.innerHTML = '<span class="cleared-mark">\u2014</span>';
      } else {
        var extra = '';
        if (l.truncated) extra += ' <span title="响应被截断，翻译可能不完整" style="cursor:help">\u26A0\uFE0F</span>';
        if (l.warning && !l.truncated) extra += ' <span title="' + escHtml(l.warning) + '" style="cursor:help;color:var(--yellow)">\u26A0\uFE0F</span>';
        if (l.degraded) extra += ' <span title="无旧译文，已降级为直译" style="cursor:help;color:var(--text-muted)">↓</span>';
        newCell.innerHTML = hl(l.new_translation) + extra;
      }
      newCell.className = 'cell-editable col-new';
      newCell.onclick = function(e) { editTranslation(index, e); };
      newCell.title = l.warning || '点击编辑';
    }
    var keepBtn = row.querySelector('.col-actions button[onclick^="keepOld"]');
    if (keepBtn) {
      keepBtn.disabled = !l.translation || l.keepOld;
      keepBtn.title = !l.translation ? '无原译文可保留' : l.keepOld ? '已标记保留' : '用旧译文替换新译文';
      keepBtn.textContent = l.keepOld ? '已保留' : '保留译文';
    }
    return;
  }
  // 如果有搜索或排序激活，增量更新无意义，走全量
  if (state.compareQuery || state.sortState !== 0) {
    renderCompare();
    return;
  }
  var row = document.querySelector('.compare-table tbody tr[data-row-index="' + index + '"]');
  if (!row) {
    // 行不存在（首次出现翻译结果），整体刷新一次
    renderCompare();
    return;
  }
  // 更新行样式
  row.className = (l.error ? 'row-error' : '') + (l.keepOld ? ' row-keep' : '');
  // 更新"新译文"列（跳过正在编辑的单元格）
  var newCell = row.querySelector('.col-new');
  if (newCell) {
    // 如果单元格内有正在编辑的 textarea，跳过更新
    if (newCell.querySelector('.inline-edit')) return;
    if (l.error) {
      newCell.innerHTML = '\u26A0 ' + escHtml(l.error);
    } else if (l.new_translation === ' ') {
      newCell.innerHTML = '<span class="cleared-mark">\u2014</span>';
    } else {
      var extra = '';
      if (l.truncated) extra += ' <span title="响应被截断，翻译可能不完整" style="cursor:help">\u26A0\uFE0F</span>';
      if (l.warning && !l.truncated) extra += ' <span title="' + escHtml(l.warning) + '" style="cursor:help;color:var(--yellow)">\u26A0\uFE0F</span>';
      if (l.degraded) extra += ' <span title="无旧译文，已降级为直译" style="cursor:help;color:var(--text-muted)">↓</span>';
      newCell.innerHTML = hl(l.new_translation) + extra;
    }
    // 恢复可编辑属性
    newCell.className = 'cell-editable col-new';
    newCell.onclick = function(e) { editTranslation(index, e); };
    newCell.title = l.warning || '点击编辑';
  }
  // 更新"保留译文"按钮状态
  var keepBtn = row.querySelector('.col-actions button[onclick^="keepOld"]');
  if (keepBtn) {
    keepBtn.disabled = !l.translation || l.keepOld;
    keepBtn.title = !l.translation ? '无原译文可保留' : l.keepOld ? '已标记保留' : '用旧译文替换新译文';
    keepBtn.textContent = l.keepOld ? '已保留' : '保留译文';
  }
}

// ── 批量翻译开始/结束标记（用于增量更新判断） ──
var _batchUpdating = false;
function setBatchUpdating(v) { _batchUpdating = v; }

// ── Module exports ──
export { renderInternal, getCheckedFileNames, updateSearchUI, renderPreview, updatePreviewLine, toggleSort, renderCompare, updatePreviewSelectAllVisibility, onPreviewCheck, toggleSelectAllPreview, updateSelectAllPreview, getCheckedPreviewIndices, onCompareCheck, toggleSelectAllCompare, updateSelectAllCompare, getCheckedRows, onPreviewRowLimitChange, onPreviewCustomLimitChange, initPreviewRowLimit, updateCompareRow, _appendCompareRow, setBatchUpdating };

// ── Window bindings (HTML onclick compat) ──
window.updateSearchUI = updateSearchUI;
window.renderPreview = renderPreview;
window.updatePreviewLine = updatePreviewLine;
window.toggleSort = toggleSort;
window.renderCompare = renderCompare;
window.updatePreviewSelectAllVisibility = updatePreviewSelectAllVisibility;
window.onPreviewCheck = onPreviewCheck;
window.toggleSelectAllPreview = toggleSelectAllPreview;
window.updateSelectAllPreview = updateSelectAllPreview;
window.getCheckedPreviewIndices = getCheckedPreviewIndices;
window.onCompareCheck = onCompareCheck;
window.toggleSelectAllCompare = toggleSelectAllCompare;
window.updateSelectAllCompare = updateSelectAllCompare;
window.getCheckedRows = getCheckedRows;
window.onPreviewRowLimitChange = onPreviewRowLimitChange;
window.onPreviewCustomLimitChange = onPreviewCustomLimitChange;
window.initPreviewRowLimit = initPreviewRowLimit;
window.updateCompareRow = updateCompareRow;
window._appendCompareRow = _appendCompareRow;
window.renderInternal = renderInternal;
window.getCheckedFileNames = getCheckedFileNames;
window.setBatchUpdating = setBatchUpdating;
