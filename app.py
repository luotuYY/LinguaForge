"""TxtLlmHub — Flask 后端
文件上传解析、LLM API 调用、批量流式翻译/润色/分词
"""
import os
import json
import requests
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Flask, request, jsonify, send_from_directory, Response, stream_with_context

app = Flask(__name__, static_folder="static", static_url_path="")

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


# ── 翻译策略（隐性规则，仅对默认混合提示词生效） ──
_HIDDEN_RULES_BASE = (
    "【翻译策略】请先判断原文特征，再选择翻译方式：\n"
    "判断1：原文是否包含日文假名（如 あいうえお、アイウエオ、クノイチ、すね当て 等）？\n"
    "  → 是：直接翻译为中文。严禁臆测、发挥、解读为谜题或代号。跳过后续判断。\n"
    "  → 否：进入判断2。\n"
    "判断2：原文是否为装备名/技能名/物品名/UI标签/菜单项/mod字段名？\n"
    "  → 是（mod字段名/短标识符，如 del、get、set 等常见代码键名）：保持原文不变，不翻译。\n"
    "  → 是（装备名/技能名/物品名/UI标签/菜单项）：简洁准确直译，严禁添加任何修饰、解释或额外描述。\n"
    "  → 否：进入判断3。\n"
    "判断3：原文为对话/剧情/角色台词/叙事文本。\n"
    "  → 自然流畅翻译，贴合角色性格与情感，保留语境韵味和俚语。"
)
_HIDDEN_RULES_BLEND = (
    "\n【糅合对比补充】对比新旧译文时：若原文含日文假名，"
    "  → 优先选择直译准确度更高的译文，严禁因旧译文更\"自然\"而偏离原意。\n"
    "  → 若原文为装备名/UI字段名，优先选择更简洁准确的译文。"
)
# ── 分类策略（分词页 system prompt 的角色指令，可由前端自定义） ──
DEFAULT_TAG_STRATEGY = "你是一个游戏文本分类专家。请将以下文本归入最合适的类别。"

# 完整规则 = 基础 + 糅合（润色 Step2 使用）
_HIDDEN_RULES = _HIDDEN_RULES_BASE + _HIDDEN_RULES_BLEND
# ── 默认翻译参数（前端可通过 system_prompt 覆盖） ──
DEFAULT_PARAMS = {
    "temperature": 0.7,
    "top_p": 0.6,
    "max_tokens": 1024,
    "repetition_penalty": 1.05,
    "system_prompt": (
        "你是一个全能的游戏本地化专家。你将收到混合了UI提示、系统通知和少量对话片段的文本。"
        "请逐句判断类型并应用不同策略翻译："
        "- 若为UI/菜单/按钮/系统提示/Mod说明/术语：采用【UI模式】—— 绝对准确的术语，极度简洁，保留占位符和快捷键，长度不超过原文。"
        "- 若为对话/剧情/角色台词：采用【对白模式】—— 自然口语化，贴合角色情绪，完全消除翻译腔，必要时可意译。"
        "- 若一句话中混有术语和对话，优先保证术语准确，再用口语化方式串联。"
        "注意保留原文全部格式。只需要输出翻译后的结果，不要额外解释。"
    ),
}

# 润色 Step1：直译底稿提示词
POLISH_DIRECT_PROMPT = (
    "你是一个专业游戏翻译初稿专家。请对以下混合文本进行逐句直译，作为底稿。"
    "同时，为每句自动打上类型标签（[UI] 或 [DIALOGUE]）。判断标准："
    "- [UI]：按钮、菜单、系统提示、Mod说明、属性列表、包含占位符/快捷键的文本。"
    "- [DIALOGUE]：角色对白、剧情叙述、包含情绪和语气的文本。"
    "翻译要求："
    "- [UI]句：进行结构对齐的忠实直译，术语和占位符保留英文。"
    "- [DIALOGUE]句：翻译为意思准确、带基础情绪的通顺中文，允许微调语序。"
    "输出格式："
    "[标签] 中文底稿"
    "只输出带标签的译文，不要额外解释。"
)

# 润色 Step2：对比糅合提示词
POLISH_PROMPT = (
    "你是一个资深游戏本地化校对专家。"
    "你将收到已打好标签的【直译新译文】和对应的【旧译文】。"
    "请针对[UI]和[DIALOGUE]标签，采用不同策略进行融合润色："
    ""
    "【对[UI]文本 - 铁律模式】"
    "1. 术语与格式以直译新译文为唯一准绳，修正旧译文错误。"
    "2. 极度精简，删除任何冗余字，确保长度不超过原文。"
    "3. 在满足以上条件后，可微调用词使其略通顺，但绝不意译。"
    ""
    "【对[DIALOGUE]文本 - 重写模式】"
    "1. 以'听起来像地道的中文原生对白'为唯一目标。"
    "2. 无畏地抛弃直译新译文的生硬结构，只继承其准确语义和基础情绪。"
    "3. 吸收旧译文在口语化和角色贴合度上的优点。"
    "4. 进行创造性重写，活化语言，让对白'活'起来。"
    ""
    "输出时去掉所有标签，直接输出润色后的纯译文文本。保持原文顺序和格式。"
    "只输出最终译文，不要额外解释。"
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
    """判断文本是否为纯符号/分隔线等无需翻译的内容"""
    return not re.search(
        r'[A-Za-z'
        r'぀-ゟ'     # 平假名
        r'゠-ヿ'     # 片假名
        r'一-鿿'     # CJK 汉字
        r'가-힯'     # 韩文
        r'Ѐ-ӿ'     # 西里尔
        r']',
        text,
    )


def _call_llm(text: str, overrides: dict = None, api_config: dict = None, hidden_rules: str = None) -> dict:
    """
    调用 LLM API
    - overrides: 翻译参数（temperature, system_prompt…）
    - api_config: {'api_base': '...', 'api_key': '...', 'model': '...'}
    - hidden_rules: 自定义隐性翻译规则（None 时使用默认规则）
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
            {"role": "system", "content": params["system_prompt"] + "\n\n" + (hidden_rules if hidden_rules is not None else _HIDDEN_RULES_BASE)},
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

def _call_llm_polish(text: str, old_translation: str, overrides: dict = None, api_config: dict = None, hidden_rules: str = None) -> dict:
    """润色模式：先直译，再与旧译文对比糅合，返回 {translation, error?}"""
    # 纯符号/分隔线跳过翻译
    if _is_nontranslatable(text):
        return {"translation": text}
    # 无旧译文时降级为直译（无法糅合）
    if not old_translation or not old_translation.strip():
        result = _call_llm(text, overrides, api_config, hidden_rules=hidden_rules)
        if result.get("translation"):
            result["translation"] = _strip_tags(result["translation"])
        result["degraded"] = True  # 标记为降级：无旧译文，跳过润色糅合
        return result
    # Step1：直译底稿
    polish_overrides = {**(overrides or {}), "system_prompt": (overrides or {}).get("system_prompt") or POLISH_DIRECT_PROMPT}
    direct_result = _call_llm(text, polish_overrides, api_config, hidden_rules=hidden_rules)
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
            {"role": "system", "content": ((overrides or {}).get("polish_prompt", POLISH_PROMPT) if overrides else POLISH_PROMPT) + ("\n\n" + _HIDDEN_RULES_BLEND if (hidden_rules is None or hidden_rules) else "")},
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
            line["_file"] = filename
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
    if "hidden_rules" in data and data["hidden_rules"] is not None:
        overrides["hidden_rules"] = data["hidden_rules"]
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

@app.route("/tag")
def tag_page():
    return send_from_directory("static", "tag.html")


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
    hidden_rules = overrides.pop("hidden_rules", None)
    result = _call_llm(text, overrides, api_config, hidden_rules=hidden_rules)
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
    hidden_rules = overrides.pop("hidden_rules", None)
    result = _call_llm_polish(text, old_translation, overrides, api_config, hidden_rules=hidden_rules)
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
    """分词专用批量流式响应（返回 tag_l1/tag_l2/confidence 而非 translation）"""
    def generate():
        for i in empty_indices:
            yield (json.dumps({"index": i, "tag_l1": "", "tag_l2": "", "confidence": 0, "error": ""}, ensure_ascii=False) + "\n").encode("utf-8")
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            future_map = {}
            for idx, item in valid_items:
                future = submit_fn(executor, idx, item)
                future_map[future] = idx
            for future in as_completed(future_map):
                idx = future_map[future]
                try:
                    result = future.result()
                except Exception as exc:
                    result = {"translation": "", "error": str(exc)}
                # 解析 LLM 返回的分类 JSON（后端统一解析，前端直接使用）
                tag_l1, tag_l2, confidence = "", "", 0
                content = result.get("translation", "")
                if content and not result.get("error"):
                    try:
                        s = content.index("{")
                        e = content.rindex("}")
                        j = json.loads(content[s:e+1])
                        tag_l1 = j.get("l1", "")
                        tag_l2 = j.get("l2", "")
                        confidence = j.get("confidence", 0)
                    except (ValueError, json.JSONDecodeError, KeyError):
                        pass
                line = json.dumps({
                    "index": idx,
                    "tag_l1": tag_l1,
                    "tag_l2": tag_l2,
                    "confidence": confidence,
                    "error": result.get("error", ""),
                }, ensure_ascii=False)
                yield (line + "\n").encode("utf-8")
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


def _stream_batch_response(valid_items, empty_indices, concurrency, submit_fn):
    """通用批量翻译流式响应
    - valid_items: [(index, item), ...]  需要翻译的条目
    - empty_indices: set  空原文的索引
    - concurrency: int  并发数
    - submit_fn: callable(executor, idx, item) -> Future  提交翻译任务
    """
    def generate():
        for i in empty_indices:
            yield (json.dumps({"index": i, "new_translation": "", "error": ""}, ensure_ascii=False) + "\n").encode("utf-8")
        with ThreadPoolExecutor(max_workers=concurrency) as executor:
            future_map = {}
            for idx, item in valid_items:
                future = submit_fn(executor, idx, item)
                future_map[future] = idx
            for future in as_completed(future_map):
                idx = future_map[future]
                try:
                    result = future.result()
                except Exception as exc:
                    result = {"translation": "", "error": str(exc)}
                line = json.dumps({
                    "index": idx,
                    "new_translation": result.get("translation", ""),
                    "error": result.get("error", ""),
                    "truncated": result.get("truncated", False),
                    "warning": result.get("warning", ""),
                    "degraded": result.get("degraded", False),
                }, ensure_ascii=False)
                yield (line + "\n").encode("utf-8")
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
    hidden_rules = overrides.pop("hidden_rules", None)

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
            hidden_rules=hidden_rules
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
    hidden_rules = overrides.pop("hidden_rules", None)

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
            hidden_rules=hidden_rules,
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
        "hidden_rules": _HIDDEN_RULES,
        "hidden_rules_base": _HIDDEN_RULES_BASE,
        "hidden_rules_blend": _HIDDEN_RULES_BLEND,
        "default_tag_strategy": DEFAULT_TAG_STRATEGY,
        "presets": {
            "direct": [
                {
                    "id": "__preset_ui_direct__",
                    "name": "UI / Mod（术语）",
                    "text": "你是一个专业游戏中文本地化专家，专精于UI、菜单、控件、Mod说明及软件界面翻译。\n请将给定原文翻译为中文，严格遵循以下规则：\n1. 术语第一：识别并保持游戏/软件专业术语、缩写、变量名（如{0}、%s）、快捷键（&键）的绝对准确与一致，必要时保留英文原词。\n2. 极度简洁：UI空间有限，译文必须比原文更短或等长，严禁添加解释性文字。\n3. 功能明确：按钮和选项翻译需能直接反映其点击后的操作，避免歧义。\n4. 格式保留：完整保留原文中的换行、空格、占位符和特殊符号。\n注意只需要输出翻译后的结果，不要额外解释。",
                    "locked": True
                },
                {
                    "id": "__preset_dialogue_direct__",
                    "name": "对话 / 剧情（生动）",
                    "text": "你是一个顶尖的游戏本地化及配音脚本翻译专家。\n请将以下游戏对话/剧情文本翻译成中文。你的唯一信条：译文必须听起来像一个以中文为母语的角色，在那一刻会自然而然说出的话。\n遵循以下要求：\n1. 声入人心：根据上下文判断角色性格与情绪，中文对白必须贴合其身份、年龄和当下情感，保留俚语、口头禅和语气词。\n2. 彻底摆脱翻译腔：无视原文的英文句式结构，用地道中文口语彻底重写。被动变主动，名词变动词，长句化短句。\n3. 情境优先：为达到原文的戏剧效果或情感冲击力，可以牺牲字面翻译，进行创造性改写（意译）。\n4. 注意保持原文格式，只需要输出翻译后的结果，不要额外解释。",
                    "locked": True
                }
            ],
            "polish": [
                {
                    "id": "__preset_ui_polish__",
                    "name": "UI / Mod（术语）",
                    "text": "你是一个专业中文本地化直译专家。\n请对给定原文进行极度忠实、结构对齐的直译。保留所有术语、占位符、快捷键标记不翻译。\n保留原文的换行和格式。即使读起来生硬，也务必保留原文语序和结构。\n注意只需要输出翻译后的结果，不要额外解释。",
                    "step2": "你是一个专业游戏UI本地化校对专家。\n现在给你两个版本的译文：\n直译新译文：极度忠实原文结构和术语，但可能生硬。\n旧译文：线上正在使用的版本，可能更流畅但可能有术语错误或格式问题。\n请融合两者优点，输出最终UI译文，遵循铁律：\n1. 术语绝对准确：旧译文术语若与直译新译文冲突，以直译新译文的术语为准，修正旧译文错误。\n2. 极致简洁：删除所有冗余字词，确保译文长度不超过原文。\n3. 功能无歧义：按钮/选项的翻译必须清晰传达其功能。\n4. 修复格式：确保占位符、快捷键标记与直译新译文完全一致。\n5. 有限润色：在满足以上4条的前提下，可微调用词使其略为通顺，但绝不扩展或意译。\n只输出最终译文，不要额外解释。",
                    "locked": True
                },
                {
                    "id": "__preset_dialogue_polish__",
                    "name": "对话 / 剧情（生动）",
                    "text": "你是一个专业游戏翻译初稿专家。\n请将以下游戏对话翻译成中文。目标是产出一个意思准确、基本通顺、但没有经过精细艺术加工的初稿。\n要求：\n- 准确传达原文的语义和情绪基调（喜怒哀乐）。\n- 保留所有关键信息、比喻和俚语意象（即使暂时读起来有点生硬）。\n- 可以保留部分原文结构，但需转换成通顺的中文。\n- 这是半成品，不需要完美，但必须为下一步的艺术润色提供无误的原材料。\n注意只需要输出翻译后的结果，不要额外解释。",
                    "step2": "你是一个顶尖的游戏本地化润色及配音导演。\n现在给你两个版本的译文：\n直译新译文：意思准确、情绪基调正确，但缺乏艺术加工，可能略带翻译腔。\n旧译文：可能是来自旧版翻译的参考，有可取之处但也可能存在问题。\n你的任务是基于这两个版本，进行彻底的创造性重写，以产出最终中文对白。务必遵循：\n1. 唯一目标：最终译文必须听起来像原生中文游戏的精彩对白，完全消除翻译腔。\n2. 导演思维：想象角色正在说这句话。它的语气、节奏、用词是否100%贴合此情此景的角色？如果不，就改到贴合为止。\n3. 敢于重写：不被直译新译文的句子结构束缚。取其意，忘其形。继承旧译文中的神来之笔，但毫不犹豫地改写平淡或出戏的部分。\n4. 活化语言：善用中文四字格、俗语、语气词、短句，让对白\"活\"起来。\n5. 情感校准：确保最终译文的情绪冲击力，不低于、甚至要超越原文。\n只输出最终润色后的中文对白，不要额外解释。",
                    "locked": True
                }
            ]
        }
    })

import atexit
atexit.register(_close_session)

if __name__ == "__main__":
    os.makedirs("static", exist_ok=True)
    print(f"TxtLlmHub 启动: http://127.0.0.1:5000")
    print(f"LLM API: {LLM_API_URL}")
    app.run(host="127.0.0.1", port=5000, debug=False)
