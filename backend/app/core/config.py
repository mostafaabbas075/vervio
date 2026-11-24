from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration sourced from environment variables."""

    app_name: str = "Vervio API"
    environment: str = "development"
    cors_origins: str = "http://localhost:3000"
    database_url: str | None = None
    auth_session_cookie_name: str = "vervio_session"
    auth_session_ttl_hours: int = 8
    auth_cookie_secure: bool | None = None
    auth_cookie_samesite: str = "lax"
    auth_cookie_domain: str | None = None
    openai_api_key: str | None = None
    openai_realtime_model: str = "gpt-realtime-2.1-mini"
    openai_interview_max_duration_seconds: int = Field(default=600, ge=1, le=7_200)
    ai_realtime_provider: str = "gemini"
    gemini_api_key: str | None = None
    gemini_live_model: str = "gemini-3.8-live"
    gemini_assessment_model: str = "gemini-2.5-flash"
    recording_storage_dir: str = "private-recordings"
    recording_max_upload_bytes: int = Field(default=100 * 1024 * 1024, ge=1)
    storage_provider: str = "local"
    r2_account_id: str | None = None
    r2_bucket_name: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: str | None = None

    @field_validator("storage_provider")
    @classmethod
    def validate_storage_provider(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"local", "local_private", "cloudflare_r2", "r2"}:
            raise ValueError(
                f"Unsupported storage provider: {value!r}. Must be 'local' or 'cloudflare_r2'."
            )
        return "cloudflare_r2" if normalized in {"cloudflare_r2", "r2"} else "local"

    @field_validator("auth_cookie_samesite")
    @classmethod
    def validate_auth_cookie_samesite(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"lax", "strict", "none"}:
            raise ValueError("AUTH_COOKIE_SAMESITE must be 'lax', 'strict', or 'none'.")
        return normalized

    @field_validator("auth_cookie_domain")
    @classmethod
    def validate_auth_cookie_domain(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        normalized = value.strip().lower()
        if "://" in normalized or "/" in normalized:
            raise ValueError("AUTH_COOKIE_DOMAIN must be a domain, not a URL.")
        return normalized

    @field_validator("ai_realtime_provider")
    @classmethod
    def validate_ai_realtime_provider(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in {"gemini", "openai"}:
            raise ValueError(
                f"Unsupported AI realtime provider: {value!r}. Must be 'gemini' or 'openai'."
            )
        return normalized

    @field_validator("gemini_live_model")
    @classmethod
    def validate_gemini_live_model(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("GEMINI_LIVE_MODEL must not be empty.")
        return normalized

    @field_validator("gemini_assessment_model")
    @classmethod
    def validate_gemini_assessment_model(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("GEMINI_ASSESSMENT_MODEL must not be empty.")
        return normalized

    @field_validator("recording_storage_dir")
    @classmethod
    def validate_recording_storage_dir(cls, value: str) -> str:
        normalized = value.strip()
        path = Path(normalized)
        if not normalized or path.is_absolute() or ".." in path.parts:
            raise ValueError("RECORDING_STORAGE_DIR must be a safe relative path.")
        return normalized

    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[2] / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @model_validator(mode="after")
    def validate_cross_site_cookie_security(self) -> "Settings":
        if self.auth_cookie_samesite == "none" and not self.session_cookie_secure:
            raise ValueError("AUTH_COOKIE_SAMESITE=none requires AUTH_COOKIE_SECURE=true.")
        return self

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def session_cookie_secure(self) -> bool:
        if self.auth_cookie_secure is not None:
            return self.auth_cookie_secure

        return self.environment.lower() not in {"development", "test"}

    @property
    def session_cookie_domain(self) -> str | None:
        return self.auth_cookie_domain

    @property
    def recording_storage_path(self) -> Path:
        return (Path(__file__).resolve().parents[2] / self.recording_storage_dir).resolve()

    @property
    def r2_endpoint_url(self) -> str | None:
        if not self.r2_account_id or not self.r2_account_id.strip():
            return None
        return f"https://{self.r2_account_id.strip()}.r2.cloudflarestorage.com"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
