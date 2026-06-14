# TxtLlmHub

本地 LLM + 商业 API 双模文本翻译/润色工具。上传 `原文=旧译文` 格式的 txt 文件，逐行翻译或润色，预览、对比、导出一站完成。

## 项目结构

```
TxtLlmHub/
├── app.py              # Flask 后端（API 路由 + LLM 调用，线程安全）
├── requirements.txt    # Python 依赖
├── start.bat           # Windows 一键启动脚本
├── static/
│   ├── index.html      # 单页前端（四格仪表盘 + 本地/商业切换）
│   ├── uta.jpg         # 背景图片
│   └── js/
│       └── particles.js # 粒子特效
├── 商业api对接方法.md   # 商业API 对接参考文档
└── README.md
```

## 功能

| 模块 | 说明 |
|---|---|
| **本地/商业双模** | 工具栏一键切换，默认本地 LLM，不自动切换 |
| 文件上传 | 拖拽或点击上传 `.txt`，可多选。自动解析 `原文=旧译文` 格式 |
| 手动输入 | 文本框中粘贴 `原文=译文`，点击「添加」追加或「加载」替换 |
| 源文本预览 | 展示前 200 行，原文与旧译文并排。悬停浮现「译」按钮单行翻译 |
| 预览栏勾选翻译 | 每条右侧复选框 + 顶部全选框，勾选后批量并发翻译 |
| LLM 翻译 | 直译 / 润色双模式，支持单行、全量、勾选批量翻译，并发可调 1–10 |
| 翻译对比 | 原文 / 旧译文 / 新译文三列对照。原文列点击复制，新译文列点击行内编辑 |
| 排序 | ▼ 按钮循环：默认顺序 → 按原文自然排序 → 按新译文自然排序 |
| 导出 | 单文件直接导出；多文件选分别导出或合并导出（带 `# === 文件名 ===` 分组头） |
| 复制/删除选中 | 对比表勾选多行后批量复制（原文=译文格式）或删除 |
| System Prompt 管理 | 保存多组 Prompt 模板，一键切换，直译/润色各自独立记忆参数 |
| **商业 API 支持** | 折叠面板配置：API Base URL / Key / Model；支持关闭思考推理模式 |
| **连接复用** | 线程本地 `requests.Session` 保活，降低 TCP 握手开销 |

## 前置条件

- **本地模式**：已启动 OpenAI Chat Completions 兼容的 LLM 服务（llama.cpp / Ollama / vLLM 等）
- **商业模式**：有效的商业 API Key（DeepSeek / 通义千问 / 智谱 等）
- Python 3.9+

## 快速开始

### 一键启动（Windows）

双击 `start.bat`，自动检测 Python、安装依赖并启动服务，浏览器自动打开。

### 手动启动

```bash
# 1. 启动本地 LLM 服务（以 llama.cpp 为例）
./server -m /path/to/model.gguf --host 127.0.0.1 --port 8080

# 2. 安装依赖
pip install -r requirements.txt

# 3. 启动
python app.py
```

浏览器打开 http://127.0.0.1:5000，工具栏指示灯变绿即 LLM 已连接。

### 切换商业 API

1. 点击工具栏 **「商业API」** 按钮切换模式
2. 展开翻译卡内的 **⚙️ API 配置（商业模型）** 面板
3. 填写 API Base URL、API Key、Model Name
4. 点击 **测试连接** 验证
5. 默认关闭思考推理（提速），需要时勾选「启用思考/推理」

## 配置

### 环境变量

```bash
# Windows PowerShell
$env:LLM_API_URL="http://127.0.0.1:11434/v1/chat/completions"
$env:LLM_MODEL="qwen2.5:7b"
$env:LLM_API_KEY="sk-your-api-key"
python app.py
```

### app.py 默认值

```python
LLM_API_URL = "http://127.0.0.1:8080/v1/chat/completions"
LLM_MODEL = "local-model"
LLM_TIMEOUT = 120          # 单次请求超时秒数
DEFAULT_CONCURRENCY = 5    # 默认并发数
```

| 环境变量 | 说明 |
|---|---|
| `LLM_API_URL` | 本地 LLM 服务地址 |
| `LLM_MODEL` | 本地模型名称 |
| `LLM_API_KEY` | API Key（商业模式下也可在 UI 中填写） |

### 前端本地持久化（localStorage）

| 键 | 说明 |
|---|---|
| `tllmh_provider` | 当前模式：`local` / `commercial` |
| `tllmh_mode` | 翻译模式：`direct` / `polish` |
| `tllmh_params_direct` | 直译模式的 temperature / top_p / max_tokens 等 |
| `tllmh_params_polish` | 润色模式的参数 |
| `tllmh_api_config` | 商业 API 配置（含 enable_thinking） |
| `tllmh_prompts_direct` | 直译模式保存的 Prompt 模板 |
| `tllmh_prompts_polish` | 润色模式保存的 Prompt 模板 |

## 支持的 LLM 部署

任何提供 `/v1/chat/completions` 端点的服务均可对接：

| 框架 | 启动示例 | 默认地址 |
|---|---|---|
| llama.cpp | `./server -m model.gguf --host 127.0.0.1 --port 8080` | `http://127.0.0.1:8080/v1/chat/completions` |
| Ollama | `ollama serve` | `http://127.0.0.1:11434/v1/chat/completions` |
| vLLM | `python -m vllm.entrypoints.openai.api_server --model /path --port 8080` | `http://127.0.0.1:8080/v1/chat/completions` |
| LocalAI | 默认兼容 OpenAI API | `http://127.0.0.1:8080/v1/chat/completions` |

> Ollama 模型名需完整标识如 `qwen2.5:7b`；llama.cpp 名称可自定义。

### 商业 API 示例

| 服务商 | API Base URL | 模型名 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat` |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen-plus` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4-flash` |
| 月之暗面 | `https://api.moonshot.cn/v1/chat/completions` | `moonshot-v1-8k` |

> 使用 `deepseek-chat` 而非 `deepseek-reasoner` 可避免推理 token 耗时，显著提速。

## 文件格式

输入 txt 每行一条，`=` 左侧为原文，右侧为旧译文：

```
Clothes overlays=衣服贴图
Skin/eye overlays=皮肤/眼睛贴图
Face Bonemod=面部骨骼
ON=打开
OFF=关闭
```

- 无 `=` 的行视为纯原文（旧译文为空）
- 空行自动跳过
- 优先 UTF-8，失败时回退 GBK

## 翻译模式

### 直译模式
直接调用 LLM 翻译原文。适用于从零开始翻译的场景。

### 润色模式
两步流程：
1. 直译：获取基础译文
2. 糅合：将直译结果与旧译文一同发送给 LLM，融合优点输出最终译文

适用于已有旧版译文（如旧版汉化），希望用新模型优化质量。

## 排序功能

对比表工具栏 ▼ 按钮三态循环：

| 状态 | 说明 |
|---|---|
| ▼ | 保持原始上传顺序（默认） |
| ▼A | 按原文列自然排序 |
| ▼N | 按新译文列自然排序 |

自然排序正确处理数字序列（1, 2, 10 而非 1, 10, 2），中文按 zh-CN locale 拼音排序。

## 导出说明

多文件导出时弹窗选择：
- **分别导出**：每个源文件单独生成 `.retranslated.txt`
- **合并导出**：合并为一个文件，用 `# === 文件名 ===` 区分来源

导出格式为 `原文=新译文`，仅包含已完成翻译的行。

## 行内编辑

点击对比表「新译文」列即可编辑：
- 文本区自动适应内容高度
- `Enter` 提交，`Escape` 取消
- 失焦自动保存
- 支持手动拖拽调整高度（`resize: vertical`）

## 提速建议

| 措施 | 效果 |
|---|---|
| 关闭思考推理 | 商业 API 面板取消勾选「启用思考」（默认关闭） |
| 使用非推理模型 | `deepseek-chat` 比 `deepseek-reasoner` 快数倍 |
| 降低 max_tokens | 512 → 256 对短文本翻译足够 |
| 提高并发数 | 5 → 8–10（取决于 LLM 服务能力） |
| 连接复用 | `_get_session()` 线程本地 Session 保持 HTTP Keep-Alive |

> 连接复用操作在 TCP 层面，不会向 LLM 上下文窗口堆积任何内容，互不影响。

## API 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 前端页面 |
| `/api/upload` | POST | 上传 txt（multipart/form-data） |
| `/api/manual-input` | POST | 手动输入解析 `{"text":"原文=译文\n..."}` |
| `/api/translate` | POST | 直译单条 `{"text":"原文", ...params, ...api_config}` |
| `/api/translate-polish` | POST | 润色单条 `{"text":"原文", "old_translation":"旧译文", ...}` |
| `/api/translate-batch` | POST | 批量直译 `{"items":[...], "concurrency":5, ...}` |
| `/api/translate-batch-polish` | POST | 批量润色 |
| `/api/check-llm` | GET / POST | 检测 LLM 连通性。POST 支持动态 API 配置 |
| `/api/config` | GET | 返回当前配置和默认参数 |

### 请求体额外字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `api_base` | string | 动态覆盖 API 地址 |
| `api_key` | string | API Key（Bearer 认证） |
| `model` | string | 动态覆盖模型名 |
| `enable_thinking` | boolean | 启用思考/推理模式（默认不传） |
| `provider` | string | 前端标记：`local` / `commercial` |

## 并发说明

- 前端默认并发数 5，可调范围 1–10
- 批量翻译通过 `ThreadPoolExecutor` 并行调用 LLM
- **线程安全**：每个工作线程独立持有 `requests.Session`，避免竞态
- 空原文行自动跳过
- 停止按钮在分块边界响应，及时中断

## 常见问题

**Q: 顶栏显示"本地 LLM 未连接"？**
A: 确认已切换到正确的模式（本地/商业），检查 LLM 服务是否启动且端口匹配。Ollama 默认端口为 11434。

**Q: 翻译结果为空或报"响应格式异常"？**
A: 检查模型名是否与 LLM 服务中一致。Ollama 需完整标识如 `qwen2.5:7b`。商业 API 需确认 Base URL 和 Key 正确。

**Q: 翻译很慢？**
A: 调高并发数到 5–8；使用非推理模型；降低 max_tokens；关闭思考推理模式。

**Q: 某行翻译失败会怎样？**
A: 失败行在对比表中标记红色错误状态，可通过「重试失败行」或逐行「重译」修复。批量翻译中的失败不影响其他行。

**Q: 如何切换翻译模式？**
A: 翻译操作区有「直译」/「润色」切换按钮。两种模式的 System Prompt 和参数独立保存。
商业API 润色模式需两步调用，消耗 2 倍 token。

**Q: 上传文件编码问题？**
A: 优先 UTF-8 解码，失败时自动回退 GBK。手动输入区域自动统一 `\r\n` 和 `\r` 为 `\n`。

**Q: 本地模式会受商业 API 功能影响吗？**
A: 不会。本地 LLM 的调用路径完全独立，新增的商业 API 功能（enable_thinking、provider 字段等）在本地模式下不产生额外开销。连接复用反而略微提速。

## 技术说明

- 前端原生 JavaScript，零构建工具，零依赖
- 粒子特效使用 particles.js
- 后端线程安全的 `threading.local()` Session 管理
- Flask 开发模式自动重载（`debug=True`）
- 配置通过 `localStorage` 持久化，按翻译模式分别存储
