/**
 * LinguaForge - 分词/标签模块
 * 文本分类、LLM 分词、卡片拖拽排序、标签管理、导入翻译
 * Depends on: utils.js, db.js, state.js, api.js, render.js, app.js
 */

import { $, escHtml, showToast, setHighlight, hl, matches, createLogger } from './utils.js';
import { dbGet, dbSet, dbSetCache, dbHas, dbReady } from './db.js';
import { state, rebuildIndicesAndCheckboxes, updateTranslateAllButton, resetInputDefault } from './state.js';
import { renderFileList } from './api.js';
import { renderPreview, renderCompare, _renderPagination, _bindPagination } from './render.js';
import { switchPage } from './app.js';

// ── 分词页状态 ──
var tagState = {
  lines: [],
  files: [],
  fileNames: [],
  translating: false,
  abort: false,
  query: '',
  previewRowLimit: 200,
  previewPage: 1,
  colPages: {},       // {colId: pageNum} 每列独立页码
  tagStarted: false,  // 是否过分词任务(用于区分「开始」和「继续」)
  _tagCounts: null,  // 缓存分类计数，避免每次O(n) filter
};

// ── 分类体系(动态 schema,前端可自定义) ──
var DEFAULT_SUB_POOL = ['UI文本', '菜单/按钮', '属性/状态', '物品/装备', '技能/招式', '系统提示', 'Mod/插件', '代码标识符', '对话/台词', '旁白/叙述', '情感/语气', '俚语/口语', '描述/刻画', '幽默/讽刺', '严肃/正式'];

var DEFAULT_TAG_SCHEMA = {
  '硬术语': {
    color: '#4fc3f7', icon: '🔧',
    subs: ['UI文本', '菜单/按钮', '属性/状态', '物品/装备', '技能/招式', '系统提示', 'Mod/插件', '代码标识符']
  },
  '硬生动': {
    color: '#81c784', icon: '🎭',
    subs: ['对话/台词', '旁白/叙述', '情感/语气', '俚语/口语', '描述/刻画', '幽默/讽刺', '严肃/正式']
  }
};

function getTagSchema() {
  var saved = dbGet('tllmh_tag_schema');
  if (saved && typeof saved === 'object' && Object.keys(saved).length > 0) {
    return saved;
  }
  return DEFAULT_TAG_SCHEMA;
}

function getEnabledSchema() {
  var schema = getTagSchema();
  var result = {};
  Object.keys(schema).forEach(function(k) {
    if (schema[k].enabled !== false) result[k] = schema[k];
  });
  return result;
}

function saveTagSchema(schema) {
  dbSet('tllmh_tag_schema', schema);
}

function getSubPool() {
  var saved = dbGet('tllmh_sub_pool');
  if (Array.isArray(saved)) return saved;
  return DEFAULT_SUB_POOL.slice();
}
function saveSubPool(pool) {
  dbSet('tllmh_sub_pool', pool);
}

function getAllSubCategories() {
  var schema = getEnabledSchema();
  var r = [];
  Object.keys(schema).forEach(function(l1) {
    schema[l1].subs.forEach(function(l2) { r.push({l1:l1, l2:l2, label:l1+' / '+l2}); });
  });
  return r;
}

// ── API 配置(读取顶部工具栏的共享元素) ──
function tagGetApiConfig() {
  // 直接从顶部工具栏的共享 DOM 元素读取
  var cfg = {};
  var base = document.getElementById('apiBase');
  var key = document.getElementById('apiKey');
  var model = document.getElementById('modelName');
  if (base && base.value.trim()) cfg.api_base = base.value.trim();
  if (key && key.value.trim()) cfg.api_key = key.value.trim();
  if (model && model.value.trim()) cfg.model = model.value.trim();
  var thinkingEl = document.getElementById('enableThinking');
  if (thinkingEl) cfg.enable_thinking = thinkingEl.checked;
  return cfg;
}

// ── 文件上传(分词页) ──
async function tagProcessFiles(files) {
  var txtFiles = Array.from(files).filter(function(f) { return f.name.endsWith('.txt'); });
  if (txtFiles.length === 0) { showToast('请选择 .txt 文件'); return; }
  var form = new FormData();
  for (var i = 0; i < txtFiles.length; i++) form.append('file', txtFiles[i]);
  try {
    var r = await fetch('/api/upload', { method: 'POST', body: form });
    if (!r.ok) { showToast('文件解析失败'); return; }
    var d = await r.json();
    var offset = tagState.lines.length;
    var linesByFile = {};
    for (var li = 0; li < d.lines.length; li++) {
      var lf = d.lines[li].file || '';
      if (!linesByFile[lf]) linesByFile[lf] = [];
      linesByFile[lf].push(d.lines[li]);
    }
    var addedFiles = 0, addedLines = 0;
    for (var fi = 0; fi < (d.files || []).length; fi++) {
      var fname = d.files[fi];
      if (tagState.fileNames.indexOf(fname) !== -1) continue;
      tagState.fileNames.push(fname);
      tagState.files.push({name: fname});
      var fileLines = linesByFile[fname] || [];
      for (var fli = 0; fli < fileLines.length; fli++) {
        tagState.lines.push({
          index: offset++, original: fileLines[fli].original,
          translation: fileLines[fli].translation, file: fname,
          tag_l1: '', tag_l2: '', confidence: 0
        });
        addedLines++;
      }
      addedFiles++;
    }
    tagRenderFileList();
    tagBtnState();
    tagRenderPreview();
    tagRenderColumns();
    showToast('已加载 ' + (addedLines || d.count) + ' 行');
  } catch(e) { showToast('上传失败: ' + e.message); }
}

// ── 手动输入(分词页) ──
async function tagLoadManualInput() {
  var raw = document.getElementById('tagManualInput').value.trim();
  if (!raw) { showToast('输入内容为空'); return; }
  try {
    var r = await fetch('/api/manual-input', {
      method: 'POST', headers: {'Content-Type':'application/json; charset=utf-8'},
      body: JSON.stringify({text: raw})
    });
    if (!r.ok) { showToast('解析失败'); return; }
    var d = await r.json();
    var offset = tagState.lines.length;
    d.lines.forEach(function(l, i) {
      tagState.lines.push({
        index: offset+i, original: l.original, translation: l.translation,
        file: '手动录入', tag_l1: '', tag_l2: '', confidence: 0
      });
    });
    if (tagState.fileNames.indexOf('手动录入') === -1) {
      tagState.fileNames.push('手动录入');
      tagState.files.push({name: '手动录入'});
    }
    tagRenderFileList();
    tagBtnState();
    tagRenderPreview();
    tagRenderColumns();
    document.getElementById('tagManualInput').value = '';
    showToast('已添加 ' + d.count + ' 行');
  } catch(e) { showToast('加载失败: ' + e.message); }
}

// ── 文件列表 ──
function tagRenderFileList() {
  var html = '';
  for (var i = 0; i < tagState.files.length; i++) {
    var f = tagState.files[i];
    var cnt = tagState.lines.filter(function(l) { return l.file === f.name; }).length;
    html += '<div class="file-entry"><span class="file-name">' + escHtml(f.name) +
      '</span><span class="file-count">' + cnt + ' 行</span>' +
      '<span class="file-delete" data-action="tag-delete-file" data-index="' + i + '">🗑</span></div>';
  }
  document.getElementById('tagFileInfo').innerHTML = html || '<div class="empty-state">暂无来源文件</div>';
}

function tagDeleteFile(index) {
  var f = tagState.files[index];
  if (!f) return;
  tagState.lines = tagState.lines.filter(function(l) { return l.file !== f.name; });
  tagState.lines.forEach(function(l, i) { l.index = i; });
  tagState.files.splice(index, 1);
  tagState.fileNames = tagState.files.map(function(x) { return x.name; });
  tagRenderFileList();
  tagRenderPreview();
  tagRenderColumns();
  tagBtnState();
}

// ── 收起/展开输入区 ──
var _tagCollapsed = false;
function tagToggleCollapse() {
  _tagCollapsed = !_tagCollapsed;
  var row = document.getElementById('tagTopRow');
  var icon = document.getElementById('tagCollapseIcon');
  var title = document.querySelector('#page-tag .collapse-title');
  if (_tagCollapsed) {
    row.classList.add('collapsed');
    icon.textContent = '▼';
    if (title) title.textContent = '展开';
  } else {
    row.classList.remove('collapsed');
    icon.textContent = '▲';
    if (title) title.textContent = '输入/预览';
  }
}

// ── 预览行数限制 ──
function tagOnRowLimitChange() { tagRenderPreview(); tagRenderColumns(); }
function tagOnCustomLimitChange() {}

// ── 预览列表 ──
function tagRenderPreview() {
  var q = tagState.query;
  setHighlight(q);
  var checkedFiles = tagState.files.map(function(f) { return f.name; });
  var filtered = tagState.lines.filter(function(l) {
    return !l.file || checkedFiles.indexOf(l.file) >= 0;
  });
  var lines = filtered.slice();
  if (q) {
    lines = lines.filter(function(l) {
      return matches(l.original, q) || matches(l.translation, q) || matches(l.tag_l2, q);
    });
  }
  var total = lines.length;
  var perPage = tagState.previewRowLimit || 200;
  var totalPages = Math.max(1, Math.ceil(total / perPage));
  if (tagState.previewPage > totalPages) tagState.previewPage = totalPages;
  if (tagState.previewPage < 1) tagState.previewPage = 1;
  var start = (tagState.previewPage - 1) * perPage;
  var pageLines = lines.slice(start, start + perPage);
  if (tagState.lines.length === 0) {
    document.getElementById('tagPreview').innerHTML = '<div class="empty-state">请先上传 txt 文件</div>';
    document.getElementById('tagPreviewCount').textContent = '0 行';
    return;
  }
  if (q && total === 0) {
    document.getElementById('tagPreview').innerHTML = '<div class="empty-state">无匹配结果</div>';
    document.getElementById('tagPreviewCount').textContent = '0 条匹配';
    return;
  }
  var html = '<div class="line-list">';
  pageLines.forEach(function(l) {
    var tagBadge = '';
    if (l.tag_l1) {
      var cat = getEnabledSchema()[l.tag_l1];
      tagBadge = '<span class="tag-badge" style="background:' + (cat ? cat.color : '#888') + '">' +
        escHtml(l.tag_l1) + (l.tag_l2 ? ' / ' + escHtml(l.tag_l2) : '') + '</span>';
    }
    html += '<div class="line-item">' +
      '<span class="line-num">' + (l.index + 1) + '</span>' +
      '<span class="line-text">' +
        '<span class="orig">' + hl(l.original) + '</span>' +
        (l.translation ? '<span class="sep">=</span><span class="tran">' + hl(l.translation) + '</span>' : '') +
        (l.tag_l1 ? '<span class="sep">\u2192</span><span style="color:var(--green)">' + hl(l.tag_l2 || l.tag_l1) + '</span>' : '') +
      '</span>' +
    '</div>';
  });
  html += '</div>';
  html += _renderPagination(total, perPage, tagState.previewPage, 'tag-preview');
  document.getElementById('tagPreview').innerHTML = html;
  _bindPagination('tagPreview', 'tag-preview', {
      onPage: function(p) { tagState.previewPage = p; tagRenderPreview(); },
      onRowsPerPage: function(v) { tagState.previewRowLimit = v; tagState.previewPage = 1; tagState.colPages = {}; tagRenderPreview(); tagRenderColumns(); }
    });
  document.getElementById('tagPreviewCount').textContent = q ? total + ' 条匹配' : filtered.length + ' 行';
}

// ── 分类栏（显示条数与预览下拉同步） ──

function tagRenderColumns() {
  var container = document.getElementById('tagColumns');
  if (!container) return;
  var schema = getEnabledSchema();
  var validL1 = Object.keys(schema);
  var perPage = tagState.previewRowLimit || 200;
  // 清洗数据：将不属于当前 schema 的词条重置为未分类
  tagState.lines.forEach(function(l) {
    if (l.tag_l1 && validL1.indexOf(l.tag_l1) === -1) {
      l.tag_l1 = '';
      l.tag_l2 = '';
      l.confidence = 0;
    }
    if (l.tag_l1 && schema[l.tag_l1]) {
      if (schema[l.tag_l1].subs.indexOf(l.tag_l2) === -1) {
        l.tag_l2 = schema[l.tag_l1].subs[0] || '';
      }
    }
  });
  // 校验后每次渲染都重建计数缓存（与渲染本身 O(n) 相比开销可忽略）
  _initTagCounts();
  var html = '';
  Object.keys(schema).forEach(function(l1) {
    var cat = schema[l1];
    var items = tagState.lines.filter(function(l) { return l.tag_l1 === l1; });
    var colId = 'tag-col-' + l1;
    var cp = _getColPage(colId, items.length, perPage);
    var shown = items.slice((cp - 1) * perPage, cp * perPage);
    html += '<div class="tag-column" data-l1="' + l1 + '">' +
      '<div class="tag-column-header" style="border-left:3px solid ' + cat.color + '">' +
      '<span class="tag-col-icon">' + cat.icon + '</span>' +
      '<span class="tag-col-title">' + escHtml(l1) + '</span>' +
      '<span class="tag-col-count" id="cnt-' + l1 + '">' + items.length + '</span></div>' +
      '<div class="tag-column-body" data-l1="' + l1 + '" data-action="tag-column-body">';
    shown.forEach(function(l) { html += tagRenderCard(l); });
    if (items.length === 0) html += '<div class="tag-column-empty">拖入词条或运行分词</div>';
    html += '</div>';
    html += _renderColPagination(colId, items.length, perPage);
    html += '</div>';
  });
  var untagged = tagState.lines.filter(function(l) { return !l.tag_l1; });
  var untaggedColId = 'tag-col-__untagged';
  var ucp = _getColPage(untaggedColId, untagged.length, perPage);
  var unShown = untagged.slice((ucp - 1) * perPage, ucp * perPage);
  html += '<div class="tag-column tag-column-untagged">' +
    '<div class="tag-column-header" style="border-left:3px solid #888">' +
    '<span class="tag-col-icon">📋</span><span class="tag-col-title">未分类</span>' +
    '<span class="tag-col-count" id="cnt-untagged">' + untagged.length + '</span></div>' +
    '<div class="tag-column-body" data-l1="" data-action="tag-column-body">';
  unShown.forEach(function(l) { html += tagRenderCard(l); });
  if (untagged.length === 0 && tagState.lines.length > 0) html += '<div class="tag-column-empty">所有词条已分类 ✓</div>';
  html += '</div>';
  html += _renderColPagination(untaggedColId, untagged.length, perPage);
  html += '</div>';
  container.innerHTML = html;
  // 绑定各列分页事件
  container.querySelectorAll('.tag-column').forEach(function(colEl) {
    _bindColPagination(colEl);
  });
  // 如果分类标签面板处于展开状态,同步刷新
  var catPanel = document.getElementById('tagCatPanel');
  if (catPanel && catPanel.classList.contains('visible')) tagRenderCatPanel();
}

// ── 分页状态管理 ──
function _getColPage(colId, total, perPage) {
  var p = tagState.colPages[colId] || 1;
  var maxP = Math.max(1, Math.ceil(total / perPage));
  if (p > maxP) p = maxP;
  tagState.colPages[colId] = p;
  return p;
}

// ── 渲染单列分页条（简洁版：翻页按钮 + 页码信息） ──
function _renderColPagination(colId, total, perPage) {
  if (total <= perPage) return '';
  var totalPages = Math.ceil(total / perPage);
  var currentPage = _getColPage(colId, total, perPage);
  var start = (currentPage - 1) * perPage + 1;
  var end = Math.min(currentPage * perPage, total);
  var html = '<div class="col-pagination">';
  html += '<button class="col-pg-btn" data-colpg="' + colId + '" data-page="' + (currentPage - 1) + '"' + (currentPage <= 1 ? ' disabled' : '') + '>&laquo;</button>';
  html += '<span class="col-pg-info">' + start + '-' + end + ' / ' + total + '</span>';
  html += '<button class="col-pg-btn" data-colpg="' + colId + '" data-page="' + (currentPage + 1) + '"' + (currentPage >= totalPages ? ' disabled' : '') + '>&raquo;</button>';
  html += '</div>';
  return html;
}

// ── 绑定单列分页事件 ──
function _bindColPagination(colEl) {
  colEl.querySelectorAll('.col-pg-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var colId = btn.dataset.colpg;
      var page = parseInt(btn.dataset.page);
      if (page < 1) return;
      tagState.colPages[colId] = page;
      // 优先轻量切换：只改可见性 + 更新分页条
      var body = colEl.querySelector('.tag-column-body');
      var perPage = tagState.previewRowLimit || 200;
      var totalCards = body ? body.querySelectorAll('.tag-card').length : 0;
      if (totalCards > perPage) {
        _applyColPageVisibility(body, page, perPage);
        var pgBar = colEl.querySelector('.col-pagination');
        if (pgBar) pgBar.outerHTML = _renderColPagination(colId, totalCards, perPage);
        _bindColPagination(colEl);
      } else {
        // 卡片数不超过 perPage，走全量渲染
        tagRenderColumns();
      }
    });
  });
}

// ── 增量更新单张卡片(分词进行时不重建整个列) ──
function tagUpdateOneCard(line) {
  // Schema 校验
  if (line.tag_l1) {
    var _schema = getEnabledSchema();
    if (!_schema[line.tag_l1]) {
      var _found = null;
      Object.keys(_schema).forEach(function(k) {
        if (_schema[k].subs.indexOf(line.tag_l1) >= 0) _found = k;
      });
      if (_found) {
        if (!line.tag_l2) line.tag_l2 = line.tag_l1;
        line.tag_l1 = _found;
      } else {
        line.tag_l1 = '';
        line.tag_l2 = '';
        line.confidence = 0;
      }
    }
  }
  var oldCard = document.querySelector('.tag-card[data-index="' + line.index + '"]');
  var cat = line.tag_l1 ? getEnabledSchema()[line.tag_l1] : null;
  var bc = cat ? cat.color : '#555';
  var expectedL1 = line.tag_l1 || '';

  if (oldCard) {
    var cardL1 = oldCard.getAttribute('data-l1') || '';
    if (cardL1 !== expectedL1) {
      // ── 卡片需要移动到新栏 ──
      var srcBody = oldCard.closest('.tag-column-body');
      oldCard.remove();
      // 源栏变空时恢复空状态提示
      if (srcBody && srcBody.querySelectorAll('.tag-card').length === 0) {
        var srcL1v = srcBody.dataset.l1 || '';
        var emptyMsg = (!srcL1v && tagState.lines.filter(function(l){return !l.tag_l1;}).length === 0 && tagState.lines.length > 0)
          ? '所有词条已分类 ✓' : '拖入词条或运行分词';
        srcBody.insertAdjacentHTML('beforeend', '<div class="tag-column-empty">' + emptyMsg + '</div>');
      }
      // 未分类栏：移除卡片后从池中回补，保持渲染数量
      if (!cardL1) {
        _backfillUntagged();
      }
      // 追加到目标栏末尾
      _appendCardToColumn(expectedL1, line);
      _tagBumpCount(cardL1, expectedL1);
    } else {
      // 已在正确栏，仅更新样式
      oldCard.style.borderLeftColor = bc;
      var tagEl = oldCard.querySelector('.tag-card-tag');
      if (tagEl) tagEl.innerHTML = line.tag_l2
        ? escHtml(line.tag_l2) + (line.confidence > 0 ? ' <span class="tag-confidence">' + Math.round(line.confidence*100) + '%</span>' : '')
        : '<span style="color:var(--text-muted)">未标注</span>' + (line.confidence > 0 ? ' <span class="tag-confidence">' + Math.round(line.confidence*100) + '%</span>' : '');
      oldCard.setAttribute('data-l1', expectedL1);
    }
  } else {
    // 新卡片，追加到目标栏
    _appendCardToColumn(expectedL1, line);
  }
  tagUpdateCounts();
}

// ── 追加卡片到指定栏（自动分页） ──
function _appendCardToColumn(l1, line) {
  var colEl = document.querySelector('.tag-column .tag-column-body[data-l1="' + (l1 || '') + '"]');
  if (!colEl) return;
  var column = colEl.closest('.tag-column');
  var empty = colEl.querySelector('.tag-column-empty');
  if (empty) empty.remove();
  colEl.insertAdjacentHTML('beforeend', tagRenderCard(line));
  var newCard = colEl.querySelector('.tag-card[data-index="' + line.index + '"]');
  if (newCard) newCard.setAttribute('data-l1', l1 || '');
  // 检查是否需要分页
  var perPage = tagState.previewRowLimit || 200;
  var totalCards = colEl.querySelectorAll('.tag-card').length;
  if (totalCards > perPage) {
    var colId = 'tag-col-' + (l1 || '__untagged');
    var existingPg = column.querySelector('.col-pagination');
    if (existingPg) existingPg.remove();
    colEl.insertAdjacentHTML('afterend', _renderColPagination(colId, totalCards, perPage));
    _bindColPagination(column);
    // 保持当前页，不自动跳转
    var curPage = tagState.colPages[colId] || 1;
    _applyColPageVisibility(colEl, curPage, perPage);
  }
}

// ── 应用列内卡片可见性（CSS 控制分页） ──
function _applyColPageVisibility(body, page, perPage) {
  var cards = body.querySelectorAll('.tag-card');
  var start = (page - 1) * perPage;
  var end = page * perPage;
  for (var i = 0; i < cards.length; i++) {
    cards[i].style.display = (i >= start && i < end) ? '' : 'none';
  }
}

// ── 未分类栏回补：从池中取下一个未显示的未分类条目补入 ──
function _backfillUntagged() {
  var body = document.querySelector('.tag-column-body[data-l1=""]');
  if (!body) return;
  var perPage = tagState.previewRowLimit || 200;
  var shown = body.querySelectorAll('.tag-card');
  if (shown.length >= perPage) return;
  // 收集当前已显示的 index
  var shownIdx = new Set();
  shown.forEach(function(c) { shownIdx.add(parseInt(c.dataset.index)); });
  // 找下一个未分类且未显示的条目
  for (var i = 0; i < tagState.lines.length; i++) {
    var l = tagState.lines[i];
    if (!l.tag_l1 && !shownIdx.has(l.index)) {
      var empty = body.querySelector('.tag-column-empty');
      if (empty) empty.remove();
      body.insertAdjacentHTML('beforeend', tagRenderCard(l));
      var card = body.querySelector('.tag-card[data-index="' + l.index + '"]');
      if (card) card.setAttribute('data-l1', '');
      if (shown.length + 1 >= perPage) break;
    }
  }
  // 回补后更新分页条总数
  _refreshColPagination(body);
}

// ── 刷新指定栏的分页条总数 ──
function _refreshColPagination(body) {
  var column = body.closest('.tag-column');
  if (!column) return;
  var pgBar = column.querySelector('.col-pagination');
  if (!pgBar) return;
  var l1 = body.dataset.l1;
  var colId = 'tag-col-' + (l1 || '__untagged');
  var total = body.querySelectorAll('.tag-card').length;
  var perPage = tagState.previewRowLimit || 200;
  pgBar.outerHTML = _renderColPagination(colId, total, perPage);
  _bindColPagination(column);
}

// ── 列头计数更新 ──
function _initTagCounts() {
  var schema = getEnabledSchema();
  var counts = {};
  Object.keys(schema).forEach(function(l1) { counts[l1] = 0; });
  var untagged = 0;
  tagState.lines.forEach(function(l) {
    if (l.tag_l1 && counts.hasOwnProperty(l.tag_l1)) {
      counts[l.tag_l1]++;
    } else {
      untagged++;
    }
  });
  counts['__untagged'] = untagged;
  tagState._tagCounts = counts;
}

function _tagBumpCount(oldL1, newL1) {
  var c = tagState._tagCounts;
  if (!c) return; // 未初始化时跳过（由 _initTagCounts 在 tagRenderColumns 中完成）
  oldL1 = oldL1 || '__untagged';
  newL1 = newL1 || '__untagged';
  if (oldL1 !== newL1) {
    if (c.hasOwnProperty(oldL1)) c[oldL1] = Math.max(0, (c[oldL1] || 1) - 1);
    if (c.hasOwnProperty(newL1)) c[newL1] = (c[newL1] || 0) + 1;
  }
}

function tagUpdateCounts() {
  var schema = getEnabledSchema();
  var c = tagState._tagCounts;
  if (!c) return;
  Object.keys(schema).forEach(function(l1) {
    var el = document.getElementById('cnt-' + l1);
    if (el) el.textContent = c[l1] || 0;
  });
  var ue = document.getElementById('cnt-untagged');
  if (ue) ue.textContent = c['__untagged'] || 0;
}

function tagRenderCard(l) {
  var cat = l.tag_l1 ? getEnabledSchema()[l.tag_l1] : null;
  var bc = cat ? cat.color : '#555';
  return '<div class="tag-card" draggable="true" data-index="' + l.index + '" data-l1="' + escHtml(l.tag_l1 || '') + '" ' +
    'data-action="tag-card" ' +
    'style="border-left:3px solid ' + bc + '">' +
    '<div class="tag-card-row1">' +
      '<span class="tag-card-num">#' + (l.index+1) + '</span>' +
      '<span class="tag-card-orig">' + escHtml(l.original) + '</span>' +
      '<span class="tag-card-actions"><button class="btn btn-sm" data-action="tag-edit-cat" data-index="' + l.index + '">✏️</button></span>' +
    '</div>' +
    (l.translation ? '<div class="tag-card-tran">' + escHtml(l.translation) + '</div>' : '') +
    '<div class="tag-card-tag">' + (l.tag_l2 ? escHtml(l.tag_l2) : '<span style="color:var(--text-muted)">未标注</span>') +
    (l.confidence > 0 ? ' <span class="tag-confidence">' + Math.round(l.confidence*100) + '%</span>' : '') +
    '</div></div>';
}


// ── 导入弹窗 ──
function tagImportDialog() {
  var tagged = tagState.lines.filter(function(l){return l.tag_l1;});
  if (tagged.length===0) { showToast('没有已分类的词条'); return; }

  var modal = document.getElementById('tagImportModal');
  if (!modal) {
    modal = document.createElement('div'); modal.id = 'tagImportModal';
    modal.className = 'modal-overlay'; modal.style.display = 'none';
    modal.innerHTML =
      '<div class="modal-box" style="max-width:440px">' +
        '<div class="exp-title"><span class="exp-title-icon">\u{1f4e5}</span><span>\u5bfc\u5165\u65b9\u6848</span></div>' +
        '<div class="exp-hint">\u5c06\u5206\u8bcd\u7ed3\u679c\u5bfc\u5165\u5230\u7ffb\u8bd1\u9875\uff0c\u81ea\u52a8\u53bb\u91cd</div>' +
        '<div class="exp-section">' +
          '<div class="exp-section-label">\u5bfc\u5165\u6a21\u5f0f</div>' +
          '<div class="exp-radio-group">' +
            '<label class="exp-radio-item"><input type="radio" name="tagImpMode" value="merge" checked><span class="exp-radio-text">\u5408\u5e76\u5bfc\u5165</span><span class="exp-radio-hint">\u5408\u4e3a\u4e00\u4e2a\u865a\u62df\u6587\u4ef6</span></label>' +
            '<label class="exp-radio-item"><input type="radio" name="tagImpMode" value="separate"><span class="exp-radio-text">\u5206\u522b\u5bfc\u5165</span><span class="exp-radio-hint">\u6bcf\u4e2a\u5206\u7c7b\u72ec\u7acb\u6587\u4ef6</span></label>' +
          '</div>' +
        '</div>' +
        '<div class="exp-section">' +
          '<div class="exp-section-label">\u5206\u7c7b\u7c92\u5ea6</div>' +
          '<div class="exp-radio-group">' +
            '<label class="exp-radio-item"><input type="radio" name="tagImpGran" value="l1" checked><span class="exp-radio-text">\u4e00\u7ea7\u7c7b\u76ee</span></label>' +
            '<label class="exp-radio-item"><input type="radio" name="tagImpGran" value="l2"><span class="exp-radio-text">\u4e8c\u7ea7\u7c7b\u76ee</span></label>' +
          '</div>' +
        '</div>' +
        '<label class="exp-checkbox-item"><input type="checkbox" id="tagImpUntagged" checked><span class="exp-radio-text">\u5305\u542b\u672a\u5206\u7c7b\u6761\u76ee</span></label>' +
        '<div class="exp-section">' +
          '<div class="exp-section-label">\u9884\u89c8</div>' +
          '<div class="exp-preview-box" id="tagImportPreview"></div>' +
        '</div>' +
        '<div class="exp-actions">' +
          '<button class="btn" id="tagImportCancel">\u53d6\u6d88</button>' +
          '<button class="btn btn-primary" data-action="tag-import-do">\u5bfc\u5165</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
    document.getElementById('tagImportCancel').onclick = function() { modal.style.display = 'none'; };

    modal.querySelectorAll('input[name="tagImpMode"], input[name="tagImpGran"], #tagImpUntagged').forEach(function(el) {
      el.addEventListener('change', _tagImportUpdatePreview);
    });
  }

  modal.style.display = 'flex';
  _tagImportUpdatePreview();
}

function _tagImportUpdatePreview() {
  var preview = document.getElementById('tagImportPreview'); if (!preview) return;
  var mode = (document.querySelector('input[name="tagImpMode"]:checked') || {}).value || 'merge';
  var gran = (document.querySelector('input[name="tagImpGran"]:checked') || {}).value || 'l1';
  var incUntagged = document.getElementById('tagImpUntagged').checked;
  var tagged = tagState.lines.filter(function(l){return l.tag_l1;});

  // Count duplicates
  var existingOriginals = new Set();
  if (typeof state !== 'undefined') state.lines.forEach(function(l) { existingOriginals.add(l.original); });

  if (gran === 'l2') {
    _tagImpPrevL2(preview, mode, tagged, incUntagged, existingOriginals);
  } else {
    _tagImpPrevL1(preview, mode, tagged, incUntagged, existingOriginals);
  }
}

function _tagImpPrevL1(preview, mode, tagged, incUntagged, existingOriginals) {
  var schema = getEnabledSchema(); var lines = []; var totalNew = 0;
  if (mode === 'separate') {
    var fileCount = Object.keys(schema).filter(function(k){return tagged.filter(function(l){return l.tag_l1===k;}).length>0;}).length;
    lines.push('<span style="color:var(--amber);font-weight:500">\u5206\u522b\u5bfc\u5165 ' + fileCount + ' \u4e2a\u865a\u62df\u6587\u4ef6</span>');
  } else {
    lines.push('<span style="color:var(--accent);font-weight:500">\u5408\u5e76\u5bfc\u5165\u4e3a 1 \u4e2a\u865a\u62df\u6587\u4ef6</span>');
  }
  Object.keys(schema).forEach(function(l1) {
    var items = tagged.filter(function(l){return l.tag_l1===l1;});
    if (items.length===0) return;
    var nw = items.filter(function(l){return !existingOriginals.has(l.original);}).length;
    var dup = items.length - nw;
    totalNew += nw;
    var bullet = mode==='separate' ? '<span style="color:var(--green-dim)">\u25b8</span> ' : '';
    lines.push(bullet + '<span style="color:var(--text)">' + escHtml(l1) + '</span> <span style="color:var(--text-muted)">' + items.length + ' \u6761</span>' + (dup>0?' <span style="color:var(--red-dim)">(-'+dup+' \u91cd\u590d)</span>':''));
  });
  if (incUntagged) {
    var u = tagState.lines.filter(function(l){return !l.tag_l1;});
    if (u.length>0) {
      var nwu = u.filter(function(l){return !existingOriginals.has(l.original);}).length;
      var dupu = u.length - nwu;
      totalNew += nwu;
      lines.push('<span style="color:var(--text-muted)">  \u672a\u5206\u7c7b ' + u.length + ' \u6761</span>' + (dupu>0?' <span style="color:var(--red-dim)">(-'+dupu+' \u91cd\u590d)</span>':''));
    }
  }
  lines.push('');
  lines.push('<span style="color:var(--green)">\u2714 \u5b9e\u9645\u5bfc\u5165 ' + totalNew + ' \u6761\uff08\u5df2\u53bb\u91cd\uff09</span>');
  preview.innerHTML = lines.join('<br>');
}

function _tagImpPrevL2(preview, mode, tagged, incUntagged, existingOriginals) {
  var schema = getEnabledSchema(); var totalFiles = 0; var lines = []; var totalNew = 0;
  Object.keys(schema).forEach(function(l1) {
    var items = tagged.filter(function(l){return l.tag_l1===l1;});
    if (items.length===0) return;
    var subs = {}; items.forEach(function(l){ var k = l.tag_l2||'\u672a\u7ec6\u5206'; if(!subs[k]) subs[k]=[]; subs[k].push(l); });
    var subKeys = Object.keys(subs);
    if (mode==='separate') totalFiles += subKeys.length;
    lines.push('<span style="color:var(--text)">' + escHtml(l1) + '</span>');
    subKeys.forEach(function(l2) {
      var subItems = subs[l2];
      var nw = subItems.filter(function(l){return !existingOriginals.has(l.original);}).length;
      var dup = subItems.length - nw;
      totalNew += nw;
      var bullet = mode==='separate' ? '<span style="color:var(--green-dim)">  \u25b8</span> ' : '    ';
      lines.push(bullet + '<span style="color:var(--text-secondary)">' + escHtml(l2) + '</span> <span style="color:var(--text-muted)">' + subItems.length + ' \u6761</span>' + (dup>0?' <span style="color:var(--red-dim)">(-'+dup+' \u91cd\u590d)</span>':''));
    });
  });
  if (incUntagged) {
    var u = tagState.lines.filter(function(l){return !l.tag_l1;});
    if (u.length>0) {
      var nwu = u.filter(function(l){return !existingOriginals.has(l.original);}).length;
      var dupu = u.length - nwu;
      totalNew += nwu;
      if (mode==='separate') totalFiles++;
      lines.push('<span style="color:var(--text-muted)">  \u672a\u5206\u7c7b ' + u.length + ' \u6761</span>' + (dupu>0?' <span style="color:var(--red-dim)">(-'+dupu+' \u91cd\u590d)</span>':''));
    }
  }
  if (mode === 'separate') {
    lines.unshift('<span style="color:var(--amber);font-weight:500">\u5206\u522b\u5bfc\u5165 ' + totalFiles + ' \u4e2a\u865a\u62df\u6587\u4ef6</span>');
  } else {
    lines.unshift('<span style="color:var(--accent);font-weight:500">\u5408\u5e76\u5bfc\u5165\u4e3a 1 \u4e2a\u865a\u62df\u6587\u4ef6</span>');
  }
  lines.push('');
  lines.push('<span style="color:var(--green)">\u2714 \u5b9e\u9645\u5bfc\u5165 ' + totalNew + ' \u6761\uff08\u5df2\u53bb\u91cd\uff09</span>');
  preview.innerHTML = lines.join('<br>');
}

function tagImportDo() {
  var mode = (document.querySelector('input[name="tagImpMode"]:checked') || {}).value || 'merge';
  var gran = (document.querySelector('input[name="tagImpGran"]:checked') || {}).value || 'l1';
  var incUntagged = document.getElementById('tagImpUntagged').checked;
  var modal = document.getElementById('tagImportModal');
  modal.style.display = 'none';
  tagSendToTranslate(mode, gran, incUntagged);
}


// ── 导入到翻译页(按分类分组,去重) ──
function tagSendToTranslate(mode, gran, incUntagged) {
  mode = mode || 'merge'; gran = gran || 'l1'; incUntagged = incUntagged !== false;
  if (typeof state === 'undefined') { showToast('翻译页未初始化'); return; }

  var selectedLines = [];
  var tagged = tagState.lines.filter(function(l){ return l.tag_l1; });
  if (gran === 'l2') {
    // L2: group by l1+l2
    var schema = getEnabledSchema();
    Object.keys(schema).forEach(function(l1) {
      var items = tagged.filter(function(l){return l.tag_l1===l1;});
      var subs = {}; items.forEach(function(l){ var k = l.tag_l2||'未细分'; if(!subs[k]) subs[k]=[]; subs[k].push(l); });
      Object.keys(subs).forEach(function(l2) {
        selectedLines.push({ key: l1 + ' / ' + l2, lines: subs[l2] });
      });
    });
    if (incUntagged) {
      var u = tagState.lines.filter(function(l){return !l.tag_l1;});
      if (u.length > 0) selectedLines.push({ key: '未分类', lines: u });
    }
  } else {
    // L1: group by l1
    Object.keys(getEnabledSchema()).forEach(function(l1) {
      var items = tagged.filter(function(l){return l.tag_l1===l1;});
      if (items.length > 0) selectedLines.push({ key: l1, lines: items });
    });
    if (incUntagged) {
      var u2 = tagState.lines.filter(function(l){return !l.tag_l1;});
      if (u2.length > 0) selectedLines.push({ key: '未分类', lines: u2 });
    }
  }
  if (selectedLines.length === 0) { showToast('没有已分类的条目可导入'); return; }

  // Build groups
  var groups = {};
  selectedLines.forEach(function(grp) {
    var key = mode === 'merge' ? 'tag_导入' : 'tag_' + grp.key;
    if (!groups[key]) groups[key] = [];
    grp.lines.forEach(function(l) { groups[key].push(l); });
  });

  // 去重:收集翻译页已有的 original 集合
  var existingOriginals = new Set();
  state.lines.forEach(function(l) { existingOriginals.add(l.original); });

  var totalAdded = 0;
  var fileNames = Object.keys(groups);
  fileNames.forEach(function(fname) {
    var groupLines = groups[fname];
    var virtualFile = 'tag_' + fname;
    var startIndex = state.lines.length;
    var newLines = [];
    groupLines.forEach(function(l, idx) {
      if (existingOriginals.has(l.original)) return; // 跳过重复
      newLines.push({
        original: l.original,
        translation: l.translation || '',
        new_translation: '',
        error: '',
        keepOld: false,
        truncated: false,
        warning: '',
        degraded: false,
        file: virtualFile,
        index: startIndex + newLines.length,
        _tag_l1: l.tag_l1,
        _tag_l2: l.tag_l2,
      });
    });
    if (newLines.length === 0) return;
    state.lines = state.lines.concat(newLines);
    if (state.fileNames.indexOf(virtualFile) === -1) {
      state.files.push({ name: virtualFile, checked: true });
      state.fileNames.push(virtualFile);
    }
    totalAdded += newLines.length;
  });

  if (totalAdded === 0) { showToast('所有条目已存在于翻译页'); return; }

  rebuildIndicesAndCheckboxes();
  renderFileList();
  renderPreview();
  renderCompare();
  updateTranslateAllButton();
  state.translateStarted = false;
  $('translateHint').style.display = 'none';

  tagRenderColumns();
  tagBtnState();
  showToast('已导入 ' + totalAdded + ' 行到翻译页(' + fileNames.length + ' 个分类)');
  switchPage('translate');
}

// ── 卡片拖拽 ──
var _tagDragIdx = -1;
// RAF-throttled drag state
var _dragOverTarget = null;
var _dragRafId = 0;

function tagCardDragStart(e) {
  var card = e.target.closest('.tag-card');
  _tagDragIdx = parseInt(card.dataset.index);
  e.dataTransfer.effectAllowed = 'move';
  // Freeze transitions on the dragged card for instant visual feedback
  card.style.transition = 'none';
  card.classList.add('dragging');
}

function tagCardDragEnd(e) {
  // Cancel any pending RAF
  if (_dragRafId) { cancelAnimationFrame(_dragRafId); _dragRafId = 0; }
  // Only clean the dragged card, not all cards
  var card = document.querySelector('.tag-card.dragging');
  if (card) { card.classList.remove('dragging'); card.style.transition = ''; }
  // Clean drag-over from all columns
  document.querySelectorAll('.tag-column-body.drag-over-col').forEach(function(el){
    el.classList.remove('drag-over-col');
  });
  _dragOverTarget = null;
}

function _tagApplyDragOver() {
  _dragRafId = 0;
  // Remove old highlight
  if (_dragOverTarget) _dragOverTarget.classList.remove('drag-over-col');
  // Get current element under cursor (use the last known target from drag events)
  // This is set by tagDragOver/tagDragLeave before the RAF
}

function tagDragOver(e, t) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (_dragOverTarget === t) return; // same target, skip
  // Clear old target immediately
  if (_dragOverTarget) _dragOverTarget.classList.remove('drag-over-col');
  _dragOverTarget = t;
  // Apply new highlight only once per frame
  if (!_dragRafId) _dragRafId = requestAnimationFrame(function(){
    _dragRafId = 0;
    if (_dragOverTarget) _dragOverTarget.classList.add('drag-over-col');
  });
}

function tagDragLeave(e, t) {
  // Only clear if leaving the current highlighted target
  if (_dragOverTarget === t) {
    t.classList.remove('drag-over-col');
    _dragOverTarget = null;
  }
}
function tagDrop(e, t) {
  e.preventDefault(); t.classList.remove('drag-over-col');
  var targetL1 = t.dataset.l1;
  if (_tagDragIdx < 0) return;
  var line = tagState.lines[_tagDragIdx]; if (!line) return;
  var targetCard = e.target.closest('.tag-card');
  // Determine insert position: before or after target card based on mouse Y
  var insertBefore = false;
  if (targetCard) {
    var rect = targetCard.getBoundingClientRect();
    insertBefore = (e.clientY < rect.top + rect.height / 2);
  }
  if (targetCard && parseInt(targetCard.dataset.index) !== _tagDragIdx) {
    var tIdx = parseInt(targetCard.dataset.index);
    var tLine = tagState.lines[tIdx];
    if (tLine && line.tag_l1 === tLine.tag_l1) {
      // Same L1: reorder
      tagState.lines.splice(_tagDragIdx, 1);
      var ni = tagState.lines.indexOf(tLine);
      if (!insertBefore) ni++;
      tagState.lines.splice(ni, 0, line);
      tagState.lines.forEach(function(l,i){l.index=i;});
      tagRenderColumns(); tagRenderPreview();
      showToast('已调整顺序'); _tagDragIdx = -1; return;
    }
  }
  var oldL1 = line.tag_l1;
  line.tag_l1 = targetL1;
  var dropSchema = getEnabledSchema();
  if (targetL1 && dropSchema[targetL1]) {
    if (!line.tag_l2 || (dropSchema[oldL1] && dropSchema[oldL1].subs.indexOf(line.tag_l2)===-1))
      line.tag_l2 = dropSchema[targetL1].subs[0] || '';
  } else { line.tag_l1 = ''; line.tag_l2 = ''; }
  _tagBumpCount(oldL1, line.tag_l1);
  // Cross-L1: insert at position or append
  if (targetCard && parseInt(targetCard.dataset.index) !== _tagDragIdx) {
    var tIdx2 = parseInt(targetCard.dataset.index);
    var tLine2 = tagState.lines[tIdx2];
    if (tLine2) {
      tagState.lines.splice(_tagDragIdx, 1);
      var ni2 = tagState.lines.indexOf(tLine2);
      if (!insertBefore) ni2++;
      tagState.lines.splice(ni2, 0, line);
      tagState.lines.forEach(function(l,i){l.index=i;});
    }
  }
  // If moving to a different L1 that has subs, re-tag via LLM
  if (targetL1 && targetL1 !== oldL1 && dropSchema[targetL1] && dropSchema[targetL1].subs.length > 0) {
    _tagRetagOnDrop(line, targetL1);
  }
  tagRenderColumns(); tagRenderPreview();
  showToast('已移至 ' + (targetL1 || '未分类')); _tagDragIdx = -1;
}


// ── 拖拽跨L1重新分词 ──
async function _tagRetagOnDrop(line, targetL1) {
  var schema = getEnabledSchema();
  var cat = schema[targetL1];
  if (!cat || !cat.subs.length) return;

  var fullText = line.original || '';
  tagLog('\u2192 \u91cd\u65b0\u5206\u8bcd "' + fullText + '" \u2192 ' + targetL1 + '/' + cat.subs.join(','));

  // Mark as re-tagging (visual feedback)
  line._retagging = true;
  line.confidence = 0;
  tagUpdateOneCard(line);

  var strategyText = (
    document.getElementById('tagStrategyText') &&
    document.getElementById('tagStrategyText').value.trim()
  ) || '\u4f60\u662f\u4e00\u4e2a\u6e38\u620f\u6587\u672c\u5206\u7c7b\u4e13\u5bb6\u3002\u8bf7\u5c06\u4ee5\u4e0b\u6587\u672c\u5f52\u5165\u6700\u5408\u9002\u7684\u7c7b\u522b\u3002';

  var subsDesc = cat.subs.join(', ');
  var prompt = strategyText + '\n\n\u8be5\u6761\u76ee\u5df2\u786e\u5b9a\u5c5e\u4e8e"' + targetL1 + '"\u7c7b\u522b\u3002\u8bf7\u5c06\u5176\u5f52\u5165\u4ee5\u4e0b\u5b50\u7c7b\u4e4b\u4e00:\n' + subsDesc + '\n\n\u8bf7\u4e25\u683c\u8f93\u51faJSON:{"l1":"' + targetL1 + '","l2":"\u5b50\u7c7b\u540d\u79f0","confidence":0.0~1.0}\n\u53ea\u8f93\u51faJSON\u3002';

  var ok = false;
  try {
    var apiConfig = tagGetApiConfig();
    var _rt = document.getElementById('tagTemperature');
    var _rp = document.getElementById('tagTopP');
    var _rm = document.getElementById('tagMaxTokens');
    var retagLLM = {};
    if (_rt) retagLLM.temperature = parseFloat(_rt.value) || 0.1;
    if (_rp) retagLLM.top_p = parseFloat(_rp.value) || 0.6;
    if (_rm) retagLLM.max_tokens = parseInt(_rm.value) || 512;
    var body = Object.assign({
      items: [{ original: line.original, translation: line.translation || line.original }],
      concurrency: 1,
      system_prompt: prompt,
    }, retagLLM, apiConfig);

    var r = await fetch('/api/tag-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      tagLog('\u2717 \u91cd\u5206\u8bcd\u5931\u8d25: HTTP ' + r.status + ' "' + fullText + '"', 'err');
    } else {
      var text = await r.text();
      tagLog('  重分词 API 返回: ' + text.substring(0, 200));
      var jsonLines = text.trim().split('\n');
      for (var li = jsonLines.length - 1; li >= 0; li--) {
        var t = jsonLines[li].trim(); if (!t) continue;
        try {
          var res = JSON.parse(t);
          if (res.error) {
            tagLog('\u2717 \u91cd\u5206\u8bcd\u5931\u8d25 "' + fullText + '": ' + res.error, 'err');
            break;
          }
          var l2 = (res.tag_l2 || '').trim();
          if (l2) {
            // Trim and do indexOf on subs (both sides trimmed)
            var matched = cat.subs.some(function(s) { return s.trim() === l2; });
            if (matched) {
              line.tag_l2 = l2;
              line.confidence = res.confidence || 0;
              ok = true;
              tagLog('\u2713 \u91cd\u5206\u8bcd\u6210\u529f "' + fullText + '" \u2192 ' + targetL1 + '/' + l2 + ' (' + Math.round((res.confidence||0)*100) + '%)', 'ok');
              break;
            }
          }
        } catch (e) {}
      }
      if (!ok && res && res.tag_l2) tagLog('\u26a0 \u91cd\u5206\u8bcd\u672a\u5339\u914d\u5b50\u7c7b "' + fullText + '": \u8fd4\u56de="' + (res.tag_l2||'').trim() + '", \u671f\u671b=' + cat.subs.join('|') + '\u2192\u4fdd\u6301\u9ed8\u8ba4 ' + targetL1 + '/' + line.tag_l2);
      else if (!ok) tagLog('\u26a0 \u91cd\u5206\u8bcd\u65e0\u6709\u6548\u5b50\u7c7b\u8f93\u51fa "' + fullText + '"\u2192\u4fdd\u6301\u9ed8\u8ba4 ' + targetL1 + '/' + line.tag_l2);
    }
  } catch (e) {
    tagLog('\u2717 \u91cd\u5206\u8bcd\u5f02\u5e38 "' + fullText + '": ' + (e.message || e), 'err');
  }
  line._retagging = false;
  tagUpdateOneCard(line);
}

// ── 编辑卡片分类 ──
function tagEditCategory(index) {
  var line = tagState.lines[index]; if (!line) return;
  var allSubs = getAllSubCategories();
  var options = '<option value="">未分类</option>';
  allSubs.forEach(function(s) {
    var sel = (line.tag_l1===s.l1 && line.tag_l2===s.l2) ? ' selected' : '';
    options += '<option value="'+s.l1+'|'+s.l2+'"'+sel+'>'+s.label+'</option>';
  });
  var modal = document.getElementById('tagEditModal');
  if (!modal) {
    modal = document.createElement('div'); modal.id = 'tagEditModal';
    modal.className = 'modal-overlay'; modal.style.display = 'none';
    modal.innerHTML = '<div class="modal-box"><div class="modal-msg">修改分类</div>' +
      '<div id="tagEditContent"></div><div class="modal-actions">' +
      '<button class="btn btn-primary" id="tagEditOk">确定</button>' +
      '<button class="btn" id="tagEditCancel">取消</button></div></div>';
    document.body.appendChild(modal);
    // 点击遮罩关闭
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
    // Enter 确定,Escape 关闭
    modal.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('tagEditOk').click(); }
      if (e.key === 'Escape') { modal.style.display = 'none'; }
    });
  }
  document.getElementById('tagEditContent').innerHTML =
    '<div style="margin-bottom:10px;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:6px;border-left:3px solid var(--accent)">' +
      '<div style="margin-bottom:4px"><span style="font-size:0.72rem;color:var(--text-muted)">原文</span></div>' +
      '<div style="font-size:0.82rem;color:var(--text);line-height:1.5;word-break:break-all">' + escHtml(line.original) + '</div>' +
      (line.translation ? '<div style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.06);padding-top:6px">' +
        '<div style="margin-bottom:2px"><span style="font-size:0.72rem;color:var(--text-muted)">译文</span></div>' +
        '<div style="font-size:0.82rem;color:var(--accent);line-height:1.5;word-break:break-all">' + escHtml(line.translation) + '</div></div>' : '') +
    '</div>' +
    '<div style="position:relative;margin-bottom:8px"><input type="text" id="tagEditSearch" placeholder="搜索类目..." class="param-input" style="width:100%" data-action="tag-edit-filter" autocomplete="off">' +
    '<div id="tagEditDropdown" class="tag-edit-dropdown" style="display:none"></div></div>' +
    '<select id="tagEditSelect" class="param-input" style="width:100%;margin-top:4px" data-action="tag-edit-select-change">' + options + '</select>';
  modal.style.display = 'flex'; modal._index = index;
  document.getElementById('tagEditOk').onclick = function() {
    var sel = document.getElementById('tagEditSelect').value;
    var _oldL1_ep = line.tag_l1;
    if (sel) { var p = sel.split('|'); line.tag_l1 = p[0]; line.tag_l2 = p[1]||''; }
    else { line.tag_l1 = ''; line.tag_l2 = ''; }
    _tagBumpCount(_oldL1_ep, line.tag_l1);
    line._manualEdit = true;  // 标记为手动编辑,防止被 LLM 结果覆盖
    modal.style.display = 'none'; tagRenderColumns(); tagRenderPreview();
  };
  document.getElementById('tagEditCancel').onclick = function() { modal.style.display = 'none'; };
  setTimeout(function(){ document.getElementById('tagEditSearch').focus(); }, 100);
}
function tagEditSelectChange() { var s=document.getElementById('tagEditSelect'); document.getElementById('tagEditSearch').value=s.options[s.selectedIndex].text; }
function tagEditFilter() {
  var q = document.getElementById('tagEditSearch').value.trim().toLowerCase();
  var dd = document.getElementById('tagEditDropdown');
  if (!q) { dd.style.display='none'; return; }
  var matchItems = getAllSubCategories().filter(function(s){ return s.label.toLowerCase().indexOf(q)>=0 || s.l2.toLowerCase().indexOf(q)>=0; });
  if (matchItems.length===0) { dd.style.display='none'; return; }
  var editSchema = getEnabledSchema();
  var h=''; matchItems.forEach(function(s){ h+='<div class="tag-edit-option" data-action="tag-edit-pick" data-l1="'+s.l1+'" data-l2="'+s.l2+'"><span style="color:'+(editSchema[s.l1]?editSchema[s.l1].color:'#888')+'">'+escHtml(s.l1)+'</span> / '+escHtml(s.l2)+'</div>'; });
  dd.innerHTML=h; dd.style.display='block';
}
function tagEditPick(l1,l2) {
  document.getElementById('tagEditSearch').value=l1+' / '+l2;
  document.getElementById('tagEditDropdown').style.display='none';
  var sel=document.getElementById('tagEditSelect'); var t=l1+'|'+l2;
  for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===t){sel.selectedIndex=i;break;}}
}

// ── 活跃分词请求控制器集（供 tagStop 即时取消所有进行中的请求） ──
var _tagActiveControllers = null;

function tagAbortActiveRequests() {
  if (_tagActiveControllers) {
    _tagActiveControllers.forEach(function (ctrl) { ctrl.abort(); });
    _tagActiveControllers.clear();
    _tagActiveControllers = null;
  }
}

// ── 批量分词（滑动窗口并发池：每个条目独立请求，即时可停止） ──
async function tagStart() {
  if (tagState.translating || tagState.lines.length===0) return;

  // 区分"继续分词"和"重新分词全部"
  var pending = tagState.lines.filter(function(l) { return !l.tag_l1; });
  var hasCompleted = tagState.lines.some(function(l) { return l.tag_l1; });
  if (pending.length === 0 && hasCompleted) {
    // 全部已完成 → 清空重来
    tagState.lines.forEach(function(l) { l.tag_l1 = ''; l.tag_l2 = ''; l.confidence = 0; });
    _initTagCounts();
    pending = tagState.lines.slice();
  }
  if (pending.length === 0) { showToast('没有待分词的条目'); return; }
  // 确保计数缓存已初始化（流式过程中 _tagBumpCount 依赖它）
  if (!tagState._tagCounts) _initTagCounts();

  var concurrency = parseInt(document.getElementById('tagConcurrency').value) || 5;

  tagState.translating = true; tagState.abort = false; tagState.tagStarted = true;
  document.getElementById('tagBtnStart').disabled = true;
  document.getElementById('tagBtnStop').disabled = false;
  _tagStartRuntime(); tagLogClear();
  tagLog('开始分词,共 ' + pending.length + ' 行,并发 ' + concurrency + '（即时可停止）');

  var apiConfig = tagGetApiConfig();
  var systemPrompt = document.getElementById('tagStrategyText');
  var strategyText = (systemPrompt && systemPrompt.value.trim()) || '你是一个游戏文本分类专家。请将以下文本归入最合适的类别。';
  var catDesc = '';
  var llmSchema = getEnabledSchema();
  Object.keys(llmSchema).forEach(function(l1) { catDesc += l1+': '+llmSchema[l1].subs.join(', ')+'\n'; });
  var fullPrompt = strategyText + '\n\n可用类别(一级 / 二级):\n' + catDesc + '\n请严格输出以下JSON格式:{"l1":"一级类目","l2":"二级类目","confidence":0.0~1.0}\n只输出JSON,不要其他内容。';

  var total = pending.length, done = 0, errors = 0;
  var activeControllers = new Set();
  _tagActiveControllers = activeControllers;
  var queue = pending.slice();

  // tagLLM 参数提取（从 DOM 中获取，每次请求复用）
  var tagLLM = {};
  var _tEl = document.getElementById('tagTemperature');
  var _pEl = document.getElementById('tagTopP');
  var _mEl = document.getElementById('tagMaxTokens');
  if (_tEl) tagLLM.temperature = parseFloat(_tEl.value) || 0.1;
  if (_pEl) tagLLM.top_p = parseFloat(_pEl.value) || 0.6;
  if (_mEl) tagLLM.max_tokens = parseInt(_mEl.value) || 512;

  document.getElementById('tagProgressFill').style.width = '0%';
  document.getElementById('tagProgressText').textContent = '进度: 0/' + total + ' · 并发' + concurrency;

  await new Promise(function (resolve) {
    function launchNext() {
      if (tagState.abort || queue.length === 0) {
        if (activeControllers.size === 0) resolve();
        return;
      }

      var item = queue.shift();
      var controller = new AbortController();
      activeControllers.add(controller);

      var bodyObj = Object.assign({ text: item.original, system_prompt: fullPrompt }, tagLLM, apiConfig);

      fetch('/api/tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
        signal: controller.signal,
      })
        .then(async function (res) {
          activeControllers.delete(controller);
          if (res.ok) {
            var d = await res.json();
            if (d.translation && !item._manualEdit) {
              var raw = d.translation.trim();
              var parsed = null;
              try {
                var clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                parsed = JSON.parse(clean);
              } catch (ex) {}
              var l1 = '', l2 = '', conf = 0;
              if (parsed && parsed.l1) {
                l1 = parsed.l1.trim();
                l2 = (parsed.l2 || '').trim();
                conf = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
              } else {
                l1 = raw;
              }
              if (l1) {
                var sk = Object.keys(getEnabledSchema());
                var ml1 = sk.find(function(k) { return k.toLowerCase() === l1.toLowerCase(); });
                if (ml1) l1 = ml1;
                else {
                  var fp = null;
                  sk.forEach(function(k) { if (getEnabledSchema()[k].subs.indexOf(l1) >= 0) fp = k; });
                  if (fp) { if (!l2) l2 = l1; l1 = fp; }
                  else { var fz = sk.find(function(k) { return k.toLowerCase().indexOf(l1.toLowerCase())>=0||l1.toLowerCase().indexOf(k.toLowerCase())>=0;}); l1 = fz || ''; }
                }
                item.tag_l1 = l1;
                item.tag_l2 = l2;
                item.confidence = conf;
                tagUpdateOneCard(item);
              }
            } else if (d.error) {
              errors++;
            }
            done++;
          } else {
            errors++;
            done++;
          }
          var sc = done - errors;
          document.getElementById('tagProgressFill').style.width = (done/total*100)+'%';
          document.getElementById('tagProgressText').textContent = '进度: '+done+'/'+total+' · 成功'+sc+' · 失败'+errors;
          launchNext();
        })
        .catch(function (err) {
          activeControllers.delete(controller);
          if (err.name !== 'AbortError') {
            errors++;
          }
          done++;
          var sc = done - errors;
          document.getElementById('tagProgressFill').style.width = (done/total*100)+'%';
          document.getElementById('tagProgressText').textContent = '进度: '+done+'/'+total+' · 成功'+sc+' · 失败'+errors;
          launchNext();
        });
    }

    for (var i = 0; i < Math.min(concurrency, total); i++) {
      launchNext();
    }
  });

  _tagActiveControllers = null;
  tagState.translating=false; tagState.abort=false; _tagStopRuntime();
  // 全部完成时清除 started 标志
  var stillPending = tagState.lines.filter(function(l) { return !l.tag_l1; }).length;
  if (stillPending === 0) tagState.tagStarted = false;
  tagRenderColumns();
  tagRenderPreview();
  tagUpdateTagStartButton();
  document.getElementById('tagBtnStop').disabled=true;
  tagLog('分词结束: 成功'+(done-errors)+'行'+(errors?' · 失败'+errors+'行':''), errors?'err':'ok');
  showToast('分词完成:成功'+(done-errors)+'行'+(errors?',失败'+errors+'行':''));
  tagBtnState();
}

function tagStop() { tagState.abort = true; tagAbortActiveRequests(); document.getElementById('tagBtnStop').disabled = true; showToast('正在停止...'); }

function tagUpdateTagStartButton() {
  var btn = document.getElementById('tagBtnStart');
  if (!btn) return;
  if (tagState.translating) {
    btn.disabled = true;
    btn.textContent = '分词中...';
    return;
  }
  if (tagState.lines.length === 0) {
    btn.disabled = true;
    btn.textContent = '开始分词';
    return;
  }
  var pending = tagState.lines.filter(function(l) { return !l.tag_l1; });
  var hasCompleted = tagState.lines.some(function(l) { return l.tag_l1; });
  if (tagState.tagStarted && pending.length > 0) {
    btn.disabled = false;
    btn.textContent = '继续分词 (' + pending.length + ')';
  } else if (hasCompleted) {
    btn.disabled = false;
    btn.textContent = '重新分词全部';
  } else {
    btn.disabled = false;
    btn.textContent = '开始分词';
  }
}

function tagClearAll() {
  if (tagState.lines.length===0) return;
  tagState.lines=[]; tagState.files=[]; tagState.fileNames=[]; tagState.query=''; tagState.tagStarted=false; tagState._tagCounts = null;
  document.getElementById('tagSearch').value='';
  document.getElementById('tagManualInput').value='';
  tagRenderFileList(); tagRenderPreview(); tagRenderColumns();
  document.getElementById('tagBtnStart').disabled=true;
  document.getElementById('tagBtnClear').disabled=true;
  tagLogClear(); tagLog('已清除所有数据'); showToast('已清除');
}

// ── 导出 ──
function tagExport() {
  var tagged = tagState.lines.filter(function(l){return l.tag_l1;});
  if (tagged.length===0) { showToast('没有已分类的词条'); return; }
  var parts = [], total = 0;
  var exportSchema = getEnabledSchema();
  Object.keys(exportSchema).forEach(function(l1) {
    var items = tagged.filter(function(l){return l.tag_l1===l1;});
    if (items.length===0) return;
    parts.push('=== '+l1+' ('+items.length+'条) ===');
    var subs = {}; items.forEach(function(l){ var k=l.tag_l2||'未细分'; if(!subs[k])subs[k]=[]; subs[k].push(l); });
    var subKeys = Object.keys(subs);
    subKeys.forEach(function(l2) {
      if (subKeys.length>1) parts.push('--- '+l2+' ---');
      subs[l2].forEach(function(l) { parts.push(l.translation ? l.original+'='+l.translation : l.original); });
    });
    parts.push(''); total += items.length;
  });
  var untagged = tagState.lines.filter(function(l){return !l.tag_l1;});
  if (untagged.length>0) {
    parts.push('=== 未分类 ('+untagged.length+'条) ===');
    untagged.forEach(function(l) { parts.push(l.translation ? l.original+'='+l.translation : l.original); });
  }
  tagTriggerDownload('tag_result.txt', parts.join('\n').trimEnd());
  tagLog('导出: tag_result.txt ('+total+'条已分类, '+untagged.length+'条未分类)');
  showToast('已导出 tag_result.txt');
}

function tagExportSeparate() {
  var tagged = tagState.lines.filter(function(l){return l.tag_l1;});
  if (tagged.length===0) { showToast('没有已分类的词条'); return; }
  var cats = Object.keys(getEnabledSchema()), files = 0;
  (function next(i) {
    if (i>=cats.length) {
      var u = tagState.lines.filter(function(l){return !l.tag_l1;});
      if (u.length>0) { tagTriggerDownload('未分类.txt', u.map(function(l){return l.translation?l.original+'='+l.translation:l.original;}).join('\n')); files++; }
      showToast('已导出 '+files+' 个文件'); return;
    }
    var items = tagged.filter(function(l){return l.tag_l1===cats[i];});
    if (items.length>0) { tagTriggerDownload(cats[i]+'.txt', items.map(function(l){return l.translation?l.original+'='+l.translation:l.original;}).join('\n')); files++; }
    setTimeout(function(){next(i+1);}, 200);
  })(0);
}


// ── 导出弹窗 ──
function tagExportDialog() {
  var tagged = tagState.lines.filter(function(l){return l.tag_l1;});
  if (tagged.length===0) { showToast('没有已分类的词条'); return; }

  var modal = document.getElementById('tagExportModal');
  if (!modal) {
    modal = document.createElement('div'); modal.id = 'tagExportModal';
    modal.className = 'modal-overlay'; modal.style.display = 'none';
    modal.innerHTML =
      '<div class="modal-box" style="max-width:440px">' +
        '<div class="exp-title"><span class="exp-title-icon">📤</span><span>导出方案</span></div>' +
        '<div class="exp-hint">多文件分别导出需浏览器授权自动下载</div>' +
        '<div class="exp-section">' +
          '<div class="exp-section-label">导出模式</div>' +
          '<div class="exp-radio-group">' +
            '<label class="exp-radio-item"><input type="radio" name="tagExpMode" value="merge" checked><span class="exp-radio-text">合并导出</span><span class="exp-radio-hint">单个文件</span></label>' +
            '<label class="exp-radio-item"><input type="radio" name="tagExpMode" value="separate"><span class="exp-radio-text">分别导出</span><span class="exp-radio-hint">多个文件</span></label>' +
          '</div>' +
        '</div>' +
        '<div class="exp-section">' +
          '<div class="exp-section-label">分类粒度</div>' +
          '<div class="exp-radio-group">' +
            '<label class="exp-radio-item"><input type="radio" name="tagExpGran" value="l1" checked><span class="exp-radio-text">一级类目</span></label>' +
            '<label class="exp-radio-item"><input type="radio" name="tagExpGran" value="l2"><span class="exp-radio-text">二级类目</span></label>' +
          '</div>' +
        '</div>' +
        '<label class="exp-checkbox-item"><input type="checkbox" id="tagExpUntagged" checked><span class="exp-radio-text">包含未分类条目</span></label>' +
        '<div class="exp-section">' +
          '<div class="exp-section-label">预览</div>' +
          '<div class="exp-preview-box" id="tagExportPreview"></div>' +
        '</div>' +
        '<div class="exp-actions">' +
          '<button class="btn" id="tagExportCancel">取消</button>' +
          '<button class="btn btn-primary" data-action="tag-export-do">导出</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
    document.getElementById('tagExportCancel').onclick = function() { modal.style.display = 'none'; };

    // Update preview on radio change
    modal.querySelectorAll('input[name="tagExpMode"], input[name="tagExpGran"], #tagExpUntagged').forEach(function(el) {
      el.addEventListener('change', _tagExportUpdatePreview);
    });
  }

  modal.style.display = 'flex';
  _tagExportUpdatePreview();
}

function _tagExportUpdatePreview() {
  var preview = document.getElementById('tagExportPreview'); if (!preview) return;
  var mode = (document.querySelector('input[name="tagExpMode"]:checked') || {}).value || 'merge';
  var gran = (document.querySelector('input[name="tagExpGran"]:checked') || {}).value || 'l1';
  var incUntagged = document.getElementById('tagExpUntagged').checked;
  var tagged = tagState.lines.filter(function(l){return l.tag_l1;});

  if (gran === 'l2') {
    prevL2(preview, mode, tagged, incUntagged);
  } else {
    prevL1(preview, mode, tagged, incUntagged);
  }
}

function prevL1(preview, mode, tagged, incUntagged) {
  var schema = getEnabledSchema(); var lines = [];
  if (mode === 'separate') {
    var fileCount = Object.keys(schema).filter(function(k){return tagged.filter(function(l){return l.tag_l1===k;}).length>0;}).length;
    lines.push('<span style="color:var(--amber);font-weight:500">' + fileCount + ' 个文件</span>');
  } else {
    lines.push('<span style="color:var(--accent);font-weight:500">合并为 1 个文件</span>');
  }
  Object.keys(schema).forEach(function(l1) {
    var cnt = tagged.filter(function(l){return l.tag_l1===l1;}).length;
    if (cnt > 0) {
      var bullet = mode === 'separate' ? '<span style="color:var(--green-dim)">▸</span> ' : '';
      lines.push(bullet + '<span style="color:var(--text)">' + escHtml(l1) + '</span> <span style="color:var(--text-muted)">' + cnt + ' 条</span>');
    }
  });
  if (incUntagged) {
    var u = tagState.lines.filter(function(l){return !l.tag_l1;}).length;
    if (u > 0) lines.push('<span style="color:var(--text-muted)">  未分类 ' + u + ' 条</span>');
  }
  preview.innerHTML = lines.join('<br>');
}

function prevL2(preview, mode, tagged, incUntagged) {
  var schema = getEnabledSchema(); var totalFiles = 0; var lines = [];
  Object.keys(schema).forEach(function(l1) {
    var items = tagged.filter(function(l){return l.tag_l1===l1;});
    var subs = {}; items.forEach(function(l){ var k = l.tag_l2||'未细分'; if(!subs[k]) subs[k]=0; subs[k]++; });
    var subKeys = Object.keys(subs);
    if (mode==='separate') totalFiles += subKeys.length;
    if (subKeys.length > 0) {
      lines.push('<span style="color:var(--text)">' + escHtml(l1) + '</span>');
      subKeys.forEach(function(l2) {
        var bullet = mode==='separate' ? '<span style="color:var(--green-dim)">  ▸</span> ' : '    ';
        lines.push(bullet + '<span style="color:var(--text-secondary)">' + escHtml(l2) + '</span> <span style="color:var(--text-muted)">' + subs[l2] + ' 条</span>');
      });
    }
  });
  if (incUntagged) {
    var u = tagState.lines.filter(function(l){return !l.tag_l1;}).length;
    if (u > 0) { lines.push('<span style="color:var(--text-muted)">  未分类 ' + u + ' 条</span>'); if (mode==='separate') totalFiles++; }
  }
  if (mode === 'separate') {
    lines[0] = '<span style="color:var(--amber);font-weight:500">分别导出 ' + totalFiles + ' 个文件</span>';
  }
  preview.innerHTML = lines.join('<br>');
}

function tagExportDo() {
  var mode = (document.querySelector('input[name="tagExpMode"]:checked') || {}).value || 'merge';
  var gran = (document.querySelector('input[name="tagExpGran"]:checked') || {}).value || 'l1';
  var incUntagged = document.getElementById('tagExpUntagged').checked;
  var modal = document.getElementById('tagExportModal');
  modal.style.display = 'none';

  var tagged = tagState.lines.filter(function(l){return l.tag_l1;});

  if (mode === 'merge') {
    // 合并导出
    var parts = [], total = 0;
    var schema = getEnabledSchema();

    if (gran === 'l1') {
      Object.keys(schema).forEach(function(l1) {
        var items = tagged.filter(function(l){return l.tag_l1===l1;});
        if (items.length===0) return;
        parts.push('=== '+l1+' ('+items.length+'条) ===');
        var subs = {}; items.forEach(function(l){ var k=l.tag_l2||'未细分'; if(!subs[k])subs[k]=[]; subs[k].push(l); });
        var subKeys = Object.keys(subs);
        subKeys.forEach(function(l2) {
          if (subKeys.length>1) parts.push('--- '+l2+' ---');
          subs[l2].forEach(function(l) { parts.push(l.translation ? l.original+'='+l.translation : l.original); });
        });
        parts.push(''); total += items.length;
      });
    } else {
      // L2 粒度：以二级类目作为分组头
      var l2Groups = {};
      Object.keys(schema).forEach(function(l1) {
        var items = tagged.filter(function(l){return l.tag_l1===l1;});
        items.forEach(function(l) {
          var key = l1 + ' / ' + (l.tag_l2||'未细分');
          if (!l2Groups[key]) l2Groups[key] = [];
          l2Groups[key].push(l);
        });
      });
      Object.keys(l2Groups).forEach(function(key) {
        var g = l2Groups[key];
        parts.push('=== '+key+' ('+g.length+'条) ===');
        g.forEach(function(l) { parts.push(l.translation ? l.original+'='+l.translation : l.original); });
        parts.push(''); total += g.length;
      });
    }

    if (incUntagged) {
      var untagged = tagState.lines.filter(function(l){return !l.tag_l1;});
      if (untagged.length>0) {
        parts.push('=== 未分类 ('+untagged.length+'条) ===');
        untagged.forEach(function(l) { parts.push(l.translation ? l.original+'='+l.translation : l.original); });
      }
    }
    tagTriggerDownload('tag_result.txt', parts.join('\n').trimEnd());
    tagLog('导出: tag_result.txt ('+total+'条)');
    showToast('已导出 tag_result.txt');
  } else {
    // 分别导出
    if (gran === 'l1') {
      tagExportSeparateCore(tagged, incUntagged);
    } else {
      // L2 粒度：每个二级类目单独文件
      var schema = getEnabledSchema(); var files = 0;
      var allL2 = [];
      Object.keys(schema).forEach(function(l1) {
        var items = tagged.filter(function(l){return l.tag_l1===l1;});
        var subs = {}; items.forEach(function(l){ var k=l.tag_l2||'未细分'; if(!subs[k])subs[k]=[]; subs[k].push(l); });
        Object.keys(subs).forEach(function(l2) { allL2.push({l1:l1, l2:l2, items:subs[l2]}); });
      });
      if (incUntagged) {
        var u = tagState.lines.filter(function(l){return !l.tag_l1;});
        if (u.length>0) allL2.push({l1:'', l2:'未分类', items:u});
      }
      (function next(i) {
        if (i>=allL2.length) { showToast('已导出 '+files+' 个文件'); return; }
        var g = allL2[i];
        var fname = (g.l1 ? g.l1+'_' : '') + g.l2 + '.txt';
        tagTriggerDownload(fname, g.items.map(function(l){return l.translation?l.original+'='+l.translation:l.original;}).join('\n'));
        files++;
        setTimeout(function(){next(i+1);}, 200);
      })(0);
    }
  }
}

function tagExportSeparateCore(tagged, incUntagged) {
  var cats = Object.keys(getEnabledSchema()), files = 0;
  (function next(i) {
    if (i>=cats.length) {
      if (incUntagged) {
        var u = tagState.lines.filter(function(l){return !l.tag_l1;});
        if (u.length>0) { tagTriggerDownload('未分类.txt', u.map(function(l){return l.translation?l.original+'='+l.translation:l.original;}).join('\n')); files++; }
      }
      showToast('已导出 '+files+' 个文件'); return;
    }
    var items = tagged.filter(function(l){return l.tag_l1===cats[i];});
    if (items.length>0) { tagTriggerDownload(cats[i]+'.txt', items.map(function(l){return l.translation?l.original+'='+l.translation:l.original;}).join('\n')); files++; }
    setTimeout(function(){next(i+1);}, 200);
  })(0);
}

function tagTriggerDownload(name, content) {
  var blob = new Blob([content],{type:'text/plain;charset=utf-8'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href=url; a.download=name; a.click();
  setTimeout(function(){URL.revokeObjectURL(url);},5000);
}

// ── 搜索(分词页) ──
function tagOnSearch() { tagState.query = document.getElementById('tagSearch').value; tagRenderPreview(); }
function tagClearSearch() { document.getElementById('tagSearch').value=''; tagState.query=''; tagRenderPreview(); }

// ── 按钮状态管理 ──
function tagBtnState() {
  var has = tagState.lines.length > 0;
  document.getElementById('tagBtnClear').disabled = !has;
  document.getElementById('tagBtnExport').disabled = !tagState.lines.some(function(l){return l.tag_l1;});
  var importBtn = document.getElementById('tagBtnImport');
  if (importBtn) importBtn.disabled = (typeof state !== 'undefined' && state.translating);
  tagUpdateTagStartButton();
}

// ── 运行计时器 ──
var _tagT0=0, _tagTmr=0;
function _tagStartRuntime() {
  _tagT0=Date.now(); var rd=document.getElementById('tagRuntimeDisplay');
  rd.textContent='00:00'; rd.style.display='inline';
  _tagTmr=setInterval(function(){var s=Math.floor((Date.now()-_tagT0)/1000);var m=Math.floor(s/60);rd.textContent=(m<10?'0':'')+m+':'+((s%60)<10?'0':'')+(s%60);},500);
}
function _tagStopRuntime() { clearInterval(_tagTmr); document.getElementById('tagRuntimeDisplay').style.display='none'; }

// ── 分词日志（通过统一工厂创建） ──
var _tagLogger = createLogger('tagLogArea', 100);
var tagLog = _tagLogger.log;
var tagLogClear = _tagLogger.clear;

// ── 分类标签面板 ──
function tagToggleCatPanel() {
  var panel = document.getElementById('tagCatPanel');
  var toggle = document.getElementById('tagCatToggle');
  if (panel.classList.contains('visible')) {
    panel.classList.remove('visible');
    toggle.textContent = '分类标签 ▼';
  } else {
    panel.classList.add('visible');
    toggle.textContent = '分类标签 ▲';
    tagRenderCatPanel();
  }
}

// ── 分类策略面板 ──
var _tagStrategyPresets = [
  { name: '游戏本地化', text: '你是一个游戏文本分类专家。请将以下文本归入最合适的类别。' },
  { name: 'UI/软件', text: '你是一个软件界面文本分类专家。请将以下文本归入最合适的类别。重点关注菜单、按钮、提示信息等UI元素。' },
  { name: '文学/小说', text: '你是一个文学翻译文本分类专家。请将以下文本归入最合适的类别。重点关注叙事风格、修辞手法和文学性表达。' },
];

function tagToggleStrategy() {
  var row = document.getElementById('tagStrategyRow');
  var toggle = document.getElementById('tagStrategyToggle');
  if (row.style.display === 'flex') {
    row.style.display = 'none';
    toggle.textContent = '分类策略 ▼';
  } else {
    row.style.display = 'flex';
    toggle.textContent = '分类策略 ▲';
    tagRenderStrategyPresets();
  }
}

function tagRenderStrategyPresets() {
  var container = document.getElementById('tagStrategyPresets');
  if (!container) return;
  var html = '';
  _tagStrategyPresets.forEach(function(p, i) {
    html += '<span class="prompt-chip preset" data-action="tag-strategy-preset" data-index="' + i + '" style="max-width:100px"><span class="chip-text">' + p.name + '</span></span>';
  });
  container.innerHTML = html;
}

function tagLoadStrategyPreset(index) {
  var p = _tagStrategyPresets[index];
  if (!p) return;
  var ta = document.getElementById('tagStrategyText');
  if (ta) ta.value = p.text;
  dbSet('tllmh_tag_strategy', p.text);
  showToast('已加载: ' + p.name);
}

function saveTagStrategy() {
  var ta = document.getElementById('tagStrategyText');
  if (ta) dbSet('tllmh_tag_strategy', ta.value);
}

function resetTagStrategy() {
  var ta = document.getElementById('tagStrategyText');
  if (ta) {
    ta.value = _tagStrategyPresets[0].text;
    dbSet('tllmh_tag_strategy', ta.value);
  }
  showToast('已恢复默认分类策略');
}

function _initTagStrategy() {
  var ta = document.getElementById('tagStrategyText');
  if (!ta) return;
  var saved = dbGet('tllmh_tag_strategy');
  if (saved !== null) {
    ta.value = saved;
  } else {
    // 从后端加载默认值
    try {
      fetch('/api/config').then(function(r) { return r.json(); }).then(function(d) {
        if (d.default_tag_strategy && !dbHas('tllmh_tag_strategy')) {
          ta.value = d.default_tag_strategy;
        }
      });
    } catch (e) { /* ignore */ }
  }
}

function tagRenderCatPanel() {
  var panel = document.getElementById('tagCatPanel');
  if (!panel) return;
  var schema = getEnabledSchema();
  var html = '';
  Object.keys(schema).forEach(function(l1) {
    var cat = schema[l1];
    var count = tagState.lines.filter(function(l) { return l.tag_l1 === l1; }).length;
    html += '<div class="tag-cat-group" style="border-left:3px solid ' + cat.color + '">' +
      '<div class="tag-cat-group-head">' +
        '<span class="tag-cat-icon">' + cat.icon + '</span>' +
        '<span class="tag-cat-name" style="color:' + cat.color + '">' + escHtml(l1) + '</span>' +
        '<span class="tag-cat-count">' + count + '</span>' +
      '</div>' +
      '<div class="tag-cat-subs">';
    cat.subs.forEach(function(l2) {
      var subCount = tagState.lines.filter(function(l) { return l.tag_l1 === l1 && l.tag_l2 === l2; }).length;
      html += '<span class="tag-cat-chip" style="background:' + cat.color + '22;border-color:' + cat.color + '44;color:' + cat.color + '">' +
        escHtml(l2) +
        (subCount > 0 ? ' <span class="tag-cat-chip-cnt">' + subCount + '</span>' : '') +
        '</span>';
    });
    html += '</div></div>';
  });
  // 未分类统计
  var untagged = tagState.lines.filter(function(l) { return !l.tag_l1; }).length;
  if (untagged > 0 || tagState.lines.length > 0) {
    html += '<div style="padding:6px 12px;color:var(--text-muted);font-size:0.73rem">📋 未分类:' + untagged + ' 条</div>';
  }
  panel.innerHTML = html;
}

// ── 标签管理面板(增删改一级/二级类目) ──
// ═══════════════════════════════════════════════
// 标签管理弹窗
// ═══════════════════════════════════════════════

// ── 从管理面板 DOM 读取当前 schema 状态 ──
function _readAdminSchema() {
  var schema = {};
  document.querySelectorAll('.tag-admin-group').forEach(function(group) {
    var nameInput = group.querySelector('.tag-admin-name');
    var l1 = nameInput ? (nameInput.value || nameInput.defaultValue || '').trim() : '';
    if (!l1) return;
    var color = group.querySelector('.tag-admin-color');
    var icon = group.querySelector('.tag-admin-icon');
    var enabled = group.querySelector('.tag-admin-enabled');
    var subs = [];
    group.querySelectorAll('.tag-admin-sub').forEach(function(inp) {
      var val = (inp.value || inp.defaultValue || '').trim();
      if (val) subs.push(val);
    });
    schema[l1] = {
      color: color ? color.value : '#888',
      icon: icon ? (icon.value || icon.defaultValue || '📌') : '📌',
      subs: subs.length > 0 ? subs : ['未分类'],
      enabled: enabled ? enabled.checked : true
    };
  });
  return schema;
}

// ── 从管理面板 DOM 读取当前池子状态 ──
function _readAdminPool() {
  var pool = [];
  document.querySelectorAll('.tag-admin-pool-chip').forEach(function(chip) {
    var txt = chip.querySelector('.tag-admin-pool-text');
    if (txt) pool.push(txt.textContent.trim());
  });
  return pool;
}

// ── 实时预览（不写 DB） ──
function _adminPreview() {
  var schema = _readAdminSchema();
  // 只写缓存用于渲染，不持久化到 IndexedDB（等"保存并关闭"才持久化）
  if (Object.keys(schema).length > 0) dbSetCache('tllmh_tag_schema', schema);
  saveSubPool(_readAdminPool());
  tagRenderColumns(); tagRenderPreview(); tagRenderCatPanel(); tagBtnState();
}

// ── 保存并关闭 ──
function _adminSave() {
  var schema = _readAdminSchema();
  if (Object.keys(schema).length === 0) { showToast('至少保留一个一级类目'); return; }
  saveTagSchema(schema);
  saveSubPool(_readAdminPool());
  document.getElementById('tagAdminModal').style.display = 'none';
  tagRenderColumns(); tagRenderPreview(); tagRenderCatPanel(); tagBtnState();
  showToast('标签体系已更新');
}

// ── 创建子项元素 ──
function _createSubWrap(name) {
  var wrap = document.createElement('span');
  wrap.className = 'tag-admin-sub-wrap';
  wrap.draggable = true;

  var input = document.createElement('input');
  input.className = 'tag-admin-sub';
  input.value = name || '';
  input.readOnly = true;

  var del = document.createElement('span');
  del.className = 'tag-admin-sub-del';
  del.title = '移回二级池';
  del.textContent = '\u00d7';
  del.addEventListener('click', function() { _adminRemoveSub(wrap); });

  // 拖拽
  wrap.addEventListener('dragstart', function(e) {
    e.dataTransfer.setData('text/plain', (input.value || input.defaultValue || '').trim());
    e.dataTransfer.setData('source', 'sub');
    e.dataTransfer.effectAllowed = 'move';
    wrap.classList.add('drag-start');
  });
  wrap.addEventListener('dragend', function() { wrap.classList.remove('drag-start'); });

  // 双击编辑
  input.addEventListener('dblclick', function() { input.readOnly = false; input.focus(); input.select(); });
  input.addEventListener('blur', function() { input.readOnly = true; _adminPreview(); });
  input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });

  wrap.appendChild(input);
  wrap.appendChild(del);
  return wrap;
}

// ── 创建类目组元素 ──
function _createGroup(l1, cat) {
  var group = document.createElement('div');
  group.className = 'tag-admin-group' + (cat.enabled === false ? ' tag-admin-disabled' : '');
  group.dataset.l1 = l1;

  // Header
  var header = document.createElement('div');
  header.className = 'tag-admin-group-header';

  // 启用/禁用
  var label = document.createElement('label');
  label.className = 'tag-admin-enabled-wrap';
  label.title = '启用/禁用';
  var checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'tag-admin-enabled';
  checkbox.checked = cat.enabled !== false;
  checkbox.addEventListener('change', function() {
    group.classList.toggle('tag-admin-disabled', !checkbox.checked);
    _adminPreview();
  });
  label.appendChild(checkbox);
  header.appendChild(label);

  // 图标
  var iconInput = document.createElement('input');
  iconInput.className = 'tag-admin-icon';
  iconInput.value = cat.icon || '📌';
  iconInput.style.cssText = 'width:30px;text-align:center';
  iconInput.addEventListener('change', _adminPreview);
  header.appendChild(iconInput);

  // 名称
  var nameInput = document.createElement('input');
  nameInput.className = 'tag-admin-name';
  nameInput.value = l1;
  nameInput.style.flex = '1';
  nameInput.readOnly = true;
  nameInput.addEventListener('dblclick', function() { nameInput.readOnly = false; nameInput.focus(); nameInput.select(); });
  nameInput.addEventListener('blur', function() { nameInput.readOnly = true; _adminPreview(); });
  nameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } });
  header.appendChild(nameInput);

  // 颜色
  var colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.className = 'tag-admin-color';
  colorInput.value = cat.color || '#888';
  colorInput.title = '颜色';
  colorInput.addEventListener('change', _adminPreview);
  header.appendChild(colorInput);

  // +子项
  var addSubBtn = document.createElement('button');
  addSubBtn.className = 'btn btn-sm';
  addSubBtn.textContent = '+子项';
  addSubBtn.addEventListener('click', function() {
    var wrap = _createSubWrap('');
    subsDiv.appendChild(wrap);
    var inp = wrap.querySelector('.tag-admin-sub');
    inp.readOnly = false; inp.focus();
  });
  header.appendChild(addSubBtn);

  // 删除类目
  var delBtn = document.createElement('button');
  delBtn.className = 'btn btn-sm tag-admin-del-btn';
  delBtn.textContent = '\uD83D\uDDD1';
  delBtn.addEventListener('click', function() { _adminRemoveGroup(group); });
  header.appendChild(delBtn);

  group.appendChild(header);

  // Subs container
  var subsDiv = document.createElement('div');
  subsDiv.className = 'tag-admin-subs';
  (cat.subs || []).forEach(function(sub) {
    subsDiv.appendChild(_createSubWrap(sub));
  });
  group.appendChild(subsDiv);

  // Drop zone
  group.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; group.classList.add('drag-over'); });
  group.addEventListener('dragleave', function() { group.classList.remove('drag-over'); });
  group.addEventListener('drop', function(e) { _adminDrop(e, group); });

  return group;
}

// ── 创建池子芯片 ──
function _createPoolChip(name) {
  var chip = document.createElement('div');
  chip.className = 'tag-admin-pool-chip';
  chip.draggable = true;

  var text = document.createElement('span');
  text.className = 'tag-admin-pool-text';
  text.textContent = name;

  var del = document.createElement('span');
  del.className = 'tag-admin-pool-del';
  del.title = '永久删除';
  del.textContent = '\u00d7';
  del.addEventListener('click', function(e) {
    e.stopPropagation();
    var n = text.textContent.trim();
    var pool = getSubPool(); var idx = pool.indexOf(n);
    if (idx !== -1) { pool.splice(idx, 1); saveSubPool(pool); }
    chip.remove();
    _refreshPool();
    _adminPreview();
  });

  // 拖拽
  chip.addEventListener('dragstart', function(e) {
    e.dataTransfer.setData('text/plain', text.textContent);
    e.dataTransfer.setData('source', 'pool');
    e.dataTransfer.effectAllowed = 'move';
    chip.classList.add('drag-start');
  });
  chip.addEventListener('dragend', function() { chip.classList.remove('drag-start'); });

  // 双击编辑
  chip.addEventListener('dblclick', function(e) {
    if (e.target === del) return;
    var oldName = text.textContent;
    var inp = document.createElement('input');
    inp.type = 'text'; inp.value = oldName; inp.className = 'tag-admin-sub';
    inp.style.cssText = 'width:calc(100% - 18px);padding:2px 4px;font-size:0.73rem';
    text.replaceWith(inp); inp.focus(); inp.select();
    function commit() {
      var newName = inp.value.trim();
      if (newName && newName !== oldName) {
        var pool = getSubPool(); var idx = pool.indexOf(oldName);
        if (idx !== -1) { pool[idx] = newName; saveSubPool(pool); }
      }
      text.textContent = newName || oldName;
      inp.replaceWith(text);
      _adminPreview();
    }
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { inp.value = oldName; commit(); }
    });
  });

  chip.appendChild(text);
  chip.appendChild(del);
  return chip;
}

// ── 打开管理面板 ──
function tagOpenAdmin() {
  var schema = getTagSchema();
  var subPool = getSubPool();
  var assignedSubs = new Set();
  Object.keys(schema).forEach(function(l1) { (schema[l1].subs || []).forEach(function(s) { assignedSubs.add(s); }); });
  var availablePool = subPool.filter(function(s) { return !assignedSubs.has(s); });

  var modal = document.getElementById('tagAdminModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'tagAdminModal';
    modal.className = 'modal-overlay';
    modal.style.display = 'none';

    var box = document.createElement('div');
    box.className = 'modal-box tag-admin-modal';

    // Title
    var title = document.createElement('div');
    title.className = 'modal-msg';
    title.style.cssText = 'font-weight:600;margin-bottom:6px';
    title.textContent = '\uD83D\uDCCC 管理分类标签';
    box.appendChild(title);

    // Layout
    var layout = document.createElement('div');
    layout.id = 'tagAdminBody';
    layout.className = 'tag-admin-layout';

    // Left panel
    var left = document.createElement('div');
    left.className = 'tag-admin-left';
    left.id = 'tagAdminLeft';
    layout.appendChild(left);

    // Right panel (pool)
    var right = document.createElement('div');
    right.className = 'tag-admin-right';

    var poolTitle = document.createElement('div');
    poolTitle.style.cssText = 'font-size:0.75rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px';
    poolTitle.textContent = '二级类目池';
    right.appendChild(poolTitle);

    var poolHint = document.createElement('div');
    poolHint.style.cssText = 'font-size:0.65rem;color:var(--text-muted);margin-bottom:6px';
    poolHint.textContent = '拖入左侧分配 | 双击编辑 | 仅此处可删除';
    right.appendChild(poolHint);

    var poolContainer = document.createElement('div');
    poolContainer.className = 'tag-admin-pool';
    poolContainer.id = 'tagAdminPool';
    // Pool drop zone
    poolContainer.addEventListener('dragover', function(e) { e.preventDefault(); });
    poolContainer.addEventListener('drop', function(e) { _adminPoolDrop(e); });
    right.appendChild(poolContainer);

    var poolInputRow = document.createElement('div');
    poolInputRow.style.cssText = 'display:flex;gap:4px;margin-top:8px';
    var poolInput = document.createElement('input');
    poolInput.id = 'tagAdminPoolInput';
    poolInput.className = 'tag-admin-pool-input';
    poolInput.placeholder = '输入新二级类目';
    poolInput.style.flex = '1';
    poolInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') _adminAddToPool(); });
    poolInputRow.appendChild(poolInput);
    var poolAddBtn = document.createElement('button');
    poolAddBtn.className = 'btn btn-sm';
    poolAddBtn.textContent = '+';
    poolAddBtn.addEventListener('click', _adminAddToPool);
    poolInputRow.appendChild(poolAddBtn);
    right.appendChild(poolInputRow);

    layout.appendChild(right);
    box.appendChild(layout);

    // Actions
    var actions = document.createElement('div');
    actions.className = 'modal-actions';
    actions.style.marginTop = '10px';

    var exportBtn = document.createElement('button');
    exportBtn.className = 'btn';
    exportBtn.textContent = '导出';
    exportBtn.addEventListener('click', _adminExport);
    actions.appendChild(exportBtn);

    var importBtn = document.createElement('button');
    importBtn.className = 'btn';
    importBtn.textContent = '导入';
    importBtn.addEventListener('click', _adminImport);
    actions.appendChild(importBtn);

    var spacer = document.createElement('span');
    spacer.style.flex = '1';
    actions.appendChild(spacer);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.id = 'tagAdminSave';
    saveBtn.textContent = '保存并关闭';
    saveBtn.addEventListener('click', _adminSave);
    actions.appendChild(saveBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.id = 'tagAdminCancel';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', function() { modal.style.display = 'none'; });
    actions.appendChild(cancelBtn);

    box.appendChild(actions);
    modal.appendChild(box);
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
  }

  // Render left panel
  var leftEl = document.getElementById('tagAdminLeft');
  leftEl.innerHTML = '';
  var hint = document.createElement('div');
  hint.className = 'tag-admin-hint';
  hint.textContent = '双击名称编辑 | 删除类目子项回归二级池';
  leftEl.appendChild(hint);

  var list = document.createElement('div');
  list.id = 'tagAdminList';
  Object.keys(schema).forEach(function(l1) {
    list.appendChild(_createGroup(l1, schema[l1]));
  });
  leftEl.appendChild(list);

  var addGroupBtn = document.createElement('button');
  addGroupBtn.className = 'btn btn-sm';
  addGroupBtn.style.marginTop = '4px';
  addGroupBtn.textContent = '+ 添加一级类目';
  addGroupBtn.addEventListener('click', function() {
    var colors = ['#4fc3f7','#81c784','#ef5350','#ffb74d','#ce93d8','#90a4ae','#a1887f','#4dd0e1','#f06292','#aed581'];
    var used = new Set(); document.querySelectorAll('.tag-admin-color').forEach(function(c) { used.add(c.value); });
    var avail = colors.filter(function(c) { return !used.has(c); });
    var color = avail.length > 0 ? avail[Math.floor(Math.random() * avail.length)] : colors[Math.floor(Math.random() * colors.length)];
    var grp = _createGroup('新类目', { icon: '📌', color: color, subs: [], enabled: true });
    list.appendChild(grp);
    var nameInp = grp.querySelector('.tag-admin-name');
    nameInp.readOnly = false; nameInp.focus(); nameInp.select();
  });
  leftEl.appendChild(addGroupBtn);

  // Render pool
  _refreshPool();

  modal.style.display = 'flex';
}

// ── 类目组操作 ──
function _adminRemoveGroup(group) {
  if (document.querySelectorAll('.tag-admin-group').length <= 1) {
    showToast('至少保留一个一级类目'); return;
  }
  // 将子项归还池子
  var pool = getSubPool();
  group.querySelectorAll('.tag-admin-sub').forEach(function(input) {
    var val = (input.value || input.defaultValue || '').trim();
    if (val && pool.indexOf(val) === -1) pool.push(val);
  });
  saveSubPool(pool);
  group.remove();
  _refreshPool();
  _adminPreview();
}

function _adminRemoveSub(wrap) {
  var input = wrap.querySelector('.tag-admin-sub');
  var name = (input.value || input.defaultValue || '').trim();
  wrap.remove();
  if (name) {
    var pool = getSubPool();
    if (pool.indexOf(name) === -1) { pool.push(name); saveSubPool(pool); }
    _refreshPool();
  }
  _adminPreview();
}

// ── 拖放处理 ──
function _adminDrop(e, group) {
  e.preventDefault(); group.classList.remove('drag-over');
  var name = e.dataTransfer.getData('text/plain');
  if (!name) return;
  var isSub = e.dataTransfer.getData('source') === 'sub';
  var targetWrap = e.target.closest('.tag-admin-sub-wrap');
  var subsDiv = group.querySelector('.tag-admin-subs');

  // 同组内排序
  if (isSub) {
    var existing = null;
    group.querySelectorAll('.tag-admin-sub-wrap').forEach(function(w) {
      var inp = w.querySelector('.tag-admin-sub');
      if (inp && (inp.value || inp.defaultValue || '').trim() === name) existing = w;
    });
    if (existing) {
      if (targetWrap && targetWrap !== existing) {
        var rect = targetWrap.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) subsDiv.insertBefore(existing, targetWrap);
        else subsDiv.insertBefore(existing, targetWrap.nextSibling);
        _adminPreview();
      }
      return;
    }
  }

  // 跨组：检查重复
  var dup = false;
  group.querySelectorAll('.tag-admin-sub').forEach(function(inp) {
    if ((inp.value || inp.defaultValue || '').trim() === name) dup = true;
  });
  if (dup) { _refreshPool(); return; }

  // 从源移除
  if (isSub) {
    document.querySelectorAll('.tag-admin-sub-wrap').forEach(function(w) {
      var inp = w.querySelector('.tag-admin-sub');
      if (inp && (inp.value || inp.defaultValue || '').trim() === name) w.remove();
    });
  } else {
    var pool = getSubPool(); var idx = pool.indexOf(name);
    if (idx !== -1) { pool.splice(idx, 1); saveSubPool(pool); } else return;
  }

  // 插入到目标位置
  var newWrap = _createSubWrap(name);
  if (targetWrap && targetWrap.parentElement === subsDiv) {
    var rect = targetWrap.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) subsDiv.insertBefore(newWrap, targetWrap);
    else subsDiv.insertBefore(newWrap, targetWrap.nextSibling);
  } else {
    subsDiv.appendChild(newWrap);
  }
  _refreshPool();
  _adminPreview();
}

function _adminPoolDrop(e) {
  e.preventDefault();
  var name = e.dataTransfer.getData('text/plain');
  if (!name || e.dataTransfer.getData('source') !== 'sub') return;
  document.querySelectorAll('.tag-admin-sub-wrap').forEach(function(w) {
    var inp = w.querySelector('.tag-admin-sub');
    if (inp && (inp.value || inp.defaultValue || '').trim() === name) w.remove();
  });
  var pool = getSubPool();
  if (pool.indexOf(name) === -1) { pool.push(name); saveSubPool(pool); }
  _refreshPool();
  _adminPreview();
}

// ── 池子操作 ──
function _adminAddToPool() {
  var input = document.getElementById('tagAdminPoolInput');
  if (!input) return;
  var name = input.value.trim();
  if (!name) return;
  var pool = getSubPool();
  if (pool.indexOf(name) !== -1) { showToast('此名称已存在'); return; }
  var schema = getTagSchema(); var assigned = false;
  Object.keys(schema).forEach(function(l1) { if ((schema[l1].subs || []).indexOf(name) !== -1) assigned = true; });
  if (assigned) { showToast('该名称已在分类中使用'); return; }
  pool.push(name); saveSubPool(pool);
  input.value = '';
  _refreshPool();
  _adminPreview();
  input.focus();
}

function _refreshPool() {
  var container = document.getElementById('tagAdminPool');
  if (!container) return;
  container.innerHTML = '';
  var subPool = getSubPool();
  var assignedSubs = new Set();
  document.querySelectorAll('.tag-admin-sub').forEach(function(input) {
    var val = (input.value || input.defaultValue || '').trim();
    if (val) assignedSubs.add(val);
  });
  var available = subPool.filter(function(s) { return !assignedSubs.has(s); });
  if (available.length === 0) {
    var empty = document.createElement('div');
    empty.style.cssText = 'font-size:0.68rem;color:var(--text-muted);text-align:center;padding:12px 0';
    empty.innerHTML = '池中暂无二级类目<br>点击下方按钮添加';
    container.appendChild(empty);
    return;
  }
  available.forEach(function(name) { container.appendChild(_createPoolChip(name)); });
}

// ── 导出/导入 ──
function _adminExport() {
  var schema = getTagSchema();
  var blob = new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = 'tag_schema.json'; a.click();
  setTimeout(function(){URL.revokeObjectURL(url);},5000);
  showToast('已导出标签体系');
}

function _adminImport() {
  var input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = function(e) {
    var file = e.target.files[0]; if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      try {
        var data = JSON.parse(ev.target.result);
        if (typeof data !== 'object' || data === null || Object.keys(data).length === 0) { showToast('无效的标签体系文件'); return; }
        for (var key in data) {
          if (!data[key].subs || !Array.isArray(data[key].subs)) { showToast('格式错误:' + key + ' 缺少 subs 数组'); return; }
        }
        saveTagSchema(data);
        tagOpenAdmin();
        tagRenderColumns(); tagRenderPreview(); tagRenderCatPanel();
        showToast('已导入标签体系(' + Object.keys(data).length + ' 个类目)');
      } catch (ex) { showToast('导入失败: ' + ex.message); }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── 初始化(由 switchPage 懒调用,只执行一次) ──
async function tagInit() {
  await dbReady;
  // 绑定拖拽上传
  var dz = document.getElementById('tagDropZone');
  var fi = document.getElementById('tagFileInput');
  if (dz && fi) {
    dz.addEventListener('dragover', function(e){e.preventDefault();dz.classList.add('drag-over');});
    dz.addEventListener('dragleave', function(){dz.classList.remove('drag-over');});
    dz.addEventListener('click', function(){fi.click();});
    dz.addEventListener('drop', function(e){e.preventDefault();dz.classList.remove('drag-over');if(e.dataTransfer.files.length>0)tagProcessFiles(e.dataTransfer.files);});
    fi.addEventListener('change', function(){if(fi.files.length>0)tagProcessFiles(fi.files);});
  }

  // 初始化分类策略
  _initTagStrategy();

  // 加载分词页参数持久化（并发数 + LLM 参数）
  var savedConcurrency = dbGet('tllmh_tag_concurrency');
  if (savedConcurrency != null) {
    var concEl = document.getElementById('tagConcurrency');
    if (concEl) concEl.value = savedConcurrency;
  }
  var concInput = document.getElementById('tagConcurrency');
  if (concInput) {
    concInput.addEventListener('blur', function() { dbSet('tllmh_tag_concurrency', parseInt(concInput.value) || 5); });
    // 双击 span label 恢复默认
    var concLabel = concInput.previousElementSibling;
    if (concLabel && concLabel.tagName === 'SPAN') {
      concLabel.addEventListener('dblclick', function() {
        resetInputDefault(concInput, function() { dbSet('tllmh_tag_concurrency', parseInt(concInput.value) || 5); });
      });
    }
  }

  // LLM 参数持久化
  var tagLLMParams = dbGet('tllmh_tag_params', {});
  var tagParamMap = [
    { id: 'tagTemperature', key: 'temperature' },
    { id: 'tagTopP', key: 'top_p' },
    { id: 'tagMaxTokens', key: 'max_tokens' },
  ];
  tagParamMap.forEach(function(cfg) {
    var el = document.getElementById(cfg.id);
    if (!el) return;
    if (tagLLMParams[cfg.key] != null) el.value = tagLLMParams[cfg.key];
    el.addEventListener('blur', function() {
      var p = dbGet('tllmh_tag_params', {});
      p[cfg.key] = el.value;
      dbSet('tllmh_tag_params', p);
    });
    // 双击 label span 恢复默认
    var label = el.previousElementSibling;
    if (label && label.tagName === 'SPAN') {
      label.addEventListener('dblclick', function() {
        resetInputDefault(el, function() {
          var p = dbGet('tllmh_tag_params', {});
          p[cfg.key] = el.value;
          dbSet('tllmh_tag_params', p);
        });
      });
    }
  });

  // ── 静态按钮绑定 ──
  var _b = function(id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  _b('tagBtnStart', tagStart);
  _b('tagBtnStop', tagStop);
  _b('tagBtnClear', tagClearAll);
  _b('tagBtnExport', tagExportDialog);
  _b('tagBtnImport', tagImportDialog);
  _b('tagCatToggle', tagToggleCatPanel);
  _b('tagStrategyToggle', tagToggleStrategy);

  // 标签管理按钮
  var adminBtn = document.querySelector('#page-tag .tag-ctrl-header .btn-sm');
  if (adminBtn && adminBtn.textContent.indexOf('管理') >= 0) adminBtn.addEventListener('click', tagOpenAdmin);

  // 分类策略重置
  var stratReset = document.querySelector('#tagStrategyRow .btn-sm');
  if (stratReset && stratReset.textContent.trim() === '↻') stratReset.addEventListener('click', resetTagStrategy);
  // 策略预设
  var presets = document.getElementById('tagStrategyPresets');
  if (presets) presets.addEventListener('click', function(e) {
    var chip = e.target.closest('[data-index]');
    if (chip) tagLoadStrategyPreset(parseInt(chip.dataset.index));
  });
  // 策略文本输入
  var stratText = document.getElementById('tagStrategyText');
  if (stratText) stratText.addEventListener('input', saveTagStrategy);

  // 分词页来源输入按钮
  document.querySelectorAll('#page-tag .manual-input .btn').forEach(function(btn) {
    var txt = btn.textContent.trim();
    if (txt === '添加') btn.addEventListener('click', tagLoadManualInput);
    if (txt === '重置') btn.addEventListener('click', tagClearAll);
  });

  // 分词页搜索
  var ts = document.getElementById('tagSearch');
  if (ts) ts.addEventListener('input', tagOnSearch);
  // 行数限制
  _b('tagPreviewRowLimit', function(e) { tagOnRowLimitChange(); });
  _b('tagPreviewCustomLimit', function(e) { tagOnCustomLimitChange(); });

  // ── 动态内容事件委托 ──
  // 文件列表
  var tagFileInfo = document.getElementById('tagFileInfo');
  if (tagFileInfo) tagFileInfo.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    var idx = parseInt(btn.dataset.index);
    if (action === 'tag-delete-file') tagDeleteFile(idx);
  });

  // 分类卡片
  var tagColumns = document.getElementById('tagColumns');
  if (tagColumns) tagColumns.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    var idx = parseInt(btn.dataset.index);
    if (action === 'tag-edit-cat') tagEditCategory(idx);
  });

  // 导入/导出弹窗
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    if (action === 'tag-import-do') tagImportDo();
    else if (action === 'tag-export-do') tagExportDo();
    else if (action === 'tag-edit-pick') tagEditPick(btn.dataset.l1, btn.dataset.l2);
    else if (action === 'tag-strategy-preset') tagLoadStrategyPreset(parseInt(btn.dataset.index));
  });

  // 标签管理面板（旧 data-action 委托已移除，改用直接事件监听）
  // 保留非 admin 的委托
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    if (action === 'tag-edit-pick') tagEditPick(btn.dataset.l1, btn.dataset.l2);
    else if (action === 'tag-strategy-preset') tagLoadStrategyPreset(parseInt(btn.dataset.index));
  });

  // ── 标签页：input/change/blur 委托 ──
  var tagPage = document.getElementById('page-tag');
  if (tagPage) {
    tagPage.addEventListener('input', function(e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'tag-edit-filter') tagEditFilter();
    });
    tagPage.addEventListener('change', function(e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'tag-edit-select-change') tagEditSelectChange();
    });
    // Drag/drop delegation for tag cards only (admin uses direct listeners)
    tagPage.addEventListener('dragstart', function(e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'tag-card') tagCardDragStart(e);
    });
    tagPage.addEventListener('dragend', function(e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'tag-card') tagCardDragEnd(e);
    });
    tagPage.addEventListener('dragover', function(e) {
      var col = e.target.closest('.tag-column-body');
      if (col) { e.preventDefault(); tagDragOver(e, col); }
    });
    tagPage.addEventListener('dragleave', function(e) {
      var col = e.target.closest('.tag-column-body');
      if (col) tagDragLeave(e, col);
    });
    tagPage.addEventListener('drop', function(e) {
      e.preventDefault();
      var col = e.target.closest('.tag-column-body');
      if (col) tagDrop(e, col);
    });
  }

  // 点击外部关闭标签搜索下拉框
  document.addEventListener('click', function(e) {
    var dd = document.getElementById('tagEditDropdown');
    if (dd && dd.style.display !== 'none') {
      if (!e.target.closest('#tagEditDropdown') && !e.target.closest('#tagEditSearch')) {
        dd.style.display = 'none';
      }
    }
  });

  // 初始渲染
  tagRenderColumns();
}
// ── Window bindings (HTML onclick compat) ──

// ── Module export





// ── Module exports ──
export {
  tagInit, tagLoadManualInput, tagClearAll, tagOnSearch, tagOnRowLimitChange, tagOnCustomLimitChange,
  tagStart, tagStop, tagExportDialog, tagImportDialog, tagToggleCatPanel, tagToggleStrategy,
  tagOpenAdmin, tagToggleCollapse, resetTagStrategy, saveTagStrategy
};
