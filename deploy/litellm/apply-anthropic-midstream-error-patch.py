#!/usr/bin/env python3
"""Apply Anthropic streaming safety fixes to pinned LiteLLM v1.93.0."""

from __future__ import annotations

import py_compile
import site
import sys
from pathlib import Path


MODULE_PATH = Path(
    "litellm/llms/anthropic/experimental_pass_through/adapters/streaming_iterator.py"
)
RESPONSES_MODULE_PATH = Path(
    "litellm/llms/anthropic/experimental_pass_through/responses_adapters/streaming_iterator.py"
)
TOKEN_COUNTER_MODULE_PATH = Path("litellm/litellm_core_utils/token_counter.py")
PROXY_SERVER_MODULE_PATH = Path("litellm/proxy/proxy_server.py")
ANTHROPIC_ENDPOINTS_MODULE_PATH = Path("litellm/proxy/anthropic_endpoints/endpoints.py")

STANDARD_IMPORT_ANCHOR = "import copy\nimport json\nimport traceback\n"
PATCHED_STANDARD_IMPORTS = (
    "import asyncio\n"
    "import contextlib\n"
    "import copy\n"
    "import json\n"
    "import os\n"
    "import traceback\n"
)

IMPORT_ANCHOR = "from litellm._uuid import uuid\n"
PATCHED_IMPORTS = (
    "from litellm._uuid import uuid\n"
    "from litellm.exceptions import MidStreamFallbackError\n"
    "from litellm.llms.base_llm.chat.transformation import BaseLLMException\n"
)

HELPER_ANCHOR = """if TYPE_CHECKING:
    from litellm.types.utils import ModelResponseStream


class _CombinedChunkSplitter:
"""
PATCHED_HELPERS = """if TYPE_CHECKING:
    from litellm.types.utils import ModelResponseStream


DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS = 15_000


def _anthropic_sse_heartbeat_interval_seconds() -> float:
    raw = os.environ.get("LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS")
    if raw is None or not raw.strip():
        return DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS / 1000
    try:
        value = int(raw)
    except ValueError:
        value = DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS
    if value < 0:
        value = DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS
    return value / 1000


def _anthropic_sse_ping_event() -> bytes:
    return b'event: ping\\ndata: {"type":"ping"}\\n\\n'


def _error_status_and_message(exc: Exception) -> tuple[int, str]:
    if isinstance(exc, (BaseLLMException, MidStreamFallbackError)):
        return exc.status_code, exc.message
    return 500, str(exc) or "Upstream stream ended before completion"


def _mid_stream_error_sse_event(exc: Exception) -> bytes:
    from litellm.anthropic_interface.exceptions.exception_mapping_utils import (
        AnthropicExceptionMapping,
    )

    status_code, message = _error_status_and_message(exc)
    error_response = AnthropicExceptionMapping.transform_to_anthropic_error(
        status_code=status_code,
        raw_message=message,
    )
    return f"event: error\\ndata: {json.dumps(error_response)}\\n\\n".encode()


class _CombinedChunkSplitter:
"""

ORIGINAL_WRAPPER = '''    async def async_anthropic_sse_wrapper(self) -> AsyncIterator[bytes]:
        """
        Async version of anthropic_sse_wrapper.
        Convert AnthropicStreamWrapper dict chunks to Server-Sent Events format.
        """
        async for chunk in self:
            if isinstance(chunk, dict):
                event_type: str = str(chunk.get("type", "message"))
                payload = f"event: {event_type}\\ndata: {json.dumps(chunk)}\\n\\n"
                yield payload.encode()
            else:
                # For non-dict chunks, forward the original value unchanged
                yield chunk
'''

PATCHED_WRAPPER = '''    async def async_anthropic_sse_wrapper(self) -> AsyncIterator[bytes]:
        """
        Async version of anthropic_sse_wrapper.
        Convert AnthropicStreamWrapper dict chunks to Server-Sent Events format.
        """
        heartbeat_interval = _anthropic_sse_heartbeat_interval_seconds()
        pending_chunk: Optional[asyncio.Task[Any]] = None
        try:
            while True:
                if pending_chunk is None:
                    pending_chunk = asyncio.create_task(self.__anext__())

                if heartbeat_interval > 0:
                    done, _ = await asyncio.wait(
                        {pending_chunk},
                        timeout=heartbeat_interval,
                    )
                    if not done:
                        yield _anthropic_sse_ping_event()
                        continue

                try:
                    chunk = await pending_chunk
                except StopAsyncIteration:
                    pending_chunk = None
                    break
                pending_chunk = None

                if isinstance(chunk, dict):
                    event_type: str = str(chunk.get("type", "message"))
                    payload = f"event: {event_type}\\ndata: {json.dumps(chunk)}\\n\\n"
                    yield payload.encode()
                else:
                    yield chunk
        except Exception as exc:  # noqa: BLE001
            verbose_logger.exception(
                "Anthropic Adapter - mid-stream error, emitting Anthropic error event: %s",
                exc,
            )
            yield _mid_stream_error_sse_event(exc)
        finally:
            if pending_chunk is not None:
                if not pending_chunk.done():
                    pending_chunk.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await pending_chunk
'''

RESPONSES_IMPORT_ANCHOR = '''import json
import traceback
from collections import deque
from typing import Any, AsyncIterator, Dict

from litellm import verbose_logger
from litellm._uuid import uuid
'''

RESPONSES_PATCHED_IMPORTS = '''import asyncio
import contextlib
import json
import os
import traceback
from collections import deque
from typing import Any, AsyncIterator, Dict

from litellm import verbose_logger
from litellm._uuid import uuid
'''

RESPONSES_HELPER_ANCHOR = '''from litellm._uuid import uuid


class AnthropicResponsesStreamWrapper:'''

RESPONSES_PATCHED_HELPERS = '''from litellm._uuid import uuid


DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS = 15_000


def _anthropic_sse_heartbeat_interval_seconds() -> float:
    raw = os.environ.get("LITELLM_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS")
    if raw is None or not raw.strip():
        return DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS / 1000
    try:
        value = int(raw)
    except ValueError:
        value = DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS
    if value < 0:
        value = DEFAULT_ANTHROPIC_SSE_HEARTBEAT_INTERVAL_MS
    return value / 1000


def _anthropic_sse_ping_event() -> bytes:
    return b'event: ping\\ndata: {"type":"ping"}\\n\\n'


class AnthropicResponsesStreamWrapper:'''

RESPONSES_ORIGINAL_WRAPPER = '''    async def async_anthropic_sse_wrapper(self) -> AsyncIterator[bytes]:
        """Yield SSE-encoded bytes for each Anthropic event chunk."""
        async for chunk in self:
            if isinstance(chunk, dict):
                event_type: str = str(chunk.get("type", "message"))
                payload = f"event: {event_type}\\ndata: {json.dumps(chunk)}\\n\\n"
                yield payload.encode()
            else:
                yield chunk
'''

RESPONSES_PATCHED_WRAPPER = '''    async def async_anthropic_sse_wrapper(self) -> AsyncIterator[bytes]:
        """Yield SSE events and keep quiet Responses streams observable."""
        heartbeat_interval = _anthropic_sse_heartbeat_interval_seconds()
        pending_chunk = None
        try:
            while True:
                if pending_chunk is None:
                    pending_chunk = asyncio.create_task(self.__anext__())

                if heartbeat_interval > 0:
                    done, _ = await asyncio.wait(
                        {pending_chunk},
                        timeout=heartbeat_interval,
                    )
                    if not done:
                        yield _anthropic_sse_ping_event()
                        continue

                try:
                    chunk = await pending_chunk
                except StopAsyncIteration:
                    pending_chunk = None
                    break
                pending_chunk = None

                if isinstance(chunk, dict):
                    event_type: str = str(chunk.get("type", "message"))
                    payload = f"event: {event_type}\\ndata: {json.dumps(chunk)}\\n\\n"
                    yield payload.encode()
                else:
                    yield chunk
        finally:
            if pending_chunk is not None:
                if not pending_chunk.done():
                    pending_chunk.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await pending_chunk
'''

TOKEN_COUNTER_MARKER = "def _chat2api_anthropic_image_url("
TOKEN_COUNTER_HELPER_ANCHOR = "def _count_content_list(\n"
TOKEN_COUNTER_PATCHED_HELPERS = '''def _chat2api_anthropic_image_url(source: Any) -> dict[str, Any]:
    """Convert an Anthropic image source to LiteLLM's image_url shape."""
    if not isinstance(source, dict):
        raise ValueError("Anthropic image source must be an object")

    source_type = source.get("type")
    if source_type == "base64":
        data = source.get("data")
        if not isinstance(data, str) or not data:
            raise ValueError("Anthropic base64 image source requires data")
        # The pinned LiteLLM counter uses the default image cost for auto
        # detail and does not inspect this value. Avoid duplicating a large
        # base64 payload only to obtain that fixed cost.
        url = "anthropic-base64:opaque"
    elif source_type == "url":
        url = source.get("url")
        if not isinstance(url, str) or not url:
            raise ValueError("Anthropic URL image source requires url")
        url = "anthropic-url:opaque"
    elif source_type == "file":
        file_id = source.get("file_id")
        if not isinstance(file_id, str) or not file_id:
            raise ValueError("Anthropic file image source requires file_id")
        url = "anthropic-file:opaque"
    else:
        reference = source.get("url") or source.get("file_id") or source.get("id") or source.get("data")
        if not isinstance(source_type, str) or not source_type or not isinstance(reference, str) or not reference:
            raise ValueError(f"Unsupported Anthropic image source type: {source_type}")
        # Future reference-backed image source types still receive the normal
        # image cost without sending their opaque value to the tokenizer.
        url = "anthropic-reference:opaque"

    return {"url": url, "detail": "auto"}


_CHAT2API_ANTHROPIC_MAX_CONTENT_DEPTH = 64
_CHAT2API_ANTHROPIC_MAX_CONTENT_NODES = 20_000
_CHAT2API_ANTHROPIC_MAX_TOKENIZED_CHARS = 32 * 1024
_CHAT2API_ANTHROPIC_TOKENIZER_CHUNK_CHARS = 4 * 1024
_CHAT2API_ANTHROPIC_MAX_FALLBACK_INSPECTIONS = 256
_CHAT2API_ANTHROPIC_STRUCTURAL_FALLBACK_TOKENS = (
    _CHAT2API_ANTHROPIC_MAX_TOKENIZED_CHARS + _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES
)
_CHAT2API_ANTHROPIC_UNRESOLVED_DOCUMENT_TOKENS = 4_096
# These fields describe the block itself or transport metadata.  Citation
# objects contain user-visible fields such as ``cited_text`` and ``title``;
# they must remain in the token-count traversal when replaying assistant
# messages through Anthropic's Messages API.
_CHAT2API_ANTHROPIC_STRUCTURAL_FIELDS = frozenset({"type", "cache_control"})
_CHAT2API_ANTHROPIC_ENCRYPTED_FIELDS = frozenset({"signature", "encrypted_content", "encrypted_stdout"})


def _chat2api_skip_anthropic_field(content_type: Any, field_name: str) -> bool:
    return (
        field_name in _CHAT2API_ANTHROPIC_STRUCTURAL_FIELDS
        or field_name in _CHAT2API_ANTHROPIC_ENCRYPTED_FIELDS
        or field_name.startswith("encrypted_")
        or (content_type == "redacted_thinking" and field_name == "data")
    )


def _chat2api_text_token_upper_bound(value: str) -> int:
    """Return an allocation-free upper bound for byte-level BPE tokens."""
    bytes_per_character = 1 if value.isascii() else 4
    return len(value) * bytes_per_character


def _chat2api_new_count_state() -> dict[str, Any]:
    return {
        "nodes": 0,
        "text_chars": 0,
        "truncated": False,
        "fallback_tokens": 0,
        "fallback_inspections": 0,
        "fallback_exhausted": False,
    }


def _chat2api_count_text_bounded(
    value: str,
    count_function: TokenCounterFunction,
    state: dict[str, Any],
) -> int:
    """Tokenize text in bounded chunks and flag a conservative fallback on exhaustion."""
    if not value:
        return 0

    if state["truncated"]:
        _chat2api_add_fallback_value(value, state)
        return 0

    available = _CHAT2API_ANTHROPIC_MAX_TOKENIZED_CHARS - state["text_chars"]
    if available <= 0:
        state["truncated"] = True
        state["fallback_tokens"] += _chat2api_text_token_upper_bound(value)
        return 0

    if len(value) <= _CHAT2API_ANTHROPIC_TOKENIZER_CHUNK_CHARS and len(value) <= available:
        state["text_chars"] += len(value)
        try:
            return count_function(value)
        except Exception:
            state["truncated"] = True
            state["fallback_tokens"] += _chat2api_text_token_upper_bound(value)
            return 0

    text = value[:available]
    state["text_chars"] += len(text)
    if len(text) != len(value):
        state["truncated"] = True
        remaining_characters = len(value) - len(text)
        bytes_per_character = 1 if value.isascii() else 4
        state["fallback_tokens"] += remaining_characters * bytes_per_character

    tokens = 0
    for offset in range(0, len(text), _CHAT2API_ANTHROPIC_TOKENIZER_CHUNK_CHARS):
        chunk = text[offset : offset + _CHAT2API_ANTHROPIC_TOKENIZER_CHUNK_CHARS]
        try:
            tokens += count_function(chunk)
        except Exception:
            state["truncated"] = True
            # One token per possible UTF-8 byte is conservative without
            # allocating an encoded copy of the request text.
            tokens += _chat2api_text_token_upper_bound(chunk)
            remaining = text[offset + len(chunk) :]
            state["fallback_tokens"] += _chat2api_text_token_upper_bound(remaining)
            break
    return tokens


def _chat2api_count_text_safe(value: str, count_function: TokenCounterFunction) -> int:
    state = _chat2api_new_count_state()
    tokens = _chat2api_count_text_bounded(value, count_function, state)
    return tokens + state["fallback_tokens"]


def _chat2api_exhaust_fallback_inspection(state: dict[str, Any]) -> None:
    if state["fallback_exhausted"]:
        return
    state["fallback_exhausted"] = True
    state["fallback_tokens"] += _CHAT2API_ANTHROPIC_STRUCTURAL_FALLBACK_TOKENS


def _chat2api_add_fallback_value(value: Any, state: dict[str, Any]) -> None:
    """Inspect an unprocessed value with a shared bound and without copying it."""
    if state["fallback_exhausted"]:
        return

    pending: list[tuple[Any, Optional[str], Optional[str]]] = [(value, None, None)]
    while pending:
        if state["fallback_inspections"] >= _CHAT2API_ANTHROPIC_MAX_FALLBACK_INSPECTIONS:
            _chat2api_exhaust_fallback_inspection(state)
            return

        current, field_name, parent_type = pending.pop()
        state["fallback_inspections"] += 1
        if field_name is not None and _chat2api_skip_anthropic_field(parent_type, field_name):
            continue

        if isinstance(current, str):
            state["fallback_tokens"] += max(1, _chat2api_text_token_upper_bound(current))
            continue
        if current is None:
            state["fallback_tokens"] += 1
            continue
        if isinstance(current, bool):
            state["fallback_tokens"] += 5
            continue
        if isinstance(current, (int, float)):
            state["fallback_tokens"] += max(1, len(str(current)))
            continue
        if isinstance(current, (bytes, bytearray)):
            state["fallback_tokens"] += max(1, len(current))
            continue

        if isinstance(current, Mapping):
            state["fallback_tokens"] += 1 + len(current) * 2
            content_type = current.get("type")
            available = (
                _CHAT2API_ANTHROPIC_MAX_FALLBACK_INSPECTIONS
                - state["fallback_inspections"]
                - len(pending)
            )
            if available <= 0:
                _chat2api_exhaust_fallback_inspection(state)
                return
            appended = 0
            for key, nested_value in current.items():
                nested_field = key if isinstance(key, str) else type(key).__name__
                if _chat2api_skip_anthropic_field(content_type, nested_field):
                    continue
                if appended >= available:
                    _chat2api_exhaust_fallback_inspection(state)
                    return
                state["fallback_tokens"] += _chat2api_text_token_upper_bound(nested_field)
                pending.append((nested_value, nested_field, content_type))
                appended += 1
            continue

        if isinstance(current, (list, tuple)):
            state["fallback_tokens"] += 1 + len(current) * 2
            available = (
                _CHAT2API_ANTHROPIC_MAX_FALLBACK_INSPECTIONS
                - state["fallback_inspections"]
                - len(pending)
            )
            if available <= 0:
                _chat2api_exhaust_fallback_inspection(state)
                return
            for index, item in enumerate(current):
                if index >= available:
                    _chat2api_exhaust_fallback_inspection(state)
                    return
                pending.append((item, field_name, parent_type))
            continue

        _chat2api_exhaust_fallback_inspection(state)
        return


def _chat2api_count_anthropic_document_source(
    source: Any,
    count_function: TokenCounterFunction,
    use_default_image_token_count: bool,
    state: dict[str, Any],
    depth: int,
) -> int:
    if state["truncated"]:
        _chat2api_add_fallback_value(source, state)
        return 0

    if not isinstance(source, Mapping):
        return _chat2api_count_anthropic_value_inner(
            source,
            count_function,
            use_default_image_token_count,
            state,
            depth=depth + 1,
        )

    source_type = source.get("type")
    state["nodes"] += 1
    if (
        state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES
        or len(source) + state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES
    ):
        state["truncated"] = True
        _chat2api_add_fallback_value(source, state)
        return 0

    tokens = 1 + len(source)
    if source_type in {"file", "url"}:
        # Provider-side documents cannot be dereferenced by the local proxy.
        tokens += _CHAT2API_ANTHROPIC_UNRESOLVED_DOCUMENT_TOKENS

    for key, nested_value in source.items():
        nested_field = key if isinstance(key, str) else type(key).__name__
        if _chat2api_skip_anthropic_field(source_type, nested_field):
            continue

        tokens += _chat2api_count_text_bounded(nested_field, count_function, state)
        if source_type == "base64" and nested_field == "data" and isinstance(nested_value, str):
            # Encoded documents can be many MiB and pathological for BPE
            # tokenizers. Encoded length is a conservative, constant-work cost.
            tokens += len(nested_value)
        elif source_type in {"file", "url"} and nested_field in {"file_id", "url"}:
            # Opaque provider references are not document text. Count only a
            # small bounded identifier contribution in addition to the generic
            # unresolved-document allowance above.
            if isinstance(nested_value, str):
                tokens += min(_chat2api_text_token_upper_bound(nested_value), 4_096)
        else:
            tokens += _chat2api_count_anthropic_value_inner(
                nested_value,
                count_function,
                use_default_image_token_count,
                state,
                depth=depth + 1,
            )
        if state["nodes"] >= _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES:
            state["truncated"] = True
            _chat2api_add_fallback_value(source, state)
            break
        if state["truncated"] and state["fallback_exhausted"]:
            break
    return tokens


def _chat2api_count_anthropic_value_inner(
    value: Any,
    count_function: TokenCounterFunction,
    use_default_image_token_count: bool,
    state: dict[str, Any],
    field_name: Optional[str] = None,
    depth: int = 0,
) -> int:
    if state["truncated"]:
        _chat2api_add_fallback_value(value, state)
        return 0

    if depth > _CHAT2API_ANTHROPIC_MAX_CONTENT_DEPTH:
        state["truncated"] = True
        _chat2api_add_fallback_value(value, state)
        return 0

    state["nodes"] += 1
    if state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES:
        state["truncated"] = True
        _chat2api_add_fallback_value(value, state)
        return 0

    if isinstance(value, str):
        return _chat2api_count_text_bounded(value, count_function, state)

    if isinstance(value, Mapping):
        content_type = value.get("type")
        if content_type == "image":
            image_url = _chat2api_anthropic_image_url(value.get("source"))
            return _count_image_tokens(image_url, use_default_image_token_count)
        if content_type == "image_url":
            return _count_image_tokens(value.get("image_url"), use_default_image_token_count)

        if len(value) + state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES:
            state["truncated"] = True
            _chat2api_add_fallback_value(value, state)
            return 0

        # Include lightweight JSON object/separator overhead. Keys and scalar
        # values are counted below, unlike LiteLLM's old unknown-block path.
        tokens = 1 + len(value)
        for key, nested_value in value.items():
            nested_field = key if isinstance(key, str) else type(key).__name__
            if _chat2api_skip_anthropic_field(content_type, nested_field):
                continue

            tokens += _chat2api_count_text_bounded(nested_field, count_function, state)
            if content_type == "document" and nested_field == "source":
                tokens += _chat2api_count_anthropic_document_source(
                    nested_value,
                    count_function,
                    use_default_image_token_count,
                    state,
                    depth,
                )
            else:
                tokens += _chat2api_count_anthropic_value_inner(
                    nested_value,
                    count_function,
                    use_default_image_token_count,
                    state,
                    field_name=nested_field,
                    depth=depth + 1,
                )
            if state["truncated"] and state["fallback_exhausted"]:
                break
        return tokens

    if isinstance(value, (list, tuple)):
        if len(value) + state["nodes"] > _CHAT2API_ANTHROPIC_MAX_CONTENT_NODES:
            state["truncated"] = True
            _chat2api_add_fallback_value(value, state)
            return 0
        tokens = 1 + len(value)
        for item in value:
            tokens += _chat2api_count_anthropic_value_inner(
                item,
                count_function,
                use_default_image_token_count,
                state,
                field_name=field_name,
                depth=depth + 1,
            )
            if state["truncated"] and state["fallback_exhausted"]:
                break
        return tokens

    if value is None:
        return _chat2api_count_text_bounded("null", count_function, state)
    if isinstance(value, bool):
        return _chat2api_count_text_bounded("true" if value else "false", count_function, state)
    if isinstance(value, (int, float)):
        return _chat2api_count_text_bounded(str(value), count_function, state)
    if isinstance(value, (bytes, bytearray)):
        state["truncated"] = True
        return len(value)

    state["truncated"] = True
    _chat2api_add_fallback_value(value, state)
    return 0


def _chat2api_count_anthropic_value(
    value: Any,
    count_function: TokenCounterFunction,
    use_default_image_token_count: bool,
    state: Optional[dict[str, Any]] = None,
) -> int:
    """Count current and future Anthropic blocks with bounded, conservative work."""
    owns_state = state is None
    if state is None:
        state = _chat2api_new_count_state()
    elif state["truncated"]:
        _chat2api_add_fallback_value(value, state)
        return 0

    tokens = _chat2api_count_anthropic_value_inner(
        value,
        count_function,
        use_default_image_token_count,
        state,
    )
    if owns_state:
        tokens += state["fallback_tokens"]
    return tokens


def _count_content_list(
'''
TOKEN_COUNTER_IMAGE_ANCHOR = '''            elif c["type"] == "image_url":
                image_url = c.get("image_url")
                num_tokens += _count_image_tokens(image_url, use_default_image_token_count)
'''
TOKEN_COUNTER_IMAGE_PATCH = '''            elif c["type"] == "image_url":
                image_url = c.get("image_url")
                num_tokens += _count_image_tokens(image_url, use_default_image_token_count)
            elif c["type"] == "image":
                image_url = _chat2api_anthropic_image_url(c.get("source"))
                num_tokens += _count_image_tokens(image_url, use_default_image_token_count)
'''
TOKEN_COUNTER_TOOL_BLOCK_ANCHOR = '''            elif c["type"] in ("tool_use", "tool_result"):
                num_tokens += _count_anthropic_content(
                    c,
                    count_function,
                    use_default_image_token_count,
                    default_token_count,
                )
'''
TOKEN_COUNTER_TOOL_BLOCK_PATCH = '''            elif c["type"] in ("tool_use", "tool_result"):
                num_tokens += _chat2api_count_anthropic_value(
                    c,
                    count_function,
                    use_default_image_token_count,
                    state=chat2api_state,
                )
'''
TOKEN_COUNTER_STATE_ANCHOR = '''    try:
        num_tokens = 0
        for c in content_list:
'''
TOKEN_COUNTER_STATE_PATCH = '''    try:
        num_tokens = 0
        chat2api_state: dict[str, Any] = _chat2api_new_count_state()
        for c in content_list:
'''
TOKEN_COUNTER_CONTENT_TEXT_ANCHOR = '''            if isinstance(c, str):
                num_tokens += count_function(c)
            elif c["type"] == "text":
                num_tokens += count_function(str(c.get("text", "")))
'''
TOKEN_COUNTER_CONTENT_TEXT_PATCH = '''            if isinstance(c, str):
                num_tokens += _chat2api_count_text_bounded(c, count_function, chat2api_state)
            elif c["type"] == "text":
                text = c.get("text", "")
                if not isinstance(text, str):
                    text = ""
                num_tokens += _chat2api_count_text_bounded(text, count_function, chat2api_state)
                if "citations" in c:
                    num_tokens += _chat2api_count_text_bounded(
                        "citations",
                        count_function,
                        chat2api_state,
                    )
                    num_tokens += _chat2api_count_anthropic_value(
                        c.get("citations"),
                        count_function,
                        use_default_image_token_count,
                        state=chat2api_state,
                    )
'''
TOKEN_COUNTER_THINKING_ANCHOR = '''                if thinking_text:
                    num_tokens += count_function(thinking_text)
'''
TOKEN_COUNTER_THINKING_PATCH = '''                if thinking_text:
                    num_tokens += _chat2api_count_text_bounded(
                        thinking_text,
                        count_function,
                        chat2api_state,
                    )
'''
TOKEN_COUNTER_TOOL_REFERENCE_ANCHOR = '''                if tool_name:
                    num_tokens += count_function(tool_name)
'''
TOKEN_COUNTER_TOOL_REFERENCE_PATCH = '''                if tool_name:
                    num_tokens += _chat2api_count_text_bounded(
                        tool_name,
                        count_function,
                        chat2api_state,
                    )
'''
TOKEN_COUNTER_FALLBACK_ANCHOR = '''            else:
                content_type = c.get("type", type(c).__name__) if isinstance(c, dict) else type(c).__name__
'''
TOKEN_COUNTER_FALLBACK_PATCH = '''            elif isinstance(c, Mapping) and c.get("type"):
                num_tokens += _chat2api_count_anthropic_value(
                    c,
                    count_function,
                    use_default_image_token_count,
                    state=chat2api_state,
                )
            else:
                content_type = c.get("type", type(c).__name__) if isinstance(c, dict) else type(c).__name__
'''
TOKEN_COUNTER_RETURN_ANCHOR = '''        return num_tokens
    except Exception as e:
'''
TOKEN_COUNTER_RETURN_PATCH = '''        if chat2api_state["truncated"]:
            num_tokens += chat2api_state["fallback_tokens"]
        return num_tokens
    except Exception as e:
'''

TOKEN_COUNTER_DIRECT_TEXT_ANCHOR = '''        count_function = _get_count_function(model, custom_tokenizer)
        num_tokens = count_function(text_to_count)
'''
TOKEN_COUNTER_DIRECT_TEXT_PATCH = '''        count_function = _get_count_function(model, custom_tokenizer)
        num_tokens = _chat2api_count_text_safe(text_to_count, count_function)
'''
TOKEN_COUNTER_FUNCTION_CALL_ANCHOR = '''            function_arguments = tool_call["function"].get("arguments", "")
            total += count_function(str(function_arguments))
'''
TOKEN_COUNTER_FUNCTION_CALL_PATCH = '''            function_arguments = tool_call["function"].get("arguments", "")
            if not isinstance(function_arguments, str):
                function_arguments = ""
            total += _chat2api_count_text_safe(function_arguments, count_function)
'''
TOKEN_COUNTER_LEGACY_FUNCTION_CALL_ANCHOR = '''        return count_function(str(value.get("arguments", "")))
'''
TOKEN_COUNTER_LEGACY_FUNCTION_CALL_PATCH = '''        function_arguments = value.get("arguments", "")
        if not isinstance(function_arguments, str):
            function_arguments = ""
        return _chat2api_count_text_safe(function_arguments, count_function)
'''
TOKEN_COUNTER_MESSAGE_TEXT_ANCHOR = '''            elif isinstance(value, str):
                num_tokens += params.count_function(value)
                if key == "name":
'''
TOKEN_COUNTER_MESSAGE_TEXT_PATCH = '''            elif isinstance(value, str):
                num_tokens += _chat2api_count_text_safe(value, params.count_function)
                if key == "name":
'''
TOKEN_COUNTER_SEARCH_RESULTS_ANCHOR = '''                if search_results_text:
                    num_tokens += params.count_function(search_results_text)
'''
TOKEN_COUNTER_SEARCH_RESULTS_PATCH = '''                if search_results_text:
                    num_tokens += _chat2api_count_text_safe(search_results_text, params.count_function)
'''
TOKEN_COUNTER_EXTRA_TOOLS_ANCHOR = '''        num_tokens += count_function(_format_function_definitions(tools))
'''
TOKEN_COUNTER_EXTRA_TOOLS_PATCH = '''        num_tokens += _chat2api_count_text_safe(
            _format_function_definitions(tools),
            count_function,
        )
'''

PROXY_SERVER_MARKER = "count_messages = messages"
PROXY_SERVER_COUNT_ANCHOR = '''    total_tokens = token_counter(
        model=model_to_use,
        text=prompt,
        messages=messages,
        custom_tokenizer=_tokenizer_used,  # type: ignore
    )
'''
PROXY_SERVER_COUNT_PATCH = '''    count_messages = messages
    if messages is not None:
        count_messages = list(messages)
        if system is not None and not any(
            isinstance(message, dict) and message.get("role") == "system"
            for message in count_messages
        ):
            count_messages.insert(0, {"role": "system", "content": system})

    total_tokens = await asyncio.to_thread(
        token_counter,
        model=model_to_use,
        text=prompt,
        messages=count_messages,
        tools=tools if count_messages is not None else None,
        custom_tokenizer=_tokenizer_used,  # type: ignore
    )
'''

ANTHROPIC_ENDPOINTS_MARKER = "def _chat2api_anthropic_count_tokens_local_only("
ANTHROPIC_ENDPOINTS_IMPORT_ANCHOR = "from fastapi import APIRouter, Depends, HTTPException, Request, Response\n"
ANTHROPIC_ENDPOINTS_PATCHED_IMPORTS = "import os\n" + ANTHROPIC_ENDPOINTS_IMPORT_ANCHOR
ANTHROPIC_ENDPOINTS_ROUTE_ANCHOR = '''@router.post(
    "/v1/messages/count_tokens",
'''
ANTHROPIC_ENDPOINTS_PATCHED_HELPERS = '''def _chat2api_anthropic_count_tokens_local_only() -> bool:
    """Prefer the local tokenizer when the target lacks Responses token APIs."""
    value = os.environ.get("LITELLM_ANTHROPIC_COUNT_TOKENS_LOCAL_ONLY", "true")
    return value.strip().lower() not in {"0", "false", "no", "off"}


@router.post(
    "/v1/messages/count_tokens",
'''
ANTHROPIC_ENDPOINTS_CALL_ANCHOR = '''        token_response = await internal_token_counter(
            request=token_request,
            call_endpoint=True,
        )
'''
ANTHROPIC_ENDPOINTS_CALL_PATCH = '''        token_response = await internal_token_counter(
            request=token_request,
            # Chat2API exposes Chat Completions, not /responses/input_tokens.
            # Keep local counting as the generic default; deployments with a
            # real provider counting API can opt out through the environment.
            call_endpoint=not _chat2api_anthropic_count_tokens_local_only(),
        )
'''


def replace_exact(source: str, old: str, new: str, description: str) -> str:
    occurrences = source.count(old)
    if occurrences != 1:
        raise RuntimeError(
            f"Expected exactly one {description} in the pinned LiteLLM source; "
            f"found {occurrences}. Refusing to apply a potentially unsafe patch."
        )
    return source.replace(old, new, 1)


def patch_source(source: str) -> str:
    if "def _mid_stream_error_sse_event(" in source:
        raise RuntimeError(
            "LiteLLM already contains a mid-stream Anthropic error patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        STANDARD_IMPORT_ANCHOR,
        PATCHED_STANDARD_IMPORTS,
        "standard import anchor",
    )
    patched = replace_exact(patched, IMPORT_ANCHOR, PATCHED_IMPORTS, "import anchor")
    patched = replace_exact(patched, HELPER_ANCHOR, PATCHED_HELPERS, "helper anchor")
    patched = replace_exact(patched, ORIGINAL_WRAPPER, PATCHED_WRAPPER, "async SSE wrapper")
    compile(patched, str(MODULE_PATH), "exec")
    return patched


def patch_responses_source(source: str) -> str:
    if "def _anthropic_sse_heartbeat_interval_seconds(" in source:
        raise RuntimeError(
            "LiteLLM Responses Anthropic heartbeat patch is already present; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        RESPONSES_IMPORT_ANCHOR,
        RESPONSES_PATCHED_IMPORTS,
        "Responses import anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_HELPER_ANCHOR,
        RESPONSES_PATCHED_HELPERS,
        "Responses helper anchor",
    )
    patched = replace_exact(
        patched,
        RESPONSES_ORIGINAL_WRAPPER,
        RESPONSES_PATCHED_WRAPPER,
        "Responses async SSE wrapper",
    )
    compile(patched, str(RESPONSES_MODULE_PATH), "exec")
    return patched


def patch_token_counter_source(source: str) -> str:
    if TOKEN_COUNTER_MARKER in source:
        raise RuntimeError(
            "LiteLLM already contains the Anthropic image token-count patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        TOKEN_COUNTER_HELPER_ANCHOR,
        TOKEN_COUNTER_PATCHED_HELPERS,
        "token-counter Anthropic image helper anchor",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_STATE_ANCHOR,
        TOKEN_COUNTER_STATE_PATCH,
        "token-counter shared bounded state",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_CONTENT_TEXT_ANCHOR,
        TOKEN_COUNTER_CONTENT_TEXT_PATCH,
        "token-counter bounded content text branches",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_THINKING_ANCHOR,
        TOKEN_COUNTER_THINKING_PATCH,
        "token-counter bounded thinking branch",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_TOOL_REFERENCE_ANCHOR,
        TOKEN_COUNTER_TOOL_REFERENCE_PATCH,
        "token-counter bounded tool-reference branch",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_IMAGE_ANCHOR,
        TOKEN_COUNTER_IMAGE_PATCH,
        "token-counter image branch",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_TOOL_BLOCK_ANCHOR,
        TOKEN_COUNTER_TOOL_BLOCK_PATCH,
        "token-counter bounded Anthropic tool blocks",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_FALLBACK_ANCHOR,
        TOKEN_COUNTER_FALLBACK_PATCH,
        "token-counter Anthropic compatibility fallback",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_RETURN_ANCHOR,
        TOKEN_COUNTER_RETURN_PATCH,
        "token-counter conservative fallback return",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_DIRECT_TEXT_ANCHOR,
        TOKEN_COUNTER_DIRECT_TEXT_PATCH,
        "token-counter bounded direct text path",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_FUNCTION_CALL_ANCHOR,
        TOKEN_COUNTER_FUNCTION_CALL_PATCH,
        "token-counter bounded tool call arguments",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_LEGACY_FUNCTION_CALL_ANCHOR,
        TOKEN_COUNTER_LEGACY_FUNCTION_CALL_PATCH,
        "token-counter bounded legacy function arguments",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_MESSAGE_TEXT_ANCHOR,
        TOKEN_COUNTER_MESSAGE_TEXT_PATCH,
        "token-counter bounded message text",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_SEARCH_RESULTS_ANCHOR,
        TOKEN_COUNTER_SEARCH_RESULTS_PATCH,
        "token-counter bounded search results",
    )
    patched = replace_exact(
        patched,
        TOKEN_COUNTER_EXTRA_TOOLS_ANCHOR,
        TOKEN_COUNTER_EXTRA_TOOLS_PATCH,
        "token-counter bounded tool definitions",
    )
    compile(patched, str(TOKEN_COUNTER_MODULE_PATH), "exec")
    return patched


def patch_proxy_server_source(source: str) -> str:
    if PROXY_SERVER_MARKER in source:
        raise RuntimeError(
            "LiteLLM already contains the token-counter extras patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        PROXY_SERVER_COUNT_ANCHOR,
        PROXY_SERVER_COUNT_PATCH,
        "proxy token-counter extras anchor",
    )
    compile(patched, str(PROXY_SERVER_MODULE_PATH), "exec")
    return patched


def patch_anthropic_endpoints_source(source: str) -> str:
    if ANTHROPIC_ENDPOINTS_MARKER in source:
        raise RuntimeError(
            "LiteLLM already contains the local Anthropic count-tokens patch; "
            "review the base image before removing this build patch."
        )

    patched = replace_exact(
        source,
        ANTHROPIC_ENDPOINTS_IMPORT_ANCHOR,
        ANTHROPIC_ENDPOINTS_PATCHED_IMPORTS,
        "Anthropic endpoint environment import anchor",
    )
    patched = replace_exact(
        patched,
        ANTHROPIC_ENDPOINTS_ROUTE_ANCHOR,
        ANTHROPIC_ENDPOINTS_PATCHED_HELPERS,
        "Anthropic count-tokens route anchor",
    )
    patched = replace_exact(
        patched,
        ANTHROPIC_ENDPOINTS_CALL_ANCHOR,
        ANTHROPIC_ENDPOINTS_CALL_PATCH,
        "Anthropic count-tokens local-first call anchor",
    )
    compile(patched, str(ANTHROPIC_ENDPOINTS_MODULE_PATH), "exec")
    return patched


def resolve_installed_target(relative_path: Path) -> Path:
    candidates = [Path(root) / relative_path for root in site.getsitepackages()]
    existing = [candidate for candidate in candidates if candidate.is_file()]
    if len(existing) != 1:
        rendered = ", ".join(str(candidate) for candidate in candidates)
        raise RuntimeError(
            f"Expected one installed LiteLLM target for {relative_path}, found {len(existing)}: {rendered}"
        )
    return existing[0]


def resolve_targets() -> list[Path]:
    if len(sys.argv) > 2:
        raise RuntimeError("Usage: apply-anthropic-midstream-error-patch.py [target.py]")
    if len(sys.argv) == 2:
        return [Path(sys.argv[1]).resolve()]

    return [
        resolve_installed_target(MODULE_PATH),
        resolve_installed_target(RESPONSES_MODULE_PATH),
        resolve_installed_target(TOKEN_COUNTER_MODULE_PATH),
        resolve_installed_target(PROXY_SERVER_MODULE_PATH),
        resolve_installed_target(ANTHROPIC_ENDPOINTS_MODULE_PATH),
    ]


def main() -> None:
    for target in resolve_targets():
        source = target.read_text(encoding="utf-8")
        target_path = target.as_posix()
        if target_path.endswith(RESPONSES_MODULE_PATH.as_posix()):
            patched = patch_responses_source(source)
        elif target_path.endswith(TOKEN_COUNTER_MODULE_PATH.as_posix()):
            patched = patch_token_counter_source(source)
        elif target_path.endswith(PROXY_SERVER_MODULE_PATH.as_posix()):
            patched = patch_proxy_server_source(source)
        elif target_path.endswith(ANTHROPIC_ENDPOINTS_MODULE_PATH.as_posix()):
            patched = patch_anthropic_endpoints_source(source)
        else:
            patched = patch_source(source)
        target.write_text(patched, encoding="utf-8")
        py_compile.compile(str(target), doraise=True)
        print(f"Applied Anthropic stream safety patch to {target}")


if __name__ == "__main__":
    main()
