"""Local AI router — stdlib-only LLM abstraction for RackPilot.

Providers supported:
  anthropic — claude-* via messages API
  openai    — gpt-* via chat completions API
  local     — rule-based classifier only, no external calls

API keys are never stored in the DB; they are read from the environment
variable named in ai_router_config.env_key_var (default ANTHROPIC_API_KEY).
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any

# ---------------------------------------------------------------------------
# Local intent classifier (no external calls required)
# ---------------------------------------------------------------------------

_INTENT_PATTERNS: list[tuple[str, list[str]]] = [
    ("search",   [r"\bнайди\b", r"\bпоиск\b", r"\bsearch\b", r"\bfind\b", r"\bwhere\b", r"\bгде\b"]),
    ("summary",  [r"\bкратко\b", r"\bsuммаriz", r"\bсуммаризуй\b", r"\bsummariz", r"\bкратк"]),
    ("report",   [r"\bотчёт\b", r"\bотчет\b", r"\breport\b", r"\bстатус\b", r"\bstatus\b"]),
    ("command",  [r"\bсоздай\b", r"\bудали\b", r"\bобнови\b", r"\bcreate\b", r"\bdelete\b", r"\bupdate\b"]),
    ("question", [r"\bчто\b", r"\bкак\b", r"\bпочему\b", r"\bwhat\b", r"\bhow\b", r"\bwhy\b", r"\bwhen\b"]),
]

_TAG_PATTERNS: list[tuple[str, list[str]]] = [
    ("asset",    [r"\bактив\b", r"\bоборудован", r"\basset\b", r"\bequipment\b", r"\bdevice\b"]),
    ("location", [r"\bэтаж\b", r"\bкомнат\b", r"\bзона\b", r"\broom\b", r"\bfloor\b", r"\bzone\b"]),
    ("project",  [r"\bпроект\b", r"\bproject\b"]),
    ("document", [r"\bдокумент\b", r"\bфайл\b", r"\bdocument\b", r"\bfile\b", r"\bпдф\b", r"\bpdf\b"]),
    ("time",     [r"\bвремя\b", r"\bрасписание\b", r"\btime\b", r"\bschedule\b", r"\bдата\b"]),
]


def classify(text: str) -> dict[str, Any]:
    """Return intent + tags + confidence without any external calls."""
    low = text.lower()
    intent = "unknown"
    confidence = 0.5

    for name, patterns in _INTENT_PATTERNS:
        if any(re.search(p, low) for p in patterns):
            intent = name
            confidence = 0.85
            break

    tags = [
        tag for tag, patterns in _TAG_PATTERNS
        if any(re.search(p, low) for p in patterns)
    ]
    return {"intent": intent, "confidence": confidence, "tags": tags}


# ---------------------------------------------------------------------------
# External LLM call (stdlib urllib only)
# ---------------------------------------------------------------------------

def _anthropic_request(
    api_key: str,
    model: str,
    system: str,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    body = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "system": system,
        "messages": messages,
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    content = data.get("content", [])
    text = "".join(c.get("text", "") for c in content if c.get("type") == "text")
    usage = data.get("usage", {})
    return {
        "text": text,
        "prompt_tokens": usage.get("input_tokens", 0),
        "completion_tokens": usage.get("output_tokens", 0),
    }


def _openai_request(
    api_key: str,
    model: str,
    system: str,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    chat_messages = [{"role": "system", "content": system}] + messages
    body = json.dumps({
        "model": model,
        "messages": chat_messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "content-type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    text = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return {
        "text": text,
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
    }


# ---------------------------------------------------------------------------
# AIRouter facade
# ---------------------------------------------------------------------------

class AIRouter:
    """Thin facade over provider-specific LLM calls."""

    def __init__(self, config: dict[str, Any]) -> None:
        self._provider = config.get("provider", "anthropic")
        self._model = config.get("model", "claude-haiku-4-5-20251001")
        self._env_key_var = config.get("env_key_var", "ANTHROPIC_API_KEY")
        self._max_tokens = int(config.get("max_tokens", 1024))
        self._temperature = float(config.get("temperature", 0.3))
        self._enabled = bool(config.get("enabled", True))

    # -- public ---------------------------------------------------------------

    @property
    def available(self) -> bool:
        if not self._enabled:
            return False
        if self._provider == "local":
            return True
        return bool(os.environ.get(self._env_key_var))

    @property
    def provider(self) -> str:
        return self._provider

    @property
    def model(self) -> str:
        return self._model

    def classify(self, text: str) -> dict[str, Any]:
        return classify(text)

    def invoke(
        self,
        prompt: str,
        system: str = "You are a helpful field operations assistant.",
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> dict[str, Any]:
        if not self.available:
            raise RuntimeError("AI router not available: check provider config and API key env var")

        if self._provider == "local":
            return {"text": f"[local] {classify(prompt)}", "prompt_tokens": 0, "completion_tokens": 0}

        api_key = os.environ.get(self._env_key_var, "")
        if not api_key:
            raise RuntimeError(f"API key env var {self._env_key_var!r} is not set")

        mt = max_tokens if max_tokens is not None else self._max_tokens
        temp = temperature if temperature is not None else self._temperature
        messages = [{"role": "user", "content": prompt}]

        t0 = time.monotonic()
        try:
            if self._provider == "anthropic":
                result = _anthropic_request(api_key, self._model, system, messages, mt, temp)
            elif self._provider == "openai":
                result = _openai_request(api_key, self._model, system, messages, mt, temp)
            else:
                raise ValueError(f"unknown provider: {self._provider!r}")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors="replace")
            raise RuntimeError(f"LLM API error {exc.code}: {body[:200]}") from exc

        result["latency_ms"] = int((time.monotonic() - t0) * 1000)
        result["provider"] = self._provider
        result["model"] = self._model
        return result

    def summarize(self, text: str, max_words: int = 120) -> dict[str, Any]:
        system = "You are a concise technical summarizer. Reply only with the summary, no preamble."
        prompt = f"Summarize the following in {max_words} words or fewer:\n\n{text}"
        return self.invoke(prompt, system=system, max_tokens=min(self._max_tokens, max_words * 4))

    # -- default config when table has no row --------------------------------

    @classmethod
    def default(cls) -> "AIRouter":
        return cls({
            "provider": "local",
            "model": "local",
            "env_key_var": "ANTHROPIC_API_KEY",
            "max_tokens": 1024,
            "temperature": 0.3,
            "enabled": True,
        })
