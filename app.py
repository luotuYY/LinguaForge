"""
TxtLlmHub — 本地 LLM 文本翻译/润色工具
Flask 后端：文件上传、LLM API 调用、翻译对比
支持动态 API 配置（商业模型如 DeepSeek 等）
"""
import os
import json
import requests
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Flask, request, jsonify, send_from_directory

app = Flask(__name__, static_folder="static", static_url_path="")

# ── LLM API 配置（用户手动启动 LLM 服务后填写） ──
LLM_API_URL = os.environ.get("LLM_API_URL", "http://127.0.0.1:8080/v1/chat/completions")
LLM_MODEL = os.environ.get("LLM_MODEL", "local-model")
LLM_TIMEOUT = 120
_thread_local = threading.local()

def _get_session():
    """Get a thread-local requests.Session for connection reuse."""
    if not hasattr(_thread_local, "session"):
        _thread_local.session = requests.Session()
    return _thread_local.session
DEFAULT_CONCURRENCY = 5

# 默认 LLM 参数
DEFAULT_PARAMS = {
    "temperature": 0.7,
    "top_p": 0.6,
    "max_tokens": 512,
    "repetition_penalty": 1.05,
    "system_prompt": (
        "你是一个专业的中文本地化翻译润色助手。"
        "请将给定的原文翻译成自然、地道、符合中文表达习惯的译文。"
        "注意：文本是游戏UI/菜单文本/mod/插件时，翻译需简洁准确。"
        "注意：游戏对话/剧情文本的翻译需自然流畅、贴合角色性格与情感，避免直白简略，保留语境韵味和俚语。"
        "只输出翻译结果，不要有任何解释、前缀或后缀。"
    ),
}

# 润色模式：第一步直译提示词
POLISH_DIRECT_PROMPT = (
    "你是一个专业的中文本地化翻译助手。"
    "请将给定的原文直译成中文，尽量保留原意和结构，"
    "为后续润色提供准确的基础译文。"
    "注意：文本是游戏UI/菜单文本/mod/插件时，翻译需简洁准确。"
    "注意：游戏对话/剧情文本的翻译需自然流畅、贴合角色性格与情感，避免直白简略，保留语境韵味和俚语。"
    "只输出翻译结果，不要有任何解释、前缀或后缀。"
)

# 润色模式：第二步对比糅合提示词
POLISH_PROMPT = (
    "你是一个专业的中文润色助手。"
    "请对比以下两个译文，分析各自的优缺点，融合两者的优点，"
    "输出一个更自然、更地道、更符合中文表达习惯的最终译文。"
    "注意：游戏对话/剧情文本需自然流畅、贴合角色性格与情感，避免直白简略，保留语境韵味和俚语。"
    "只输出最终润色后的译文，不要有任何解释、前缀或后缀。"
)

# 润色模式默认参数
POLISH_DEFAULT_PARAMS = {
    "temperature": 0.5,
    "top_p": 0.6,
    "max_tokens": 512,
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


def _call_llm(text: str, overrides: dict = None, api_config: dict = None) -> dict:
    """
    调用 LLM API
    - overrides: 翻译参数（temperature, system_prompt…）
    - api_config: {'api_base': '...', 'api_key': '...', 'model': '...'}
    """
    params = {**DEFAULT_PARAMS, **(overrides or {})}
    # 优先使用动态配置，否则回退到环境变量
    base_url = (api_config or {}).get("api_base") or LLM_API_URL
    model = (api_config or {}).get("model") or LLM_MODEL

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": params["system_prompt"]},
            {"role": "user", "content": f"请翻译以下文本：\n{text}"},
        ],
        "temperature": params["temperature"],
        "top_p": params["top_p"],
        "max_tokens": params["max_tokens"],
        "repetition_penalty": params["repetition_penalty"],
        "stream": False,
    }
    # 关闭思考模式：对于支持 thinking 参数的 API（Claude/DeepSeek等）
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
        translation = data["choices"][0]["message"]["content"].strip()
        return {"translation": translation}
    except requests.exceptions.ConnectionError:
        return {"translation": "", "error": "LLM 服务未启动或无法连接"}
    except requests.exceptions.Timeout:
        return {"translation": "", "error": "LLM 请求超时"}
    except (KeyError, IndexError):
        return {"translation": "", "error": "LLM 响应格式异常，请检查模型配置"}
    except Exception as e:
        return {"translation": "", "error": str(e)}


def _call_llm_polish(text: str, old_translation: str, overrides: dict = None, api_config: dict = None) -> dict:
    """润色模式：先直译，再与旧译文对比糅合，返回 {translation, error?}"""
    # 第一步：直译（使用润色专属提示词）
    polish_overrides = {**(overrides or {}), "system_prompt": (overrides or {}).get("system_prompt") or POLISH_DIRECT_PROMPT}
    direct_result = _call_llm(text, polish_overrides, api_config)
    if direct_result.get("error") or not direct_result.get("translation"):
        return direct_result

    raw = direct_result["translation"]
    # 如果没有旧译文可对比，直接返回直译结果
    if not old_translation or not old_translation.strip():
        return {"translation": raw}

    # 第二步：润色糅合
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
        "temperature": (overrides or {}).get("temperature", 0.5),
        "top_p": (overrides or {}).get("top_p", 0.6),
        "max_tokens": (overrides or {}).get("max_tokens", 512),
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
        final = data["choices"][0]["message"]["content"].strip()
        return {"translation": final}
    except requests.exceptions.ConnectionError:
        return {"translation": raw, "error": "润色步骤：LLM 服务未启动或无法连接"}
    except requests.exceptions.Timeout:
        return {"translation": raw, "error": "润色步骤：LLM 请求超时"}
    except (KeyError, IndexError):
        return {"translation": raw, "error": "润色步骤：LLM 响应格式异常"}
    except Exception as e:
        return {"translation": raw, "error": f"润色步骤：{e}"}


def _parse_txt(content: str, filename: str = "") -> list[dict]:
    """解析 key=value 格式的文本行，可选标记来源文件"""
    lines = []
    for raw in content.strip().splitlines():
        raw = raw.strip()
        if not raw:
            continue
        if "=" in raw:
            idx = raw.index("=")
            original = raw[:idx].strip()
            translation = raw[idx + 1 :].strip()
        else:
            original = raw
            translation = ""
        line = {
            "original": original,
            "translation": translation,
            "new_translation": "",
        }
        if filename:
            line["_file"] = filename
        lines.append(line)
    return lines


def _extract_overrides(data: dict) -> dict:
    """从请求中提取 LLM 参数覆盖值"""
    overrides = {}
    for key in ("temperature", "top_p", "max_tokens", "repetition_penalty", "system_prompt"):
        if key in data and data[key] is not None:
            overrides[key] = data[key]
    return overrides


def _extract_api_config(data: dict) -> dict:
    """从请求中提取 API 配置（api_base, api_key, model）"""
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


# ── 路由 ──


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


@app.route("/api/translate-batch", methods=["POST"])
def translate_batch():
    """批量翻译 - 支持并发，通过 ThreadPoolExecutor 并行调用 LLM"""
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

    indexed_results = {}
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        future_map = {}
        for idx, item in valid_items:
            future = executor.submit(
                _call_llm, item["original"].strip(), overrides, api_config
            )
            future_map[future] = (idx, item)

        for future in as_completed(future_map):
            idx, item = future_map[future]
            result = future.result()
            indexed_results[idx] = {
                **item,
                "new_translation": result.get("translation", ""),
                "error": result.get("error", ""),
            }

    results = []
    for i, item in enumerate(items):
        if i in empty_indices:
            results.append({**item, "new_translation": "", "error": ""})
        else:
            results.append(
                indexed_results.get(
                    i, {**item, "new_translation": "", "error": "并发异常"}
                )
            )

    return jsonify({"results": results, "concurrency": concurrency})


@app.route("/api/translate-batch-polish", methods=["POST"])
def translate_batch_polish():
    """批量润色翻译：每项先直译再对比糅合"""
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

    indexed_results = {}
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        future_map = {}
        for idx, item in valid_items:
            future = executor.submit(
                _call_llm_polish,
                item["original"].strip(),
                item.get("translation", "").strip(),
                overrides,
                api_config,
            )
            future_map[future] = (idx, item)

        for future in as_completed(future_map):
            idx, item = future_map[future]
            result = future.result()
            indexed_results[idx] = {
                **item,
                "new_translation": result.get("translation", ""),
                "error": result.get("error", ""),
            }

    results = []
    for i, item in enumerate(items):
        if i in empty_indices:
            results.append({**item, "new_translation": "", "error": ""})
        else:
            results.append(
                indexed_results.get(
                    i, {**item, "new_translation": "", "error": "并发异常"}
                )
            )

    return jsonify({"results": results, "concurrency": concurrency})


@app.route("/api/check-llm", methods=["GET", "POST"])
def check_llm():
    """检测 LLM 服务连通性（GET 兼容旧版，POST 支持动态配置）"""
    api_config = {}
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        api_config = _extract_api_config(data)

    api_base = api_config.get("api_base") or LLM_API_URL
    try:
        # 从 chat/completions URL 推断基础地址用于 /models 检查
        # 也支持直接检查 chat/completions 的连通性
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
    })


if __name__ == "__main__":
    os.makedirs("static", exist_ok=True)
    print(f"TxtLlmHub 启动: http://127.0.0.1:5000")
    print(f"LLM API: {LLM_API_URL}")
    app.run(host="127.0.0.1", port=5000, debug=True)
