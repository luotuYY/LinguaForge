/**
 * TxtLlmHub — 分词/标签模块（SPA 版本）
 * [SPA改造] 移除重复的 setProvider/checkLLM（共用 state.js 中的全局版本）
 * [SPA改造] 将自动初始化封装为 tagInit()，由 switchPage 懒调用
 * 只依赖 utils.js 的 $, escHtml, showToast, log 等纯工具函数
 */

// ── 分词页面状态 ──
var tagState = {
  lines: [],
  files: [],
  fileNames: [],
  translating: false,
  abort: false,
  query: '',
  previewRowLimit: 2000,
};

// ── 分类体系 ──
var TAG_CATEGORIES = {
  '硬术语': {
    color: '#4fc3f7', icon: '🔧',
    subs: ['UI文本', '菜单/按钮', '属性/状态', '物品/装备', '技能/招式', '系统提示', 'Mod/插件', '代码标识符']
  },
  '硬生动': {
    color: '#81c784', icon: '🎭',
    subs: ['对话/台词', '旁白/叙述', '情感/语气', '俚语/口语', '描述/刻画', '幽默/讽刺', '严肃/正式']
  }
};

function getAllSubCategories() {
  var r = [];
  Object.keys(TAG_CATEGORIES).forEach(function(l1) {
    TAG_CATEGORIES[l1].subs.forEach(function(l2) { r.push({l1:l1, l2:l2, label:l1+' / '+l2}); });
  });
  return r;
}

// ── API 配置（SPA: 直接读取顶部工具栏的共享元素） ──
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

// ── 文件上传 ──
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

// ── 手动输入 ──
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

// ── 收起/展开 ──
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

// ── 预览限行数 ──
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
}
function tagOnCustomLimitChange() {
  var c = document.getElementById('tagPreviewCustomLimit');
  if (!c) return;
  var v = parseInt(c.value);
  if (v > 0) { tagState.previewRowLimit = v; tagRenderPreview(); }
}

// ── 预览（与翻译页完全一致的结构） ──
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
      var cat = TAG_CATEGORIES[l.tag_l1];
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

// ── 分类栏（性能优化：限制每栏最大卡片数） ──
var TAG_MAX_CARDS = 200; // 每栏最多渲染 200 张卡片

function tagRenderColumns() {
  var container = document.getElementById('tagColumns');
  if (!container) return;
  var html = '';
  Object.keys(TAG_CATEGORIES).forEach(function(l1) {
    var cat = TAG_CATEGORIES[l1];
    var items = tagState.lines.filter(function(l) { return l.tag_l1 === l1; });
    var shown = items.slice(0, TAG_MAX_CARDS);
    html += '<div class="tag-column" data-l1="' + l1 + '">' +
      '<div class="tag-column-header" style="border-left:3px solid ' + cat.color + '">' +
      '<span class="tag-col-icon">' + cat.icon + '</span>' +
      '<span class="tag-col-title">' + escHtml(l1) + '</span>' +
      '<span class="tag-col-count" id="cnt-' + l1 + '">' + items.length + '</span></div>' +
      '<div class="tag-column-body" data-l1="' + l1 + '" ' +
      'ondragover="tagDragOver(event)" ondrop="tagDrop(event)" ondragleave="tagDragLeave(event)">';
    shown.forEach(function(l) { html += tagRenderCard(l); });
    if (items.length > TAG_MAX_CARDS) html += '<div class="tag-column-empty">…还有 ' + (items.length - TAG_MAX_CARDS) + ' 条</div>';
    if (items.length === 0) html += '<div class="tag-column-empty">拖入词条或运行分词</div>';
    html += '</div></div>';
  });
  var untagged = tagState.lines.filter(function(l) { return !l.tag_l1; });
  var unShown = untagged.slice(0, TAG_MAX_CARDS);
  html += '<div class="tag-column tag-column-untagged">' +
    '<div class="tag-column-header" style="border-left:3px solid #888">' +
    '<span class="tag-col-icon">📋</span><span class="tag-col-title">未分类</span>' +
    '<span class="tag-col-count" id="cnt-untagged">' + untagged.length + '</span></div>' +
    '<div class="tag-column-body" data-l1="" ' +
    'ondragover="tagDragOver(event)" ondrop="tagDrop(event)" ondragleave="tagDragLeave(event)">';
  unShown.forEach(function(l) { html += tagRenderCard(l); });
  if (untagged.length > TAG_MAX_CARDS) html += '<div class="tag-column-empty">…还有 ' + (untagged.length - TAG_MAX_CARDS) + ' 条</div>';
  if (untagged.length === 0 && tagState.lines.length > 0) html += '<div class="tag-column-empty">所有词条已分类 ✓</div>';
  html += '</div></div>';
  container.innerHTML = html;
  // 如果分类标签面板处于展开状态，同步刷新
  var catPanel = document.getElementById('tagCatPanel');
  if (catPanel && catPanel.style.display === 'flex') tagRenderCatPanel();
}

// ── 单条卡片更新（分词进行时不重建整个列表） ──
function tagUpdateOneCard(line) {
  var oldCard = document.querySelector('.tag-card[data-index="' + line.index + '"]');
  if (oldCard) {
    // 卡片已存在，原地更新内容
    var cat = line.tag_l1 ? TAG_CATEGORIES[line.tag_l1] : null;
    var bc = cat ? cat.color : '#555';
    oldCard.style.borderLeftColor = bc;
    var tagEl = oldCard.querySelector('.tag-card-tag');
    if (tagEl) tagEl.innerHTML = line.tag_l2
      ? escHtml(line.tag_l2) + (line.confidence > 0 ? ' <span class="tag-confidence">' + Math.round(line.confidence*100) + '%</span>' : '')
      : '<span style="color:var(--text-muted)">未标注</span>' + (line.confidence > 0 ? ' <span class="tag-confidence">' + Math.round(line.confidence*100) + '%</span>' : '');
    // 如果分类变了，需要移到正确的栏
    var parentBody = oldCard.closest('.tag-column-body');
    var targetL1 = parentBody ? parentBody.dataset.l1 : '';
    if (targetL1 !== (line.tag_l1 || '')) {
      oldCard.remove();
      var targetBody = document.querySelector('.tag-column-body[data-l1="' + (line.tag_l1 || '') + '"]');
      if (targetBody) {
        var empty = targetBody.querySelector('.tag-column-empty');
        if (empty) empty.remove();
        targetBody.insertAdjacentHTML('beforeend', tagRenderCard(line));
      }
      tagUpdateCounts();
    }
  } else {
    // 新卡片，追加到未分类栏
    var untagged = document.querySelector('.tag-column-body[data-l1=""]');
    if (untagged) {
      var empty2 = untagged.querySelector('.tag-column-empty');
      if (empty2) empty2.remove();
      untagged.insertAdjacentHTML('beforeend', tagRenderCard(line));
    }
  }
}

// ── 更新各栏计数 ──
function tagUpdateCounts() {
  Object.keys(TAG_CATEGORIES).forEach(function(l1) {
    var el = document.getElementById('cnt-' + l1);
    if (el) el.textContent = tagState.lines.filter(function(l) { return l.tag_l1 === l1; }).length;
  });
  var ue = document.getElementById('cnt-untagged');
  if (ue) ue.textContent = tagState.lines.filter(function(l) { return !l.tag_l1; }).length;
}

function tagRenderCard(l) {
  var cat = l.tag_l1 ? TAG_CATEGORIES[l.tag_l1] : null;
  var bc = cat ? cat.color : '#555';
  return '<div class="tag-card" draggable="true" data-index="' + l.index + '" ' +
    'ondragstart="tagCardDragStart(event)" ondragend="tagCardDragEnd(event)" ' +
    'style="border-left:3px solid ' + bc + '">' +
    '<div class="tag-card-num">#' + (l.index+1) + '</div>' +
    '<div class="tag-card-orig">' + escHtml(l.original) + '</div>' +
    (l.translation ? '<div class="tag-card-tran">' + escHtml(l.translation) + '</div>' : '') +
    '<div class="tag-card-tag">' + (l.tag_l2 ? escHtml(l.tag_l2) : '<span style="color:var(--text-muted)">未标注</span>') +
    (l.confidence > 0 ? ' <span class="tag-confidence">' + Math.round(l.confidence*100) + '%</span>' : '') +
    '</div><div class="tag-card-actions"><button class="btn btn-sm" onclick="tagEditCategory(' + l.index + ')">✏️</button></div></div>';
}

// ── 拖拽 ──
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
  if (targetL1 && TAG_CATEGORIES[targetL1]) {
    if (!line.tag_l2 || (TAG_CATEGORIES[line.tag_l1] && TAG_CATEGORIES[line.tag_l1].subs.indexOf(line.tag_l2)===-1))
      line.tag_l2 = TAG_CATEGORIES[targetL1].subs[0] || '';
  } else { line.tag_l1 = ''; line.tag_l2 = ''; }
  tagRenderColumns(); tagRenderPreview();
  showToast('已移至 ' + (targetL1 || '未分类')); _tagDragIdx = -1;
}

// ── 编辑分类 ──
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
  }
  document.getElementById('tagEditContent').innerHTML =
    '<div style="margin-bottom:8px"><span style="font-size:0.8rem;color:var(--text-secondary)">原文：</span>' +
    '<span style="font-size:0.8rem">' + escHtml(line.original.substring(0,60)) + '</span></div>' +
    '<div style="position:relative;margin-bottom:8px"><input type="text" id="tagEditSearch" placeholder="搜索类目..." class="param-input" style="width:100%" oninput="tagEditFilter()" autocomplete="off">' +
    '<div id="tagEditDropdown" class="tag-edit-dropdown" style="display:none"></div></div>' +
    '<select id="tagEditSelect" class="param-input" style="width:100%;margin-top:4px" onchange="tagEditSelectChange()">' + options + '</select>';
  modal.style.display = 'flex'; modal._index = index;
  document.getElementById('tagEditOk').onclick = function() {
    var sel = document.getElementById('tagEditSelect').value;
    if (sel) { var p = sel.split('|'); line.tag_l1 = p[0]; line.tag_l2 = p[1]||''; }
    else { line.tag_l1 = ''; line.tag_l2 = ''; }
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
  var h=''; matchItems.forEach(function(s){ h+='<div class="tag-edit-option" onclick="tagEditPick(\''+s.l1+'\',\''+s.l2+'\')"><span style="color:'+TAG_CATEGORIES[s.l1].color+'">'+escHtml(s.l1)+'</span> / '+escHtml(s.l2)+'</div>'; });
  dd.innerHTML=h; dd.style.display='block';
}
function tagEditPick(l1,l2) {
  document.getElementById('tagEditSearch').value=l1+' / '+l2;
  document.getElementById('tagEditDropdown').style.display='none';
  var sel=document.getElementById('tagEditSelect'); var t=l1+'|'+l2;
  for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===t){sel.selectedIndex=i;break;}}
}

// ── LLM 分词 ──
async function tagStart() {
  if (tagState.translating || tagState.lines.length===0) return;
  tagState.translating = true; tagState.abort = false;
  document.getElementById('tagBtnStart').disabled = true;
  document.getElementById('tagBtnStop').disabled = false;
  _tagStartRuntime(); tagLogClear(); tagLog('开始分词，共 ' + tagState.lines.length + ' 行');
  var concurrency = parseInt(document.getElementById('tagConcurrency').value) || 3;
  var apiConfig = tagGetApiConfig();
  var total = tagState.lines.length, done = 0, errors = 0;
  for (var start = 0; start < total; start += concurrency) {
    if (tagState.abort) { tagLog('已停止 · 完成'+done+'/'+total, 'err'); break; }
    var chunkEnd = Math.min(start+concurrency, total);
    var chunk = tagState.lines.slice(start, chunkEnd);
    tagLog('块'+(Math.floor(start/concurrency)+1)+': 第'+(start+1)+'-'+chunkEnd+'行...');
    var results = await Promise.all(chunk.map(function(line, i) {
      return tagOneLine(line, apiConfig).then(function(r) {
        var idx = start + i + 1;
        if (r.error) {
          tagLog('['+idx+'] ✗ "'+line.original.substring(0,20)+'" → '+r.error, 'err');
        } else {
          tagLog('['+idx+'] ✓ "'+line.original.substring(0,20)+'" → '+r.tag_l1+'/'+r.tag_l2, 'ok');
        }
        return r;
      });
    }));
    results.forEach(function(r,i) {
      if (r.error) { errors++; }
      else { chunk[i].tag_l1=r.tag_l1; chunk[i].tag_l2=r.tag_l2; chunk[i].confidence=r.confidence||0; }
    });
    done += chunk.length;
    document.getElementById('tagProgressFill').style.width = (done/total*100)+'%';
    document.getElementById('tagProgressText').textContent = '进度: '+done+'/'+total+' · 成功'+(done-errors)+' · 失败'+errors;
    tagLog('块'+(Math.floor(start/concurrency)+1)+': 完成 · 成功'+(chunk.length-(errors>0?1:0))+' · 失败'+(errors>0?1:0), 'ok');
    tagRenderColumns();
    tagRenderPreview();
  }
  tagState.translating=false; tagState.abort=false; _tagStopRuntime();
  document.getElementById('tagBtnStart').disabled=false;
  document.getElementById('tagBtnStop').disabled=true;
  tagLog('分词结束: 成功'+(done-errors)+'行'+(errors?' · 失败'+errors+'行':''), errors?'err':'ok');
  showToast('分词完成：成功'+(done-errors)+'行'+(errors?'，失败'+errors+'行':''));
  tagBtnState();
}

async function tagOneLine(line, apiConfig) {
  if (!line.original.trim()) return {tag_l1:'',tag_l2:'',confidence:0};
  try {
    var catDesc = '';
    Object.keys(TAG_CATEGORIES).forEach(function(l1) { catDesc += l1+': '+TAG_CATEGORIES[l1].subs.join(', ')+'\n'; });
    var systemPrompt = '你是一个游戏文本分类专家。请将以下文本归入最合适的类别。\n\n可用类别（一级 / 二级）：\n'+catDesc+
      '\n请严格输出以下JSON格式：{"l1":"一级类目","l2":"二级类目","confidence":0.0~1.0}\n只输出JSON，不要其他内容。';
    var body = Object.assign({text: line.original, system_prompt: systemPrompt, max_tokens: 100, temperature: 0.1}, apiConfig);
    var r = await fetch('/api/tag', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
    var d = await r.json();
    if (r.ok && d.translation) return tagParseResponse(d.translation);
    return {tag_l1:'',tag_l2:'',confidence:0, error: d.error||'分类失败'};
  } catch(e) { return {tag_l1:'',tag_l2:'',confidence:0, error:e.message}; }
}

function tagParseResponse(text) {
  try {
    var s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s===-1||e===-1) return {tag_l1:'',tag_l2:'',confidence:0};
    var j = JSON.parse(text.substring(s,e+1));
    var l1 = j.l1||'', l2 = j.l2||'', conf = j.confidence||0;
    if (!TAG_CATEGORIES[l1]) {
      var keys = Object.keys(TAG_CATEGORIES);
      for (var i=0;i<keys.length;i++) { if (l1.indexOf(keys[i])>=0||keys[i].indexOf(l1)>=0) { l1=keys[i]; break; } }
      if (!TAG_CATEGORIES[l1]) return {tag_l1:'',tag_l2:'',confidence:0};
    }
    var subs = TAG_CATEGORIES[l1].subs;
    if (subs.indexOf(l2)===-1) {
      for (var j2=0;j2<subs.length;j2++) { if (l2.indexOf(subs[j2])>=0||subs[j2].indexOf(l2)>=0) { l2=subs[j2]; break; } }
      if (subs.indexOf(l2)===-1) l2 = subs[0]||'';
    }
    return {tag_l1:l1, tag_l2:l2, confidence:conf};
  } catch(e) { return {tag_l1:'',tag_l2:'',confidence:0}; }
}

function tagStop() { tagState.abort=true; document.getElementById('tagBtnStop').disabled=true; showToast('正在停止...'); }

function tagClearAll() {
  if (tagState.lines.length===0) return;
  tagState.lines=[]; tagState.files=[]; tagState.fileNames=[]; tagState.query='';
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
  Object.keys(TAG_CATEGORIES).forEach(function(l1) {
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
  var cats = Object.keys(TAG_CATEGORIES), files = 0;
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

// ── 搜索 ──
function tagOnSearch() { tagState.query = document.getElementById('tagSearch').value; tagRenderPreview(); }
function tagClearSearch() { document.getElementById('tagSearch').value=''; tagState.query=''; tagRenderPreview(); }

// ── 按钮状态 ──
function tagBtnState() {
  var has = tagState.lines.length > 0;
  document.getElementById('tagBtnStart').disabled = !has || tagState.translating;
  document.getElementById('tagBtnClear').disabled = !has;
  document.getElementById('tagBtnExport').disabled = !tagState.lines.some(function(l){return l.tag_l1;});
}

// ── 计时器 ──
var _tagT0=0, _tagTmr=0;
function _tagStartRuntime() {
  _tagT0=Date.now(); var rd=document.getElementById('tagRuntimeDisplay');
  rd.textContent='00:00'; rd.style.display='inline';
  _tagTmr=setInterval(function(){var s=Math.floor((Date.now()-_tagT0)/1000);var m=Math.floor(s/60);rd.textContent=(m<10?'0':'')+m+':'+((s%60)<10?'0':'')+(s%60);},500);
}
function _tagStopRuntime() { clearInterval(_tagTmr); document.getElementById('tagRuntimeDisplay').style.display='none'; }

// ── 日志 ──
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

// ── 分类标签面板（类似翻译页 System Prompt 折叠面板） ──
function tagToggleCatPanel() {
  var panel = document.getElementById('tagCatPanel');
  var toggle = document.getElementById('tagCatToggle');
  if (panel.style.display === 'flex') {
    panel.style.display = 'none';
    toggle.textContent = '分类标签 ▼';
  } else {
    panel.style.display = 'flex';
    toggle.textContent = '分类标签 ▲';
    tagRenderCatPanel();
  }
}

function tagRenderCatPanel() {
  var panel = document.getElementById('tagCatPanel');
  if (!panel) return;
  var html = '';
  Object.keys(TAG_CATEGORIES).forEach(function(l1) {
    var cat = TAG_CATEGORIES[l1];
    var count = tagState.lines.filter(function(l) { return l.tag_l1 === l1; }).length;
    html += '<div class="tag-cat-group" style="border-left:3px solid ' + cat.color + ';padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:0 8px 8px 0">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
        '<span style="font-size:1.2rem">' + cat.icon + '</span>' +
        '<span style="font-weight:600;font-size:0.85rem;color:' + cat.color + '">' + escHtml(l1) + '</span>' +
        '<span style="font-size:0.68rem;color:var(--text-muted);margin-left:auto">' + count + ' 条</span>' +
      '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:4px">';
    cat.subs.forEach(function(l2) {
      var subCount = tagState.lines.filter(function(l) { return l.tag_l1 === l1 && l.tag_l2 === l2; }).length;
      html += '<span class="tag-cat-chip" style="background:' + cat.color + '22;border:1px solid ' + cat.color + '44;color:' + cat.color + ';padding:2px 8px;border-radius:12px;font-size:0.7rem;white-space:nowrap">' +
        escHtml(l2) +
        (subCount > 0 ? ' <span style="opacity:0.7">' + subCount + '</span>' : '') +
        '</span>';
    });
    html += '</div></div>';
  });
  // 未分类统计
  var untagged = tagState.lines.filter(function(l) { return !l.tag_l1; }).length;
  if (untagged > 0 || tagState.lines.length > 0) {
    html += '<div style="padding:6px 12px;color:var(--text-muted);font-size:0.73rem">📋 未分类：' + untagged + ' 条</div>';
  }
  panel.innerHTML = html;
}

// ── 初始化（SPA: 由 switchPage 调用，只执行一次） ──
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
  // API 配置已由顶部工具栏共享管理，无需单独加载
  // 初始渲染
  tagRenderColumns();
}
