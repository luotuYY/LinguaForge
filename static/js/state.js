/**
 * LinguaForge — 状态管理与持久化
 * 全局状态、IndexedDB 持久化、LLM 参数、API 配置、Provider 切换、提示词模板
 * Depends on: utils.js
 */


import { $, escHtml, showToast, log, showConfirm } from './utils.js';
import { dbGet, dbSet, dbDel, dbHas, dbReady } from './db.js';
// ── 渲染回调（由 app.js 注册，避免循环依赖） ──
var _renderCallbacks = { preview: null, compare: null };
function _notifyRender() {
  if (_renderCallbacks.preview) _renderCallbacks.preview();
  if (_renderCallbacks.compare) _renderCallbacks.compare();
}
// ── 全局状态 ──
const state = {
  lines: [],
  fileNames: [],
  abort: false,
  translating: false,
  previewQuery: '',
  compareQuery: '',
  translateMode: 'direct',
  sortState: 0,
  previewChecked: new Set(),  // 预览列选中的索引集合
  llmProvider: 'local',       // 'local' | 'commercial'
  compareChecked: new Set(),
  files: [],                   // [{name, checked}] 来源文件管理
  previewRowLimit: 200,        // 每页行数（分页模式）
  previewPage: 1,              // 当前页码
  comparePage: 1,              // 对比表当前页码
  translateStarted: false,     // 是否过翻译任务（用于区分「翻译全部」和「继续翻译」）
};
// ── 索引重建（数组增删后调用） ──
function rebuildIndicesAndCheckboxes() {
  for (var i = 0; i < state.lines.length; i++) { state.lines[i].index = i; }
  var newPC = new Set();
  var newCC = new Set();
  state.lines.forEach(function (l) {
    if (state.previewChecked.has(l.index)) newPC.add(l.index);
    if (state.compareChecked.has(l.index)) newCC.add(l.index);
  });
  state.previewChecked = newPC;
  state.compareChecked = newCC;
}


// ── One-time v2 migration (runs after DB ready) ──
dbReady.then(function () {
  try {
    if (!dbHas('tllmh_params_v2')) {
      dbDel('tllmh_params_polish');
      dbDel('tllmh_params_direct');
      dbSet('tllmh_params_v2', '1');
    }
  } catch (e) { /* ignore */ }
});

// ── Mode readiness flag ──
var _modeReady = false;

// ── Built-in Preset Prompts (non-deletable) ──
var PRESET_PROMPTS = {
  direct: [
    {
      id: '__preset_ui_direct__',
      name: 'UI / Mod（术语）',
      text: '你是一个专业游戏中文本地化专家，专精UI、菜单、控件、Mod说明翻译。\n规则：\n1. 游戏术语必须翻译为中文（Attack Power→攻击力，Inventory→物品栏），译名以业界通行中文为准。\n2. 极度简洁，译文不超过原文长度。\n3. 仅保留占位符（{0}、%s）、快捷键（&键）、换行和特殊符号原样不动。\n只输出译文，不要额外解释。',
      locked: true
    },
    {
      id: '__preset_dialogue_direct__',
      name: '对话 / 剧情（生动）',
      text: '你是一个顶尖的游戏本地化及配音脚本翻译专家。\n要求：\n1. 根据上下文判断角色性格与情绪，中文对白必须贴合其身份和当下情感。\n2. 彻底摆脱翻译腔，用地道中文口语重写。\n3. 为达到戏剧效果或情感冲击力，可牺牲字面翻译进行创造性改写。\n只输出译文，不要额外解释。',
      locked: true
    }
  ],
  polish: [
    {
      id: '__preset_ui_polish__',
      name: 'UI / Mod（术语）',
      text: '你是一个专业游戏UI翻译初稿专家。请对以下文本逐句直译。\n规则：\n- 游戏术语必须翻译为中文，不得保留英文。\n- 仅保留占位符（{0}、%s）、快捷键（&键）和特殊符号原样不动。\n- 结构对齐原文，即使生硬也保留原语序。\n- 不添加任何修饰或解释。\n只输出译文，不要额外解释。',
      step2: '你是一个游戏UI本地化校对专家。\n你将收到【直译新译文】和【旧译文】。\n处理规则：\n- 术语以直译新译文为准，旧译文有误则修正。\n- 所有文本必须为中文，不得出现英文术语。\n- 极致精简，长度不超过原文。\n- 可微调使其通顺，但绝不意译。\n只输出最终译文。',
      locked: true
    },
    {
      id: '__preset_dialogue_polish__',
      name: '对话 / 剧情（生动）',
      text: '你是一个专业游戏翻译初稿专家。请对以下文本逐句直译。\n要求：\n- 准确传达语义和情绪基调。\n- 保留关键信息和比喻意象。\n- 可微调语序使其通顺，但不做艺术加工。\n只输出译文，不要额外解释。',
      step2: '你是一个顶尖的游戏本地化润色专家。\n你将收到【直译新译文】和【旧译文】。\n目标：写出地道的中文对白，完全摆脱翻译腔。\n- 继承直译的语义准确性，可彻底重写结构。\n- 吸收旧译文的口语化优点。\n- 善用中文四字格、俗语、语气词，让对白活起来。\n只输出最终译文。',
      locked: true
    }
  ]
};

// ── Default Prompts (HYBRID — system defaults for each mode) ──
var DIRECT_DEFAULT = '你是一个游戏本地化翻译专家。请将以下文本翻译为中文。\n处理规则：\n- 游戏术语必须翻译为中文（Attack Power→攻击力，Inventory→物品栏），译名以业界通行中文为准。\n- 含日文假名 → 直接翻译，严禁臆测或解读为代号。\n- 纯代码键名(del/get/set等) → 保持原文不变。\n- 占位符（{0}、%s）、快捷键（&键）、换行和特殊符号 → 原样保留。\n- 对话/叙事/台词 → 自然流畅，贴合角色语气，允许意译。\n- 混合文本 → 术语优先，口语化串联。\n保留原文全部格式。只输出译文，不要额外解释。';

var POLISH_DIRECT_DEFAULT = '你是一个专业游戏翻译初稿专家。请对以下文本逐句直译，同时为每句打上类型标签。\n判断标准：\n- [UI]：按钮、菜单、系统提示、Mod说明、属性列表、含占位符/快捷键的文本。\n- [DIALOGUE]：角色对白、剧情叙述、含情绪和语气的文本。\n翻译要求：\n- [UI]句：结构对齐的忠实直译，术语必须翻译为中文，仅保留占位符和特殊符号原样不动。\n- [DIALOGUE]句：意思准确的通顺中文，允许微调语序。\n输出格式（必须严格带标签）：\n[标签] 中文底稿\n只输出带标签的译文，不要额外解释。';

var POLISH_STEP2_DEFAULT = '你是一个资深游戏本地化校对专家。你将收到带标签的【直译新译文】和【旧译文】。请根据标签分别处理：\n\n【UI 模式】\n- 所有文本必须为中文，不得出现英文术语。\n- 术语以直译新译文为准，旧译文有误则修正。\n- 极致精简，长度不超过原文。\n- 可微调使其通顺，但绝不意译。\n\n【DIALOGUE 模式】\n- 目标是写出地道的中文对白，完全摆脱翻译腔。\n- 继承直译的准确语义和情绪，但可彻底重写结构。\n- 吸收旧译文的口语化优点，进行创造性润色。\n\n输出时去掉所有标签，只输出最终的纯译文文本。';

// ── Polish Step2 prompt storage ──
function getPolishStep2Prompt() {
  return dbGet('tllmh_polish_step2') || POLISH_STEP2_DEFAULT;
}
function setPolishStep2Prompt(text) {
  if (text) { dbSet('tllmh_polish_step2', text); }
  else { dbDel('tllmh_polish_step2'); }
}

// ── LLM 参数默认值注册表（全局统一） ──
// 所有页面的 LLM 参数默认值集中管理，双击恢复默认时从这里读取
var LLM_PARAM_DEFAULTS = {
  // 翻译页
  temperature:          '0.7',
  top_p:                '0.6',
  max_tokens:           '1024',
  repetition_penalty:   '1.05',
  concurrency:          '5',
  // 去重页
  dedupTemperature:     '0.1',
  dedupTopP:            '0.6',
  dedupMaxTokens:       '10',
  dedupConcurrency:     '5',
  // 分词页
  tagTemperature:       '0.1',
  tagTopP:              '0.6',
  tagMaxTokens:         '512',
  tagConcurrency:       '5',
};

// ── 统一的双击恢复默认函数 ──
// el: input DOM 元素
// saveFn: 可选，恢复后触发的持久化回调
function resetInputDefault(el, saveFn) {
  var def = LLM_PARAM_DEFAULTS[el.id];
  if (def != null) el.value = def;
  if (window.getSelection) window.getSelection().removeAllRanges();
  el.blur();
  if (typeof saveFn === 'function') saveFn();
}

// ── 便捷：翻译页参数双击重置（兼容旧调用） ──
function resetParamDefault(el) {
  resetInputDefault(el, function() {
    if (_modeReady) saveModeParams(state.translateMode);
  });
}

function saveModeParams(mode) {
  var p = {
    temperature: $('temperature').value,
    top_p: $('top_p').value,
    max_tokens: $('max_tokens').value,
    repetition_penalty: $('repetition_penalty').value,
    system_prompt: $('system_prompt').value,
  };
  dbSet('tllmh_params_' + mode, p);
}

function loadModeParams(mode) {
  var def = mode === 'polish'
    ? { temperature: '0.7', top_p: '0.6', max_tokens: '1024', repetition_penalty: '1.05',
        system_prompt: POLISH_DIRECT_DEFAULT }
    : { temperature: '0.7', top_p: '0.6', max_tokens: '1024', repetition_penalty: '1.05',
        system_prompt: DIRECT_DEFAULT };
  try {
    var saved = dbGet('tllmh_params_' + mode, {});
    $('temperature').value = saved.temperature || def.temperature;
    $('top_p').value = saved.top_p || def.top_p;
    $('max_tokens').value = saved.max_tokens || def.max_tokens;
    $('repetition_penalty').value = saved.repetition_penalty || def.repetition_penalty;
    $('system_prompt').value = saved.system_prompt || def.system_prompt;
  } catch (e) {
    $('temperature').value = def.temperature;
    $('top_p').value = def.top_p;
    $('max_tokens').value = def.max_tokens;
    $('repetition_penalty').value = def.repetition_penalty;
    $('system_prompt').value = def.system_prompt;
  }
  // 润色模式：显示 Step2 区域
  var psSection = $('polishStep2Section');
  var promptToggle = $('promptToggle');
  if (promptToggle) {
    if (mode === 'polish') {
      promptToggle.textContent = promptToggle.textContent.indexOf('▲') >= 0 ? '润色提示词 ▲' : '润色提示词 ▼';
      promptToggle.title = '展开/折叠提示词（底稿 + 润色策略）';
    } else {
      promptToggle.textContent = promptToggle.textContent.indexOf('▲') >= 0 ? '翻译提示词 ▲' : '翻译提示词 ▼';
      promptToggle.title = '展开/折叠翻译提示词';
    }
  }
  if (mode === 'polish') {
    var psTa = $('polish_strategy');
    if (psTa) psTa.value = getPolishStep2Prompt();
    if (psSection) psSection.style.display = 'flex';
  } else {
    if (psSection) psSection.style.display = 'none';
  }
}

function getLLMParams() {
  var tempVal = parseFloat($('temperature').value);
  var topVal = parseFloat($('top_p').value);
  var maxVal = parseInt($('max_tokens').value);
  var repVal = parseFloat($('repetition_penalty').value);
  var p = {
    temperature: isNaN(tempVal) ? 0.7 : tempVal,
    top_p: isNaN(topVal) ? 0.6 : topVal,
    max_tokens: isNaN(maxVal) || maxVal <= 0 ? 1024 : maxVal,
    repetition_penalty: isNaN(repVal) || repVal < 1 ? 1.05 : repVal,
    system_prompt: $('system_prompt').value.trim() || undefined,
  };
  if (state.translateMode === 'polish') {
    p.polish_prompt = getPolishStep2Prompt();
  }
  if (_modeReady) saveModeParams(state.translateMode);
  return p;
}

// ── 翻译模式切换 ──
async function setMode(mode) {
  if (state.translateMode === mode) return;
  // 翻译进行中则中止
  if (state.translating) {
    state.abort = true;
    while (state.translating) { await new Promise(function(r) { setTimeout(r, 50); }); }
  }
  var hasNew = state.lines.some(function (l) { return l.new_translation; });
  var shouldClear = true;
  if (hasNew) {
    shouldClear = await showConfirm('切换翻译模式将清除所有已有译文，确定吗？');
  }
  if (shouldClear && hasNew) {
    for (var i = 0; i < state.lines.length; i++) {
      state.lines[i].new_translation = '';
      state.lines[i].error = '';
      state.lines[i].keepOld = false;
      state.lines[i].truncated = false;
      state.lines[i].warning = '';
      state.lines[i].degraded = false;
    }
    _notifyRender();
    state.translateStarted = false;
  }
  if (_modeReady) saveModeParams(state.translateMode);
  state.translateMode = mode;
  dbSet('tllmh_mode', mode);
  loadModeParams(mode);
  // 润色模式：Step2 区域显隐
  var psSection = $('polishStep2Section');
  if (psSection) psSection.style.display = mode === 'polish' ? 'flex' : 'none';
  if ($('promptRow').style.display === 'flex') renderSavedPrompts();
  var d = document.getElementById('btnModeDirect');
  var p = document.getElementById('btnModePolish');
  if (d) d.className = mode === 'direct' ? 'btn btn-sm segmented-btn active' : 'btn btn-sm segmented-btn';
  if (p) p.className = mode === 'polish' ? 'btn btn-sm segmented-btn active' : 'btn btn-sm segmented-btn';
  updateTranslateAllButton();
}

// ── Update translate-all button for resume / normal state ──
function updateTranslateAllButton() {
  var btn = $('btnTranslateAll');
  if (!btn) return;
  if (state.translating) {
    btn.disabled = true;
    btn.textContent = '翻译中...';
    return;
  }
  if (state.lines.length === 0) {
    btn.disabled = true;
    btn.textContent = '翻译全部';
    return;
  }
  var pending = state.lines.filter(function (l) { return !l.new_translation && !l.error; });
  var hasCompleted = state.lines.some(function (l) { return l.new_translation && !l.error; });
  if (state.translateStarted && pending.length > 0) {
    btn.disabled = false;
    btn.textContent = '继续翻译 (' + pending.length + ')';
  } else if (hasCompleted) {
    btn.disabled = false;
    btn.textContent = '重新翻译全部';
  } else {
    btn.disabled = false;
    btn.textContent = '翻译全部';
  }
}

// ── API 配置（商业模型） ──
function getApiConfig() {
  var cfg = { provider: state.llmProvider };
  if (state.llmProvider !== 'commercial') return cfg;
  cfg.api_base = $('apiBase').value.trim();
  cfg.api_key = $('apiKey').value.trim();
  cfg.model = $('modelName').value.trim();
  var thinkingEl = $('enableThinking');
  if (thinkingEl) { cfg.enable_thinking = thinkingEl.checked; }
  return cfg;
}

function loadApiConfig() {
  var cfg;
  cfg = dbGet('tllmh_api_config', {});
  $('apiBase').value = cfg.api_base || '';
  $('apiKey').value = cfg.api_key || '';
  $('modelName').value = cfg.model || '';
  var thinkingEl = $('enableThinking');
  if (thinkingEl) { thinkingEl.checked = cfg.enable_thinking === true; }
}

function saveApiConfig() {
  var cfg = {
    api_base: $('apiBase').value.trim(),
    api_key: $('apiKey').value.trim(),
    model: $('modelName').value.trim(),
    enable_thinking: $('enableThinking') ? $('enableThinking').checked : false,
  };
  dbSet('tllmh_api_config', cfg);
}

// toggleApiConfig 已移除：API 配置条改为始终展示（商业模式下），无需折叠

async function testApiConnection() {
  saveApiConfig();
  var apiConfig = getApiConfig();
  if (!apiConfig.api_base) {
    showToast('请先填写 API Base URL'); return;
  }
  try {
    var r = await fetch('/api/check-llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiConfig)
    });
    var d = await r.json();
    var isLocal = state.llmProvider === 'local';
    if (d.status === 'connected') showToast(isLocal ? '✅ 本地连接成功' : '✅ 连接成功');
    else showToast(isLocal ? '❌ 本地连接失败: ' + (d.detail || '未知错误') : '❌ 商业API连接失败: ' + (d.detail || '未知错误'));
  } catch (e) { showToast('请求失败: ' + e.message); }
}

// ── Provider 切换 ──
function setProvider(provider) {
  if (state.llmProvider === provider) return;
  state.llmProvider = provider;
  dbSet('tllmh_provider', provider);
  // 按钮高亮
  var btnL = $('btnLocal');
  var btnC = $('btnCommercial');
  if (btnL) btnL.className = provider === 'local' ? 'btn btn-sm segmented-btn active' : 'btn btn-sm segmented-btn';
  if (btnC) btnC.className = provider === 'commercial' ? 'btn btn-sm segmented-btn active' : 'btn btn-sm segmented-btn';
  // API 配置条显隐
  var bar = $('apiConfigBar');
  if (bar) bar.style.display = provider === 'commercial' ? '' : 'none';
  if (provider === 'commercial') loadApiConfig();
  checkLLM();
  showToast(provider === 'local' ? '已切换到本地LLM' : '已切换到商业API');
}

function onThinkingChange() {
  var cb = $('enableThinking');
  if (cb && cb.checked) { showToast('已启用思考模式（速度较慢）'); }
}

// ── Provider 初始化 ──
(function () {
  var saved = dbGet('tllmh_provider', 'local');
  state.llmProvider = saved;
  var btnL = $('btnLocal');
  var btnC = $('btnCommercial');
  if (btnL) btnL.className = saved === 'local' ? 'btn btn-sm segmented-btn active' : 'btn btn-sm segmented-btn';
  if (btnC) btnC.className = saved === 'commercial' ? 'btn btn-sm segmented-btn active' : 'btn btn-sm segmented-btn';
  // 显示/隐藏 API 配置条
  var bar = $('apiConfigBar');
  if (bar) bar.style.display = saved === 'commercial' ? '' : 'none';
  if (saved === 'commercial') {
    try { loadApiConfig(); } catch (e) { console.error('loadApiConfig failed:', e); }
  }
})();

// ── LLM 连通性检测 ──
async function checkLLM() {
  try {
    var providerLabel = state.llmProvider === 'local' ? '本地' : '商业';
    var apiConfig = getApiConfig();
    if (state.llmProvider === 'local') {
      apiConfig = { provider: 'local' };
    } else if (!apiConfig.api_base) {
      $('llmStatus').innerHTML = '<span class="dot dot-err"></span><span class="status-text">' + providerLabel + ' LLM 未配置</span>';
      return;
    }
    var r = await fetch('/api/check-llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(apiConfig)
    });
    var d = await r.json();
    var statusHtml = d.status === 'connected'
      ? '<span class="dot dot-ok"></span><span class="status-text">' + providerLabel + ' LLM 已连接</span>'
      : '<span class="dot dot-err"></span><span class="status-text">' + providerLabel + ' LLM 未连接</span>';
    $('llmStatus').innerHTML = statusHtml;
  } catch (e) {
    var providerLabel2 = state.llmProvider === 'local' ? '本地' : '商业';
    $('llmStatus').innerHTML = '<span class="dot dot-err"></span><span class="status-text">' + providerLabel2 + ' LLM 未连接</span>';
  }
}

// ── Default Parameter Loading ──
async function loadDefaults() {
  // 等待 IndexedDB 就绪，避免缓存为空时误写默认值覆盖用户数据
  await dbReady;
  try {
    var r = await fetch('/api/config');
    var d = await r.json();
    if (d.defaults && !dbHas('tllmh_params_direct')) {
      dbSet('tllmh_params_direct', {
        temperature: d.defaults.temperature || 0.7,
        top_p: d.defaults.top_p || 0.6,
        max_tokens: d.defaults.max_tokens || 1024,
        repetition_penalty: d.defaults.repetition_penalty || 1.05,
        system_prompt: d.defaults.system_prompt,
      });
    }
    if (d.polish_defaults && !dbHas('tllmh_params_polish')) {
      dbSet('tllmh_params_polish', {
        temperature: d.polish_defaults.temperature || 0.7,
        top_p: d.polish_defaults.top_p || 0.6,
        max_tokens: d.polish_defaults.max_tokens || 1024,
        repetition_penalty: d.polish_defaults.repetition_penalty || 1.05,
        system_prompt: d.polish_defaults.system_prompt,
      });
    }
    // 存储后端预设（供未来扩展）
    if (d.presets) {
      // 后端预设已与前端 PRESET_PROMPTS 同步
    }
  } catch (e) { /* ignore */ }
  loadModeParams(state.translateMode);
  // 加载持久化的并发数
  var savedConcurrency = dbGet('tllmh_concurrency');
  if (savedConcurrency != null) {
    var concEl = $('concurrency');
    if (concEl) concEl.value = savedConcurrency;
  }
  _modeReady = true;
}

// ── 润色策略控制（Step2 提示词，仅润色模式可见） ──
function savePolishStrategy() {
  var ta = $('polish_strategy');
  if (ta) setPolishStep2Prompt(ta.value);
}

// ── 提示词模板管理 ──
function promptKey() { return 'tllmh_prompts_' + state.translateMode; }

function showPromptBar() {
  $('promptSaveBar').style.display = 'flex';
  renderSavedPrompts();
}

function onTitleFocus() {
  if (!$('promptTitle').value) {
    var prompts = dbGet(promptKey(), []);
    $('promptTitle').placeholder = '提示词' + (prompts.length + 1);
  }
}

function savePrompt() {
  var text = $('system_prompt').value.trim();
  if (!text) { showToast('内容为空'); return; }
  var title = $('promptTitle').value.trim();
  var prompts = dbGet(promptKey(), []);
  var n = prompts.length + 1;
  if (!title) title = '提示词' + n;
  var entry = { id: Date.now(), name: title, text: text };
  // 润色模式同时保存 Step2 提示词
  if (state.translateMode === 'polish') {
    entry.step2 = getPolishStep2Prompt();
  }
  prompts.push(entry);
  dbSet(promptKey(), prompts);
  $('promptTitle').value = ''; showToast('已保存: ' + title);
  renderSavedPrompts();
}

function loadSavedPrompt(id) {
  // 优先匹配内置预设（id 为字符串）
  var presets = PRESET_PROMPTS[state.translateMode] || [];
  var preset = presets.find(function (x) { return x.id === id; });
  if (preset) {
    $('system_prompt').value = preset.text;
    if (state.translateMode === 'polish' && preset.step2) {
      setPolishStep2Prompt(preset.step2);
      var psTa = $('polish_strategy');
      if (psTa) psTa.value = preset.step2;
    }
    showToast('已加载: ' + preset.name);
    return;
  }
  // 匹配用户自定义提示词（dataset.id 返回字符串，存储的 id 为数字）
  var prompts = dbGet(promptKey(), []);
  var numId = Number(id);
  var p = prompts.find(function (x) { return x.id === numId; });
  if (p) {
    $('system_prompt').value = p.text;
    // 润色模式同时恢复配对的 Step2
    if (state.translateMode === 'polish' && p.step2) {
      setPolishStep2Prompt(p.step2);
      var psTa2 = $('polish_strategy');
      if (psTa2) psTa2.value = p.step2;
    }
    showToast('已加载: ' + p.name);
  }
}

function deletePrompt(id) {
  // 内置预设不可删除
  if (String(id).indexOf('__preset_') === 0) return;
  var prompts = dbGet(promptKey(), []);
  prompts = prompts.filter(function (x) { return x.id !== id; });
  dbSet(promptKey(), prompts);
  renderSavedPrompts();
}

function renderSavedPrompts() {
  var presets = PRESET_PROMPTS[state.translateMode] || [];
  var userPrompts = dbGet(promptKey(), []);
  var savedHtml = '';

  // 先渲染内置预设（锁定，无删除按钮）
  presets.forEach(function (p) {
    var tipText = p.text;
    if (p.step2) tipText += '\n\n—— 润色提示词 ——\n' + p.step2;
    savedHtml += '<span class="prompt-chip preset" data-action="load-saved-prompt" data-id="' + p.id + '" data-tooltip="' + escHtml(tipText) + '">' +
'<span class="chip-text">' + escHtml(p.name) + '</span>' +
      '</span>';
  });
  // 渲染用户自定义提示词
  userPrompts.forEach(function (p) {
    savedHtml += '<span class="prompt-chip" data-action="load-saved-prompt" data-id="' + p.id + '" data-tooltip="' + escHtml(p.text) + '">' +
      '<span class="chip-text">' + escHtml(p.name) + '</span>' +
      '<span class="chip-del" data-action="delete-prompt" data-id="' + p.id + '">&times;</span></span>';
  });
  $('savedPrompts').innerHTML = savedHtml;
  // 溢出芯片文本滚动动画
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      var texts = document.querySelectorAll('.chip-text');
      texts.forEach(function (el) {
        if (el.scrollWidth > el.clientWidth) {
          var overflow = el.scrollWidth - el.clientWidth + 8;
          var dur = Math.max(2.5, overflow / 25);
          el.style.setProperty('--scroll', '-' + overflow + 'px');
          el.style.animation = 'chipScroll ' + dur + 's linear infinite alternate';
        }
      });
    });
  });
}

function togglePrompt() {
  var row = $('promptRow');
  var toggle = $('promptToggle');
  var isPolish = state.translateMode === 'polish';
  var label = isPolish ? '润色提示词' : '翻译提示词';
  if (row.style.display === 'flex') {
    row.style.display = 'none';
    toggle.textContent = label + ' ▼';
  } else {
    row.style.display = 'flex';
    showPromptBar();
    var prompts = dbGet(promptKey(), []);
    $('promptTitle').placeholder = '提示词' + (prompts.length + 1);
    toggle.textContent = label + ' ▲';
  }
}

function resetSystemPrompt() {
  var mode = state.translateMode;
  var defaults = mode === 'polish' ? POLISH_DIRECT_DEFAULT : DIRECT_DEFAULT;
  $('system_prompt').value = defaults;
  // 润色模式同时重置 Step2
  if (mode === 'polish') {
    setPolishStep2Prompt(POLISH_STEP2_DEFAULT);
    var psTa = $('polish_strategy');
    if (psTa) psTa.value = POLISH_STEP2_DEFAULT;
  }
  saveModeParams(mode);
  showToast('已恢复默认提示词');
}


// ── 提示词导入/导出（JSON 格式） ──
function exportPrompts() {
  var directPrompts = [];
  var polishPrompts = [];
  try { directPrompts = dbGet('tllmh_prompts_direct', []); } catch (e) {}
  try { polishPrompts = dbGet('tllmh_prompts_polish', []); } catch (e) {}

  // 为每条润色提示词补全 step2（优先条目自带，回退全局默认）
  var globalStep2 = getPolishStep2Prompt();
  polishPrompts.forEach(function(p) {
    if (!p.step2) p.step2 = globalStep2;
  });

  var data = {
    version: 2,
    exported_at: new Date().toISOString(),
    source: 'LinguaForge',
    direct: directPrompts,
    polish: polishPrompts,
  };

  var total = directPrompts.length + polishPrompts.length;
  if (total === 0) { showToast('没有自定义提示词可导出'); return; }

  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'LinguaForge_prompts_' + new Date().toISOString().slice(0, 10) + '.json';
  a.click();
  setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  showToast('已导出 ' + total + ' 条提示词（直译' + directPrompts.length + ' / 润色' + polishPrompts.length + '）');
}

function importPrompts() {
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
        if (!data.version) { showToast('无效的提示词配置文件'); return; }
        var impDirect = data.direct || [];
        var impPolish = data.polish || [];
        if (impDirect.length === 0 && impPolish.length === 0) {
          showToast('文件中没有提示词数据'); return;
        }

        // 读取现有提示词
        var existDirect = [];
        var existPolish = [];
        try { existDirect = dbGet('tllmh_prompts_direct', []); } catch (e) {}
        try { existPolish = dbGet('tllmh_prompts_polish', []); } catch (e) {}

        // 计算新增/更新数
        var existDirectIds = {};
        var existPolishIds = {};
        existDirect.forEach(function(p) { existDirectIds[p.id] = true; });
        existPolish.forEach(function(p) { existPolishIds[p.id] = true; });
        var newD = impDirect.filter(function(p) { return !existDirectIds[p.id]; }).length;
        var newP = impPolish.filter(function(p) { return !existPolishIds[p.id]; }).length;
        var updD = impDirect.length - newD;
        var updP = impPolish.length - newP;

        // 构建预览 HTML
        var previewHtml = '<div style="margin-bottom:12px;font-size:0.82rem;color:var(--text-secondary)">';
        previewHtml += '来源：' + escHtml(data.source || '未知') + (data.exported_at ? ' · ' + data.exported_at.slice(0, 10) : '') + '</div>';
        if (impDirect.length > 0) {
          previewHtml += '<div style="margin-bottom:8px"><b style="color:var(--accent)">直译提示词</b> (' + impDirect.length + ' 条)</div>';
          previewHtml += '<div style="margin-bottom:10px;padding-left:8px">';
          impDirect.forEach(function(p) {
            var badge = existDirectIds[p.id] ? ' <span style="color:var(--amber);font-size:0.68rem">更新</span>' : ' <span style="color:var(--green);font-size:0.68rem">新增</span>';
            previewHtml += '<div style="font-size:0.78rem;padding:2px 0">· ' + escHtml(p.name || '未命名') + badge + '</div>';
          });
          previewHtml += '</div>';
        }
        if (impPolish.length > 0) {
          previewHtml += '<div style="margin-bottom:8px"><b style="color:var(--accent)">润色提示词</b> (' + impPolish.length + ' 条)</div>';
          previewHtml += '<div style="margin-bottom:10px;padding-left:8px">';
          impPolish.forEach(function(p) {
            var badge = existPolishIds[p.id] ? ' <span style="color:var(--amber);font-size:0.68rem">更新</span>' : ' <span style="color:var(--green);font-size:0.68rem">新增</span>';
            previewHtml += '<div style="font-size:0.78rem;padding:2px 0">· ' + escHtml(p.name || '未命名') + badge + '</div>';
          });
          previewHtml += '</div>';
        }
        if (newD + newP > 0) {
          previewHtml += '<div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px">同名同ID的提示词将被覆盖，其余保留。</div>';
        }

        // 显示预览弹窗
        var modal = document.getElementById('importPreviewModal');
        if (!modal) {
          modal = document.createElement('div');
          modal.id = 'importPreviewModal';
          modal.className = 'modal-overlay';
          modal.style.display = 'none';
          modal.innerHTML = '<div class="modal-box" style="max-width:480px"><div class="modal-msg" style="font-weight:600">📥 导入提示词</div>' +
            '<div id="importPreviewBody"></div>' +
            '<div class="modal-actions"><button class="btn btn-primary" id="importPreviewOk">确认导入</button><button class="btn" id="importPreviewCancel">取消</button></div></div>';
          document.body.appendChild(modal);
          modal.addEventListener('click', function(ev) { if (ev.target === modal) modal.style.display = 'none'; });
          document.addEventListener('keydown', function(ev) { if (ev.key === 'Escape' && modal.style.display === 'flex') modal.style.display = 'none'; });
        }
        document.getElementById('importPreviewBody').innerHTML = previewHtml;
        modal.style.display = 'flex';
        document.getElementById('importPreviewCancel').onclick = function() { modal.style.display = 'none'; };
        document.getElementById('importPreviewOk').onclick = function() {
          modal.style.display = 'none';
          // 执行合并导入
          var directMap = {};
          existDirect.forEach(function(p) { directMap[p.id] = p; });
          impDirect.forEach(function(p) { directMap[p.id] = p; });
          var mergedDirect = Object.values(directMap);

          var polishMap = {};
          existPolish.forEach(function(p) { polishMap[p.id] = p; });
          impPolish.forEach(function(p) { polishMap[p.id] = p; });
          var mergedPolish = Object.values(polishMap);

          dbSet('tllmh_prompts_direct', mergedDirect);
          dbSet('tllmh_prompts_polish', mergedPolish);

          if (data.polish_step2) {
            setPolishStep2Prompt(data.polish_step2);
            var psTa = $('polish_strategy');
            if (psTa) psTa.value = data.polish_step2;
          }

          renderSavedPrompts();
          var msg = '导入完成：新增 ' + (newD + newP) + ' 条';
          if (updD + updP > 0) msg += '，更新 ' + (updD + updP) + ' 条';
          showToast(msg);
        };
      } catch (ex) {
        showToast('导入失败: ' + ex.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ── Button state helpers ──
function updateManualBtn() {
  var btn = document.getElementById('btnManualInput');
  if (!btn) return;
  btn.textContent = state.lines.length > 0 ? '添加' : '加载';
}

function updateRetryButton() {
  var failed = state.lines.filter(function (l) { return l.error; }).length;
  $('btnRetryFailed').disabled = (failed === 0);
  // btnRetrySelected 常亮，由 retrySelected() 自行处理无选中
}
function updateExportCheckedButton() {
  var btn = document.getElementById('btnExportChecked');
  if (btn) btn.disabled = state.previewChecked.size === 0 && state.compareChecked.size === 0;
}

// ── Init: restore saved mode, then load defaults ──
(function () {
  var saved = dbGet('tllmh_mode');
  if (saved === 'polish') setMode('polish');
})();
setTimeout(function () { loadDefaults(); }, 0);

// ── Connectivity check on startup + periodic polling ──
checkLLM();
var _llmPollTimer = setInterval(checkLLM, 15000);
document.addEventListener('visibilitychange', function () {
  if (document.hidden) {
    clearInterval(_llmPollTimer);
    _llmPollTimer = 0;
  } else {
    if (!_llmPollTimer) { checkLLM(); _llmPollTimer = setInterval(checkLLM, 15000); }
  }
});

// ── Module exports ──
function registerRenderCallbacks(previewFn, compareFn) {
  _renderCallbacks.preview = previewFn;
  _renderCallbacks.compare = compareFn;
}

export { state, rebuildIndicesAndCheckboxes, PRESET_PROMPTS, DIRECT_DEFAULT, POLISH_DIRECT_DEFAULT, POLISH_STEP2_DEFAULT, getPolishStep2Prompt, setPolishStep2Prompt, LLM_PARAM_DEFAULTS, resetInputDefault, resetParamDefault, saveModeParams, loadModeParams, getLLMParams, setMode, updateTranslateAllButton, getApiConfig, loadApiConfig, saveApiConfig, testApiConnection, setProvider, onThinkingChange, checkLLM, loadDefaults, savePolishStrategy, showPromptBar, onTitleFocus, savePrompt, loadSavedPrompt, deletePrompt, renderSavedPrompts, togglePrompt, resetSystemPrompt, exportPrompts, importPrompts, updateManualBtn, updateRetryButton, updateExportCheckedButton, promptKey, registerRenderCallbacks };
