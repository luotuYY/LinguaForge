# AGENTS.md

## 项目概览

LinguaForge 是游戏本地化翻译工具，支持翻译/润色 + 分词/标签分类 + 去重。
Flask 后端（app.py）+ 原生 JS ES Modules 前端（SPA），NDJSON 流式响应。

## 前端模块化要求

LinguaForge 前端采用纯 ES 模块架构：

- 所有 JS 文件位于 `static/js/`，通过 `main.js` 作为唯一入口点按依赖顺序导入。
- 每个模块通过 `export { ... }` 显式声明对外接口，通过 `import { ... }` from './xxx.js' 声明依赖。
- **禁止** `window.xxx` 绑定和 HTML `onclick`/`oninput`/`onchange` 等内联事件属性。
- 所有 DOM 事件通过 `addEventListener` 或事件委托（`data-action` + `closest('[data-action]')`）绑定。
- 依赖图（无循环依赖）：
  ```
  db  particles  utils
        ↑        ↑
       state ←─── app (renderCallbacks)
      ↑     ↑
    render  tag / dedup
      ↑
     api
      ↑
     app  →  main.js
  ```

### 模块职责

| 模块 | 职责 |
|---|---|
| `db.js` | IndexedDB 持久化层，内存缓存 + 异步写入，启动时自动迁移 localStorage |
| `utils.js` | DOM 选择器、HTML 转义、搜索高亮、剪贴板、自然排序、Toast、Confirm/Tooltip |
| `state.js` | 全局状态、LLM 参数、API 配置、Provider 切换、提示词模板 CRUD、渲染回调注册 |
| `render.js` | 预览列表 + 对比表格 DOM 渲染、搜索 UI、增量更新 |
| `api.js` | 文件上传/解析、单条/批量翻译（NDJSON 流式）、文件列表管理 |
| `app.js` | 事件编排、SPA 路由、翻译控制、导出、网格拖拽、行内编辑 |
| `tag.js` | 分词页：LLM 分类、卡片拖拽、标签管理、导入翻译页 |
| `dedup.js` | 去重页：重复组检测、LLM 评估、应用去重（zip 下载） |
| `particles.js` | 粒子特效，页面不可见时暂停 |

### 规则

- **禁止** `window.xxx = xxx` 绑定。所有函数通过 ES 模块 `export`/`import` 通信。
- **禁止** HTML 内联事件属性（`onclick`、`oninput`、`onchange`、`ondblclick`、`onblur` 等）。
- 事件绑定方式：
  - 静态元素：在初始化函数中使用 `addEventListener`
  - 动态生成内容：使用事件委托 + `data-action` 属性
- **所有模块统一标准**：tag.js、dedup.js 与其他模块一样使用 `import`/`export`，不存在例外。

## 持久化

数据持久化使用 IndexedDB（`db.js`），内存缓存 + 异步写入。`dbGet` 同步读缓存，`dbSet` 异步持久化。启动时自动从 localStorage 迁移旧数据。

localStorage key 以 `tllmh_` 前缀命名，保持向后兼容。

## 后端

- `app.py`：Flask 后端，15 个 API 端点（翻译 8 + 分词 3 + 去重 3 + 通用 1）
- `ThreadPoolExecutor` 并发 + `requests.Session` 连接复用
- `threading.local()` 每线程独立 Session
- NDJSON 流式响应：`_stream_batch_response()` / `_stream_batch_response_dedup()` + `queue.Queue` 桥接线程→Generator
- 文件大小限制：单次请求 20MB（`MAX_CONTENT_LENGTH` 50MB）
- 支持任何 `/v1/chat/completions` 端点的 LLM（本地或商业 API）

## PowerShell + Python 代码生成注意事项

- **禁止 PowerShell 内联 Python 处理中文/Unicode 文件**。python -c "..." 和 @'...'@ | python 在 PowerShell 中通过管道传递时使用 GBK 控制台编码，会损坏非 ASCII 字符。替代方案：
  - 用 [System.IO.File]::WriteAllText(path, , [System.Text.UTF8Encoding]::new(False)) 先把 Python 脚本写入磁盘，再 python script.py 执行。
  - 或用 $env:PYTHONIOENCODING='utf-8'; python -c "..."。
- **在 Python 中生成 JS 代码时避免普通字符串的转义损耗**。\' 在 Python 普通字符串（非 raw）中会变成 '（丢失反斜杠）。JS 中需要字面 \'（反斜杠+引号）的场景，用 chr(92) + chr(39) 拼接，或用 Python 原始字符串 '''...'''。
- **每次修改 JS 文件后立即运行 `node --check file.js`** 验证语法，避免累积多层错误。
- **apply_patch 工具有严格的 @@ 上下文格式要求**，不适合大段多行替换。复杂替换优先用文件读写 + 字符串操作。
- **操作前后用 `git checkout -- file` 快速回退**。当脚本部分执行成功但写入失败时，文件可能处于半修改状态，直接回退比修复更高效。

## Git 工作流

远程仓库：`https://github.com/luotuYY/LinguaForge`
推送：Token 已配置在 git remote URL 中，直接 `git push origin main` 即可。

```bash
# 开发完成后提交推送
cd LinguaForge
git add -A
git commit -m "描述"
git push origin main

# 拉取远程更新
git pull origin main
```

### ⚠️ 自动提交规则

**每次对项目文件有修改（代码、配置、文档等），必须立即执行：**

```bash
cd LinguaForge
git add -A
git commit -m "简要描述修改内容"
git push origin main
```

- 不要等用户提醒，改完就推
- commit message 要简洁明了，说明改了什么
- 如果是修 bug，注明修复了什么问题
- 如果是新功能，注明功能名称
