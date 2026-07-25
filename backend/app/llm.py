"""Thin async wrapper over the vLLM OpenAI-compatible endpoint."""

import json
import logging
import re
from typing import Any, TypeVar

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletion
from pydantic import BaseModel, ValidationError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from .config import Settings

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

_JSON_BLOCK = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


class LLMError(RuntimeError):
    pass


class MalformedOutput(LLMError):
    """Model returned something that would not parse into the target schema."""


def _looks_like_unsupported_param(exc: Exception) -> bool:
    """Distinguish "this server does not support that field" from a real error.

    Only a 4xx complaining about the parameter should trigger the fallback; a
    500, a timeout or a connection failure must surface instead of silently
    dropping schema enforcement for the rest of the process.
    """
    status = getattr(exc, "status_code", None)
    if status is not None and not 400 <= int(status) < 500:
        return False
    text = str(exc).casefold()
    return any(
        marker in text
        for marker in (
            "response_format",
            "json_schema",
            "unsupported",
            "unexpected keyword",
            "extra inputs are not permitted",
            "unrecognized",
        )
    )


def _extract_json(raw: str) -> str:
    """Pull a JSON document out of a possibly chatty response.

    Guided decoding normally makes this a no-op, but it stays as a safety net
    for when guided decoding is unavailable or the model wraps output in a
    fenced block anyway.
    """
    raw = (raw or "").strip()
    if fenced := _JSON_BLOCK.search(raw):
        raw = fenced.group(1).strip()
    if raw.startswith("{") or raw.startswith("["):
        return raw
    # Last resort: widest brace span in the text.
    start, end = raw.find("{"), raw.rfind("}")
    if start != -1 and end > start:
        return raw[start : end + 1]
    return raw


class LLM:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = AsyncOpenAI(
            base_url=settings.llm_base_url,
            api_key=settings.llm_api_key,
            timeout=settings.llm_timeout_s,
            max_retries=0,  # retries are handled by tenacity below
        )
        self.model = settings.llm_model
        #: Cleared permanently if the server rejects `response_format`, so the
        #: probe costs one failed request per process, not one per call.
        self._structured_output_supported = True

    async def aclose(self) -> None:
        await self._client.close()

    @retry(
        retry=retry_if_exception_type(MalformedOutput),
        stop=stop_after_attempt(2),
        wait=wait_exponential(multiplier=0.5, max=4),
        reraise=True,
    )
    async def structured(
        self,
        *,
        messages: list[dict[str, Any]],
        schema: type[T],
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> T:
        """Complete into a Pydantic model, constrained by structured decoding.

        Uses the OpenAI-standard `response_format: json_schema`, which vLLM
        implements on top of xgrammar. vLLM's own `guided_json` extension would
        also work but has moved twice across releases, so the standard field is
        the safer target. Servers that reject it fall back to plain decoding,
        where the prompt plus `_extract_json` plus a retry carry the load -
        Gemma 4 emits valid JSON unprompted in practice.
        """
        completion = await self._complete_json(
            messages=messages, schema=schema, temperature=temperature, max_tokens=max_tokens
        )
        raw = completion.choices[0].message.content or ""
        try:
            return schema.model_validate_json(_extract_json(raw))
        except (ValidationError, json.JSONDecodeError) as exc:
            logger.warning("model output failed %s validation: %s", schema.__name__, exc)
            raise MalformedOutput(
                f"could not parse {schema.__name__} from: {raw[:400]}"
            ) from exc

    async def _complete_json(
        self,
        *,
        messages: list[dict[str, Any]],
        schema: type[T],
        temperature: float,
        max_tokens: int,
    ) -> ChatCompletion:
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if self._structured_output_supported:
            try:
                return await self._client.chat.completions.create(
                    **kwargs,
                    response_format={
                        "type": "json_schema",
                        "json_schema": {
                            "name": schema.__name__,
                            "schema": schema.model_json_schema(),
                        },
                    },
                )
            except Exception as exc:
                if not _looks_like_unsupported_param(exc):
                    raise
                logger.warning(
                    "server rejected response_format=json_schema (%s); "
                    "falling back to unconstrained JSON decoding",
                    exc,
                )
                self._structured_output_supported = False
        return await self._client.chat.completions.create(**kwargs)

    async def with_tools(
        self,
        *,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None,
        temperature: float = 0.0,
        max_tokens: int = 1024,
    ) -> ChatCompletion:
        """One turn of a tool-calling loop.

        Pass `tools=None` to force the model to answer in prose - that is how
        the verification loop ends a claim once its search budget is spent.
        """
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        return await self._client.chat.completions.create(**kwargs)

    async def health(self) -> bool:
        try:
            await self._client.models.list()
            return True
        except Exception as exc:  # noqa: BLE001 - health check must not raise
            logger.warning("LLM health check failed: %s", exc)
            return False
