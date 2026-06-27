/**
 * LinguaForge — IndexedDB 持久化层
 * 内存缓存 + IndexedDB 异步持久化，启动时自动迁移 localStorage
 * 无模块依赖，可最先加载
 */

var DB_NAME = 'LinguaForgeDB';
var DB_VERSION = 1;
var STORE_NAME = 'kv';

var _db = null;
var _cache = {};

// ── IndexedDB 打开（含建表） ──
function _openDB() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = function (e) { resolve(e.target.result); };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

// ── 从 IndexedDB 加载全部到内存缓存 ──
function _loadAllFromDB() {
  return new Promise(function (resolve, reject) {
    var tx = _db.transaction(STORE_NAME, 'readonly');
    var store = tx.objectStore(STORE_NAME);
    var req = store.openCursor();
    req.onsuccess = function (e) {
      var cursor = e.target.result;
      if (cursor) {
        _cache[cursor.key] = cursor.value;
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = function (e) { reject(e.target.error); };
  });
}

// ── localStorage → IndexedDB 一次性迁移 ──
var MIGRATE_KEYS = [
  // state.js
  'tllmh_params_v2',
  'tllmh_params_direct',
  'tllmh_params_polish',
  'tllmh_mode',
  'tllmh_provider',
  'tllmh_api_config',
  'tllmh_polish_step2',
  'tllmh_prompts_direct',
  'tllmh_prompts_polish',
  // tag.js
  'tllmh_tag_schema',
  'tllmh_sub_pool',
  'tllmh_tag_strategy',
  // dedup.js
  'tllmh_dedup_params',
];

function _migrateFromLocalStorage() {
  var migrated = 0;
  for (var i = 0; i < MIGRATE_KEYS.length; i++) {
    var key = MIGRATE_KEYS[i];
    if (_cache.hasOwnProperty(key)) continue; // IndexedDB 已有，跳过
    var raw = localStorage.getItem(key);
    if (raw === null) continue;
    try {
      _cache[key] = JSON.parse(raw);
    } catch (e) {
      _cache[key] = raw;
    }
    migrated++;
  }
  if (migrated === 0) return Promise.resolve();
  // 批量写入 IndexedDB
  return new Promise(function (resolve, reject) {
    var tx = _db.transaction(STORE_NAME, 'readwrite');
    var store = tx.objectStore(STORE_NAME);
    for (var j = 0; j < MIGRATE_KEYS.length; j++) {
      var k = MIGRATE_KEYS[j];
      if (_cache.hasOwnProperty(k)) {
        store.put(_cache[k], k);
      }
    }
    tx.oncomplete = function () {
      resolve();
    };
    tx.onerror = function (e) { reject(e.target.error); };
  });
}

// ── 初始化 Promise（模块加载时自动执行） ──
var dbReady = _openDB()
  .then(function (db) {
    _db = db;
    return _loadAllFromDB();
  })
  .then(function () {
    return _migrateFromLocalStorage();
  })
  .then(function () {
  })
  .catch(function (err) {
    console.error('[db] IndexedDB 初始化失败，回退到 localStorage:', err);
    // 回退：从 localStorage 加载全部到缓存
    for (var i = 0; i < MIGRATE_KEYS.length; i++) {
      var key = MIGRATE_KEYS[i];
      var raw = localStorage.getItem(key);
      if (raw !== null) {
        try { _cache[key] = JSON.parse(raw); } catch (e) { _cache[key] = raw; }
      }
    }
    _db = null;
  });

// ── 同步读取（从内存缓存） ──
function dbGet(key, defaultValue) {
  if (_cache.hasOwnProperty(key)) return _cache[key];
  return defaultValue !== undefined ? defaultValue : null;
}

// ── 写入（内存缓存 + 异步持久化到 IndexedDB） ──
function dbSet(key, value) {
  _cache[key] = value;
  if (!_db) return;
  try {
    var tx = _db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
  } catch (e) {
    console.warn('[db] 写入失败:', key, e);
  }
}

// ── 仅写入内存缓存（不持久化，用于预览等临时场景） ──
function dbSetCache(key, value) {
  _cache[key] = value;
}

// ── 删除 ──
function dbDel(key) {
  delete _cache[key];
  if (!_db) return;
  try {
    var tx = _db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
  } catch (e) {
    console.warn('[db] 删除失败:', key, e);
  }
}

// ── 判断 key 是否存在 ──
function dbHas(key) {
  return _cache.hasOwnProperty(key);
}

// ── Module exports ──
export { dbReady, dbGet, dbSet, dbSetCache, dbDel, dbHas };

// ── Window bindings ──
