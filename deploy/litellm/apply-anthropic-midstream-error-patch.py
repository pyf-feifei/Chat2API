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


def resolve_installed_target(relative_path: Path) -> Path:
    candidates = [Path(root) / relative_path for root in site.getsitepackages()]
    existing = [candidate for candidate in candidates if candidate.is_file()]
    if len(existing) != 1:
        rendered = ", ".join(str(candidate) for candidate in candidates)
        raise RuntimeError(
            f"Expected one installed LiteLLM streaming iterator, found {len(existing)}: {rendered}"
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
    ]


def main() -> None:
    for target in resolve_targets():
        source = target.read_text(encoding="utf-8")
        if "responses_adapters" in target.as_posix():
            patched = patch_responses_source(source)
        else:
            patched = patch_source(source)
        target.write_text(patched, encoding="utf-8")
        py_compile.compile(str(target), doraise=True)
        print(f"Applied Anthropic stream safety patch to {target}")


if __name__ == "__main__":
    main()
