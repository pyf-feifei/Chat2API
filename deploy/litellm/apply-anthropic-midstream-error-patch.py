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
        media_type = source.get("media_type") or "application/octet-stream"
        url = data if data.startswith("data:") else f"data:{media_type};base64,{data}"
    elif source_type == "url":
        url = source.get("url")
        if not isinstance(url, str) or not url:
            raise ValueError("Anthropic URL image source requires url")
    else:
        raise ValueError(f"Unsupported Anthropic image source type: {source_type}")

    return {"url": url, "detail": "auto"}


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

    total_tokens = token_counter(
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
        TOKEN_COUNTER_IMAGE_ANCHOR,
        TOKEN_COUNTER_IMAGE_PATCH,
        "token-counter image branch",
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
