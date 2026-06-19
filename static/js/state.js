/**
 * TxtLlmHub — 状态管理与持久化
 * 全局状态、localStorage 持久化、LLM 参数、API 配置、Provider 切换、提示词模板
 * Depends on: utils.js
 */

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
  previewRowLimit: 2000,       // 预览行数上限
  hiddenRulesEnabled: true,    // 翻译策略开关
  hiddenRulesText: '',         // 自定义翻译策略文本
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


// ── One-time v2 localStorage migration ──
(function () {
  try {
    if (!localStorage.getItem('tllmh_params_v2')) {
      localStorage.removeItem('tllmh_params_polish');
      localStorage.removeItem('tllmh_params_direct');
      localStorage.setItem('tllmh_params_v2', '1');
    }
  } catch (e) { /* ignore */ }
})();

// ── Mode readiness flag ──
var _modeReady = false;

// ── Built-in Preset Prompts (non-deletable) ──
var PRESET_PROMPTS = {
  direct: [
    {
      id: '__preset_ui_direct__',
      name: 'UI / Mod（术语）',
      text: '你是一个专业游戏中文本地化专家，专精于UI、菜单、控件、Mod说明及软件界面翻译。\n请将给定原文翻译为中文，严格遵循以下规则：\n1. 术语第一：识别并保持游戏/软件专业术语、缩写、变量名（如{0}、%s）、快捷键（&键）的绝对准确与一致，必要时保留英文原词。\n2. 极度简洁：UI空间有限，译文必须比原文更短或等长，严禁添加解释性文字。\n3. 功能明确：按钮和选项翻译需能直接反映其点击后的操作，避免歧义。\n4. 格式保留：完整保留原文中的换行、空格、占位符和特殊符号。\n注意只需要输出翻译后的结果，不要额外解释。',
      locked: true
    },
    {
      id: '__preset_dialogue_direct__',
      name: '对话 / 剧情（生动）',
      text: '你是一个顶尖的游戏本地化及配音脚本翻译专家。\n请将以下游戏对话/剧情文本翻译成中文。你的唯一信条：译文必须听起来像一个以中文为母语的角色，在那一刻会自然而然说出的话。\n遵循以下要求：\n1. 声入人心：根据上下文判断角色性格与情绪，中文对白必须贴合其身份、年龄和当下情感，保留俚语、口头禅和语气词。\n2. 彻底摆脱翻译腔：无视原文的英文句式结构，用地道中文口语彻底重写。被动变主动，名词变动词，长句化短句。\n3. 情境优先：为达到原文的戏剧效果或情感冲击力，可以牺牲字面翻译，进行创造性改写（意译）。\n4. 注意保持原文格式，只需要输出翻译后的结果，不要额外解释。',
      locked: true
    }
  ],
  polish: [
    {
      id: '__preset_ui_polish__',
      name: 'UI / Mod（术语）',
      text: '你是一个专业中文本地化直译专家。\n请对给定原文进行极度忠实、结构对齐的直译。保留所有术语、占位符、快捷键标记不翻译。\n保留原文的换行和格式。即使读起来生硬，也务必保留原文语序和结构。\n注意只需要输出翻译后的结果，不要额外解释。',
      step2: '你是一个专业游戏UI本地化校对专家。\n现在给你两个版本的译文：\n直译新译文：极度忠实原文结构和术语，但可能生硬。\n旧译文：线上正在使用的版本，可能更流畅但可能有术语错误或格式问题。\n请融合两者优点，输出最终UI译文，遵循铁律：\n1. 术语绝对准确：旧译文术语若与直译新译文冲突，以直译新译文的术语为准，修正旧译文错误。\n2. 极致简洁：删除所有冗余字词，确保译文长度不超过原文。\n3. 功能无歧义：按钮/选项的翻译必须清晰传达其功能。\n4. 修复格式：确保占位符、快捷键标记与直译新译文完全一致。\n5. 有限润色：在满足以上4条的前提下，可微调用词使其略为通顺，但绝不扩展或意译。\n只输出最终译文，不要额外解释。',
      locked: true
    },
    {
      id: '__preset_dialogue_polish__',
      name: '对话 / 剧情（生动）',
      text: '你是一个专业游戏翻译初稿专家。\n请将以下游戏对话翻译成中文。目标是产出一个意思准确、基本通顺、但没有经过精细艺术加工的初稿。\n要求：\n- 准确传达原文的语义和情绪基调（喜怒哀乐）。\n- 保留所有关键信息、比喻和俚语意象（即使暂时读起来有点生硬）。\n- 可以保留部分原文结构，但需转换成通顺的中文。\n- 这是半成品，不需要完美，但必须为下一步的艺术润色提供无误的原材料。\n注意只需要输出翻译后的结果，不要额外解释。',
      step2: '你是一个顶尖的游戏本地化润色及配音导演。\n现在给你两个版本的译文：\n直译新译文：意思准确、情绪基调正确，但缺乏艺术加工，可能略带翻译腔。\n旧译文：可能是来自旧版翻译的参考，有可取之处但也可能存在问题。\n你的任务是基于这两个版本，进行彻底的创造性重写，以产出最终中文对白。务必遵循：\n1. 唯一目标：最终译文必须听起来像原生中文游戏的精彩对白，完全消除翻译腔。\n2. 导演思维：想象角色正在说这句话。它的语气、节奏、用词是否100%贴合此情此景的角色？如果不，就改到贴合为止。\n3. 敢于重写：不被直译新译文的句子结构束缚。取其意，忘其形。继承旧译文中的神来之笔，但毫不犹豫地改写平淡或出戏的部分。\n4. 活化语言：善用中文四字格、俗语、语气词、短句，让对白"活"起来。\n5. 情感校准：确保最终译文的情绪冲击力，不低于、甚至要超越原文。\n只输出最终润色后的中文对白，不要额外解释。',
      locked: true
    }
  ]
};

// ── Default Prompts (HYBRID — system defaults for each mode) ──
var DIRECT_DEFAULT = '你是一个全能的游戏本地化专家。你将收到混合了UI提示、系统通知和少量对话片段的文本。\n请逐句判断类型并应用不同策略翻译：\n- 若为UI/菜单/按钮/系统提示/Mod说明/术语：采用【UI模式】—— 绝对准确的术语，极度简洁，保留占位符和快捷键，长度不超过原文。\n- 若为对话/剧情/角色台词：采用【对白模式】—— 自然口语化，贴合角色情绪，完全消除翻译腔，必要时可意译。\n- 若一句话中混有术语和对话，优先保证术语准确，再用口语化方式串联。\n注意保留原文全部格式。只需要输出翻译后的结果，不要额外解释。';

var POLISH_DIRECT_DEFAULT = '你是一个专业游戏翻译初稿专家。请对以下混合文本进行逐句直译，作为底稿。\n同时，为每句自动打上类型标签（[UI] 或 [DIALOGUE]）。判断标准：\n- [UI]：按钮、菜单、系统提示、Mod说明、属性列表、包含占位符/快捷键的文本。\n- [DIALOGUE]：角色对白、剧情叙述、包含情绪和语气的文本。\n翻译要求：\n- [UI]句：进行结构对齐的忠实直译，术语和占位符保留英文。\n- [DIALOGUE]句：翻译为意思准确、带基础情绪的通顺中文，允许微调语序。\n输出格式：\n[标签] 中文底稿\n只输出带标签的译文，不要额外解释。';

var POLISH_STEP2_DEFAULT = '你是一个资深游戏本地化校对专家。\n你将收到已打好标签的直译新译文和对应的旧译文。\n请针对[UI]和[DIALOGUE]标签，采用不同策略进行融合润色：\n\n【对[UI]文本 - 铁律模式】\n1. 术语与格式以直译新译文为唯一准绳，修正旧译文错误。\n2. 极度精简，删除任何冗余字，确保长度不超过原文。\n3. 在满足以上条件后，可微调用词使其略通顺，但绝不意译。\n\n【对[DIALOGUE]文本 - 重写模式】\n1. 以"听起来像地道的中文原生对白"为唯一目标。\n2. 无畏地抛弃直译新译文的生硬结构，只继承其准确语义和基础情绪。\n3. 吸收旧译文在口语化和角色贴合度上的优点。\n4. 进行创造性重写，活化语言，让对白"活"起来。\n\n输出时去掉所有标签，直接输出润色后的纯译文文本。保持原文顺序和格式。\n只输出最终译文，不要额外解释。';

// ── Polish Step2 prompt storage ──
function getPolishStep2Prompt() {
  return localStorage.getItem('tllmh_polish_step2') || POLISH_STEP2_DEFAULT;
}
function setPolishStep2Prompt(text) {
  if (text) { localStorage.setItem('tllmh_polish_step2', text); }
  else { localStorage.removeItem('tllmh_polish_step2'); }
}

// ── LLM 参数持久化 ──
function resetParamDefault(el) {
  var defaults = { temperature: '0.7', top_p: '0.6', max_tokens: '1024', repetition_penalty: '1.05' };
  if (defaults[el.id]) el.value = defaults[el.id];
  if (window.getSelection) window.getSelection().removeAllRanges();
  el.blur();
  if (_modeReady) saveModeParams(state.translateMode);
}

function saveModeParams(mode) {
  var p = {
    temperature: $('temperature').value,
    top_p: $('top_p').value,
    max_tokens: $('max_tokens').value,
    repetition_penalty: $('repetition_penalty').value,
    system_prompt: $('system_prompt').value,
  };
  localStorage.setItem('tllmh_params_' + mode, JSON.stringify(p));
}

function loadModeParams(mode) {
  var def = mode === 'polish'
    ? { temperature: '0.7', top_p: '0.6', max_tokens: '1024', repetition_penalty: '1.05',
        system_prompt: POLISH_DIRECT_DEFAULT }
    : { temperature: '0.7', top_p: '0.6', max_tokens: '1024', repetition_penalty: '1.05',
        system_prompt: DIRECT_DEFAULT };
  try {
    var saved = JSON.parse(localStorage.getItem('tllmh_params_' + mode) || '{}');
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
}

function getLLMParams() {
  var p = {
    temperature: parseFloat($('temperature').value) || 0.3,
    top_p: parseFloat($('top_p').value) || 0.6,
    max_tokens: parseInt($('max_tokens').value) || 1024,
    repetition_penalty: parseFloat($('repetition_penalty').value) || 1.05,
    system_prompt: $('system_prompt').value.trim() || undefined,
  };
  // 润色模式附带 Step2 提示词
  if (state.translateMode === 'polish') {
    p.polish_prompt = getPolishStep2Prompt();
  }
  // 翻译策略：仅对默认混合提示词生效，预设自带策略时跳过
  var currentPrompt = ($('system_prompt').value || '').trim();
  var defaultPrompt = state.translateMode === 'polish' ? POLISH_DIRECT_DEFAULT : DIRECT_DEFAULT;
  var isDefaultPrompt = (currentPrompt === defaultPrompt);
  // 显示/隐藏翻译策略面板
  var hrRow = $('hiddenRulesRow');
  if (hrRow) hrRow.style.display = isDefaultPrompt ? 'none' : 'none'; // 始终隐藏，由 toggle 控制展开
  var hrToggle = $('hiddenRulesToggle');
  if (hrToggle) hrToggle.style.opacity = isDefaultPrompt ? '1' : '0.4';
  if (hrToggle) hrToggle.title = isDefaultPrompt ? '展开/折叠翻译策略' : '翻译策略仅对默认提示词生效';
  if (isDefaultPrompt) {
    var hrEnabled = $('hiddenRulesEnabled');
    var hrText = $('hiddenRulesText');
    if (hrEnabled) {
      state.hiddenRulesEnabled = hrEnabled.checked;
      localStorage.setItem('tllmh_hidden_rules_enabled', String(hrEnabled.checked));
    }
    if (hrText) {
      state.hiddenRulesText = hrText.value.trim();
      localStorage.setItem('tllmh_hidden_rules_text', hrText.value);
    }
    if (state.hiddenRulesEnabled) {
      p.hidden_rules = state.hiddenRulesText || undefined;
    } else {
      p.hidden_rules = '';
    }
  } else {
    // 预设/自定义提示词：不传 hidden_rules，后端会用默认规则
    // 但预设自带完整策略，默认规则反而干扰，所以传空
    p.hidden_rules = '';
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
    renderPreview();
    renderCompare();
    state.translateStarted = false;
  }
  if (_modeReady) saveModeParams(state.translateMode);
  state.translateMode = mode;
  localStorage.setItem('tllmh_mode', mode);
  loadModeParams(mode);
  _updateHiddenRulesUI();
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
  try { cfg = JSON.parse(localStorage.getItem('tllmh_api_config') || '{}'); } catch (e) { cfg = {}; }
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
  localStorage.setItem('tllmh_api_config', JSON.stringify(cfg));
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
  localStorage.setItem('tllmh_provider', provider);
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

// ── 翻译策略控制（隐性规则，仅对默认提示词生效） ──
function toggleHiddenRules() {
  var row = $('hiddenRulesRow');
  var toggle = $('hiddenRulesToggle');
  // 检查当前是否为默认提示词
  var currentPrompt = ($('system_prompt') ? $('system_prompt').value : '').trim();
  var defaultPrompt = state.translateMode === 'polish' ? POLISH_DIRECT_DEFAULT : DIRECT_DEFAULT;
  if (currentPrompt !== defaultPrompt) {
    showToast('翻译策略仅对默认提示词生效，预设自带策略');
    return;
  }
  if (row.style.display === 'flex') {
    row.style.display = 'none';
    toggle.textContent = '翻译策略 ▼';
  } else {
    row.style.display = 'flex';
    toggle.textContent = '翻译策略 ▲';
  }
}

function _initHiddenRules() {
  try {
    var savedEnabled = localStorage.getItem('tllmh_hidden_rules_enabled');
    if (savedEnabled !== null) {
      state.hiddenRulesEnabled = savedEnabled === 'true';
    }
    var savedText = localStorage.getItem('tllmh_hidden_rules_text');
    if (savedText !== null) {
      state.hiddenRulesText = savedText.trim();
    }
  } catch (e) { /* ignore */ }
  var cb = $('hiddenRulesEnabled');
  if (cb) cb.checked = state.hiddenRulesEnabled;
  var ta = $('hiddenRulesText');
  if (ta) ta.value = state.hiddenRulesText;
  _updateHiddenRulesUI();
}

function _updateHiddenRulesUI() {
  var currentPrompt = ($('system_prompt') ? $('system_prompt').value : '').trim();
  var defaultPrompt = state.translateMode === 'polish' ? POLISH_DIRECT_DEFAULT : DIRECT_DEFAULT;
  var isDefault = (currentPrompt === defaultPrompt);
  var toggle = $('hiddenRulesToggle');
  if (toggle) {
    toggle.style.opacity = isDefault ? '1' : '0.4';
    toggle.title = isDefault ? '展开/折叠翻译策略' : '翻译策略仅对默认提示词生效，预设自带策略';
  }
  // 如果当前不是默认提示词，折叠面板
  if (!isDefault) {
    var row = $('hiddenRulesRow');
    if (row) row.style.display = 'none';
    if (toggle) toggle.textContent = '翻译策略 ▼';
  }
}

// ── Provider 初始化 ──
(function () {
  var saved = localStorage.getItem('tllmh_provider') || 'local';
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
  try {
    var r = await fetch('/api/config');
    var d = await r.json();
    if (d.defaults && !localStorage.getItem('tllmh_params_direct')) {
      localStorage.setItem('tllmh_params_direct', JSON.stringify({
        temperature: d.defaults.temperature || 0.7,
        top_p: d.defaults.top_p || 0.6,
        max_tokens: d.defaults.max_tokens || 1024,
        repetition_penalty: d.defaults.repetition_penalty || 1.05,
        system_prompt: d.defaults.system_prompt,
      }));
    }
    if (d.polish_defaults && !localStorage.getItem('tllmh_params_polish')) {
      localStorage.setItem('tllmh_params_polish', JSON.stringify({
        temperature: d.polish_defaults.temperature || 0.7,
        top_p: d.polish_defaults.top_p || 0.6,
        max_tokens: d.polish_defaults.max_tokens || 1024,
        repetition_penalty: d.polish_defaults.repetition_penalty || 1.05,
        system_prompt: d.polish_defaults.system_prompt,
      }));
    }
    // 加载后端默认翻译策略（基础规则，润色糅合规则由后端自动追加）
    if (d.hidden_rules_base && !localStorage.getItem('tllmh_hidden_rules_text')) {
      state.hiddenRulesText = d.hidden_rules_base.trim();
    }
    // 存储后端预设（供未来扩展）
    if (d.presets) {
      window._backendPresets = d.presets;
    }
  } catch (e) { /* ignore */ }
  _initHiddenRules();
  loadModeParams(state.translateMode);
  _modeReady = true;
}

// ── 提示词模板管理 ──
function promptKey() { return 'tllmh_prompts_' + state.translateMode; }

function showPromptBar() {
  $('promptSaveBar').style.display = 'flex';
  renderSavedPrompts();
}

function onTitleFocus() {
  if (!$('promptTitle').value) {
    var prompts = JSON.parse((localStorage.getItem(promptKey()) || '[]'));
    $('promptTitle').placeholder = '提示词' + (prompts.length + 1);
  }
}

function savePrompt() {
  var text = $('system_prompt').value.trim();
  if (!text) { showToast('内容为空'); return; }
  var title = $('promptTitle').value.trim();
  var prompts = JSON.parse((localStorage.getItem(promptKey()) || '[]'));
  var n = prompts.length + 1;
  if (!title) title = '提示词' + n;
  var entry = { id: Date.now(), name: title, text: text };
  // 润色模式同时保存 Step2 提示词
  if (state.translateMode === 'polish') {
    entry.step2 = getPolishStep2Prompt();
  }
  prompts.push(entry);
  localStorage.setItem(promptKey(), JSON.stringify(prompts));
  $('promptTitle').value = ''; showToast('已保存: ' + title);
  renderSavedPrompts();
}

function loadSavedPrompt(id) {
  // 优先匹配内置预设
  var presets = PRESET_PROMPTS[state.translateMode] || [];
  var preset = presets.find(function (x) { return x.id === id; });
  if (preset) {
    $('system_prompt').value = preset.text;
    if (state.translateMode === 'polish' && preset.step2) {
      setPolishStep2Prompt(preset.step2);
    }
    showToast('已加载: ' + preset.name);
    _updateHiddenRulesUI();
    return;
  }
  // 匹配用户自定义提示词
  var prompts = JSON.parse((localStorage.getItem(promptKey()) || '[]'));
  var p = prompts.find(function (x) { return x.id === id; });
  if (p) {
    $('system_prompt').value = p.text;
    // 润色模式同时恢复配对的 Step2
    if (state.translateMode === 'polish' && p.step2) {
      setPolishStep2Prompt(p.step2);
    }
    showToast('已加载: ' + p.name);
    _updateHiddenRulesUI();
  }
}

function deletePrompt(id) {
  // 内置预设不可删除
  if (String(id).indexOf('__preset_') === 0) return;
  var prompts = JSON.parse((localStorage.getItem(promptKey()) || '[]'));
  prompts = prompts.filter(function (x) { return x.id !== id; });
  localStorage.setItem(promptKey(), JSON.stringify(prompts));
  renderSavedPrompts();
}

function renderSavedPrompts() {
  var presets = PRESET_PROMPTS[state.translateMode] || [];
  var userPrompts = JSON.parse((localStorage.getItem(promptKey()) || '[]'));
  var savedHtml = '';

  // 先渲染内置预设（锁定，无删除按钮）
  presets.forEach(function (p) {
    savedHtml += '<span class="prompt-chip preset" onclick="loadSavedPrompt(\'' + p.id + '\')" data-tooltip="' + escHtml(p.text) + '">' +
'<span class="chip-text">' + escHtml(p.name) + '</span>' +
      '</span>';
  });
  // 渲染用户自定义提示词
  userPrompts.forEach(function (p) {
    savedHtml += '<span class="prompt-chip" onclick="loadSavedPrompt(' + p.id + ')" data-tooltip="' + escHtml(p.text) + '">' +
      '<span class="chip-text">' + escHtml(p.name) + '</span>' +
      '<span class="chip-del" onclick="deletePrompt(' + p.id + ');event.stopPropagation()">&times;</span></span>';
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
  if (row.style.display === 'flex') {
    row.style.display = 'none';
    toggle.textContent = 'System Prompt ▼';
  } else {
    row.style.display = 'flex';
    showPromptBar();
    var prompts = JSON.parse((localStorage.getItem(promptKey()) || '[]'));
    $('promptTitle').placeholder = '提示词' + (prompts.length + 1);
    toggle.textContent = 'System Prompt ▲';
  }
}

function resetSystemPrompt() {
  var mode = state.translateMode;
  var defaults = mode === 'polish' ? POLISH_DIRECT_DEFAULT : DIRECT_DEFAULT;
  $('system_prompt').value = defaults;
  // 润色模式同时重置 Step2 为默认值
  if (mode === 'polish') {
    setPolishStep2Prompt(POLISH_STEP2_DEFAULT);
  }
  saveModeParams(mode);
  _updateHiddenRulesUI();
  showToast('已恢复默认提示词');
}

function resetHiddenRules() {
  try {
    fetch('/api/config').then(function(resp) { return resp.json(); }).then(function(d) {
      var rules = (d.hidden_rules_base || d.hidden_rules || '').trim();
      if (rules) {
        state.hiddenRulesText = rules;
        $('hiddenRulesText').value = rules;
        localStorage.setItem('tllmh_hidden_rules_text', rules);
        showToast('已恢复默认翻译策略');
      }
    });
  } catch (e) { /* ignore */ }
}

// ── 提示词导入/导出（JSON 格式） ──
function exportPrompts() {
  var data = {
    version: 1,
    direct: [],
    polish: [],
    hidden_rules_enabled: state.hiddenRulesEnabled,
    hidden_rules_text: state.hiddenRulesText,
    polish_step2: getPolishStep2Prompt(),
  };
  try {
    data.direct = JSON.parse(localStorage.getItem('tllmh_prompts_direct') || '[]');
    data.polish = JSON.parse(localStorage.getItem('tllmh_prompts_polish') || '[]');
  } catch (e) { /* ignore */ }
  var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'TxtLlmHub_prompts.json';
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出提示词配置');
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
        if (data.direct && data.direct.length > 0) {
          localStorage.setItem('tllmh_prompts_direct', JSON.stringify(data.direct));
        }
        if (data.polish && data.polish.length > 0) {
          localStorage.setItem('tllmh_prompts_polish', JSON.stringify(data.polish));
        }
        if (typeof data.hidden_rules_enabled === 'boolean') {
          state.hiddenRulesEnabled = data.hiddenRulesEnabled;
          localStorage.setItem('tllmh_hidden_rules_enabled', String(data.hidden_rules_enabled));
          var cb = $('hiddenRulesEnabled');
          if (cb) cb.checked = data.hidden_rules_enabled;
        }
        if (data.hidden_rules_text) {
          state.hiddenRulesText = data.hidden_rules_text;
          localStorage.setItem('tllmh_hidden_rules_text', data.hidden_rules_text);
          var ta = $('hiddenRulesText');
          if (ta) ta.value = data.hidden_rules_text;
        }
        if (data.polish_step2) {
          setPolishStep2Prompt(data.polish_step2);
        }
        renderSavedPrompts();
        showToast('已导入提示词配置（' + ((data.direct||[]).length + (data.polish||[]).length) + ' 条）');
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
  var checked = state.compareChecked.size;
  var rsBtn = $('btnRetrySelected');
  if (rsBtn) rsBtn.disabled = (checked === 0);
}
function updateExportCheckedButton() {
  var btn = $('btnExportChecked');
  if (!btn) return;
  btn.disabled = (state.compareChecked.size === 0);
}

// ── Init: restore saved mode, then load defaults ──
(function () {
  var saved = localStorage.getItem('tllmh_mode');
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
