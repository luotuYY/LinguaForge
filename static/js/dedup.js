/**
 * LinguaForge — 去重模块
 */

import { $, escHtml, showToast } from './utils.js';
import { _renderPagination } from './render.js';
import { state, getApiConfig, resetInputDefault } from './state.js';
import { dbGet, dbSet, dbReady } from './db.js';

var dedupState = {
    entries: [],
    groups: {},
    files: [],
    selected: new Map(),
    bestIndices: new Map(),
    filterDupOnly: false,
    visibleKeys: [],
    processing: false,
    evaluating: false,
    abort: false,
    fileContents: {},
    rowsPerPage: 200,
    currentPage: 1,
};

// ── 默认参数 ──
var DEDUP_DEFAULTS = {
    temperature: 0.1,
    top_p: 0.6,
    max_tokens: 10,
    rep_penalty: 1.0,
    concurrency: 5,
    strategy:
      "你是一个专业的文本质量评估专家。\n" +
      "以下是一组具有相同原文但不同译文的条目，请判断哪一条译文质量最高。\n" +
      "评估标准：准确性（是否忠实于原文）、自然度（是否通顺地道）、语境适配（是否符合游戏场景）。",
};

// ── 持久化 ──
function loadDedupParams() {
    var cfg = {};
    cfg = dbGet("tllmh_dedup_params", {});
    $("dedupTemperature").value = cfg.temperature != null ? cfg.temperature : DEDUP_DEFAULTS.temperature;
    $("dedupTopP").value = cfg.top_p != null ? cfg.top_p : DEDUP_DEFAULTS.top_p;
    $("dedupMaxTokens").value = cfg.max_tokens != null ? cfg.max_tokens : DEDUP_DEFAULTS.max_tokens;

    $("dedupConcurrency").value = cfg.concurrency != null ? cfg.concurrency : DEDUP_DEFAULTS.concurrency;
    $("dedupStrategyText").value = cfg.strategy || DEDUP_DEFAULTS.strategy;
}

function saveDedupParams() {
    dbSet("tllmh_dedup_params", getDedupParams());
}

function getDedupParams() {
    return {
      temperature: parseFloat($("dedupTemperature").value) || DEDUP_DEFAULTS.temperature,
      top_p: parseFloat($("dedupTopP").value) || DEDUP_DEFAULTS.top_p,
      max_tokens: parseInt($("dedupMaxTokens").value) || DEDUP_DEFAULTS.max_tokens,
      rep_penalty: DEDUP_DEFAULTS.rep_penalty,
      concurrency: parseInt($("dedupConcurrency").value) || DEDUP_DEFAULTS.concurrency,
      strategy: $("dedupStrategyText").value.trim() || DEDUP_DEFAULTS.strategy,
    };
}

function toggleDedupStrategy() {
    var row = $("dedupStrategyRow");
    var toggle = $("dedupStrategyToggle");
    if (!row || !toggle) return;
    var show = row.style.display === "none" || !row.style.display;
    row.style.display = show ? "flex" : "none";
    toggle.textContent = show ? "评估策略 ▲" : "评估策略 ▼";
}

function resetDedupStrategy() {
    $("dedupStrategyText").value = DEDUP_DEFAULTS.strategy;
    saveDedupParams();
    dedupLog("已恢复默认评估策略");
}

// ── 日志 ──
function dedupLog(msg, cls) {
    var area = $("dedupLogArea");
    if (!area) return;
    area.style.display = "flex";
    area.style.flexDirection = "column";
    var time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    var body = escHtml(msg);
    if (cls) { body = '<span class="' + cls + '">' + body + "</span>"; }
    area.innerHTML +=
      '<div class="log-line"><span class="log-time">' + time + "</span> " + body + "</div>";
    area.scrollTop = area.scrollHeight;
}

function clearDedupLog() {
    var area = $("dedupLogArea");
    if (area) {
      area.innerHTML = "";
      area.style.display = "none";
    }
}

// ── 条目工具 ──
function _entryId(e) {
    return (e.file || "") + "|" + (e.line != null ? e.line : 0);
}

function getDedupApiConfig() {
    if (typeof window.getApiConfig === "function") return window.getApiConfig();
    return { provider: "local" };
}

// ── 增量更新整组 DOM（以组为单位） ──
function _updateGroupDOM(key, gIdx) {
    var container = $("dedupGroups");
    if (!container) return;
    var group = dedupState.groups[key];
    if (!group) return;
    var bestIdx = dedupState.bestIndices.get(key);
    if (bestIdx == null) bestIdx = -1;

    // 更新组头最优标签
    var groupEl = container.querySelector('.dedup-group[data-group="' + gIdx + '"]');
    if (groupEl) {
      var header = groupEl.querySelector(".dedup-group-header");
      var bestSpan = groupEl.querySelector(".dedup-group-best");
      if (bestIdx >= 0) {
        if (!bestSpan) {
          bestSpan = document.createElement("span");
          bestSpan.className = "dedup-group-best";
          header.appendChild(bestSpan);
        }
        bestSpan.textContent = "最优：#" + (bestIdx + 1);
      } else if (bestSpan) {
        bestSpan.remove();
      }
    }

    // 更新每行 class
    group.forEach(function (e, idx) {
      var isSelected = !!dedupState.selected.get(_entryId(e));
      var isBest = bestIdx >= 0 && idx === bestIdx;
      var row = container.querySelector('.dedup-row[data-group="' + gIdx + '"][data-idx="' + idx + '"]');
      if (row) {
        row.className = "dedup-row";
        if (isSelected) row.classList.add("dedup-row-selected");
        if (isBest) row.classList.add("dedup-row-best");
      }
    });
}

// ── 全量渲染重复组 ──
function renderGroups() {
    var container = $("dedupGroups");
    if (!container) return;

    var allKeys = Object.keys(dedupState.groups);
    var visibleKeys;
    if (dedupState.filterDupOnly) {
      visibleKeys = [];
      allKeys.forEach(function (key) {
        var g = dedupState.groups[key];
        var allSame = g.every(function (e) { return e.translation === g[0].translation; });
        if (!allSame) visibleKeys.push(key);
      });
    } else {
      visibleKeys = allKeys;
    }

    var fltBtn = $("dedupFilterBtn");
    if (fltBtn) {
      fltBtn.className = "dedup-nav-btn" + (dedupState.filterDupOnly ? " dedup-filter-on" : " dedup-filter-off");
    }

    dedupState.visibleKeys = visibleKeys;

    if (visibleKeys.length === 0) {
      container.innerHTML = '<div class="empty-state">未发现重复的原文</div>';
      $("dedupGroupCount").textContent = "0";
      $("dedupApplyBtn").disabled = true;
      updateSelectedCount();
      return;
    }

    var html = "";
    visibleKeys.forEach(function (key, gIdx) {
      var entries = dedupState.groups[key];
      var bestIdx = dedupState.bestIndices.get(key);
      if (bestIdx == null) bestIdx = -1;

      html += '<div class="dedup-group" data-group="' + gIdx + '">';
      html += '<div class="dedup-group-header" data-action="toggle-group">';
      html += '  <span class="dedup-group-toggle">▼</span>';
      html += '  <span class="dedup-group-original">' + escHtml(key) + "</span>";
      html += '  <span class="dedup-group-count">' + entries.length + " 条</span>";
      if (bestIdx >= 0) {
        html += '  <span class="dedup-group-best">最优：#' + (bestIdx + 1) + "</span>";
      }
      html += "</div>";
      html += '<div class="dedup-group-body">';

      entries.forEach(function (e, idx) {
        var checked = !!dedupState.selected.get(_entryId(e));
        var isBest = bestIdx >= 0 && idx === bestIdx;
        var rowClass = checked ? " dedup-row-selected" : "";
        if (isBest) rowClass += " dedup-row-best";

        html +=
          '<div class="dedup-row' + rowClass +
          '" data-group="' + gIdx +
          '" data-idx="' + idx +
          '" data-action="select-row">';
        html += '  <span class="dedup-row-original">' + escHtml(e.original) + "</span>";
        html += '  <span class="dedup-row-trans">' + escHtml(e.translation) + "</span>";
        html += '  <span class="dedup-row-file">' + escHtml(e.file) + "</span>";
        html += "</div>";
      });

      html += "</div></div>";
    });

    // Pagination
    var total = visibleKeys.length;
    var perPage = dedupState.rowsPerPage || 200;
    var totalPages = Math.max(1, Math.ceil(total / perPage));
    if (dedupState.currentPage > totalPages) dedupState.currentPage = totalPages;
    if (dedupState.currentPage < 1) dedupState.currentPage = 1;
    var start = (dedupState.currentPage - 1) * perPage;
    var pageKeys = visibleKeys.slice(start, start + perPage);

    var paginatedHtml = "";
    pageKeys.forEach(function (key, pIdx) {
      var gIdx = visibleKeys.indexOf(key);
      var entries = dedupState.groups[key];
      var bestIdx = dedupState.bestIndices.get(key);
      if (bestIdx == null) bestIdx = -1;

      paginatedHtml += '<div class="dedup-group" data-group="' + gIdx + '">';
      paginatedHtml += '<div class="dedup-group-header" data-action="toggle-group">';
      paginatedHtml += '  <span class="dedup-group-toggle">▼</span>';
      paginatedHtml += '  <span class="dedup-group-original">' + escHtml(key) + "</span>";
      paginatedHtml += '  <span class="dedup-group-count">' + entries.length + " 条</span>";
      if (bestIdx >= 0) {
        paginatedHtml += '  <span class="dedup-group-best">最优：#' + (bestIdx + 1) + "</span>";
      }
      paginatedHtml += "</div>";
      paginatedHtml += '<div class="dedup-group-body">';

      entries.forEach(function (e, idx) {
        var checked = !!dedupState.selected.get(_entryId(e));
        var isBest = bestIdx >= 0 && idx === bestIdx;
        var rowClass = checked ? " dedup-row-selected" : "";
        if (isBest) rowClass += " dedup-row-best";

        paginatedHtml +=
          '<div class="dedup-row' + rowClass +
          '" data-group="' + gIdx +
          '" data-idx="' + idx +
          '" data-action="select-row">';
        paginatedHtml += '  <span class="dedup-row-original">' + escHtml(e.original) + "</span>";
        paginatedHtml += '  <span class="dedup-row-trans">' + escHtml(e.translation) + "</span>";
        paginatedHtml += '  <span class="dedup-row-file">' + escHtml(e.file) + "</span>";
        paginatedHtml += "</div>";
      });

      paginatedHtml += "</div></div>";
    });

    container.innerHTML = paginatedHtml;
    // Remove old pagination bar and add new one
    var oldPg = container.parentElement.querySelector('.pagination-bar');
    if (oldPg) oldPg.remove();
    if (total > perPage) {
      var pgHtml = _renderPagination(total, perPage, dedupState.currentPage, 'dedup');
      container.insertAdjacentHTML('afterend', pgHtml);
      // Re-bind (insertAdjacentHTML puts it after container, need to find it)
      var pgBar = container.parentElement.querySelector('.pagination-bar');
      if (pgBar) {
        pgBar.querySelectorAll('button[data-pg="dedup"]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            dedupState.currentPage = parseInt(btn.dataset.page);
            renderGroups();
            container.scrollTop = 0;
          });
        });
        var sel = pgBar.querySelector('select[data-pg-rowsper="dedup"]');
        if (sel) {
          sel.addEventListener('change', function() {
            dedupState.rowsPerPage = parseInt(sel.value) || 200;
            dedupState.currentPage = 1;
            renderGroups();
          });
        }
      }
    }
    $("dedupGroupCount").textContent = visibleKeys.length;

    $("dedupApplyBtn").disabled = false;
    updateSelectedCount();
}

// 供 onclick 调用
function _dedupSelect(gIdx, idx) {
    var key = dedupState.visibleKeys[gIdx];
    if (key == null) return;
    var group = dedupState.groups[key];
    if (!group) return;
    // 更新状态
    group.forEach(function (e, i) {
      dedupState.selected.set(_entryId(e), i === idx);
    });
    dedupState.bestIndices.set(key, idx);
    // 以组为单位增量渲染
    _updateGroupDOM(key, gIdx);
    updateSelectedCount();
}

function toggleDedupGroup(el) {
    var body = el.nextElementSibling;
    var toggle = el.querySelector(".dedup-group-toggle");
    if (body.style.display === "none") {
      body.style.display = "";
      toggle.textContent = "▼";
    } else {
      body.style.display = "none";
      toggle.textContent = "▶";
    }
}

function updateSelectedCount() {
    var count = 0;
    dedupState.selected.forEach(function (v) { if (v) count++; });
    $("dedupSelectedCount").textContent = count;
}

// ── 文件读取 ──
function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = reject;
      reader.readAsText(file, "UTF-8");
    });
}

// ── 上传（仅解析，不评估） ──
async function handleFiles(fileList) {
    if (dedupState.processing) return;
    dedupState.processing = true;
    $("dedupBtnStart").disabled = true;

    var txtFiles = [];
    var fileContents = {};
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var fname = (f._relativePath || f.webkitRelativePath || f.name || "");
      if (!fname.toLowerCase().endsWith(".txt")) continue;
      txtFiles.push(f);
      try {
        var content = await readFileAsText(f);
        var relPath = f._relativePath || f.webkitRelativePath || f.name;
        fileContents[relPath] = content;
      } catch (e) {
        console.warn("读取文件失败:", f.name, e);
      }
    }

    if (txtFiles.length === 0) {
      showToast("未找到 .txt 文件");
      dedupState.processing = false;
      return;
    }

    var names = Object.keys(fileContents);
    var info = $("dedupFileInfo");
    if (info) {
      info.innerHTML =
        '<div style="font-size:0.73rem;color:var(--accent)">' +
        names.map(function (n) { return escHtml(n); }).join("<br>") +
        "</div>" +
        '<div style="font-size:0.68rem;color:var(--text-muted);margin-top:2px">共 ' + names.length + " 个文件（" + txtFiles.length + " 个 .txt）</div>";
    }

    var form = new FormData();
    var pathList = [];
    txtFiles.forEach(function (f) {
      var relPath = f._relativePath || f.webkitRelativePath || f.name;
      form.append("file", f);
      pathList.push(relPath);
    });
    form.append("_paths", JSON.stringify(pathList));

    try {
      clearDedupLog();
      dedupLog("上传中，共 " + txtFiles.length + " 个 .txt 文件...");
      dedupState.fileContents = fileContents;
      var r = await fetch("/api/dedup/upload", { method: "POST", body: form });
      var data = await r.json();
      if (data.error) {
        showToast("上传失败: " + data.error);
        dedupLog("错误: " + data.error);
        return;
      }

      dedupState.entries = data.entries;
      dedupState.groups = data.groups;
      dedupState.files = data.files;
      dedupState.bestIndices = new Map();
      dedupState.selected = new Map();

      // 默认选中每组第 0 条；若所有译文相同则直接标记为 best
      var autoSkipped = 0;
      Object.keys(data.groups).forEach(function (key) {
        var group = data.groups[key];
        var allSame = group.every(function (e) { return e.translation === group[0].translation; });
        if (allSame) {
          dedupState.bestIndices.set(key, 0);
          autoSkipped++;
        }
        group.forEach(function (e, idx) {
          dedupState.selected.set(_entryId(e), idx === 0);
        });
      });

      dedupLog(
        "解析完成: " + data.total_entries + " 条, " + data.total_groups + " 个重复组（" + autoSkipped + " 组译文完全相同，已自动勾选第一条）"
      );

      if (data.total_groups > 0) {
        $("dedupBtnStart").disabled = false;
        $("dedupProgressText").textContent = "待评估 " + data.total_groups + " 组";
        showToast("发现 " + data.total_groups + " 个重复组");
      } else {
        $("dedupProgressText").textContent = "无需评估";
        showToast("未发现重复组");
      }
      renderGroups();
    } catch (e) {
      showToast("上传失败: " + e.message);
      dedupLog("异常: " + e.message);
    } finally {
      dedupState.processing = false;
    }
}

// ── 批量评估（分块发送，每块完后检查 abort） ──
function _chunkArray(arr, size) {
    var chunks = [];
    for (var i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

async function _evaluateOneChunk(groupsChunk, chunkIdx) {
    var params = getDedupParams();
    var apiConfig = getDedupApiConfig();

    return fetch("/api/dedup/evaluate-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groups: groupsChunk,
        concurrency: Math.min(params.concurrency, groupsChunk.length),
        temperature: params.temperature,
        top_p: params.top_p,
        max_tokens: params.max_tokens,
        repetition_penalty: params.rep_penalty,
        system_prompt: params.strategy,
        ...apiConfig,
      }),
    });
}

async function _streamOneChunk(groupsChunk, chunkIdx, chunkKeys, total, completed, errors, offset) {
    var r = await _evaluateOneChunk(groupsChunk, chunkIdx);
    if (!r.ok) {
      var errData = await r.json().catch(function () { return { error: "HTTP " + r.status }; });
      throw new Error(errData.error || "HTTP " + r.status);
    }

    var reader = r.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    dedupLog(">> 块 " + (chunkIdx+1) + " (" + groupsChunk.length + " 组)");

    while (true) {
      if (dedupState.abort) break;
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });

      var lines = buffer.split("\n");
      buffer = lines.pop();

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li].trim();
        if (!line) continue;
        if (dedupState.abort) break;
        try {
          var data = JSON.parse(line);
          completed.val++;

          if (data.best_index !== undefined && data.best_index !== null) {
            var key = chunkKeys[data.group_index];
            if (key) {
              var group = dedupState.groups[key];
              group.forEach(function (e, idx) {
                dedupState.selected.set(_entryId(e), idx === data.best_index);
              });
              dedupState.bestIndices.set(key, data.best_index);
              var visibleIdx = dedupState.visibleKeys.indexOf(key);
              _updateGroupDOM(key, visibleIdx);
              var snip = key.length > 48 ? key.substring(0, 45) + "..." : key;
              dedupLog("OK " + snip + " → 第" + (data.best_index+1) + "条", "ok");
            }
          } else if (data.error) {
            errors.val++;
            var eKey = chunkKeys[data.group_index];
            var eDisp = eKey ? (eKey.length > 48 ? eKey.substring(0, 45) + "..." : eKey) : "[" + ((offset || 0) + data.group_index + 1) + "]";
            dedupLog("FAIL " + eDisp + ": " + data.error, "err");
          }

          var fill = $("dedupProgressFill");
          var text = $("dedupProgressText");
          fill.style.width = (completed.val / total * 100) + "%";
          text.textContent = "评估进度: " + completed.val + "/" + total;
        } catch (e) {}
      }
    }
}

async function dedupStart() {
    if (dedupState.evaluating) return;
    var groupKeys = Object.keys(dedupState.groups);
    if (groupKeys.length === 0) { showToast("无重复组"); return; }

    dedupState.evaluating = true;
    dedupState.abort = false;
    $("dedupBtnStart").disabled = true;
    $("dedupBtnStop").disabled = false;
    clearDedupLog();

    // 筛选模式下只评估当前可见的组（译文不同的）
    var candidateKeys;
    if (dedupState.filterDupOnly) {
      candidateKeys = [];
      groupKeys.forEach(function (key) {
        var g = dedupState.groups[key];
        var allSame = g.every(function (e) { return e.translation === g[0].translation; });
        if (!allSame) candidateKeys.push(key);
      });
    } else {
      candidateKeys = groupKeys;
    }

    var skippedCount = 0;
    var allGroups = [];
    candidateKeys.forEach(function (key) {
      var group = dedupState.groups[key];
      if (dedupState.bestIndices.has(key)) {
        skippedCount++;
        return;
      }
      allGroups.push({
        key: key,
        items: group.map(function (e) {
          return { original: e.original, translation: e.translation };
        }),
      });
    });

    if (allGroups.length === 0) {
      dedupLog("所有 " + skippedCount + " 组条目均相同，无需评估");
      showToast("所有组条目均相同，无需评估");
      dedupState.evaluating = false;
      $("dedupBtnStart").disabled = false;
      $("dedupBtnStop").disabled = true;
      return;
    }

    var concurrency = Math.min(getDedupParams().concurrency, allGroups.length);
    var chunks = _chunkArray(allGroups, concurrency);

    dedupLog("开始评估，共 " + allGroups.length + " 组（跳过了 " + skippedCount + " 组完全相同的），分 " + chunks.length + " 块，每块 " + concurrency + " 组");

    var fill = $("dedupProgressFill");
    var text = $("dedupProgressText");
    fill.style.width = "0%";
    text.textContent = "评估进度: 0/" + allGroups.length;

    var completed = { val: 0 };
    var errors = { val: 0 };
    var chunkOffset = 0;

    try {
      for (var ci = 0; ci < chunks.length; ci++) {
        if (dedupState.abort) break;
        var chunk = chunks[ci];
        var chunkItems = chunk.map(function (g) { return g.items; });
        var chunkKeys = chunk.map(function (g) { return g.key; });
        await _streamOneChunk(chunkItems, ci, chunkKeys, allGroups.length, completed, errors, chunkOffset);
        chunkOffset += chunk.length;
      }

      if (dedupState.abort) {
        dedupLog("评估已停止，完成 " + completed.val + "/" + allGroups.length + " 组");
      } else {
        dedupLog("评估完成: " + completed.val + " 组, 失败 " + errors.val + " 组");
        showToast("评估完成");
      }
      updateSelectedCount();
    } catch (e) {
      dedupLog("评估异常: " + e.message);
      showToast("评估失败: " + e.message);
    } finally {
      dedupState.evaluating = false;
      dedupState.abort = false;
      $("dedupBtnStart").disabled = false;
      $("dedupBtnStop").disabled = true;
    }
};

function dedupStop() {
    dedupState.abort = true;
    $("dedupBtnStop").disabled = true;
    $("dedupBtnStop").textContent = "停止中...";
    dedupLog("正在停止...");
    setTimeout(function () {
      if ($("dedupBtnStop")) $("dedupBtnStop").textContent = "停止";
    }, 1000);
};


// ── 筛选/导航 ──
function _dedupToggleFilter() {
    dedupState.filterDupOnly = !dedupState.filterDupOnly;
    dedupState.visibleKeys = [];
    renderGroups();
};

// ── 应用去重（下载 zip） ──
async function applyDedup() {
    if (dedupState.processing) return;

    // 直接从 groups + selected 构建 selected 条目列表，不依赖 entries.find
    var selected = [];
    Object.keys(dedupState.groups).forEach(function (key) {
      var group = dedupState.groups[key];
      group.forEach(function (e) {
        if (dedupState.selected.get(_entryId(e))) {
          selected.push(e);
        }
      });
    });

    if (selected.length === 0) {
      showToast("没有选择任何条目(" + Object.keys(dedupState.groups).length + "组)");
      return;
    }
    if (Object.keys(dedupState.fileContents).length === 0) {
      showToast("未找到文件内容，请重新上传");
      return;
    }

    try {
      dedupState.processing = true;
      dedupLog("正在生成去重结果，选中 " + selected.length + " 条...");
      var r = await fetch("/api/dedup/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selected: selected,
          file_contents: dedupState.fileContents,
        }),
      });
      if (!r.ok) {
        var err = await r.json().catch(function () { return { error: "HTTP " + r.status }; });
        showToast("应用失败: " + (err.error || "未知错误"));
        dedupLog("错误: " + (err.error || "未知错误"));
        return;
      }

      var blob = await r.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "dedup_result.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      var bakCount = r.headers.get("X-Bak-Count") || "0";
      dedupLog("已下载 dedup_result.zip（含 " + bakCount + " 个 .bak 备份文件）");
      showToast("已下载去重结果");
    } catch (e) {
      showToast("应用失败: " + e.message);
      dedupLog("异常: " + e.message);
    } finally {
      dedupState.processing = false;
    }
};

// ── 事件绑定 ──
// 递归遍历拖拽的目录结构（dataTransfer.files 不递归子目录）
async function _traverseEntry(entry, path, results) {
    if (entry.isFile) {
      return new Promise(function (resolve, reject) {
        entry.file(function (file) {
          file._relativePath = path ? path + "/" + file.name : file.name;
          results.push(file);
          resolve();
        }, function (err) {
          console.warn("读取文件失败:", path + "/" + entry.name, err);
          resolve();
        });
      });
    }
    if (entry.isDirectory) {
      var reader = entry.createReader();
      return new Promise(function (resolve, reject) {
        var entries = [];
        function readBatch() {
          reader.readEntries(function (batch) {
            if (batch.length === 0) { resolve(entries); return; }
            entries = entries.concat(Array.from(batch));
            readBatch();
          }, function (err) {
            console.warn("读取目录失败:", path + "/" + entry.name, err);
            resolve(entries);
          });
        }
        readBatch();
      }).then(function (subEntries) {
        var subPath = path ? path + "/" + entry.name : entry.name;
        return Promise.all(subEntries.map(function (se) {
          return _traverseEntry(se, subPath, results);
        }));
      });
    }
}

async function _getFilesFromDataTransferItems(items) {
    var results = [];
    var pending = [];
    for (var i = 0; i < items.length; i++) {
      var entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (entry) {
        pending.push(_traverseEntry(entry, "", results));
      } else {
        var file = items[i].getAsFile ? items[i].getAsFile() : null;
        if (file && file.name) {
          file._relativePath = file.name;
          results.push(file);
        }
      }
    }
    await Promise.all(pending);
    return results;
}

function setupUpload() {
    var dropZone = $("dedupDropZone");
    var fileInput = $("dedupFileInput");
    if (!dropZone || !fileInput) return;

    dropZone.addEventListener("dragover", function (e) { e.preventDefault(); dropZone.classList.add("drag-over"); });
    dropZone.addEventListener("dragleave", function () { dropZone.classList.remove("drag-over"); });
    dropZone.addEventListener("click", function (e) {
      if (e.target !== fileInput) {
        e.preventDefault();
        // 优先使用 showDirectoryPicker API（支持递归遍历子目录和特殊符号文件名）
        if (window.showDirectoryPicker) {
          pickDirectoryWithAPI();
        } else {
          fileInput.click();
        }
      }
    });
    dropZone.addEventListener("drop", async function (e) {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
      var files = [];
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        files = await _getFilesFromDataTransferItems(e.dataTransfer.items);
      }
      if (files.length === 0 && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        files = Array.from(e.dataTransfer.files);
      }
      if (files.length > 0) {
        handleFiles(files);
      }
    });
    fileInput.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    fileInput.addEventListener("change", function () {
      if (fileInput.files.length > 0) {
        // 统一补充 _relativePath，保持路径一致性
        var mapped = [];
        for (var fi = 0; fi < fileInput.files.length; fi++) {
          var f = fileInput.files[fi];
          f._relativePath = f.webkitRelativePath || f.name;
          mapped.push(f);
        }
        handleFiles(mapped);
        fileInput.value = "";
      }
    });

    // ── showDirectoryPicker API（Chrome 86+） ──
    async function pickDirectoryWithAPI() {
      try {
        var dirHandle = await window.showDirectoryPicker();
        var files = await getFilesFromDirectoryHandle(dirHandle);
        if (files.length > 0) {
          handleFiles(files);
        } else {
          showToast("未找到 .txt 文件");
        }
      } catch (err) {
        if (err.name !== "AbortError" && err.name !== "SecurityError") {
          console.warn("showDirectoryPicker 失败，回退到 fileInput", err);
          fileInput.click();
        }
      }
    }

    // ── 递归读取目录句柄（File System Access API） ──
    async function getFilesFromDirectoryHandle(dirHandle, path) {
      if (!path) path = "";
      var result = [];
      // 注意：for await...of 在 Chrome 中目录迭代器可用
      for await (var entry of dirHandle.values()) {
        var entryPath = path ? path + "/" + entry.name : entry.name;
        if (entry.kind === "file") {
          if (entry.name.toLowerCase().endsWith(".txt")) {
            var file = await entry.getFile();
            file._relativePath = entryPath;
            result.push(file);
          }
        } else if (entry.kind === "directory") {
          var subFiles = await getFilesFromDirectoryHandle(entry, entryPath);
          result.push.apply(result, subFiles);
        }
      }
      return result;
    }
}

function setupParams() {
    loadDedupParams();
}

async function init() {
    setupUpload();
    await dbReady;
    setupParams();
    // 日志区准备就绪（初始隐藏）
    var la = $("dedupLogArea");
    if (la) la.style.display = "none";
    renderGroups();

    // ── 事件绑定 ──
    var groups = $("dedupGroups");
    if (groups) {
      groups.addEventListener("click", function(e) {
        var row = e.target.closest(".dedup-row[data-action='select-row']");
        if (row) {
          _dedupSelect(parseInt(row.dataset.group), parseInt(row.dataset.idx));
          return;
        }
        var header = e.target.closest(".dedup-group-header[data-action='toggle-group']");
        if (header) toggleDedupGroup(header);
      });
    }

    var _bind = function(id, fn) { var el = $(id); if (el) el.addEventListener("click", fn); };
    _bind("dedupBtnStart", dedupStart);
    _bind("dedupBtnStop", dedupStop);
    _bind("dedupApplyBtn", applyDedup);
    _bind("dedupFilterBtn", _dedupToggleFilter);
    _bind("dedupStrategyToggle", toggleDedupStrategy);
    _bind("dedupStrategyReset", resetDedupStrategy);

    var _bindChange = function(id, fn) { var el = $(id); if (el) el.addEventListener("blur", fn); };
    _bindChange("dedupTemperature", saveDedupParams);
    _bindChange("dedupTopP", saveDedupParams);
    _bindChange("dedupMaxTokens", saveDedupParams);

    _bindChange("dedupConcurrency", saveDedupParams);

    // 双击 label 恢复默认值
    var dedupParamRow = document.querySelector('#page-dedup .param-row');
    if (dedupParamRow) {
      dedupParamRow.querySelectorAll('label').forEach(function(label) {
        var input = label.nextElementSibling;
        if (input && input.type === 'number') {
          label.addEventListener('dblclick', function() {
            resetInputDefault(input, saveDedupParams);
          });
          label.style.cursor = 'pointer';
        }
      });
    }
    // 去重页并发数：双击 span 恢复默认
    var dedupConcurrencyEl = document.getElementById('dedupConcurrency');
    if (dedupConcurrencyEl) {
      var concLabel = dedupConcurrencyEl.previousElementSibling;
      if (concLabel && concLabel.tagName === 'SPAN') {
        concLabel.addEventListener('dblclick', function() {
          resetInputDefault(dedupConcurrencyEl, saveDedupParams);
        });
      }
    }
}


// ── Module exports ──
var dedupInit = init;
export { dedupInit };
