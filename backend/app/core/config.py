from __future__ import annotations

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT = Path(__file__).resolve().parents[3]  # project root


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", env_file_encoding="utf-8", extra="ignore")

    # Server
    host: str = "0.0.0.0"
    port: int = 4173
    debug: bool = False
    reload: bool = False

    # Database
    db_path: Path = ROOT / "data" / "rackpilot.db"
    db_wal: bool = True

    # Migrations
    migrations_dir: Path = ROOT / "server" / "migrations"

    # Static files (frontend build)
    static_dir: Path = ROOT / "frontend" / "dist"
    static_dev_proxy: str = "http://localhost:5173"  # Vite dev server

    # Auth
    session_secret: str = "change-me-in-production"
    session_ttl_hours: int = 72

    # Master key for secrets encryption (32 hex bytes = 64 chars)
    master_key: str = ""

    # AI
    openai_api_key: str = ""
    anthropic_api_key: str = ""
    ai_default_model: str = "gpt-4o-mini"

    # Local development agent coordinator
    coordinator_url: str = "http://127.0.0.1:4180"
    coordinator_token: str = ""
    coordinator_timeout_seconds: float = 5.0

    # Email
    smtp_host: str = ""
    smtp_port: int = 587

    # Organisation defaults
    default_org: str = "default"

    # Features
    lan_mode: bool = True  # trust local network, relaxed CORS


settings = Settings()
