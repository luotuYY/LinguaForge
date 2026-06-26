/**
 * LinguaForge - 分词/标签模块
 * 文本分类、LLM 分词、卡片拖拽排序、标签管理、导入翻译
 * Depends on: utils.js, db.js, state.js, api.js, render.js, app.js
 */

import { $, escHtml, showToast, log, logChunk, setHighlight, hl, matches } from './utils.js';
import { dbGet, dbSet, dbHas } from './db.js';
import { state, rebuildIndicesAndCheckboxes, updateTranslateAllButton } from './state.js';
import { renderFileList } from './api.js';
import { renderPreview, renderCompare } from './render.js';
import { switchPage } from './app.js';

// ── 分词页状态 ──
var tagState = {
  lines: [],
  files: [],
  fileNames: [],
  translating: false,
  abort: false,
  query: '',
  previewRowLimit: 2000,
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
function tagOnRowLimitChange() {
  var sel = document.getElementById('tagPreviewRowLimit');
  var custom = document.getElementById('tagPreviewCustomLimit');
  if (!sel) return;
  var val = sel.value;
  if (val === '-2') { sel.style.display='none'; if(custom){custom.style.display='inline-block';custom.focus();} return; }
  tagState.previewRowLimit = (val === '-1') ? 0 : (parseInt(val) || 2000);
  if (custom) custom.style.display='none';
  if (sel) sel.style.display='inline-block';
  tagRenderPreview();
  tagRenderColumns();
}
function tagOnCustomLimitChange() {
  var c = document.getElementById('tagPreviewCustomLimit');
  if (!c) return;
  var v = parseInt(c.value);
  if (v > 0) { tagState.previewRowLimit = v; tagRenderPreview(); tagRenderColumns(); }
}

// ── 预览列表 ──
function tagRenderPreview() {
  var q = tagState.query;
  setHighlight(q);
  var checkedFiles = tagState.files.map(function(f) { return f.name; });
  var filtered = tagState.lines.filter(function(l) {
    return !l.file || checkedFiles.indexOf(l.file) >= 0;
  });
  var lines = filtered.slice();
  var limit = tagState.previewRowLimit || 0;
  if (limit > 0 && lines.length > limit) lines = lines.slice(0, limit);
  if (q) {
    lines = lines.filter(function(l) {
      return matches(l.original, q) || matches(l.translation, q) || matches(l.tag_l2, q);
    });
  }
  if (tagState.lines.length === 0) {
    document.getElementById('tagPreview').innerHTML = '<div class="empty-state">请先上传 txt 文件</div>';
    document.getElementById('tagPreviewCount').textContent = '0 行';
    return;
  }
  if (q && lines.length === 0) {
    document.getElementById('tagPreview').innerHTML = '<div class="empty-state">无匹配结果</div>';
    document.getElementById('tagPreviewCount').textContent = '0 条匹配';
    return;
  }
  var html = '<div class="line-list">';
  lines.forEach(function(l) {
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
  document.getElementById('tagPreview').innerHTML = html;
  document.getElementById('tagPreviewCount').textContent = q ? lines.length + ' 条匹配' : filtered.length + ' 行';
}

// ── 分类栏（显示条数与预览下拉同步） ──

function tagRenderColumns() {
  var container = document.getElementById('tagColumns');
  if (!container) return;
  var schema = getEnabledSchema();
  var validL1 = Object.keys(schema);
  var displayLimit = tagState.previewRowLimit || 0;
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
    var shown = displayLimit > 0 ? items.slice(0, displayLimit) : items;
    html += '<div class="tag-column" data-l1="' + l1 + '">' +
      '<div class="tag-column-header" style="border-left:3px solid ' + cat.color + '">' +
      '<span class="tag-col-icon">' + cat.icon + '</span>' +
      '<span class="tag-col-title">' + escHtml(l1) + '</span>' +
      '<span class="tag-col-count" id="cnt-' + l1 + '">' + items.length + '</span></div>' +
      '<div class="tag-column-body" data-l1="' + l1 + '" ' +
      'data-action="tag-column-body">';
    shown.forEach(function(l) { html += tagRenderCard(l); });
    if (displayLimit > 0 && items.length > displayLimit) html += '<div class="tag-column-empty">…还有 ' + (items.length - displayLimit) + ' 条</div>';
    if (items.length === 0) html += '<div class="tag-column-empty">拖入词条或运行分词</div>';
    html += '</div></div>';
  });
  var untagged = tagState.lines.filter(function(l) { return !l.tag_l1; });
  var untaggedLimit = tagState.previewRowLimit || 0;
  var unShown = untaggedLimit > 0 ? untagged.slice(0, untaggedLimit) : untagged;
  html += '<div class="tag-column tag-column-untagged">' +
    '<div class="tag-column-header" style="border-left:3px solid #888">' +
    '<span class="tag-col-icon">📋</span><span class="tag-col-title">未分类</span>' +
    '<span class="tag-col-count" id="cnt-untagged">' + untagged.length + '</span></div>' +
    '<div class="tag-column-body" data-l1="" ' +
    'data-action="tag-column-body">';
  unShown.forEach(function(l) { html += tagRenderCard(l); });
  if (untaggedLimit > 0 && untagged.length > untaggedLimit) html += '<div class="tag-column-empty">…还有 ' + (untagged.length - untaggedLimit) + ' 条</div>';
  if (untagged.length === 0 && tagState.lines.length > 0) html += '<div class="tag-column-empty">所有词条已分类 ✓</div>';
  html += '</div></div>';
  container.innerHTML = html;
  // 如果分类标签面板处于展开状态,同步刷新
  var catPanel = document.getElementById('tagCatPanel');
  if (catPanel && catPanel.classList.contains('visible')) tagRenderCatPanel();
}

// ── 增量更新单张卡片(分词进行时不重建整个列) ──
function tagUpdateOneCard(line) {
  var oldCard = document.querySelector('.tag-card[data-index="' + line.index + '"]');
  var cat = line.tag_l1 ? getEnabledSchema()[line.tag_l1] : null;
  var bc = cat ? cat.color : '#555';
  var expectedL1 = line.tag_l1 || '';

  if (oldCard) {
    // 更新内容
    oldCard.style.borderLeftColor = bc;
    var tagEl = oldCard.querySelector('.tag-card-tag');
    if (tagEl) tagEl.innerHTML = line.tag_l2
      ? escHtml(line.tag_l2) + (line.confidence > 0 ? ' <span class="tag-confidence">' + Math.round(line.confidence*100) + '%</span>' : '')
      : '<span style="color:var(--text-muted)">未标注</span>' + (line.confidence > 0 ? ' <span class="tag-confidence">' + Math.round(line.confidence*100) + '%</span>' : '');

    // 用 data-l1 属性判断卡片是否在正确栏(比 parentBody 更可靠)
    var cardL1 = oldCard.getAttribute('data-l1') || '';
    if (cardL1 !== expectedL1) {
      // 需要移动
      var srcBody = oldCard.closest('.tag-column-body');
      oldCard.remove();
      // 源栏变空时恢复空状态提示
      if (srcBody && srcBody.querySelectorAll('.tag-card').length === 0) {
        var srcL1 = srcBody.dataset.l1 || '';
        var emptyMsg = (!srcL1 && tagState.lines.filter(function(l){return !l.tag_l1;}).length === 0 && tagState.lines.length > 0)
          ? '所有词条已分类 ✓' : '拖入词条或运行分词';
        srcBody.insertAdjacentHTML('beforeend', '<div class="tag-column-empty">' + emptyMsg + '</div>');
      }
      // 插入目标栏
      var targetBody = document.querySelector('.tag-column-body[data-l1="' + expectedL1 + '"]');
      if (targetBody) {
        var empty = targetBody.querySelector('.tag-column-empty');
        if (empty) empty.remove();
        targetBody.insertAdjacentHTML('beforeend', tagRenderCard(line));
        // 更新新卡片的 data-l1
        var newCard = targetBody.querySelector('.tag-card[data-index="' + line.index + '"]');
        if (newCard) newCard.setAttribute('data-l1', expectedL1);
      }
      _tagBumpCount(cardL1, expectedL1);
    } else {
      // 已在正确栏,更新 data-l1 以防万一
      oldCard.setAttribute('data-l1', expectedL1);
    }
  } else {
    // 新卡片,追加到目标栏(优先目标栏,而非固定追加到未分类)
    var targetBody2 = document.querySelector('.tag-column-body[data-l1="' + expectedL1 + '"]');
    if (targetBody2) {
      var empty2 = targetBody2.querySelector('.tag-column-empty');
      if (empty2) empty2.remove();
      targetBody2.insertAdjacentHTML('beforeend', tagRenderCard(line));
      var newCard2 = targetBody2.querySelector('.tag-card[data-index="' + line.index + '"]');
      if (newCard2) newCard2.setAttribute('data-l1', expectedL1);
    }
  }
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
  if (!c) { _initTagCounts(); c = tagState._tagCounts; }
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
  if (!c) { _initTagCounts(); c = tagState._tagCounts; }
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
    var body = Object.assign({
      items: [{ original: line.original, translation: line.translation || line.original }],
      concurrency: 1,
      system_prompt: prompt,
    }, apiConfig);

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

// ── 批量分词(分块发送,每块条数 = 并发数,块间可停止) ──
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

  var concurrency = parseInt(document.getElementById('tagConcurrency').value) || 5;

  // 按并发数分块
  var chunks = [];
  for (var ci = 0; ci < pending.length; ci += concurrency) {
    chunks.push(pending.slice(ci, ci + concurrency));
  }
  var totalChunks = chunks.length;

  tagState.translating = true; tagState.abort = false; tagState.tagStarted = true;
  document.getElementById('tagBtnStart').disabled = true;
  document.getElementById('tagBtnStop').disabled = false;
  _tagStartRuntime(); tagLogClear();
  tagLog('开始分词,共 ' + pending.length + ' 行,并发 ' + concurrency + ',分 ' + totalChunks + ' 块');

  var apiConfig = tagGetApiConfig();
  var systemPrompt = document.getElementById('tagStrategyText');
  var strategyText = (systemPrompt && systemPrompt.value.trim()) || '你是一个游戏文本分类专家。请将以下文本归入最合适的类别。';
  var catDesc = '';
  var llmSchema = getEnabledSchema();
  Object.keys(llmSchema).forEach(function(l1) { catDesc += l1+': '+llmSchema[l1].subs.join(', ')+'\n'; });
  var fullPrompt = strategyText + '\n\n可用类别(一级 / 二级):\n' + catDesc + '\n请严格输出以下JSON格式:{"l1":"一级类目","l2":"二级类目","confidence":0.0~1.0}\n只输出JSON,不要其他内容。';

  var total = pending.length, done = 0, errors = 0;
  try {
    for (var chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      // 块间检查停止信号
      if (tagState.abort) {
        tagLog('用户停止,已完成 ' + done + '/' + total + ' 行(' + chunkIdx + '/' + totalChunks + ' 块)');
        break;
      }

      var chunk = chunks[chunkIdx];
      logChunk(chunkIdx + 1, totalChunks, chunk.length, total, 'tag');

      var batchBody = Object.assign({
        items: chunk.map(function(l) { return { original: l.original }; }),
        concurrency: concurrency,
        system_prompt: fullPrompt,
      }, apiConfig);
      var r = await fetch('/api/tag-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batchBody)
      });

      if (!r.ok) {
        var errText = '';
        try { var ed = await r.json(); errText = ed.error || ''; } catch (ex) { errText = r.statusText; }
        errors += chunk.length;
        done += chunk.length;
        tagLog('块 ' + (chunkIdx + 1) + ' 失败: ' + (errText || '请求错误'), 'err');
      } else {
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
                var item = chunk[pos];
                if (res.error) {
                  errors++;
                  tagLog('[' + (done+1) + '] ✗ "' + item.original.substring(0,20) + '" → ' + res.error, 'err');
                } else if (!item._manualEdit) {
                  item.tag_l1 = res.tag_l1;
                  item.tag_l2 = res.tag_l2;
                  item.confidence = res.confidence || 0;
                  tagUpdateOneCard(item);
                  tagLog('[' + (done+1) + '] ✓ "' + item.original.substring(0,20) + '" → ' + res.tag_l1 + '/' + res.tag_l2, 'ok');
                }
                done++;
              }
            } catch (parseErr) {}
          }
          document.getElementById('tagProgressFill').style.width = (done/total*100)+'%';
          document.getElementById('tagProgressText').textContent = '进度: '+done+'/'+total+' · 成功'+(done-errors)+' · 失败'+errors+' · 块'+(chunkIdx+1)+'/'+totalChunks;
        }
        // 处理 buffer 残留
        if (buf.trim()) {
          try {
            var lastRes = JSON.parse(buf.trim());
            var lastPos = lastRes.index;
            if (lastPos >= 0 && lastPos < chunk.length) {
              var lastItem = chunk[lastPos];
              if (lastRes.error) { errors++; }
              else if (!lastItem._manualEdit) {
                lastItem.tag_l1 = lastRes.tag_l1;
                lastItem.tag_l2 = lastRes.tag_l2;
                lastItem.confidence = lastRes.confidence || 0;
                tagUpdateOneCard(lastItem);
              }
              done++;
            }
          } catch (e2) {}
        }
      }

      // 更新进度
      document.getElementById('tagProgressFill').style.width = (done/total*100)+'%';
      document.getElementById('tagProgressText').textContent = '进度: '+done+'/'+total+' · 成功'+(done-errors)+' · 失败'+errors+' · 块'+(chunkIdx+1)+'/'+totalChunks;
    }
  } catch (e) {
    tagLog('异常: ' + e.message, 'err');
  }

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

function tagStop() { tagState.abort=true; document.getElementById('tagBtnStop').disabled=true; showToast('正在停止,当前块完成后不再发起新请求'); }

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

// ── 分词日志 ──
function tagLog(msg, cls) {
  var area = document.getElementById('tagLogArea'); if (!area) return;
  area.classList.add('visible');
  var now = new Date();
  var ts = (now.getHours()<10?'0':'')+now.getHours()+':'+(now.getMinutes()<10?'0':'')+now.getMinutes()+':'+(now.getSeconds()<10?'0':'')+now.getSeconds();
  var line = document.createElement('div'); line.className='log-line';
  line.innerHTML = '<span class="ts">'+ts+'</span><span class="'+(cls||'')+'">'+escHtml(msg)+'</span>';
  area.appendChild(line); while(area.children.length>100) area.removeChild(area.firstChild);
  area.scrollTop = area.scrollHeight;
}
function tagLogClear() { var a=document.getElementById('tagLogArea'); if(a){a.innerHTML='';a.classList.remove('visible');} }

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
    modal.innerHTML =
      '<div class="modal-box tag-admin-modal">' +
        '<div class="modal-msg" style="font-weight:600;margin-bottom:6px">📌 管理分类标签</div>' +
        '<div id="tagAdminBody" class="tag-admin-layout">' +
          '<div class="tag-admin-left" id="tagAdminLeft"></div>' +
          '<div class="tag-admin-right">' +
            '<div style="font-size:0.75rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px">二级类目池</div>' +
            '<div style="font-size:0.65rem;color:var(--text-muted);margin-bottom:6px">拖入左侧分配 | 双击编辑 | 仅此处可删除</div>' +
            '<div class="tag-admin-pool" id="tagAdminPool" data-action="tag-admin-pool-drop"></div>' +
            '<div style="display:flex;gap:4px;margin-top:8px">' +
            '<input id="tagAdminPoolInput" class="tag-admin-pool-input" placeholder="输入新二级类目" style="flex:1"' +
            ' onkeydown="if(event.key===\'Enter\')tagAdminAddToPool()">' +
            '<button class="btn btn-sm" data-action="tag-admin-add-pool">+</button>' +
          '</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-actions" style="margin-top:10px">' +
          '<button class="btn" data-action="tag-admin-export">导出</button>' +
          '<button class="btn" data-action="tag-admin-import">导入</button>' +
          '<span style="flex:1"></span>' +
          '<button class="btn btn-primary" id="tagAdminSave">保存并关闭</button>' +
          '<button class="btn" id="tagAdminCancel">取消</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.style.display = 'none'; });
    document.getElementById('tagAdminCancel').onclick = function() { modal.style.display = 'none'; };
    document.getElementById('tagAdminSave').onclick = _adminSave;
  }

  var leftHtml = '<div class="tag-admin-hint">双击名称编辑 | 删除类目子项回归二级池</div>';
  leftHtml += '<div id="tagAdminList">';
  Object.keys(schema).forEach(function(l1) {
    var cat = schema[l1];
    var disabledCls = cat.enabled === false ? ' tag-admin-disabled' : '';
    leftHtml +=
      '<div class="tag-admin-group' + disabledCls + '" data-l1="' + escHtml(l1) + '"' +
        ' data-action="tag-admin-group">' +
        '<div class="tag-admin-group-header">' +
          '<label class="tag-admin-enabled-wrap" title="启用/禁用">' +
            '<input type="checkbox" class="tag-admin-enabled"' + (cat.enabled !== false ? ' checked' : '') +
              ' data-action="admin-toggle-group">' +
          '</label>' +
          '<input class="tag-admin-icon" value="' + escHtml(cat.icon || '📌') + '" data-action="auto-save" style="width:30px;text-align:center">' +
          '<input class="tag-admin-name" value="' + escHtml(l1) + '" style="flex:1"' +
            ' data-action="make-editable" data-lock="save"' +
            ' readonly">' +
          '<input class="tag-admin-color" type="color" value="' + (cat.color || '#888') + '" data-action="auto-save" title="颜色">' +
          '<button class="btn btn-sm" data-action="tag-admin-add-sub">+子项</button>' +
          '<button class="btn btn-sm tag-admin-del-btn" data-action="tag-admin-remove-group">🗑</button>' +
        '</div>' +
        '<div class="tag-admin-subs">';
    (cat.subs || []).forEach(function(sub) {
      leftHtml += '<span class="tag-admin-sub-wrap" draggable="true"' +
        ' data-action="tag-admin-sub">' +
        '<input class="tag-admin-sub" value="' + escHtml(sub) + '"' +
          ' data-action="make-editable" data-lock="save"' +
          ' readonly">' +
        '<span class="tag-admin-sub-del" data-action="tag-admin-remove-sub" title="移回二级池">&times;</span>' +
      '</span>';
    });
    leftHtml += '</div></div>';
  });
  leftHtml += '</div>';
  leftHtml += '<button class="btn btn-sm" data-action="tag-admin-add-group" style="margin-top:4px">+ 添加一级类目</button>';
  document.getElementById('tagAdminLeft').innerHTML = leftHtml;

  var poolHtml = '';
  availablePool.forEach(function(name) {
    poolHtml +=
      '<div class="tag-admin-pool-chip" draggable="true"' +
        ' data-action="tag-admin-pool-chip">' +
        '<span class="tag-admin-pool-text">' + escHtml(name) + '</span>' +
        '<span class="tag-admin-pool-del" data-action="tag-admin-del-pool-item" title="永久删除">&times;</span>' +
      '</div>';
  });
  if (poolHtml === '') {
    poolHtml = '<div style="font-size:0.68rem;color:var(--text-muted);text-align:center;padding:12px 0">池中暂无二级类目<br>点击下方按钮添加</div>';
  }
  document.getElementById('tagAdminPool').innerHTML = poolHtml;

  modal.style.display = 'flex';
}


function tagAdminAddSub(btn) {
  var wrapper = btn.closest('.tag-admin-group').querySelector('.tag-admin-subs');
  var span = document.createElement('span');
  span.className = 'tag-admin-sub-wrap';
  span.draggable = true;
  span.setAttribute('data-action', 'tag-admin-sub');
  span.innerHTML = '<input class="tag-admin-sub" placeholder="新子项" value="">' +
    '<span class="tag-admin-sub-del" data-action="tag-admin-remove-sub" title="移回二级池">&times;</span>';
  wrapper.appendChild(span);
  span.querySelector('input').focus();
}


function _randomAdminColor() {
  var palette = ['#4fc3f7','#81c784','#ef5350','#ffb74d','#ce93d8','#90a4ae','#a1887f','#4dd0e1','#f06292','#aed581'];
  var used = new Set();
  document.querySelectorAll('.tag-admin-color').forEach(function(c) { used.add(c.value); });
  var available = palette.filter(function(c) { return !used.has(c); });
  if (available.length === 0) available = palette;
  return available[Math.floor(Math.random() * available.length)];
}

function tagAdminAddGroup() {
  var list = document.getElementById('tagAdminList');
  var newGroup = document.createElement('div');
  newGroup.className = 'tag-admin-group';
  newGroup.setAttribute('data-action', 'tag-admin-group');
  newGroup.dataset.l1 = '新类目';
  newGroup.innerHTML = '<div class="tag-admin-group-header">' +
    '<label class="tag-admin-enabled-wrap" title="启用/禁用">' +
      '<input type="checkbox" class="tag-admin-enabled" checked data-action="admin-toggle-group">' +
    '</label>' +
    '<input class="tag-admin-icon" value="📌" data-action="auto-save" style="width:30px;text-align:center">' +
    '<input class="tag-admin-name" value="新类目" data-action="make-editable" data-lock="save" readonly style="flex:1">' +
    '<input class="tag-admin-color" type="color" value=' + _randomAdminColor() + ' data-action="auto-save">' +
    '<button class="btn btn-sm" data-action="tag-admin-add-sub">+子项</button>' +
    '<button class="btn btn-sm tag-admin-del-btn" data-action="tag-admin-remove-group">🗑</button>' +
  '</div>' +
  '<div class="tag-admin-subs"></div>';
  list.appendChild(newGroup);
  newGroup.querySelector('.tag-admin-name').focus();
  
}

function tagAdminRemoveGroup(btn) {
  if (document.querySelectorAll('.tag-admin-group').length <= 1) {
    showToast('至少保留一个一级类目');
    return;
  }
  var group = btn.closest('.tag-admin-group');
  var subInputs = group.querySelectorAll('.tag-admin-sub');
  var pool = getSubPool();
  subInputs.forEach(function(input) {
    var val = (input.value || input.defaultValue || '').trim();
    if (val && pool.indexOf(val) === -1) pool.push(val);
  });
  saveSubPool(pool);
  group.remove();
  _refreshPool();
  _adminPreview();
}


// ── 从一级类目下移除子项（回归二级池） ──
function tagAdminRemoveSub(el) {
  var input = el.parentElement.querySelector('.tag-admin-sub');
  var name = (input.value || input.defaultValue || '').trim();
  el.parentElement.remove();
  if (name) { var pool = getSubPool(); if (pool.indexOf(name) === -1) { pool.push(name); saveSubPool(pool); } _refreshPool(); }
  _adminPreview();
}

// ── 池子拖拽事件 ──
function tagAdminPoolDragStart(e, el) {
  e.dataTransfer.setData('text/plain', el.querySelector('.tag-admin-pool-text').textContent);
  e.dataTransfer.setData('source', 'pool');
  e.dataTransfer.effectAllowed = 'move'; el.classList.add('drag-start');
  setTimeout(function() { if (el) el.classList.remove('drag-start'); }, 0);
}
function tagAdminPoolDragEnd(e, el) { el.classList.remove('drag-start'); }

// ── 一级类目 drop 区域 ──
function tagAdminDragOver(e, group) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; group.classList.add('drag-over'); }
function tagAdminDragLeave(e, group) { group.classList.remove('drag-over'); }
function tagAdminDrop(e, group) {
  e.preventDefault(); group.classList.remove('drag-over');
  var name = e.dataTransfer.getData('text/plain');
  if (!name) return;
  var isSub = e.dataTransfer.getData('source') === 'sub';
  
  // Find target sub-wrap under mouse for position-aware insertion
  var targetWrap = e.target.closest('.tag-admin-sub-wrap');
  var subsDiv = group.querySelector('.tag-admin-subs');
  
  // Same-group reorder: if the dragged item is already in this group, just move it
  if (isSub) {
    var existingInGroup = null;
    group.querySelectorAll('.tag-admin-sub-wrap').forEach(function(wrap) {
      var inp = wrap.querySelector('.tag-admin-sub');
      if (inp && (inp.value || inp.defaultValue || '').trim() === name) existingInGroup = wrap;
    });
    if (existingInGroup) {
      // Reorder within same group
      if (targetWrap && targetWrap !== existingInGroup) {
        var rect = targetWrap.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          subsDiv.insertBefore(existingInGroup, targetWrap);
        } else {
          subsDiv.insertBefore(existingInGroup, targetWrap.nextSibling);
        }
        _adminPreview();
      }
      return;
    }
  }
  
  // Cross-group: check duplicates
  var existingSubs = group.querySelectorAll('.tag-admin-sub');
  for (var i = 0; i < existingSubs.length; i++) {
    if ((existingSubs[i].value || existingSubs[i].defaultValue || '').trim() === name) {
      _refreshPool(); return;
    }
  }
  
  if (isSub) {
    // Remove from source group
    var allWraps = document.querySelectorAll('.tag-admin-sub-wrap');
    allWraps.forEach(function(wrap) {
      var input = wrap.querySelector('.tag-admin-sub');
      var subName = (input.value || input.defaultValue || '').trim();
      if (subName === name) { wrap.remove(); }
    });
  } else {
    // Remove from pool
    var pool = getSubPool(); var idx = pool.indexOf(name);
    if (idx !== -1) { pool.splice(idx, 1); saveSubPool(pool); }
    else return;
  }
  
  // Create and insert at position
  var subHtml = '<span class="tag-admin-sub-wrap" draggable="true"' +
    ' data-action="tag-admin-sub">' +
    '<input class="tag-admin-sub" value="' + escHtml(name) + '" data-action="make-editable" data-lock="save" readonly>' +
    '<span class="tag-admin-sub-del" data-action="tag-admin-remove-sub" title="移回二级池">&times;</span>' +
  '</span>';
  var temp = document.createElement('div'); temp.innerHTML = subHtml; var newEl = temp.firstElementChild;
  if (targetWrap && targetWrap.parentElement === subsDiv) {
    var rect = targetWrap.getBoundingClientRect();
    if (e.clientY < rect.top + rect.height / 2) {
      subsDiv.insertBefore(newEl, targetWrap);
    } else {
      subsDiv.insertBefore(newEl, targetWrap.nextSibling);
    }
  } else {
    subsDiv.appendChild(newEl);
  }
  _refreshPool();
  _adminPreview();
}

// ── 池子双击编辑 ──
function tagAdminPoolEdit(e, el) {
  if (e.target.classList.contains('tag-admin-pool-del')) return;
  var textSpan = el.querySelector('.tag-admin-pool-text');
  var oldName = textSpan.textContent;
  var input = document.createElement('input');
  input.type = 'text'; input.value = oldName; input.className = 'tag-admin-sub';
  input.style.cssText = 'width:calc(100% - 18px);padding:2px 4px;font-size:0.73rem';
  textSpan.replaceWith(input); input.focus(); input.select();
  function commit() {
    var newName = input.value.trim();
    if (newName && newName !== oldName) {
      var pool = getSubPool(); var idx = pool.indexOf(oldName);
      if (idx !== -1) { pool[idx] = newName; saveSubPool(pool); }
    }
    var span = document.createElement('span'); span.className = 'tag-admin-pool-text'; span.textContent = newName || oldName; input.replaceWith(span);
    _adminPreview();
    
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', function(ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    if (ev.key === 'Escape') { input.value = oldName; commit(); }
  });
}

// ── 永久删除池子条目 ──
function tagAdminDeletePoolItem(e, el) {
  e.stopPropagation();
  var chip = el.closest('.tag-admin-pool-chip');
  if (!chip) return;
  var nameEl = chip.querySelector('.tag-admin-pool-text');
  if (!nameEl) return;
  var name = nameEl.textContent;
  var pool = getSubPool(); var idx = pool.indexOf(name); if (idx !== -1) { pool.splice(idx, 1); saveSubPool(pool); }
  chip.remove();
  if (document.querySelectorAll('.tag-admin-pool-chip').length === 0) _refreshPool();
  _adminPreview();
}

// ── 添加新条目到池子 ──
function tagAdminAddToPool() {
  var input = document.getElementById('tagAdminPoolInput');
  if (!input) return;
  var name = input.value.trim();
  if (!name) return;
  var pool = getSubPool(); if (pool.indexOf(name) !== -1) { showToast('此名称已存在'); return; }
  var schema = getTagSchema(); var assigned = false;
  Object.keys(schema).forEach(function(l1) { if ((schema[l1].subs || []).indexOf(name) !== -1) assigned = true; });
  if (assigned) { showToast('该名称已在分类中使用'); return; }
  pool.push(name); saveSubPool(pool);
  input.value = '';
  _refreshPool();
  _adminPreview();
  input.focus();
}

// ── 左侧子项拖拽 ──
function tagAdminSubDragStart(e, el) {
  var input = el.querySelector('.tag-admin-sub');
  var name = (input.value || input.defaultValue || '').trim();
  e.dataTransfer.setData('text/plain', name);
  e.dataTransfer.setData('source', 'sub');
  e.dataTransfer.effectAllowed = 'move';
  el.classList.add('drag-start');
}
function tagAdminSubDragEnd(e, el) { el.classList.remove('drag-start'); }

// ── 池子接收拖入的子项 ──
function tagAdminPoolDrop(e) {
  e.preventDefault();
  var name = e.dataTransfer.getData('text/plain');
  var source = e.dataTransfer.getData('source');
  if (!name || source !== 'sub') return;
  // 从左侧DOM移除
  var wraps = document.querySelectorAll('.tag-admin-sub-wrap');
  wraps.forEach(function(wrap) {
    var input = wrap.querySelector('.tag-admin-sub');
    var subName = (input.value || input.defaultValue || '').trim();
    if (subName === name) { wrap.remove(); }
  });
  // 加入池子
  var pool = getSubPool();
  if (pool.indexOf(name) === -1) { pool.push(name); saveSubPool(pool); }
  _refreshPool();
  _adminPreview();
}

// ── 刷新右侧池子 DOM ──
function _refreshPool() {
  var container = document.getElementById('tagAdminPool'); if (!container) return;
  var subPool = getSubPool();
  var assignedSubs = new Set();
  // 从当前DOM扫描已分配的子项（反映未保存的拖拽/删除操作）
  document.querySelectorAll('.tag-admin-sub').forEach(function(input) {
    var val = (input.value || input.defaultValue || '').trim();
    if (val) assignedSubs.add(val);
  });
  var available = subPool.filter(function(s) { return !assignedSubs.has(s); });
  if (available.length === 0) { container.innerHTML = '<div style="font-size:0.68rem;color:var(--text-muted);text-align:center;padding:12px 0">池中暂无二级类目<br>点击下方按钮添加</div>'; return; }
  var html = '';
  available.forEach(function(name) {
    html += '<div class="tag-admin-pool-chip" draggable="true" data-action="tag-admin-pool-chip">' +
      '<span class="tag-admin-pool-text">' + escHtml(name) + '</span>' +
      '<span class="tag-admin-pool-del" data-action="tag-admin-del-pool-item" title="永久删除">&times;</span>' +
    '</div>';
  });
  container.innerHTML = html;
}

// ── 自动保存(静默, 不关闭弹窗) ──
function _adminPreview() {
  // Read current admin DOM state and re-render columns without saving to DB
  var newSchema = {};
  var groups = document.querySelectorAll('.tag-admin-group');
  groups.forEach(function(group) {
    var nameInput = group.querySelector('.tag-admin-name');
    var l1 = nameInput ? (nameInput.value || nameInput.defaultValue || '').trim() : '';
    var color = group.querySelector('.tag-admin-color'); var colorVal = color ? color.value : '#888';
    var icon = group.querySelector('.tag-admin-icon'); var iconVal = icon ? (icon.value || icon.defaultValue || '📌') : '📌';
    var enabled = group.querySelector('.tag-admin-enabled'); var enabledVal = enabled ? enabled.checked : true;
    var subs = [];
    group.querySelectorAll('.tag-admin-sub').forEach(function(subInput) { var val = (subInput.value || subInput.defaultValue || '').trim(); if (val) subs.push(val); });
    if (l1) { newSchema[l1] = { color: colorVal, icon: iconVal, subs: subs.length > 0 ? subs : ['未分类'], enabled: enabledVal }; }
  });
  // Temporarily override the schema in cache for rendering
  dbSet('tllmh_tag_schema', newSchema);
  var poolChips = document.querySelectorAll('.tag-admin-pool-chip'); var newPool = [];
  poolChips.forEach(function(chip) { var txt = chip.querySelector('.tag-admin-pool-text'); if (txt) newPool.push(txt.textContent.trim()); });
  saveSubPool(newPool);
  tagRenderColumns(); tagRenderPreview(); tagRenderCatPanel(); tagBtnState();
}

function _autoSave() {
  var newSchema = {};
  var groups = document.querySelectorAll('.tag-admin-group');
  groups.forEach(function(group) {
    var nameInput = group.querySelector('.tag-admin-name');
    var l1 = nameInput ? (nameInput.value || nameInput.defaultValue || '').trim() : '';
    var color = group.querySelector('.tag-admin-color'); var colorVal = color ? color.value : '#888';
    var icon = group.querySelector('.tag-admin-icon'); var iconVal = icon ? (icon.value || icon.defaultValue || '📌') : '📌';
    var enabled = group.querySelector('.tag-admin-enabled'); var enabledVal = enabled ? enabled.checked : true;
    var subs = [];
    group.querySelectorAll('.tag-admin-sub').forEach(function(subInput) { var val = (subInput.value || subInput.defaultValue || '').trim(); if (val) subs.push(val); });
    if (l1 && subs.length > 0) { newSchema[l1] = { color: colorVal, icon: iconVal, subs: subs, enabled: enabledVal }; }
  });
  if (Object.keys(newSchema).length === 0) return;
  var poolChips = document.querySelectorAll('.tag-admin-pool-chip'); var newPool = [];
  poolChips.forEach(function(chip) { var txt = chip.querySelector('.tag-admin-pool-text'); if (txt) newPool.push(txt.textContent.trim()); });
  saveSubPool(newPool); saveTagSchema(newSchema);
  tagRenderColumns(); tagRenderPreview(); tagRenderCatPanel(); tagBtnState();
}

// ── 保存逻辑 ──
function _adminSave() {
  var modal = document.getElementById('tagAdminModal');
  var groups = document.querySelectorAll('.tag-admin-group');
  // Check before auto-save (avoids toast on every silent save)
  var hasValid = false;
  groups.forEach(function(group) {
    var nameInput = group.querySelector('.tag-admin-name');
    var l1 = nameInput ? (nameInput.value || nameInput.defaultValue || '').trim() : '';
    var subs = [];
    group.querySelectorAll('.tag-admin-sub').forEach(function(s) { var val = (s.value || s.defaultValue || '').trim(); if (val) subs.push(val); });
    if (l1 && subs.length > 0) hasValid = true;
  });
  if (!hasValid) { showToast('至少保留一个一级类目'); return; }
  _autoSave();
  modal.style.display = 'none';
  tagRenderColumns(); tagRenderPreview(); tagRenderCatPanel(); tagBtnState();
  showToast('标签体系已更新');
}

function tagAdminExport() {
  var schema = getTagSchema();
  var blob = new Blob([JSON.stringify(schema, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'tag_schema.json';
  a.click();
  setTimeout(function(){URL.revokeObjectURL(url);},5000);
  showToast('已导出标签体系');
}

function tagAdminImport() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      try {
        var data = JSON.parse(ev.target.result);
        if (typeof data !== 'object' || data === null || Object.keys(data).length === 0) {
          showToast('无效的标签体系文件');
          return;
        }
        // 验证结构:每个 key 必须有 subs 数组
        for (var key in data) {
          if (!data[key].subs || !Array.isArray(data[key].subs)) {
            showToast('格式错误:' + key + ' 缺少 subs 数组');
            return;
          }
        }
        saveTagSchema(data);
        // 刷新管理面板
        tagOpenAdmin();
        tagRenderColumns();
        tagRenderPreview();
        tagRenderCatPanel();
        showToast('已导入标签体系(' + Object.keys(data).length + ' 个类目)');
      } catch (ex) {
        showToast('导入失败: ' + ex.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── 初始化(由 switchPage 懒调用,只执行一次) ──
function tagInit() {
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

  // 标签管理面板
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    if (action === 'tag-admin-add-pool') tagAdminAddToPool();
    else if (action === 'tag-admin-export') tagAdminExport();
    else if (action === 'tag-admin-import') tagAdminImport();
    else if (action === 'tag-admin-add-sub') tagAdminAddSub(btn);
    else if (action === 'tag-admin-remove-group') tagAdminRemoveGroup(btn);
    else if (action === 'tag-admin-remove-sub') tagAdminRemoveSub(btn);
    else if (action === 'tag-admin-add-group') tagAdminAddGroup();
    else if (action === 'tag-admin-del-pool-item') tagAdminDeletePoolItem(e, btn);
    else if (action === 'tag-edit-pick') tagEditPick(btn.dataset.l1, btn.dataset.l2);
    else if (action === 'make-editable') { btn.readOnly = false; btn.focus(); btn.select(); }
    else if (action === 'tag-admin-pool-chip') tagAdminPoolEdit(e, btn);
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
      var action = el.dataset.action;
      if (action === 'tag-edit-select-change') tagEditSelectChange();
      else if (action === 'auto-save' || action === 'admin-toggle-group') {
        if (action === 'admin-toggle-group') {
          var group = el.closest('.tag-admin-group');
          if (group) group.classList.toggle('tag-admin-disabled', !el.checked);
        }
        _adminPreview();
      }
    });
    tagPage.addEventListener('blur', function(e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var lockType = el.getAttribute('data-lock');
      if (lockType) el.readOnly = true;
      // Preview on blur for admin panel inputs
      if (el.classList.contains('tag-admin-name') || el.classList.contains('tag-admin-sub') ||
          el.classList.contains('tag-admin-icon') || el.classList.contains('tag-admin-color')) {
        _adminPreview();
      }
    }, true);
    tagPage.addEventListener('dblclick', function(e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      if (el.dataset.action === 'make-editable') { el.readOnly = false; el.focus(); el.select(); }
    });
    // Drag/drop delegation for tag cards
    tagPage.addEventListener('dragstart', function(e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var action = el.dataset.action;
      if (action === 'tag-card') tagCardDragStart(e);
      else if (action === 'tag-admin-sub') tagAdminSubDragStart(e, el);
      else if (action === 'tag-admin-pool-chip') tagAdminPoolDragStart(e, el);
    });
    tagPage.addEventListener('dragend', function(e) {
      var el = e.target.closest('[data-action]');
      if (!el) return;
      var action = el.dataset.action;
      if (action === 'tag-card') tagCardDragEnd(e);
      else if (action === 'tag-admin-sub') tagAdminSubDragEnd(e, el);
      else if (action === 'tag-admin-pool-chip') tagAdminPoolDragEnd(e, el);
    });
    tagPage.addEventListener('dragover', function(e) {
      // Find the drop container (column body, admin group, or pool)
      var col = e.target.closest('.tag-column-body');
      var grp = e.target.closest('.tag-admin-group');
      var pool = e.target.closest('.tag-admin-pool');
      if (col) { e.preventDefault(); tagDragOver(e, col); }
      else if (grp) { e.preventDefault(); tagAdminDragOver(e, grp); }
      else if (pool) { e.preventDefault(); }
    });
    tagPage.addEventListener('dragleave', function(e) {
      var col = e.target.closest('.tag-column-body');
      var grp = e.target.closest('.tag-admin-group');
      if (col) tagDragLeave(e, col);
      else if (grp) tagAdminDragLeave(e, grp);
    });
    tagPage.addEventListener('drop', function(e) {
      e.preventDefault();
      var col = e.target.closest('.tag-column-body');
      var grp = e.target.closest('.tag-admin-group');
      if (col) tagDrop(e, col);
      else if (grp) tagAdminDrop(e, grp);
      else {
        // Pool drop
        var poolEl = e.target.closest('.tag-admin-pool');
        if (poolEl) tagAdminPoolDrop(e);
      }
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
