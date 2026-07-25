"""Runtime configuration, read from the environment."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Model serving
    llm_base_url: str = "http://vllm:8000/v1"
    llm_api_key: str = "local-dev-key"
    llm_model: str = "google/gemma-4-12B-it"
    llm_timeout_s: float = 180.0

    # Research MCP
    mcp_url: str = "https://mcp.alien.club/mcp?config=cfg_UtzjgjDLGNrW"
    #: Preferred auth: a long-lived `oat_...` key from alien.club.
    mcp_api_key: str = ""
    #: Fallback auth, from `scripts/mcp_login.py`, when no static key exists.
    mcp_client_id: str = ""
    mcp_client_secret: str = ""
    mcp_refresh_token: str = ""
    mcp_timeout_s: float = 60.0
    #: Offer the model BnF/Gallica archive search. Off by default: it only helps
    #: historical claims, and an extra tool costs tool-choice accuracy.
    mcp_enable_archive: bool = False

    # Pipeline
    max_searches_per_claim: int = 3
    max_searches_per_request: int = 24
    claim_concurrency: int = 4
    max_claims: int = 12
    # Transcripts longer than this are truncated before decomposition. Gemma 4
    # 12B has a 256K window, so this is a latency guard, not a capacity one.
    max_transcript_chars: int = 24_000

    # API
    api_key: str = ""
    log_level: str = "INFO"

    @property
    def mcp_configured(self) -> bool:
        return bool(self.mcp_api_key or (self.mcp_client_id and self.mcp_refresh_token))


@lru_cache
def get_settings() -> Settings:
    return Settings()
