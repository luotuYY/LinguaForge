/**
 * TxtLlmHub — 工具函数
 * DOM 选择、HTML 转义、搜索高亮、剪贴板、自然排序
 * 无状态依赖，可最先加载
 */

/** Shorthand DOM selector */
const $ = id => document.getElementById(id);

/** Escape HTML special characters */
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Escape regex special characters for literal matching */
function escRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Search Highlight ──
let highlightRegex = null;
function setHighlight(q) {
  highlightRegex = q ? new RegExp(escRegex(q), 'gi') : null;
}
function hl(text) {
  if (!highlightRegex || !text) return escHtml(text);
  return escHtml(text).replace(highlightRegex, m => '<mark>' + m + '</mark>');
}
function matches(text, q) {
  if (!q) return true;
  return text.toLowerCase().includes(q.toLowerCase());
}

// ── Clipboard ──
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  showToast('已复制: ' + text.substring(0, 40));
}

// ── Natural Sort ──
function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g;
  const aa = String(a).match(re) || [];
  const bb = String(b).match(re) || [];
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const ap = aa[i] || '';
    const bp = bb[i] || '';
    if (ap !== bp) {
      const an = parseInt(ap, 10);
      const bn = parseInt(bp, 10);
      if (!isNaN(an) && !isNaN(bn)) return an - bn;
      const cmp = ap.localeCompare(bp, 'zh-CN', { numeric: true, sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

// ── Toast Notification ──
let toastTimer = 0;
function showToast(msg) {
  const toast = $('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2500);
}

// ── Activity Log ──
function log(msg, cls, prepend) {
  const logArea = $('logArea');
  if (!logArea) return;
  logArea.classList.add('visible');
  const now = new Date();
  const ts = now.getHours().toString().padStart(2, '0') + ':' +
             now.getMinutes().toString().padStart(2, '0') + ':' +
             now.getSeconds().toString().padStart(2, '0');
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = '<span class="ts">' + ts + '</span><span class="' + (cls || '') + '">' + escHtml(msg) + '</span>';
  if (prepend) {
    logArea.insertBefore(line, logArea.firstChild);
  } else {
    logArea.appendChild(line);
    while (logArea.children.length > 200) { logArea.removeChild(logArea.firstChild); }
    logArea.scrollTop = logArea.scrollHeight;
  }
}
function clearLog() {
  const logArea = $('logArea');
  if (!logArea) return;
  logArea.innerHTML = '';
  logArea.classList.remove('visible');
}

// ── Custom Confirm Modal (replaces native confirm) ──
function showConfirm(msg) {
  return new Promise(function (resolve) {
    window._showConfirmActive = true;
    $('confirmMsg').textContent = msg;
    var modal = $('confirmModal');
    modal.style.display = 'flex';
    function cleanup(result) {
      modal.style.display = 'none';
      window._showConfirmActive = false;
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
      if (e.key === 'Enter')  { e.preventDefault(); cleanup(true); }
    }
    document.addEventListener('keydown', onKey);
    $('confirmOk').onclick = function () { cleanup(true); };
    $('confirmCancel').onclick = function () { cleanup(false); };
    setTimeout(function () { $('confirmOk').focus(); }, 50);
  });
}

// ── Custom Tooltip ──
(function () {
  var tip = document.createElement('div');
  tip.id = 'custom-tooltip';
  document.body.appendChild(tip);

  var currentEl = null;

  function onLeave() {
    if (currentEl) {
      currentEl.setAttribute('title', currentEl.getAttribute('data-original-title') || '');
      currentEl.removeAttribute('data-original-title');
      currentEl.removeEventListener('mouseleave', onLeave);
      currentEl = null;
    }
    tip.style.display = 'none';
  }

  function show(el, e) {
    if (currentEl === el) return;
    onLeave();
    currentEl = el;
    el.setAttribute('data-original-title', el.getAttribute('title') || '');
    el.removeAttribute('title');
    el.addEventListener('mouseleave', onLeave);
    tip.textContent = el.getAttribute('data-original-title');
    tip.style.display = 'block';
    position(e);
  }

  function position(e) {
    var x = e.clientX + 12;
    var y = e.clientY + 12;
    requestAnimationFrame(function () {
      var tw = tip.offsetWidth;
      var th = tip.offsetHeight;
      if (x + tw > window.innerWidth - 8) x = e.clientX - tw - 8;
      if (y + th > window.innerHeight - 8) y = e.clientY - th - 8;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    });
  }

  document.addEventListener('mouseover', function (e) {
    var el = e.target.closest('[title], [data-tooltip]');
    if (!el) { onLeave(); return; }
    if (el.hasAttribute('data-tooltip')) {
      // 使用 data-tooltip（避免与原生 title 冲突）
      if (currentEl === el) return;
      onLeave();
      currentEl = el;
      el.addEventListener('mouseleave', onLeave);
      tip.textContent = el.getAttribute('data-tooltip');
      tip.style.display = 'block';
      position(e);
      return;
    }
    show(el, e);
  });

  document.addEventListener('mousemove', function (e) {
    if (currentEl) position(e);
  });
})();
