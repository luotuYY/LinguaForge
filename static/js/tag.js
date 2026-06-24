/**
 * TxtLlmHub - 分词/标签模块
 * 文本分类、LLM 分词、卡片拖拽排序、标签管理、导入翻译
 * Depends on: utils.js($, escHtml, showToast, log)
 */

// ── 分词页状态 ──
var tagState = {
  lines: [],
  files: [],
  fileNames: [],
  translating: false,
  abort: false,
  query: '',
  previewRowLimit: 2000,
  selectedIndices: new Set(),
  tagStarted: false,  // 是否过分词任务(用于区分「开始」和「继续」)
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
  try {
    var saved = localStorage.getItem('tllmh_tag_schema');
    if (saved) {
      var parsed = JSON.parse(saved);
      if (typeof parsed === 'object' && parsed !== null && Object.keys(parsed).length > 0) {
        return parsed;
      }
    }
  } catch (e) { /* ignore corrupt data */ }
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
  localStorage.setItem('tllmh_tag_schema', JSON.stringify(schema));
}

function getSubPool() {
  try {
    var saved = localStorage.getItem('tllmh_sub_pool');
    if (saved) {
      var arr = JSON.parse(saved);
      if (Array.isArray(arr)) return arr;
    }
  } catch (e) { /* ignore */ }
  return DEFAULT_SUB_POOL.slice();
}
function saveSubPool(pool) {
  localStorage.setItem('tllmh_sub_pool', JSON.stringify(pool));
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
      var lf = d.lines[li]._file || '';
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
          translation: fileLines[fli].translation, _file: fname,
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
        _file: '手动录入', tag_l1: '', tag_l2: '', confidence: 0
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
    var cnt = tagState.lines.filter(function(l) { return l._file === f.name; }).length;
    html += '<div class="file-entry"><span class="file-name">' + escHtml(f.name) +
      '</span><span class="file-count">' + cnt + ' 行</span>' +
      '<span class="file-delete" onclick="tagDeleteFile(' + i + ')">🗑</span></div>';
  }
  document.getElementById('tagFileInfo').innerHTML = html || '<div class="empty-state">暂无来源文件</div>';
}

function tagDeleteFile(index) {
  var f = tagState.files[index];
  if (!f) return;
  tagState.lines = tagState.lines.filter(function(l) { return l._file !== f.name; });
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
    return !l._file || checkedFiles.indexOf(l._file) >= 0;
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
  var html = '';
  Object.keys(schema).forEach(function(l1) {
    var cat = schema[l1];
    var items = tagState.lines.filter(function(l) { return l.tag_l1 === l1; });
    var shown = displayLimit > 0 ? items.slice(0, displayLimit) : items;
    html += '<div class="tag-column" data-l1="' + l1 + '">' +
      '<div class="tag-column-header" style="border-left:3px solid ' + cat.color + '">' +
      '<input type="checkbox" class="tag-column-select-all" data-l1="' + l1 + '" onchange="tagSelectAllInColumn(\'' + l1 + '\', this.checked)" title="全选/取消本分类">' +
      '<span class="tag-col-icon">' + cat.icon + '</span>' +
      '<span class="tag-col-title">' + escHtml(l1) + '</span>' +
      '<span class="tag-col-count" id="cnt-' + l1 + '">' + items.length + '</span></div>' +
      '<div class="tag-column-body" data-l1="' + l1 + '" ' +
      'ondragover="tagDragOver(event)" ondrop="tagDrop(event)" ondragleave="tagDragLeave(event)">';
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
    '<input type="checkbox" class="tag-column-select-all" data-l1="" onchange="tagSelectAllInColumn(\'\', this.checked)" title="全选/取消未分类">' +
    '<span class="tag-col-icon">📋</span><span class="tag-col-title">未分类</span>' +
    '<span class="tag-col-count" id="cnt-untagged">' + untagged.length + '</span></div>' +
    '<div class="tag-column-body" data-l1="" ' +
    'ondragover="tagDragOver(event)" ondrop="tagDrop(event)" ondragleave="tagDragLeave(event)">';
  unShown.forEach(function(l) { html += tagRenderCard(l); });
  if (untaggedLimit > 0 && untagged.length > untaggedLimit) html += '<div class="tag-column-empty">…还有 ' + (untagged.length - untaggedLimit) + ' 条</div>';
  if (untagged.length === 0 && tagState.lines.length > 0) html += '<div class="tag-column-empty">所有词条已分类 ✓</div>';
  html += '</div></div>';
  container.innerHTML = html;
  tagUpdateColumnSelectAllStates();
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
      tagUpdateCounts();
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
function tagUpdateCounts() {
  var schema = getEnabledSchema();
  Object.keys(schema).forEach(function(l1) {
    var el = document.getElementById('cnt-' + l1);
    if (el) el.textContent = tagState.lines.filter(function(l) { return l.tag_l1 === l1; }).length;
  });
  var ue = document.getElementById('cnt-untagged');
  if (ue) ue.textContent = tagState.lines.filter(function(l) { return !l.tag_l1; }).length;
}

function tagRenderCard(l) {
  var cat = l.tag_l1 ? getEnabledSchema()[l.tag_l1] : null;
  var bc = cat ? cat.color : '#555';
  var checkedAttr = tagState.selectedIndices.has(l.index) ? ' checked' : '';
  return '<div class="tag-card" draggable="true" data-index="' + l.index + '" data-l1="' + escHtml(l.tag_l1 || '') + '" ' +
    'ondragstart="tagCardDragStart(event)" ondragend="tagCardDragEnd(event)" ' +
    'style="border-left:3px solid ' + bc + '">' +
    '<div class="tag-card-row1">' +
      '<input type="checkbox" class="tag-card-check" data-index="' + l.index + '"' + checkedAttr + ' onchange="tagToggleSelect(' + l.index + ', this.checked)" title="勾选后导入翻译">' +
      '<span class="tag-card-num">#' + (l.index+1) + '</span>' +
      '<span class="tag-card-orig">' + escHtml(l.original) + '</span>' +
      '<span class="tag-card-actions"><button class="btn btn-sm" onclick="tagEditCategory(' + l.index + ')">✏️</button></span>' +
    '</div>' +
    (l.translation ? '<div class="tag-card-tran">' + escHtml(l.translation) + '</div>' : '') +
    '<div class="tag-card-tag">' + (l.tag_l2 ? escHtml(l.tag_l2) : '<span style="color:var(--text-muted)">未标注</span>') +
    (l.confidence > 0 ? ' <span class="tag-confidence">' + Math.round(l.confidence*100) + '%</span>' : '') +
    '</div></div>';
}

// ── 卡片选中/全选 ──
function tagToggleSelect(index, checked) {
  if (checked) tagState.selectedIndices.add(index);
  else tagState.selectedIndices.delete(index);
  tagUpdateColumnSelectAllStates();
  tagBtnState();
}

// ── 列头全选/状态同步 ──
function tagSelectAllInColumn(l1, checked) {
  var lines = tagState.lines.filter(function(l) { return (l.tag_l1 || '') === l1; });
  lines.forEach(function(l) {
    if (checked) tagState.selectedIndices.add(l.index);
    else tagState.selectedIndices.delete(l.index);
  });
  document.querySelectorAll('.tag-card-check').forEach(function(cb) {
    var idx = parseInt(cb.dataset.index);
    cb.checked = tagState.selectedIndices.has(idx);
  });
  tagUpdateColumnSelectAllStates();
  tagBtnState();
}

function tagUpdateColumnSelectAllStates() {
  document.querySelectorAll('.tag-column').forEach(function(col) {
    var l1 = col.dataset.l1;
    var lines = tagState.lines.filter(function(l) { return (l.tag_l1 || '') === l1; });
    var total = lines.length;
    var selected = lines.filter(function(l) { return tagState.selectedIndices.has(l.index); }).length;
    var chk = col.querySelector('.tag-column-select-all');
    if (chk) {
      chk.checked = (total > 0 && selected === total);
      chk.indeterminate = (selected > 0 && selected < total);
    }
  });
}

// ── 导入到翻译页(按分类分组,去重) ──
function tagSendToTranslate() {
  if (tagState.selectedIndices.size === 0) { showToast('请先勾选要导入的条目'); return; }
  var selectedLines = [];
  tagState.selectedIndices.forEach(function(idx) {
    var line = tagState.lines[idx];
    if (line) selectedLines.push(line);
  });
  if (selectedLines.length === 0) { showToast('没有有效条目可导入'); return; }
  if (typeof state === 'undefined') { showToast('翻译页未初始化'); return; }

  // 按 tag_l1 分组
  var groups = {};
  selectedLines.forEach(function(l) {
    var key = l.tag_l1 || '未分类';
    if (!groups[key]) groups[key] = [];
    groups[key].push(l);
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
        _file: virtualFile,
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

  tagState.selectedIndices.clear();
  tagRenderColumns();
  tagBtnState();
  showToast('已导入 ' + totalAdded + ' 行到翻译页(' + fileNames.length + ' 个分类)');
  switchPage('translate');
}

// ── 卡片拖拽 ──
var _tagDragIdx = -1;
function tagCardDragStart(e) { _tagDragIdx = parseInt(e.target.closest('.tag-card').dataset.index); e.dataTransfer.effectAllowed='move'; e.target.closest('.tag-card').classList.add('dragging'); }
function tagCardDragEnd(e) { document.querySelectorAll('.tag-card').forEach(function(el){el.classList.remove('dragging');}); document.querySelectorAll('.tag-column-body').forEach(function(el){el.classList.remove('drag-over-col');}); }
function tagDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect='move'; e.currentTarget.classList.add('drag-over-col'); }
function tagDragLeave(e) { e.currentTarget.classList.remove('drag-over-col'); }
function tagDrop(e) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over-col');
  var targetL1 = e.currentTarget.dataset.l1;
  if (_tagDragIdx < 0) return;
  var line = tagState.lines[_tagDragIdx]; if (!line) return;
  var targetCard = e.target.closest('.tag-card');
  if (targetCard && parseInt(targetCard.dataset.index) !== _tagDragIdx) {
    var tIdx = parseInt(targetCard.dataset.index);
    var tLine = tagState.lines[tIdx];
    if (tLine && line.tag_l1 === tLine.tag_l1) {
      tagState.lines.splice(_tagDragIdx, 1);
      var ni = tagState.lines.indexOf(tLine);
      tagState.lines.splice(ni, 0, line);
      tagState.lines.forEach(function(l,i){l.index=i;});
      tagRenderColumns(); tagRenderPreview();
      showToast('已调整顺序'); _tagDragIdx = -1; return;
    }
  }
  line.tag_l1 = targetL1;
  var dropSchema = getEnabledSchema();
  if (targetL1 && dropSchema[targetL1]) {
    if (!line.tag_l2 || (dropSchema[line.tag_l1] && dropSchema[line.tag_l1].subs.indexOf(line.tag_l2)===-1))
      line.tag_l2 = dropSchema[targetL1].subs[0] || '';
  } else { line.tag_l1 = ''; line.tag_l2 = ''; }
  tagRenderColumns(); tagRenderPreview();
  showToast('已移至 ' + (targetL1 || '未分类')); _tagDragIdx = -1;
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
    '<div style="position:relative;margin-bottom:8px"><input type="text" id="tagEditSearch" placeholder="搜索类目..." class="param-input" style="width:100%" oninput="tagEditFilter()" autocomplete="off">' +
    '<div id="tagEditDropdown" class="tag-edit-dropdown" style="display:none"></div></div>' +
    '<select id="tagEditSelect" class="param-input" style="width:100%;margin-top:4px" onchange="tagEditSelectChange()">' + options + '</select>';
  modal.style.display = 'flex'; modal._index = index;
  document.getElementById('tagEditOk').onclick = function() {
    var sel = document.getElementById('tagEditSelect').value;
    if (sel) { var p = sel.split('|'); line.tag_l1 = p[0]; line.tag_l2 = p[1]||''; }
    else { line.tag_l1 = ''; line.tag_l2 = ''; }
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
  var h=''; matchItems.forEach(function(s){ h+='<div class="tag-edit-option" onclick="tagEditPick(\''+s.l1+'\',\''+s.l2+'\')"><span style="color:'+(editSchema[s.l1]?editSchema[s.l1].color:'#888')+'">'+escHtml(s.l1)+'</span> / '+escHtml(s.l2)+'</div>'; });
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
  tagState.lines=[]; tagState.files=[]; tagState.fileNames=[]; tagState.query=''; tagState.selectedIndices.clear(); tagState.tagStarted=false;
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

function tagTriggerDownload(name, content) {
  var blob = new Blob([content],{type:'text/plain;charset=utf-8'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href=url; a.download=name; a.click();
  URL.revokeObjectURL(url);
}

// ── 搜索(分词页) ──
function tagOnSearch() { tagState.query = document.getElementById('tagSearch').value; tagRenderPreview(); }
function tagClearSearch() { document.getElementById('tagSearch').value=''; tagState.query=''; tagRenderPreview(); }

// ── 按钮状态管理 ──
function tagBtnState() {
  var has = tagState.lines.length > 0;
  document.getElementById('tagBtnClear').disabled = !has;
  document.getElementById('tagBtnExport').disabled = !tagState.lines.some(function(l){return l.tag_l1;});
  var hasSelected = tagState.selectedIndices.size > 0;
  var importBtn = document.getElementById('tagBtnImport');
  if (importBtn) importBtn.disabled = !hasSelected || (typeof state !== 'undefined' && state.translating);
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
    html += '<span class="prompt-chip preset" onclick="tagLoadStrategyPreset(' + i + ')" style="max-width:100px"><span class="chip-text">' + p.name + '</span></span>';
  });
  container.innerHTML = html;
}

function tagLoadStrategyPreset(index) {
  var p = _tagStrategyPresets[index];
  if (!p) return;
  var ta = document.getElementById('tagStrategyText');
  if (ta) ta.value = p.text;
  localStorage.setItem('tllmh_tag_strategy', p.text);
  showToast('已加载: ' + p.name);
}

function saveTagStrategy() {
  var ta = document.getElementById('tagStrategyText');
  if (ta) localStorage.setItem('tllmh_tag_strategy', ta.value);
}

function resetTagStrategy() {
  var ta = document.getElementById('tagStrategyText');
  if (ta) {
    ta.value = _tagStrategyPresets[0].text;
    localStorage.setItem('tllmh_tag_strategy', ta.value);
  }
  showToast('已恢复默认分类策略');
}

function _initTagStrategy() {
  var ta = document.getElementById('tagStrategyText');
  if (!ta) return;
  var saved = localStorage.getItem('tllmh_tag_strategy');
  if (saved !== null) {
    ta.value = saved;
  } else {
    // 从后端加载默认值
    try {
      fetch('/api/config').then(function(r) { return r.json(); }).then(function(d) {
        if (d.default_tag_strategy && !localStorage.getItem('tllmh_tag_strategy')) {
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
            '<div class="tag-admin-pool" id="tagAdminPool" ondragover="event.preventDefault()" ondrop="tagAdminPoolDrop(event)"></div>' +
            '<div style="display:flex;gap:4px;margin-top:8px">' +
            '<input id="tagAdminPoolInput" class="tag-admin-sub" placeholder="输入新二级类目" style="flex:1"' +
            ' onkeydown="if(event.key==="Enter")tagAdminAddToPool()">' +
            '<button class="btn btn-sm" onclick="tagAdminAddToPool()">+</button>' +
          '</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-actions" style="margin-top:10px">' +
          '<button class="btn" onclick="tagAdminExport()">导出</button>' +
          '<button class="btn" onclick="tagAdminImport()">导入</button>' +
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
      '<div class="tag-admin-group"' + disabledCls + '" data-l1="' + escHtml(l1) + '"' +
        ' ondragover="tagAdminDragOver(event, this)"' +
        ' ondragleave="tagAdminDragLeave(event, this)"' +
        ' ondrop="tagAdminDrop(event, this)">' +
        '<div class="tag-admin-group-header">' +
          '<label class="tag-admin-enabled-wrap" title="启用/禁用">' +
            '<input type="checkbox" class="tag-admin-enabled"' + (cat.enabled !== false ? ' checked' : '') +
              ' onchange="this.closest(\'.tag-admin-group\').classList.toggle(\'tag-admin-disabled\', !this.checked)">' +
          '</label>' +
          '<input class="tag-admin-icon" value="' + escHtml(cat.icon || '📌') + '" onchange="_autoSave()" style="width:30px;text-align:center">' +
          '<input class="tag-admin-name" value="' + escHtml(l1) + '" style="flex:1"' +
            ' ondblclick="this.readOnly=false;this.focus();this.select()"' +
            ' onblur="this.readOnly=true"' +
            ' readonly">' +
          '<input class="tag-admin-color" type="color" value="' + (cat.color || '#888') + '" onchange="_autoSave()" title="颜色">' +
          '<button class="btn btn-sm" onclick="tagAdminAddSub(this)">+子项</button>' +
          '<button class="btn btn-sm tag-admin-del-btn" onclick="tagAdminRemoveGroup(this)">🗑</button>' +
        '</div>' +
        '<div class="tag-admin-subs">';
    (cat.subs || []).forEach(function(sub) {
      leftHtml += '<span class="tag-admin-sub-wrap" draggable="true"' +
        ' ondragstart="tagAdminSubDragStart(event, this)"' +
        ' ondragend="tagAdminSubDragEnd(event, this)">' +
        '<input class="tag-admin-sub" value="' + escHtml(sub) + '"' +
          ' ondblclick="this.readOnly=false;this.focus();this.select()"' +
          ' onblur="this.readOnly=true;_autoSave()"' +
          ' readonly">' +
        '<span class="tag-admin-sub-del" onclick="tagAdminRemoveSub(this)" title="移回二级池">&times;</span>' +
      '</span>';
    });
    leftHtml += '</div></div>';
  });
  leftHtml += '</div>';
  leftHtml += '<button class="btn btn-sm" onclick="tagAdminAddGroup()" style="margin-top:4px">+ 添加一级类目</button>';
  document.getElementById('tagAdminLeft').innerHTML = leftHtml;

  var poolHtml = '';
  availablePool.forEach(function(name) {
    poolHtml +=
      '<div class="tag-admin-pool-chip" draggable="true"' +
        ' ondragstart="tagAdminPoolDragStart(event, this)"' +
        ' ondragend="tagAdminPoolDragEnd(event, this)"' +
        ' ondblclick="tagAdminPoolEdit(event, this)">' +
        '<span class="tag-admin-pool-text">' + escHtml(name) + '</span>' +
        '<span class="tag-admin-pool-del" onclick="tagAdminDeletePoolItem(event, this)" title="永久删除">&times;</span>' +
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
  span.setAttribute('ondragstart', 'tagAdminSubDragStart(event, this)');
  span.setAttribute('ondragend', 'tagAdminSubDragEnd(event, this)');
  span.innerHTML = '<input class="tag-admin-sub" placeholder="新子项" value="">' +
    '<span class="tag-admin-sub-del" onclick="tagAdminRemoveSub(this)" title="移回二级池">&times;</span>';
  wrapper.appendChild(span);
  span.querySelector('input').focus();
}

function tagAdminAddGroup() {
  var list = document.getElementById('tagAdminList');
  var newGroup = document.createElement('div');
  newGroup.className = 'tag-admin-group';
  newGroup.dataset.l1 = '新类目';
  newGroup.innerHTML = '<div class="tag-admin-group-header">' +
    '<label class="tag-admin-enabled-wrap" title="启用/禁用">' +
      '<input type="checkbox" class="tag-admin-enabled" checked onchange="this.closest(\'.tag-admin-group\').classList.toggle(\'tag-admin-disabled\', !this.checked)">' +
    '</label>' +
    '<input class="tag-admin-icon" value="📌" style="width:30px;text-align:center">' +
    '<input class="tag-admin-name" value="新类目" ondblclick="this.readOnly=false;this.focus();this.select()" onblur="this.readOnly=true" readonly style="flex:1">' +
    '<input class="tag-admin-color" type="color" value="#888888">' +
    '<button class="btn btn-sm" onclick="tagAdminAddSub(this)">+子项</button>' +
    '<button class="btn btn-sm tag-admin-del-btn" onclick="tagAdminRemoveGroup(this)">🗑</button>' +
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
  _autoSave();
}


// ── 从一级类目下移除子项（回归二级池） ──
function tagAdminRemoveSub(el) {
  var input = el.parentElement.querySelector('.tag-admin-sub');
  var name = (input.value || input.defaultValue || '').trim();
  el.parentElement.remove();
  if (name) { var pool = getSubPool(); if (pool.indexOf(name) === -1) { pool.push(name); saveSubPool(pool); } _refreshPool(); _autoSave(); }
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
  
  // 不允许在同一类目内重复
  var existingSubs = group.querySelectorAll('.tag-admin-sub');
  for (var i = 0; i < existingSubs.length; i++) {
    if ((existingSubs[i].value || existingSubs[i].defaultValue || '').trim() === name) {
      _refreshPool(); return;
    }
  }
  
  if (isSub) {
    // 左侧子项拖动: 从源类目中移除
    var allWraps = document.querySelectorAll('.tag-admin-sub-wrap');
    allWraps.forEach(function(wrap) {
      var input = wrap.querySelector('.tag-admin-sub');
      var subName = (input.value || input.defaultValue || '').trim();
      if (subName === name) { wrap.remove(); }
    });
  } else {
    // 池子拖动: 从池中移除
    var pool = getSubPool(); var idx = pool.indexOf(name);
    if (idx !== -1) { pool.splice(idx, 1); saveSubPool(pool); }
    else return;
  }
  
  // 添加到目标类目
  var subHtml = '<span class="tag-admin-sub-wrap" draggable="true"' +
    ' ondragstart="tagAdminSubDragStart(event, this)"' +
    ' ondragend="tagAdminSubDragEnd(event, this)">' +
    '<input class="tag-admin-sub" value="' + escHtml(name) + '" ondblclick="this.readOnly=false;this.focus();this.select()" onblur="this.readOnly=true" readonly>' +
    '<span class="tag-admin-sub-del" onclick="tagAdminRemoveSub(this)" title="移回二级池">&times;</span>' +
  '</span>';
  var subsDiv = group.querySelector('.tag-admin-subs');
  var temp = document.createElement('div'); temp.innerHTML = subHtml; subsDiv.appendChild(temp.firstElementChild);
  _refreshPool();
  _autoSave();
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
    _autoSave();
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
  var name = chip.querySelector('.tag-admin-pool-text').textContent;
  var pool = getSubPool(); var idx = pool.indexOf(name); if (idx !== -1) { pool.splice(idx, 1); saveSubPool(pool); }
  chip.remove();
  if (document.querySelectorAll('.tag-admin-pool-chip').length === 0) _refreshPool();
  _autoSave();
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
  pool.push(name); saveSubPool(pool); _refreshPool(); _autoSave();
  input.value = '';
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
  _autoSave();
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
    html += '<div class="tag-admin-pool-chip" draggable="true" ondragstart="tagAdminPoolDragStart(event, this)" ondragend="tagAdminPoolDragEnd(event, this)" ondblclick="tagAdminPoolEdit(event, this)">' +
      '<span class="tag-admin-pool-text">' + escHtml(name) + '</span>' +
      '<span class="tag-admin-pool-del" onclick="tagAdminDeletePoolItem(event, this)" title="永久删除">&times;</span>' +
    '</div>';
  });
  container.innerHTML = html;
}

// ── 自动保存(静默, 不关闭弹窗) ──
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
  URL.revokeObjectURL(url);
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
  // 选中状态变化时更新按钮
  document.addEventListener('change', function(e) {
    if (e.target.classList.contains('tag-card-check') || e.target.classList.contains('tag-column-select-all')) {
      tagBtnState();
    }
  });
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
window.tagAdminAddGroup = tagAdminAddGroup;
window.tagAdminAddSub = tagAdminAddSub;
window.tagAdminAddToPool = tagAdminAddToPool;
window.tagAdminDeletePoolItem = tagAdminDeletePoolItem;
window.tagAdminDragLeave = tagAdminDragLeave;
window.tagAdminDragOver = tagAdminDragOver;
window.tagAdminDrop = tagAdminDrop;
window.tagAdminExport = tagAdminExport;
window.tagAdminImport = tagAdminImport;
window.tagAdminPoolDragEnd = tagAdminPoolDragEnd;
window.tagAdminPoolDragStart = tagAdminPoolDragStart;
window.tagAdminPoolEdit = tagAdminPoolEdit;
window.tagAdminRemoveGroup = tagAdminRemoveGroup;
window.tagAdminRemoveSub = tagAdminRemoveSub;
window.tagBtnState = tagBtnState;
window.tagCardDragEnd = tagCardDragEnd;
window.tagCardDragStart = tagCardDragStart;
window.tagClearAll = tagClearAll;
window.tagClearSearch = tagClearSearch;
window.tagDeleteFile = tagDeleteFile;
window.tagDragLeave = tagDragLeave;
window.tagDragOver = tagDragOver;
window.tagDrop = tagDrop;
window.tagEditCategory = tagEditCategory;
window.tagEditFilter = tagEditFilter;
window.tagEditPick = tagEditPick;
window.tagEditSelectChange = tagEditSelectChange;
window.tagExport = tagExport;
window.tagExportSeparate = tagExportSeparate;
window.resetTagStrategy = resetTagStrategy;
window.tagGetApiConfig = tagGetApiConfig;
window.tagInit = tagInit;
window.tagLoadManualInput = tagLoadManualInput;
window.tagLoadStrategyPreset = tagLoadStrategyPreset;
window.tagLog = tagLog;
window.tagLogClear = tagLogClear;
window.tagOnCustomLimitChange = tagOnCustomLimitChange;
window.tagOnRowLimitChange = tagOnRowLimitChange;
window.tagOnSearch = tagOnSearch;
window.tagOpenAdmin = tagOpenAdmin;
window.tagProcessFiles = tagProcessFiles;
window.tagRenderCard = tagRenderCard;
window.tagRenderCatPanel = tagRenderCatPanel;
window.tagRenderColumns = tagRenderColumns;
window.tagRenderFileList = tagRenderFileList;
window.tagRenderPreview = tagRenderPreview;
window.tagRenderStrategyPresets = tagRenderStrategyPresets;
window.tagSelectAllInColumn = tagSelectAllInColumn;
window.tagSendToTranslate = tagSendToTranslate;
window.tagStart = tagStart;
window.tagStop = tagStop;
window.tagToggleCatPanel = tagToggleCatPanel;
window.tagToggleCollapse = tagToggleCollapse;
window.tagToggleSelect = tagToggleSelect;
window.tagToggleStrategy = tagToggleStrategy;
window.tagTriggerDownload = tagTriggerDownload;
window.tagUpdateColumnSelectAllStates = tagUpdateColumnSelectAllStates;
window.tagUpdateCounts = tagUpdateCounts;
window.tagUpdateOneCard = tagUpdateOneCard;
window.tagUpdateTagStartButton = tagUpdateTagStartButton;

// ── Module export
window.tagAdminSubDragStart = tagAdminSubDragStart;
window.tagAdminSubDragEnd = tagAdminSubDragEnd;
window.tagAdminPoolDrop = tagAdminPoolDrop;

window._autoSave = _autoSave;

export {};
