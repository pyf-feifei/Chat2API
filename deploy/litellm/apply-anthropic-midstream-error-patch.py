#!/usr/bin/env python3
"""Apply LiteLLM PR #33352 to the pinned v1.93.0 package source."""

from __future__ import annotations

import py_compile
import site
import sys
from pathlib import Path


MODULE_PATH = Path(
    "litellm/llms/anthropic/experimental_pass_through/adapters/streaming_iterator.py"
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
        try:
            async for chunk in self:
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

    patched = replace_exact(source, IMPORT_ANCHOR, PATCHED_IMPORTS, "import anchor")
    patched = replace_exact(patched, HELPER_ANCHOR, PATCHED_HELPERS, "helper anchor")
    patched = replace_exact(patched, ORIGINAL_WRAPPER, PATCHED_WRAPPER, "async SSE wrapper")
    compile(patched, str(MODULE_PATH), "exec")
    return patched


def resolve_target() -> Path:
    if len(sys.argv) > 2:
        raise RuntimeError("Usage: apply-anthropic-midstream-error-patch.py [target.py]")
    if len(sys.argv) == 2:
        return Path(sys.argv[1]).resolve()

    candidates = [Path(root) / MODULE_PATH for root in site.getsitepackages()]
    existing = [candidate for candidate in candidates if candidate.is_file()]
    if len(existing) != 1:
        rendered = ", ".join(str(candidate) for candidate in candidates)
        raise RuntimeError(
            f"Expected one installed LiteLLM streaming iterator, found {len(existing)}: {rendered}"
        )
    return existing[0]


def main() -> None:
    target = resolve_target()
    source = target.read_text(encoding="utf-8")
    patched = patch_source(source)
    target.write_text(patched, encoding="utf-8")
    py_compile.compile(str(target), doraise=True)
    print(f"Applied Anthropic mid-stream error patch to {target}")


if __name__ == "__main__":
    main()
