# 大模型网关模块
# 职责:封装 OpenAI 兼容 API 调用,从环境变量读取配置
# 安全规则:
# - API Key 仅从环境变量 MODEL_API_KEY 读取(绝不硬编码、绝不返回给前端)
# - 未配置 API Key 时返回明确错误 E4002,不假装调用成功
# - 大模型不得计算任何数值(规则 8),数值由后端工具计算
# - 超时/网络错误返回明确错误,不编造结果

import json
import os
from dataclasses import dataclass, field

import httpx


class LLMGatewayError(Exception):
    """大模型网关异常,携带错误码与详细信息。

    Attributes:
        code: 错误码(E4002 配置缺失 / E4003 调用失败)
        message: 错误摘要
        detail: 错误详情
    """

    def __init__(self, code: str, message: str, detail: str = ""):
        self.code = code
        self.message = message
        self.detail = detail
        super().__init__(f"[{code}] {message}" + (f": {detail}" if detail else ""))


@dataclass
class LLMConfig:
    """大模型配置(从环境变量读取)。

    Attributes:
        base_url: API 基础地址(含 /v1,不含 /chat/completions)
        api_key: API Key(仅后端持有)
        model: 模型名称
        timeout: 请求超时(秒)
    """
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout: int = 30


def load_llm_config() -> LLMConfig:
    """从环境变量加载大模型配置。

    读取 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME / MODEL_TIMEOUT。
    同时兼容旧变量名 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_TIMEOUT。
    """
    return LLMConfig(
        base_url=os.environ.get("MODEL_BASE_URL", os.environ.get("LLM_BASE_URL", "")),
        api_key=os.environ.get("MODEL_API_KEY", os.environ.get("LLM_API_KEY", "")),
        model=os.environ.get("MODEL_NAME", os.environ.get("LLM_MODEL", "")),
        timeout=int(os.environ.get("MODEL_TIMEOUT", os.environ.get("LLM_TIMEOUT", "30"))),
    )


def is_configured() -> bool:
    """检查大模型是否已配置(API Key 非空)。

    前端据此决定是否启用运行时 Agent,或显示配置提示。
    """
    config = load_llm_config()
    return bool(config.api_key and config.base_url and config.model)


@dataclass
class ChatMessage:
    """对话消息(OpenAI 兼容格式)。

    Attributes:
        role: 角色 system / user / assistant / tool
        content: 文本内容
        tool_calls: assistant 消息中的工具调用列表
        tool_call_id: tool 消息对应的调用 ID
        name: tool 消息对应的工具名
    """
    role: str
    content: str | None = None
    tool_calls: list[dict] | None = None
    tool_call_id: str | None = None
    name: str | None = None

    def to_dict(self) -> dict:
        """转为 OpenAI API 请求体中的 message 字典。

        注意:tool_calls 中 function.arguments 必须是 JSON 字符串(非 dict),
        DeepSeek 等严格实现的 API 会拒绝 dict 类型的 arguments(E422)。
        """
        d: dict = {"role": self.role}
        if self.content is not None:
            d["content"] = self.content
        if self.tool_calls is not None:
            # 确保 arguments 为 JSON 字符串(兼容 DeepSeek 严格校验)
            serialized_calls = []
            for tc in self.tool_calls:
                tc_copy = dict(tc)
                fn = tc_copy.get("function", {})
                if isinstance(fn.get("arguments"), dict):
                    fn_copy = dict(fn)
                    fn_copy["arguments"] = json.dumps(fn["arguments"], ensure_ascii=False)
                    tc_copy["function"] = fn_copy
                serialized_calls.append(tc_copy)
            d["tool_calls"] = serialized_calls
        if self.tool_call_id is not None:
            d["tool_call_id"] = self.tool_call_id
        if self.name is not None:
            d["name"] = self.name
        return d


@dataclass
class LLMResponse:
    """大模型响应。

    Attributes:
        content: 文本回复(可能为空,如果模型选择调用工具)
        tool_calls: 工具调用列表,每项:{"id": str, "type": "function",
                     "function": {"name": str, "arguments": str}}
        finish_reason: 结束原因(stop / tool_calls / length)
        model_used: 实际使用的模型名
        usage: token 用量统计
    """
    content: str | None = None
    tool_calls: list[dict] = field(default_factory=list)
    finish_reason: str = ""
    model_used: str = ""
    usage: dict = field(default_factory=dict)


def chat_completion(
    messages: list[ChatMessage],
    tools: list[dict] | None = None,
    tool_choice: str | dict = "auto",
    temperature: float = 0.1,
    max_tokens: int = 4096,
) -> LLMResponse:
    """调用 OpenAI 兼容 chat/completions API。

    Args:
        messages: 对话消息列表
        tools: 可用工具定义(OpenAI function calling 格式)
        tool_choice: 工具选择策略("auto" / "none" / 指定工具)
        temperature: 温度参数(Agent 场景用低温度保证确定性)
        max_tokens: 最大生成 token 数

    Returns:
        LLMResponse

    Raises:
        LLMGatewayError:
            E4002 — 未配置 API Key / base_url / model
            E4003 — API 调用失败(网络/超时/HTTP错误/响应解析失败)
    """
    config = load_llm_config()

    # 配置校验:未配置时返回明确错误,不假装成功
    if not config.api_key:
        raise LLMGatewayError(
            "E4002",
            "未配置模型 API Key",
            "请在后端环境变量中设置 MODEL_API_KEY(参见 .env.example),"
            "配置后重启服务。API Key 不会出现在前端代码中。",
        )
    if not config.base_url:
        raise LLMGatewayError(
            "E4002",
            "未配置模型 API 地址",
            "请在后端环境变量中设置 MODEL_BASE_URL(OpenAI 兼容地址,含 /v1)。",
        )
    if not config.model:
        raise LLMGatewayError(
            "E4002",
            "未配置模型名称",
            "请在后端环境变量中设置 MODEL_NAME(如 gpt-4o-mini)。",
        )

    # 构建请求体
    url = config.base_url.rstrip("/") + "/chat/completions"
    payload: dict = {
        "model": config.model,
        "messages": [m.to_dict() for m in messages],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice

    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Content-Type": "application/json",
    }

    # 发起 HTTP 请求
    try:
        with httpx.Client(timeout=config.timeout) as client:
            resp = client.post(url, json=payload, headers=headers)
    except httpx.TimeoutException as e:
        raise LLMGatewayError(
            "E4003",
            f"模型 API 请求超时({config.timeout}秒)",
            f"请求地址: {url},模型: {config.model}。请增大 MODEL_TIMEOUT 或检查网络。",
        )
    except httpx.ConnectError as e:
        raise LLMGatewayError(
            "E4003",
            "无法连接模型 API 服务器",
            f"请求地址: {url},连接错误: {e}",
        )
    except httpx.HTTPError as e:
        raise LLMGatewayError(
            "E4003",
            "模型 API 请求失败",
            f"HTTP 错误: {e}",
        )

    # HTTP 状态码校验
    if resp.status_code == 401:
        raise LLMGatewayError(
            "E4003",
            "模型 API 认证失败(401)",
            "MODEL_API_KEY 无效或已过期,请检查环境变量配置。",
        )
    if resp.status_code == 429:
        raise LLMGatewayError(
            "E4003",
            "模型 API 请求限流(429)",
            "请求过于频繁或配额已用尽,请稍后重试。",
        )
    if resp.status_code >= 500:
        raise LLMGatewayError(
            "E4003",
            f"模型 API 服务端错误({resp.status_code})",
            f"响应: {resp.text[:500]}",
        )
    if resp.status_code != 200:
        raise LLMGatewayError(
            "E4003",
            f"模型 API 返回异常状态码({resp.status_code})",
            f"响应: {resp.text[:500]}",
        )

    # 解析响应
    try:
        body = resp.json()
    except Exception as e:
        raise LLMGatewayError(
            "E4003",
            "模型 API 响应解析失败(非 JSON)",
            f"响应前 500 字符: {resp.text[:500]}",
        )

    try:
        choice = body["choices"][0]
        message = choice["message"]
        tool_calls = message.get("tool_calls") or []
        # 解析 tool_calls 中的 arguments(JSON 字符串 → dict)
        parsed_tool_calls = []
        for tc in tool_calls:
            fn = tc.get("function", {})
            args_str = fn.get("arguments", "{}")
            try:
                args = json.loads(args_str) if args_str else {}
            except Exception:
                args = {"_raw_arguments": args_str}
            parsed_tool_calls.append({
                "id": tc.get("id", ""),
                "type": "function",
                "function": {
                    "name": fn.get("name", ""),
                    "arguments": args,
                },
            })
        return LLMResponse(
            content=message.get("content"),
            tool_calls=parsed_tool_calls,
            finish_reason=choice.get("finish_reason", ""),
            model_used=body.get("model", config.model),
            usage=body.get("usage", {}),
        )
    except (KeyError, IndexError, TypeError) as e:
        raise LLMGatewayError(
            "E4003",
            "模型 API 响应结构异常",
            f"解析错误: {e},响应: {str(body)[:500]}",
        )