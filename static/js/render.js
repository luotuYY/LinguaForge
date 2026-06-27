/**
 * LinguaForge — 渲染层
 * 预览列表、对比表格的 DOM 渲染，搜索 UI，复选框/排序状态管理
 * Depends on: utils.js, state.js
 */

import { $, escHtml, setHighlight, hl, matches, naturalCompare } from './utils.js';
import { state, updateExportCheckedButton } from './state.js';
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
  if (q) {
    lines = lines.filter(function (l) {
      return matches(l.original, q) || matches(l.translation, q) || matches(l.new_translation, q);
    });
  }
  var total = lines.length;
  var perPage = state.previewRowLimit || 200;
  var totalPages = Math.max(1, Math.ceil(total / perPage));
  if (state.previewPage > totalPages) state.previewPage = totalPages;
  if (state.previewPage < 1) state.previewPage = 1;
  var start = (state.previewPage - 1) * perPage;
  var pageLines = lines.slice(start, start + perPage);

  if (state.lines.length === 0) {
    $('cardPreview').innerHTML = '<div class="empty-state">请先上传 txt 文件</div>';
  } else if (q && total === 0) {
    $('cardPreview').innerHTML = '<div class="empty-state">无匹配结果</div>';
  } else {
    var previewHtml = '<div class="line-list">';
    pageLines.forEach(function (l) {
      previewHtml += '<div class="line-item">' +
        '<span class="line-num">' + (l.index + 1) + '</span>' +
        '<span class="line-text">' +
          '<span class="orig">' + hl(l.original) + '</span>' +
          (l.translation ? '<span class="sep">=</span><span class="tran">' + hl(l.translation) + '</span>' : '') +
          (l.new_translation ? '<span class="sep">\u2192</span><span style="color:var(--green)">' + hl(l.new_translation) + '</span>' : '') +
        '</span>' +
        '<span class="line-actions">' +
          '<button class="btn" data-action="delete-preview-line" data-index="' + l.index + '" title="删除此条目">\uD83D\uDDD1</button>' +
          '<button class="btn" data-action="translate-one" data-index="' + l.index + '" ' + (state.translating ? 'disabled' : '') + '>\u8BD1</button>' +
        '</span>' +
        '<span class="line-check-wrap">' +
          '<input type="checkbox" class="preview-check" data-index="' + l.index + '" data-action="preview-check" ' + (state.previewChecked.has(l.index) ? 'checked' : '') + '>' +
        '</span>' +
      '</div>';
    });
    previewHtml += '</div>';
    previewHtml += _renderPagination(total, perPage, state.previewPage, 'preview');
    $('cardPreview').innerHTML = previewHtml;
    _bindPagination('cardPreview', 'preview', {
      onPage: function(p) { state.previewPage = p; renderPreview(); },
      onRowsPerPage: function(v) { state.previewRowLimit = v; state.previewPage = 1; state.comparePage = 1; renderPreview(); renderCompare(); }
    });
  }
  $('previewSearchCount').textContent = q
    ? total + ' 条匹配'
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
      '<button class="btn" data-action="delete-preview-line" data-index="' + l.index + '" title="删除此条目">🗑</button>' +
      '<button class="btn" data-action="translate-one" data-index="' + l.index + '" ' + (state.translating ? 'disabled' : '') + '>译</button>' +
    '</span>' +
    '<span class="line-check-wrap">' +
      '<input type="checkbox" class="preview-check" data-index="' + l.index + '" data-action="preview-check" ' + (state.previewChecked.has(l.index) ? 'checked' : '') + '>' +
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
    var total = rows.length;
    var perPage = state.previewRowLimit || 200;
    var totalPages = Math.max(1, Math.ceil(total / perPage));
    if (state.comparePage > totalPages) state.comparePage = totalPages;
    if (state.comparePage < 1) state.comparePage = 1;
    var start = (state.comparePage - 1) * perPage;
    var pageRows = rows.slice(start, start + perPage);
    var compareHtml = '<table class="compare-table"><thead><tr>' +
      '<th class="col-check"><input type="checkbox" id="selectAllCompare" data-action="toggle-select-all-compare" title="全选/取消筛选结果"></th>' +
      '<th class="col-orig">原文</th>' +
      '<th class="col-old">旧译文</th>' +
      '<th class="col-new">新译文 <button class="btn btn-sm" data-action="clear-new-without-old" title="清空所有无旧译文词条的新译文" style="font-size:0.68rem;padding:1px 6px">清</button></th>' +
      '<th class="col-tag">分类</th>' +
      '<th class="col-actions"></th>' +
    '</tr></thead><tbody>';
    pageRows.forEach(function (l) {
      var rowCls = (l.error ? 'row-error' : '') + (l.keepOld ? ' row-keep' : '');
      var tagBadge = '';
      if (l.tag_l1) {
        var tagSchema = null;
        try { tagSchema = window._compareTagSchema || null; } catch(e) {}
        var tagColor = '#888';
        if (tagSchema && tagSchema[l.tag_l1] && tagSchema[l.tag_l1].color) tagColor = tagSchema[l.tag_l1].color;
        tagBadge = '<span class="tag-badge" style="background:' + tagColor + ';font-size:0.65rem;padding:1px 6px;border-radius:4px;color:#fff">' +
          escHtml(l.tag_l1) + (l.tag_l2 ? ' / ' + escHtml(l.tag_l2) : '') +
          (l.confidence > 0 ? ' <span style="opacity:0.8">' + Math.round(l.confidence*100) + '%</span>' : '') +
          '</span>';
      } else if (l._tagging) {
        tagBadge = '<span style="color:var(--text-muted);font-size:0.72rem">分词中...</span>';
      }
      compareHtml += '<tr class="' + rowCls + '" data-row-index="' + l.index + '">' +
        '<td class="col-check"><input type="checkbox" class="row-check" data-index="' + l.index + '" data-action="compare-check" ' + (state.compareChecked.has(l.index) ? 'checked' : '') + '></td>' +
        '<td class="cell-copyable" data-action="copy-original" title="点击复制">' + hl(l.original) + '</td>' +
        '<td>' + (l.translation ? hl(l.translation) : '\u2014') + '</td>' +
        '<td class="cell-editable col-new" data-action="edit-translation" data-index="' + l.index + '" title="' + (l.warning ? l.warning : '点击编辑') + '">' +
          (l.error ? '\u26A0' + escHtml(l.error) : l.new_translation === ' ' ? '<span class="cleared-mark">\u2014</span>' : hl(l.new_translation)) +
          (l.truncated ? ' <span title="响应被截断，翻译可能不完整" style="cursor:help">\u26A0\uFE0F</span>' : '') +
          (l.warning && !l.truncated ? ' <span title="' + escHtml(l.warning) + '" style="cursor:help;color:var(--yellow)">\u26A0\uFE0F</span>' : '') +
          (l.degraded ? ' <span title="无旧译文，已降级为直译" style="cursor:help;color:var(--text-muted)">↓</span>' : '') +
        '</td>' +
        '<td class="col-tag">' + tagBadge + '</td>' +
        '<td class="col-actions">' +
          '<button class="btn btn-sm" data-action="keep-old" data-index="' + l.index + '" ' + (l.keepOld || !l.translation ? 'disabled' : '') + ' title="' + (!l.translation ? '无原译文可保留' : l.keepOld ? '已标记保留' : '用旧译文替换新译文') + '">' + (l.keepOld ? '已保留' : '保留译文') + '</button>' +
          '<button class="btn btn-sm" data-action="retry-one" data-index="' + l.index + '">重译</button>' +
          '<button class="btn btn-sm" data-action="copy-row" data-index="' + l.index + '" title="复制原文=译文">复制</button>' +
        '</td>' +
      '</tr>';
    });
    compareHtml += '</tbody></table>';
    compareHtml += _renderPagination(total, perPage, state.comparePage, 'compare');
    $('cardCompare').innerHTML = compareHtml;
    _bindPagination('cardCompare', 'compare', {
      onPage: function(p) { state.comparePage = p; renderCompare(); },
      onRowsPerPage: function(v) { state.previewRowLimit = v; state.previewPage = 1; state.comparePage = 1; renderPreview(); renderCompare(); }
    });
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
  }
  // Only consider current page
  var perPage = state.previewRowLimit || 200;
  var totalPages = Math.max(1, Math.ceil(visible.length / perPage));
  if (state.previewPage > totalPages) state.previewPage = totalPages;
  var start = (state.previewPage - 1) * perPage;
  visible = visible.slice(start, start + perPage);
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

// ── 分页控件渲染 ──
function _renderPagination(total, perPage, currentPage, pageKey) {
  if (total <= perPage) return '';
  var totalPages = Math.ceil(total / perPage);
  var start = (currentPage - 1) * perPage + 1;
  var end = Math.min(currentPage * perPage, total);

  var html = '<div class="pagination-bar">';
  html += '<span class="pagination-info">' + start + '-' + end + ' / ' + total + ' 条</span>';
  html += '<div class="pagination-controls">';
  // 上一页
  html += '<button data-pg="' + pageKey + '" data-page="' + (currentPage - 1) + '"' + (currentPage <= 1 ? ' disabled' : '') + '>&laquo;</button>';
  // 页码
  var pages = _calcPageRange(currentPage, totalPages);
  pages.forEach(function (p) {
    if (p === '...') {
      html += '<span class="pg-ellipsis">...</span>';
    } else {
      html += '<button data-pg="' + pageKey + '" data-page="' + p + '"' + (p === currentPage ? ' class="pg-active"' : '') + '>' + p + '</button>';
    }
  });
  // 下一页
  html += '<button data-pg="' + pageKey + '" data-page="' + (currentPage + 1) + '"' + (currentPage >= totalPages ? ' disabled' : '') + '>&raquo;</button>';
  html += '</div>';
  html += '<div class="pagination-rowsper">';
  html += '<select data-pg-rowsper="' + pageKey + '">';
  [200, 500, 1000, 2000].forEach(function (n) {
    html += '<option value="' + n + '"' + (perPage === n ? ' selected' : '') + '>' + n + '</option>';
  });
  html += '</select>';
  html += '</div>';
  html += '</div>';
  return html;
}

function _calcPageRange(cur, total) {
  if (total <= 7) {
    var arr = [];
    for (var i = 1; i <= total; i++) arr.push(i);
    return arr;
  }
  var pages = [1];
  if (cur > 3) pages.push('...');
  for (var i = Math.max(2, cur - 1); i <= Math.min(total - 1, cur + 1); i++) {
    pages.push(i);
  }
  if (cur < total - 2) pages.push('...');
  pages.push(total);
  return pages;
}

function _bindPagination(containerId, pageKey, callbacks) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('button[data-pg="' + pageKey + '"]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var page = parseInt(btn.dataset.page);
      if (page < 1) return;
      if (callbacks && callbacks.onPage) callbacks.onPage(page);
      var el = document.getElementById(containerId);
      if (el) el.scrollTop = 0;
    });
  });
  var sel = container.querySelector('select[data-pg-rowsper="' + pageKey + '"]');
  if (sel) {
    sel.addEventListener('change', function () {
      var val = parseInt(sel.value) || 200;
      if (callbacks && callbacks.onRowsPerPage) callbacks.onRowsPerPage(val);
    });
  }
}

// ── 旧版行数限制（兼容） ──
function onPreviewRowLimitChange() { renderPreview(); }
function onPreviewCustomLimitChange() {}
function initPreviewRowLimit() { state.previewRowLimit = 200; }

// ── 增量追加单行到对比表（批量更新专用，不触发全量重建） ──
function _appendCompareRow(l) {
  var tbody;
  var table = document.querySelector('.compare-table');
  if (!table) {
    // 表格不存在，创建骨架
    $('cardCompare').innerHTML = '<table class="compare-table"><thead><tr>' +
      '<th class="col-check"><input type="checkbox" id="selectAllCompare" data-action="toggle-select-all-compare" title="全选/取消筛选结果"></th>' +
      '<th class="col-orig">原文</th>' +
      '<th class="col-old">旧译文</th>' +
      '<th class="col-new">新译文 <button class="btn btn-sm" data-action="clear-new-without-old" title="清空所有无旧译文词条的新译文" style="font-size:0.68rem;padding:1px 6px">清</button></th>' +
      '<th class="col-tag">分类</th>' +
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
  var tagCell = '';
  if (l.tag_l1) {
    var _ts = null; try { _ts = window._compareTagSchema || null; } catch(e) {}
    var _tc = '#888'; if (_ts && _ts[l.tag_l1] && _ts[l.tag_l1].color) _tc = _ts[l.tag_l1].color;
    tagCell = '<span class="tag-badge" style="background:' + _tc + ';font-size:0.65rem;padding:1px 6px;border-radius:4px;color:#fff">' +
      escHtml(l.tag_l1) + (l.tag_l2 ? ' / ' + escHtml(l.tag_l2) : '') + '</span>';
  } else if (l._tagging) {
    tagCell = '<span style="color:var(--text-muted);font-size:0.72rem">分词中...</span>';
  }
  tr.innerHTML =
    '<td class="col-check"><input type="checkbox" class="row-check" data-index="' + l.index + '" data-action="compare-check"></td>' +
    '<td class="cell-copyable" data-action="copy-original" title="点击复制">' + hl(l.original) + '</td>' +
    '<td>' + (l.translation ? hl(l.translation) : '\u2014') + '</td>' +
    '<td class="cell-editable col-new" data-action="edit-translation" data-index="' + l.index + '" title="' + (l.warning || '点击编辑') + '">' + newContent + '</td>' +
    '<td class="col-tag">' + tagCell + '</td>' +
    '<td class="col-actions">' +
      '<button class="btn btn-sm" data-action="keep-old" data-index="' + l.index + '" ' + (l.keepOld || !l.translation ? 'disabled' : '') + ' title="' + (!l.translation ? '无原译文可保留' : l.keepOld ? '已标记保留' : '用旧译文替换新译文') + '">' + (l.keepOld ? '已保留' : '保留译文') + '</button>' +
      '<button class="btn btn-sm" data-action="retry-one" data-index="' + l.index + '">重译</button>' +
      '<button class="btn btn-sm" data-action="copy-row" data-index="' + l.index + '" title="复制原文=译文">复制</button>' +
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
export { renderInternal, getCheckedFileNames, updateSearchUI, renderPreview, updatePreviewLine, toggleSort, renderCompare, updatePreviewSelectAllVisibility, onPreviewCheck, toggleSelectAllPreview, updateSelectAllPreview, getCheckedPreviewIndices, onCompareCheck, toggleSelectAllCompare, updateSelectAllCompare, getCheckedRows, onPreviewRowLimitChange, onPreviewCustomLimitChange, initPreviewRowLimit, updateCompareRow, _appendCompareRow, setBatchUpdating, _renderPagination, _bindPagination };

// ── Window bindings (HTML onclick compat) ──
