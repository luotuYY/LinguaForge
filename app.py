"""TxtLlmHub — Flask 后端
文件上传解析、LLM API 调用、批量流式翻译/润色/分词
"""
import os
import json
import requests
import re
import threading
import queue
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context

app = Flask(__name__, static_folder="static", static_url_path="")
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024  # 50MB 文件上传限制

# ── LLM API 配置 ──
LLM_API_URL = os.environ.get("LLM_API_URL", "http://127.0.0.1:8080/v1/chat/completions")
LLM_MODEL = os.environ.get("LLM_MODEL", "local-model")
LLM_TIMEOUT = 120
_thread_local = threading.local()

def _get_session():
    """Get a thread-local requests.Session for connection reuse."""
    if not hasattr(_thread_local, "session"):
        _thread_local.session = requests.Session()
    return _thread_local.session


def _close_session():
    """Close thread-local session if exists."""
    if hasattr(_thread_local, "session"):
        _thread_local.session.close()
        del _thread_local.session


DEFAULT_CONCURRENCY = 5


# ── 分类策略（分词页 system prompt 的角色指令，可由前端自定义） ──
DEFAULT_TAG_STRATEGY = "你是一个游戏文本分类专家。请将以下文本归入最合适的类别。"
# ── 默认翻译参数（前端可通过 system_prompt 覆盖） ──
DEFAULT_PARAMS = {
    "temperature": 0.7,
    "top_p": 0.6,
    "max_tokens": 1024,
    "repetition_penalty": 1.05,
    "system_prompt": (
        "你是一个游戏本地化翻译专家。请将以下文本翻译为中文。\n"
        "处理规则：\n"
        "- 游戏术语必须翻译为中文（Attack Power→攻击力，Inventory→物品栏），译名以业界通行中文为准。\n"
        "- 含日文假名 → 直接翻译，严禁臆测或解读为代号。\n"
        "- 纯代码键名(del/get/set等) → 保持原文不变。\n"
        "- 占位符（{0}、%s）、快捷键（&键）、换行和特殊符号 → 原样保留。\n"
        "- 对话/叙事/台词 → 自然流畅，贴合角色语气，允许意译。\n"
        "- 混合文本 → 术语优先，口语化串联。\n"
        "保留原文全部格式。只输出译文，不要额外解释。"
    ),
}

# 润色 Step1：直译底稿提示词
POLISH_DIRECT_PROMPT = (
    "你是一个专业游戏翻译初稿专家。请对以下文本逐句直译，同时为每句打上类型标签。\n"
    "判断标准：\n"
    "- [UI]：按钮、菜单、系统提示、Mod说明、属性列表、含占位符/快捷键的文本。\n"
    "- [DIALOGUE]：角色对白、剧情叙述、含情绪和语气的文本。\n"
    "翻译要求：\n"
    "- [UI]句：结构对齐的忠实直译，术语必须翻译为中文，仅保留占位符和特殊符号原样不动。\n"
    "- [DIALOGUE]句：意思准确的通顺中文，允许微调语序。\n"
    "输出格式（必须严格带标签）：\n"
    "[标签] 中文底稿\n"
    "只输出带标签的译文，不要额外解释。"
)

# 润色 Step2：对比糅合提示词
POLISH_PROMPT = (
    "你是一个资深游戏本地化校对专家。"
    "你将收到带标签的【直译新译文】和【旧译文】。请根据标签分别处理：\n"
    ""
    "【UI 模式】\n"
    "- 所有文本必须为中文，不得出现英文术语。\n"
    "- 术语以直译新译文为准，旧译文有误则修正。\n"
    "- 极致精简，长度不超过原文。\n"
    "- 可微调使其通顺，但绝不意译。\n"
    ""
    "【DIALOGUE 模式】\n"
    "- 目标是写出地道的中文对白，完全摆脱翻译腔。\n"
    "- 继承直译的准确语义和情绪，但可彻底重写结构。\n"
    "- 吸收旧译文的口语化优点，进行创造性润色。\n"
    ""
    "输出时去掉所有标签，只输出最终的纯译文文本。"
)

# ── 润色模式默认参数 ──
POLISH_DEFAULT_PARAMS = {
    "temperature": 0.7,
    "top_p": 0.6,
    "max_tokens": 1024,
    "repetition_penalty": 1.05,
    "system_prompt": POLISH_DIRECT_PROMPT,
}


def _build_api_headers(api_config: dict = None) -> dict:
    """根据 api_config 构建请求头，包含 API Key 认证"""
    headers = {"Content-Type": "application/json"}
    api_key = (api_config or {}).get("api_key") or os.environ.get("LLM_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _is_nontranslatable(text: str) -> bool:
    """判断文本是否为纯符号/分隔线等无需翻译的内容
    使用 unicodedata.category 检测任意 Unicode 文字（覆盖所有脚本）"""
    import unicodedata
    return not any(unicodedata.category(ch).startswith("L") for ch in text)


def _call_llm(text: str, overrides: dict = None, api_config: dict = None) -> dict:
    """
    调用 LLM API
    - overrides: 翻译参数（temperature, system_prompt…）
    - api_config: {'api_base': '...', 'api_key': '...', 'model': '...'}
    """
    if _is_nontranslatable(text):
        return {"translation": text}
    params = {**DEFAULT_PARAMS, **(overrides or {})}
    # API 地址/模型：优先前端传入，回退到环境变量
    base_url = (api_config or {}).get("api_base") or LLM_API_URL
    model = (api_config or {}).get("model") or LLM_MODEL

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": params["system_prompt"]},
            {"role": "user", "content": text},
        ],
        "temperature": params["temperature"],
        "top_p": params["top_p"],
        "max_tokens": params["max_tokens"],
        "repetition_penalty": params["repetition_penalty"],
        "stream": False,
    }
    # 思考模式控制
    enable_thinking = (api_config or {}).get("enable_thinking")
    if enable_thinking is False:
        payload["thinking"] = {"type": "disabled"}
    try:
        resp = _get_session().post(
            base_url,
            json=payload,
            timeout=LLM_TIMEOUT,
            headers=_build_api_headers(api_config),
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("choices") or not data["choices"][0].get("message"):
            return {"translation": "", "error": "LLM 响应缺少 choices 或 message 字段"}
        translation = _strip_tags(data["choices"][0]["message"]["content"].strip())
        result = {"translation": translation}
        if data["choices"][0].get("finish_reason") == "length":
            result["truncated"] = True
        return result
    except requests.exceptions.ConnectionError:
        return {"translation": "", "error": "LLM 服务未启动或无法连接"}
    except requests.exceptions.Timeout:
        return {"translation": "", "error": "LLM 请求超时"}
    except (KeyError, IndexError):
        return {"translation": "", "error": "LLM 响应格式异常，请检查模型配置"}
    except Exception as e:
        return {"translation": "", "error": str(e)}


def _strip_tags(text: str) -> str:
    """清理 LLM 输出中残留的标签和指令回显"""
    # 清理行首类型标签（[UI]/[DIALOGUE]/【UI模式】等）
    text = re.sub(
        r"^\[(?:UI|DIALOGUE)\]\s+(?=\S)|^【(?:UI模式|对白模式)】\s*(?=\S)",
        "",
        text,
        flags=re.MULTILINE,
    )
    return text

def _call_llm_polish(text: str, old_translation: str, overrides: dict = None, api_config: dict = None) -> dict:
    """润色模式：先直译，再与旧译文对比糅合，返回 {translation, error?}"""
    # 纯符号/分隔线跳过翻译
    if _is_nontranslatable(text):
        return {"translation": text}
    # 无旧译文时降级为直译（无法糅合）
    if not old_translation or not old_translation.strip():
        result = _call_llm(text, overrides, api_config)
        if result.get("translation"):
            result["translation"] = _strip_tags(result["translation"])
        result["degraded"] = True  # 标记为降级：无旧译文，跳过润色糅合
        return result
    # Step1：直译底稿
    polish_overrides = {**(overrides or {}), "system_prompt": (overrides or {}).get("system_prompt") or POLISH_DIRECT_PROMPT}
    direct_result = _call_llm(text, polish_overrides, api_config)
    if direct_result.get("error") or not direct_result.get("translation"):
        return direct_result

    # 保留 [UI]/[DIALOGUE] 标签传给 Step2，不剥离
    raw = direct_result["translation"]

    # Step2：与旧译文对比糅合
    base_url = (api_config or {}).get("api_base") or LLM_API_URL
    model = (api_config or {}).get("model") or LLM_MODEL

    polish_payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": (overrides or {}).get("polish_prompt", POLISH_PROMPT) if overrides else POLISH_PROMPT},
            {"role": "user", "content": (
                f"原文：{text}\n"
                f"旧译文：{old_translation}\n"
                f"直译新译文：{raw}\n"
                f"请融合优点输出最终译文。"
            )},
        ],
        "temperature": (overrides or {}).get("temperature", 0.7),
        "top_p": (overrides or {}).get("top_p", 0.6),
        "max_tokens": (overrides or {}).get("max_tokens", 1024),
        "repetition_penalty": (overrides or {}).get("repetition_penalty", 1.05),
        "stream": False,
    }
    enable_thinking = (api_config or {}).get("enable_thinking")
    if enable_thinking is False:
        polish_payload["thinking"] = {"type": "disabled"}
    try:
        resp = _get_session().post(
            base_url,
            json=polish_payload,
            timeout=LLM_TIMEOUT,
            headers=_build_api_headers(api_config),
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("choices") or not data["choices"][0].get("message"):
            return {"translation": raw, "warning": "糅合步骤：LLM 响应缺少 choices 或 message 字段，使用直译结果"}
        final = _strip_tags(data["choices"][0]["message"]["content"].strip())
        result = {"translation": final}
        if data["choices"][0].get("finish_reason") == "length":
            result["truncated"] = True
        return result
    except requests.exceptions.ConnectionError:
        return {"translation": raw, "warning": "润色步骤失败，使用直译结果"}
    except requests.exceptions.Timeout:
        return {"translation": raw, "warning": "润色步骤超时，使用直译结果"}
    except (KeyError, IndexError):
        return {"translation": raw, "warning": "润色步骤响应格式异常，使用直译结果"}
    except Exception as e:
        return {"translation": raw, "warning": f"润色步骤失败，使用直译结果"}


def _parse_txt(content: str, filename: str = "") -> list[dict]:
    """解析 key=value 格式的文本行，原文严格保留首尾空格"""
    lines = []
    for raw_line in content.splitlines():
        raw_line = raw_line.rstrip("\r\n")  # 仅去除换行符，保留行首尾空格
        if not raw_line:
            continue
        if "=" in raw_line:
            idx = raw_line.index("=")        # 第一个等号位置
            original = raw_line[:idx]         # 原样保留（包括前后空格）
            translation = raw_line[idx + 1:]  # 原样保留（包括前后空格）
        else:
            original = raw_line
            translation = ""
        line = {
            "original": original,
            "translation": translation,
            "new_translation": "",
        }
        if filename:
            line["file"] = filename
        lines.append(line)
    return lines
def _extract_overrides(data: dict) -> dict:
    """从请求中提取 LLM 参数覆盖值（含润色第二步提示词）"""
    overrides = {}
    for key in ("temperature", "top_p", "max_tokens", "repetition_penalty", "system_prompt"):
        if key in data and data[key] is not None:
            overrides[key] = data[key]
    if "polish_prompt" in data and data["polish_prompt"] is not None:
        overrides["polish_prompt"] = data["polish_prompt"]
    return overrides


def _extract_api_config(data: dict) -> dict:
    """从请求体提取 API 配置（api_base/api_key/model/enable_thinking）"""
    config = {}
    for key in ("api_base", "api_key", "model"):
        val = data.get(key)
        if val and val.strip():
            config[key] = val.strip()
    # 提取 enable_thinking（False=关闭思考，True/不传=默认）
    if "enable_thinking" in data:
        val = data["enable_thinking"]
        if isinstance(val, str):
            config["enable_thinking"] = val.lower() not in ("false", "0", "no", "off")
        else:
            config["enable_thinking"] = bool(val)
    return config


# ── API 路由 ──


@app.after_request
def _no_cache(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/upload", methods=["POST"])
def upload():
    """上传并解析 txt 文件，支持多文件，每行标记来源"""
    files = request.files.getlist("file")
    if not files:
        return jsonify({"error": "未提供文件"}), 400

    all_lines = []
    file_names = []
    for f in files:
        if not f.filename:
            continue
        file_names.append(f.filename)
        raw = f.read()
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            content = raw.decode("gbk", errors="replace")
        all_lines.extend(_parse_txt(content, filename=f.filename))

    return jsonify({
        "lines": all_lines,
        "count": len(all_lines),
        "files": file_names,
    })


@app.route("/api/manual-input", methods=["POST"])
def manual_input():
    """手动输入解析，复用 _parse_txt"""
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text:
        return jsonify({"error": "文本为空"}), 400
    lines = _parse_txt(text)
    return jsonify({"lines": lines, "count": len(lines)})


@app.route("/api/translate", methods=["POST"])
def translate():
    """翻译单条文本"""
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"error": "文本为空"}), 400
    api_config = _extract_api_config(data)
    overrides = _extract_overrides(data)
    result = _call_llm(text, overrides, api_config)
    if result.get("error"):
        return jsonify(result), 503
    return jsonify(result)


@app.route("/api/translate-polish", methods=["POST"])
def translate_polish():
    """润色翻译单条：直译后与旧译文对比糅合"""
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    old_translation = data.get("old_translation", "").strip()
    if not text:
        return jsonify({"error": "文本为空"}), 400
    api_config = _extract_api_config(data)
    overrides = _extract_overrides(data)
    result = _call_llm_polish(text, old_translation, overrides, api_config)
    if result.get("error") and not result.get("translation"):
        return jsonify(result), 503
    return jsonify(result)

@app.route("/api/tag", methods=["POST"])
def tag_text():
    """分词/分类单条文本：用自定义 system_prompt 调用 LLM，不追加翻译隐式规则"""
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify({"error": "文本为空"}), 400
    api_config = _extract_api_config(data)
    overrides = _extract_overrides(data)
    # 分词不追加翻译策略，使用纯分类提示词
    params = {**DEFAULT_PARAMS, **overrides}
    base_url = api_config.get("api_base") or LLM_API_URL
    model = api_config.get("model") or LLM_MODEL
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": params["system_prompt"]},
            {"role": "user", "content": text},
        ],
        "temperature": params.get("temperature", 0.1),
        "top_p": params.get("top_p", 0.6),
        "max_tokens": params.get("max_tokens", 512),
        "repetition_penalty": params.get("repetition_penalty", 1.05),
        "stream": False,
    }
    enable_thinking = api_config.get("enable_thinking")
    if enable_thinking is False:
        payload["thinking"] = {"type": "disabled"}
    try:
        resp = _get_session().post(
            base_url, json=payload, timeout=LLM_TIMEOUT,
            headers=_build_api_headers(api_config),
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("choices") or not data["choices"][0].get("message"):
            return jsonify({"translation": "", "error": "LLM 响应缺少 choices 或 message 字段"})
        content = data["choices"][0]["message"]["content"].strip()
        result = {"translation": content}
        if data["choices"][0].get("finish_reason") == "length":
            result["truncated"] = True
        return jsonify(result)
    except requests.exceptions.ConnectionError:
        return jsonify({"translation": "", "error": "LLM 服务未启动或无法连接"}), 503
    except requests.exceptions.Timeout:
        return jsonify({"translation": "", "error": "LLM 请求超时"}), 503
    except Exception as e:
        return jsonify({"translation": "", "error": str(e)}), 503

@app.route("/api/tag-batch", methods=["POST"])
def tag_batch():
    """批量分词 - 流式输出，每完成一条即推送"""
    data = request.get_json(silent=True) or {}
    items = data.get("items", [])
    if not items:
        return jsonify({"error": "分词列表为空"}), 400

    concurrency = max(1, min(data.get("concurrency", DEFAULT_CONCURRENCY), 10))
    api_config = _extract_api_config(data)
    overrides = _extract_overrides(data)
    params = {**DEFAULT_PARAMS, **overrides}
    base_url = api_config.get("api_base") or LLM_API_URL
    model = api_config.get("model") or LLM_MODEL
    enable_thinking = api_config.get("enable_thinking")

    valid_items = []
    empty_indices = set()
    for i, item in enumerate(items):
        if not item.get("original", "").strip():
            empty_indices.add(i)
        else:
            valid_items.append((i, item))

    def _submit_tag(executor, idx, item):
        def _do_tag():
            text = item["original"].strip()
            if not text:
                return {"translation": ""}
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": params["system_prompt"]},
                    {"role": "user", "content": text},
                ],
                "temperature": params.get("temperature", 0.1),
                "top_p": params.get("top_p", 0.6),
                "max_tokens": params.get("max_tokens", 512),
                "repetition_penalty": params.get("repetition_penalty", 1.05),
                "stream": False,
            }
            if enable_thinking is False:
                payload["thinking"] = {"type": "disabled"}
            try:
                resp = _get_session().post(
                    base_url, json=payload, timeout=LLM_TIMEOUT,
                    headers=_build_api_headers(api_config),
                )
                resp.raise_for_status()
                rdata = resp.json()
                if not rdata.get("choices") or not rdata["choices"][0].get("message"):
                    return {"translation": "", "error": "LLM 响应缺少 choices 或 message 字段"}
                content = rdata["choices"][0]["message"]["content"].strip()
                result = {"translation": content}
                if rdata["choices"][0].get("finish_reason") == "length":
                    result["truncated"] = True
                return result
            except requests.exceptions.ConnectionError:
                return {"translation": "", "error": "LLM 服务未启动或无法连接"}
            except requests.exceptions.Timeout:
                return {"translation": "", "error": "LLM 请求超时"}
            except Exception as e:
                return {"translation": "", "error": str(e)}
        return executor.submit(_do_tag)

    return _stream_batch_response_tag(valid_items, empty_indices, concurrency, _submit_tag)


def _stream_batch_response_tag(valid_items, empty_indices, concurrency, submit_fn):
    """分词批量流式响应 -> 委托给统一 _stream_batch_response 处理"""
    return _stream_batch_response(valid_items, empty_indices, concurrency, submit_fn, result_mode="tag")


def _stream_batch_response(valid_items, empty_indices, concurrency, submit_fn, result_mode="translate"):
    """通用批量流式响应
    result_mode: "translate" 返回翻译字段 | "tag" 返回 tag_l1/tag_l2/confidence
    """
    _sentinel = object()
    cancel_event = threading.Event()

    def generate():
        for i in empty_indices:
            empty_obj = (
                {"index": i, "tag_l1": "", "tag_l2": "", "confidence": 0, "error": ""}
                if result_mode == "tag"
                else {"index": i, "new_translation": "", "error": ""}
            )
            yield (json.dumps(empty_obj, ensure_ascii=False) + "\n").encode("utf-8")

        result_queue = queue.Queue()

        def _worker():
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                try:
                    future_map = {}
                    for idx, item in valid_items:
                        future = submit_fn(executor, idx, item)
                        future_map[future] = idx
                    for future in as_completed(future_map):
                        if cancel_event.is_set():
                            break
                        idx = future_map[future]
                        try:
                            result = future.result()
                        except Exception as exc:
                            result = {"translation": "", "error": str(exc)}
                        if result_mode == "tag":
                            tag_l1, tag_l2, confidence = "", "", 0
                            content_text = result.get("translation", "")
                            if content_text and not result.get("error"):
                                try:
                                    s = content_text.index("{")
                                    e = content_text.rindex("}")
                                    j = json.loads(content_text[s:e+1])
                                    tag_l1 = j.get("l1", "")
                                    tag_l2 = j.get("l2", "")
                                    confidence = j.get("confidence", 0)
                                except (ValueError, json.JSONDecodeError, KeyError):
                                    pass
                            result_queue.put((idx, tag_l1, tag_l2, confidence, result.get("error", "")))
                        else:
                            result_queue.put((idx, result))
                except Exception:
                    pass
                finally:
                    cancel_event.set()
                    executor.shutdown(wait=False)
                    _close_session()
            result_queue.put(_sentinel)

        threading.Thread(target=_worker, daemon=True).start()

        try:
            while True:
                item = result_queue.get(timeout=LLM_TIMEOUT + 30)
                if item is _sentinel:
                    break
                if result_mode == "tag":
                    idx, tag_l1, tag_l2, confidence, error_str = item
                    line = json.dumps({
                        "index": idx, "tag_l1": tag_l1, "tag_l2": tag_l2,
                        "confidence": confidence, "error": error_str,
                    }, ensure_ascii=False)
                else:
                    idx, result = item
                    line = json.dumps({
                        "index": idx,
                        "new_translation": result.get("translation", ""),
                        "error": result.get("error", ""),
                        "truncated": result.get("truncated", False),
                        "warning": result.get("warning", ""),
                        "degraded": result.get("degraded", False),
                    }, ensure_ascii=False)
                yield (line + "\n").encode("utf-8")
        except (queue.Empty, GeneratorExit):
            cancel_event.set()

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        direct_passthrough=True,
        headers={
            "X-Concurrency": str(concurrency),
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/translate-batch", methods=["POST"])
def translate_batch():
    """批量翻译 - 流式输出，每完成一条即推送"""
    data = request.get_json(silent=True) or {}
    items = data.get("items", [])
    if not items:
        return jsonify({"error": "翻译列表为空"}), 400

    concurrency = max(1, min(data.get("concurrency", DEFAULT_CONCURRENCY), 10))
    api_config = _extract_api_config(data)
    overrides = _extract_overrides(data)

    valid_items = []
    empty_indices = set()
    for i, item in enumerate(items):
        if not item.get("original", "").strip():
            empty_indices.add(i)
        else:
            valid_items.append((i, item))

    return _stream_batch_response(
        valid_items, empty_indices, concurrency,
        lambda executor, idx, item: executor.submit(
            _call_llm, item["original"].strip(), overrides, api_config,
        ),
    )


@app.route("/api/translate-batch-polish", methods=["POST"])
def translate_batch_polish():
    """批量润色翻译 - 流式输出，每完成一条即推送"""
    data = request.get_json(silent=True) or {}
    items = data.get("items", [])
    if not items:
        return jsonify({"error": "翻译列表为空"}), 400

    concurrency = max(1, min(data.get("concurrency", DEFAULT_CONCURRENCY), 10))
    api_config = _extract_api_config(data)
    overrides = _extract_overrides(data)

    valid_items = []
    empty_indices = set()
    for i, item in enumerate(items):
        if not item.get("original", "").strip():
            empty_indices.add(i)
        else:
            valid_items.append((i, item))

    return _stream_batch_response(
        valid_items, empty_indices, concurrency,
        lambda executor, idx, item: executor.submit(
            _call_llm_polish,
            item["original"].strip(),
            item.get("translation", "").strip(),
            overrides,
            api_config,
        ),
    )


@app.route("/api/check-llm", methods=["GET", "POST"])
def check_llm():
    """检测 LLM 服务连通性（GET 兼容旧版，POST 支持动态配置）"""
    api_config = {}
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        api_config = _extract_api_config(data)

    api_base = api_config.get("api_base") or LLM_API_URL
    try:
        # 尝试 /models 端点检查连通性，失败则回退到 chat/completions
        base_url = api_base.rstrip("/")
        if base_url.endswith("/chat/completions"):
            base_url = base_url.rsplit("/chat/completions", 1)[0]
        resp = _get_session().get(
            base_url + "/models",
            timeout=8,
            headers=_build_api_headers(api_config),
        )
        if resp.status_code == 200:
            return jsonify({"status": "connected"})
        return jsonify({"status": "disconnected", "detail": f"HTTP {resp.status_code}"})
    except requests.exceptions.ConnectionError:
        return jsonify({"status": "disconnected", "detail": "无法连接"})
    except Exception as e:
        return jsonify({"status": "disconnected", "detail": str(e)})


@app.route("/api/config", methods=["GET"])
def get_config():
    return jsonify({
        "api_url": LLM_API_URL,
        "model": LLM_MODEL,
        "defaults": DEFAULT_PARAMS,
        "polish_defaults": POLISH_DEFAULT_PARAMS,
        "direct_default_prompt": DEFAULT_PARAMS["system_prompt"],
        "polish_step1_default": POLISH_DIRECT_PROMPT,
        "polish_step2_default": POLISH_PROMPT,
        "default_tag_strategy": DEFAULT_TAG_STRATEGY,
        "presets": {
            "direct": [
                {
                    "id": "__preset_ui_direct__",
                    "name": "UI / Mod（术语）",
                    "text": "你是一个专业游戏中文本地化专家，专精UI、菜单、控件、Mod说明翻译。\n规则：\n1. 游戏术语必须翻译为中文（Attack Power→攻击力，Inventory→物品栏），译名以业界通行中文为准。\n2. 极度简洁，译文不超过原文长度。\n3. 仅保留占位符（{0}、%s）、快捷键（&键）、换行和特殊符号原样不动。\n只输出译文，不要额外解释。",
                    "locked": True
                },
                {
                    "id": "__preset_dialogue_direct__",
                    "name": "对话 / 剧情（生动）",
                    "text": "你是一个顶尖的游戏本地化及配音脚本翻译专家。\n要求：\n1. 根据上下文判断角色性格与情绪，中文对白必须贴合其身份和当下情感。\n2. 彻底摆脱翻译腔，用地道中文口语重写。\n3. 为达到戏剧效果或情感冲击力，可牺牲字面翻译进行创造性改写。\n只输出译文，不要额外解释。",
                    "locked": True
                }
            ],
            "polish": [
                {
                    "id": "__preset_ui_polish__",
                    "name": "UI / Mod（术语）",
                    "text": "你是一个专业游戏UI翻译初稿专家。请对以下文本逐句直译。\n规则：\n- 游戏术语必须翻译为中文，不得保留英文。\n- 仅保留占位符（{0}、%s）、快捷键（&键）和特殊符号原样不动。\n- 结构对齐原文，即使生硬也保留原语序。\n- 不添加任何修饰或解释。\n只输出译文，不要额外解释。",
                    "step2": "你是一个游戏UI本地化校对专家。\n你将收到【直译新译文】和【旧译文】。\n处理规则：\n- 术语以直译新译文为准，旧译文有误则修正。\n- 所有文本必须为中文，不得出现英文术语。\n- 极致精简，长度不超过原文。\n- 可微调使其通顺，但绝不意译。\n只输出最终译文。",
                    "locked": True
                },
                {
                    "id": "__preset_dialogue_polish__",
                    "name": "对话 / 剧情（生动）",
                    "text": "你是一个专业游戏翻译初稿专家。请对以下文本逐句直译。\n要求：\n- 准确传达语义和情绪基调。\n- 保留关键信息和比喻意象。\n- 可微调语序使其通顺，但不做艺术加工。\n只输出译文，不要额外解释。",
                    "step2": "你是一个顶尖的游戏本地化润色专家。\n你将收到【直译新译文】和【旧译文】。\n目标：写出地道的中文对白，完全摆脱翻译腔。\n- 继承直译的语义准确性，可彻底重写结构。\n- 吸收旧译文的口语化优点。\n- 善用中文四字格、俗语、语气词，让对白活起来。\n只输出最终译文。",
                    "locked": True
                }
            ]
        }
    })

import atexit
atexit.register(_close_session)

# ═══════════════════════════════════════════
# 去重模块
# ═══════════════════════════════════════════\]

import io
import zipfile

DEDUP_DEFAULT_CONCURRENCY = 5

# ── 去重评估默认策略（结构化提示词） ──
DEDUP_DEFAULT_STRATEGY = (
    "你是一个专业的文本质量评估专家。\n"
    "以下是一组具有相同原文但不同译文的条目，请判断哪一条译文质量最高。\n"
    "评估标准：准确性（是否忠实于原文）、自然度（是否通顺地道）、语境适配（是否符合游戏场景）。"
)

# 输出格式 → 追加在角色指令 + 待评估列表之后
DEDUP_OUTPUT_FORMAT = (
    "只输出最佳条目的序号（从0开始的数字），不要任何其他文字。"
)


def _parse_txt_with_index(content: str, filename: str = "") -> list[dict]:
    entries = _parse_txt(content, filename)
    # 还原 true line number（跳过空行以匹配 dedup_apply 的 splitlines 索引）
    lines = content.splitlines()
    real_idx = 0
    for entry in entries:
        while real_idx < len(lines) and not lines[real_idx]:
            real_idx += 1
        entry["line"] = real_idx
        real_idx += 1
    return entries


@app.route("/api/dedup/upload", methods=["POST"])
def dedup_upload():
    files = request.files.getlist("file")
    if not files:
        return jsonify({"error": "未提供文件"}), 400

    # 从前端传入的独立路径字段读取文件相对路径
    _sent_paths = []
    try:
        _sent_paths = json.loads(request.form.get("_paths", "[]"))
    except Exception:
        pass

    all_entries = []
    used_paths = set()
    for idx, f in enumerate(files):
        # 优先使用前端传入的路径（支持拖拽/目录选择/特殊符号文件名）
        rel_path = _sent_paths[idx] if idx < len(_sent_paths) else f.filename
        if not rel_path or not rel_path.lower().endswith(".txt"):
            continue
        raw = f.read()
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError:
            try:
                content = raw.decode("gbk", errors="replace")
            except Exception:
                continue
        entries = _parse_txt_with_index(content, rel_path)
        all_entries.extend(entries)
        used_paths.add(rel_path)

    if not all_entries:
        return jsonify({"error": "未解析到有效条目"}), 400

    groups = {}
    for e in all_entries:
        groups.setdefault(e["original"], []).append(e)

    duplicate_groups = {k: v for k, v in groups.items() if len(v) > 1}

    return jsonify({
        "entries": all_entries,
        "groups": duplicate_groups,
        "total_entries": len(all_entries),
        "total_groups": len(duplicate_groups),
        "files": sorted(used_paths),
    })


@app.route("/api/dedup/evaluate-batch", methods=["POST"])
def dedup_evaluate_batch():
    """批量并发评估多个重复组，流式 NDJSON 返回每组 best_index"""
    data = request.get_json(silent=True) or {}
    groups_list = data.get("groups", [])
    if not groups_list:
        return jsonify({"error": "重复组列表为空"}), 400

    concurrency = max(1, min(data.get("concurrency", DEDUP_DEFAULT_CONCURRENCY), 10))
    api_config = _extract_api_config(data)
    overrides = _extract_overrides(data)

    strategy = overrides.get("system_prompt") or DEDUP_DEFAULT_STRATEGY

    base_url = api_config.get("api_base") or LLM_API_URL
    model = api_config.get("model") or LLM_MODEL
    enable_thinking = api_config.get("enable_thinking")

    valid_items = []
    for g_idx, group in enumerate(groups_list):
        if len(group) < 2:
            continue
        valid_items.append((g_idx, group))

    def _submit(executor, g_idx, group):
        def _do():
            # 构造 prompt：角色指令 + 条目列表 + 明确范围的输出格式
            entries_text = ""
            for ei, e in enumerate(group):
                entries_text += f"{ei+1}. {e['original']}={e['translation']}\n"
            output_format = f"请只输出 BEST: N 格式（N 为 1 到 {len(group)} 之间的最佳序号），不要任何其他文字。\n例如：BEST: 1"
            full_prompt = f"{strategy}\n\n{entries_text}\n\n{output_format}"

            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": "你是一个专业的文本质量评估专家。"},
                    {"role": "user", "content": full_prompt},
                ],
                "temperature": overrides.get("temperature", 0.1),
                "top_p": overrides.get("top_p", 0.6),
                "max_tokens": overrides.get("max_tokens", 10),
                "repetition_penalty": overrides.get("repetition_penalty", 1.0),
                "stream": False,
            }
            if enable_thinking is False:
                payload["thinking"] = {"type": "disabled"}
            try:
                resp = _get_session().post(
                    base_url, json=payload, timeout=LLM_TIMEOUT,
                    headers=_build_api_headers(api_config),
                )
                resp.raise_for_status()
                rdata = resp.json()
                content = rdata["choices"][0]["message"]["content"].strip()
                # 优先匹配 "BEST: N" 格式，回退到取最后一个有效数字
                best_match = re.search(r"BEST:\s*(\d+)", content, re.IGNORECASE)
                if best_match:
                    best_n = int(best_match.group(1))
                    if 1 <= best_n <= len(group):
                        return {"best_index": best_n - 1}
                all_nums = re.findall(r"\b(\d+)\b", content)
                valid_nums = [int(n) for n in all_nums if 1 <= int(n) <= len(group)]
                if valid_nums:
                    return {"best_index": valid_nums[-1] - 1}
                return {"error": f"无法解析返回: {content}"}
            except Exception as exc:
                return {"error": str(exc)}
        return executor.submit(_do)

    return _stream_batch_response_dedup(valid_items, concurrency, _submit)


def _stream_batch_response_dedup(valid_items, concurrency, submit_fn):
    """去重评估专用流式响应（返回 best_index）"""
    _sentinel = object()
    cancel_event = threading.Event()

    def generate():
        result_queue = queue.Queue()

        def _worker():
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                try:
                    future_map = {}
                    for g_idx, group in valid_items:
                        future = submit_fn(executor, g_idx, group)
                        future_map[future] = g_idx
                    for future in as_completed(future_map):
                        if cancel_event.is_set():
                            break
                        g_idx = future_map[future]
                        try:
                            result = future.result()
                        except Exception as exc:
                            result = {"error": str(exc)}
                        result_queue.put((g_idx, result))
                except Exception:
                    pass
                finally:
                    cancel_event.set()
                    executor.shutdown(wait=False)
                    _close_session()
            result_queue.put(_sentinel)

        threading.Thread(target=_worker, daemon=True).start()

        try:
            while True:
                item = result_queue.get(timeout=LLM_TIMEOUT + 30)
                if item is _sentinel:
                    break
                g_idx, result = item
                line = json.dumps({
                    "group_index": g_idx,
                    "best_index": result.get("best_index"),
                    "error": result.get("error", ""),
                }, ensure_ascii=False)
                yield (line + "\n").encode("utf-8")
        except (queue.Empty, GeneratorExit):
            cancel_event.set()

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        direct_passthrough=True,
        headers={
            "X-Concurrency": str(concurrency),
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/dedup/apply", methods=["POST"])
def dedup_apply():
    """应用去重，返回 zip 包含去重后的目录结构 + .bak 文件记录移除条目"""
    data = request.get_json(silent=True) or {}
    selected = data.get("selected", [])
    file_contents = data.get("file_contents", {})
    if not selected:
        return jsonify({"error": "未选择任何条目"}), 400
    if not file_contents:
        return jsonify({"error": "缺少文件原始内容"}), 400
    # 防止请求体过大导致 OOM
    total_size = sum(len(c.encode("utf-8")) for c in file_contents.values())
    if total_size > 10 * 1024 * 1024:
        return jsonify({"error": "文件总大小超过 10 MB 限制，请分批处理"}), 413

    # 按文件收集选中行号
    file_selected = {}
    for e in selected:
        fpath = e.get("file")
        if not fpath:
            continue
        file_selected.setdefault(fpath, set()).add(e.get("line"))

    # 构建每个文件的新内容和 bak 内容
    # bak_files: { relPath: bakText }
    # new_files: { relPath: newText }
    new_files = {}
    bak_files = {}

    for fpath, content in file_contents.items():
        selected_lines = file_selected.get(fpath, set())
        lines = content.splitlines()
        new_lines = []
        removed_lines = []
        for idx, line in enumerate(lines):
            if idx in selected_lines:
                new_lines.append(line)
            else:
                removed_lines.append((idx, line))

        new_files[fpath] = "\n".join(new_lines)

        if removed_lines:
            bak_parts = []
            bak_parts.append(f"# ═══ 去重备份 — 来源: {fpath} ═══")
            bak_parts.append(f"# 移除 {len(removed_lines)} 条重复条目，保留 {len(new_lines)} 条")
            bak_parts.append("")
            for idx, line in removed_lines:
                bak_parts.append(f"# [行{idx}] {line}")
                bak_parts.append(line)
            bak_files[fpath] = "\n".join(bak_parts)

    # 打包 zip
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # 去重后的文件
        for fpath, content in new_files.items():
            zf.writestr(fpath, content.encode("utf-8"))
        # bak 文件（放入 bak/ 子目录）
        for bak_path, content in bak_files.items():
            zf.writestr("bak/" + bak_path, content.encode("utf-8"))

    buf.seek(0)
    return Response(
        buf.getvalue(),
        mimetype="application/zip",
        headers={
            "Content-Disposition": "attachment; filename=dedup_result.zip",
            "X-Bak-Count": str(len(bak_files)),
            "Cache-Control": "no-cache",
        },
    )


if __name__ == "__main__":
    os.makedirs("static", exist_ok=True)
    print(f"TxtLlmHub 启动: http://127.0.0.1:5000")
    print(f"LLM API: {LLM_API_URL}")
    app.run(host="127.0.0.1", port=5000, debug=False)
