"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://ficino:ficino@postgres:5432/ficino"
    redis_url: str = "redis://redis:6379/0"

    # Provider selection
    llm_provider: str = "ollama"  # "ollama" or "api"
    embed_provider: str = "ollama"  # "ollama" or "api"

    # Ollama
    ollama_base_url: str = "http://host.docker.internal:11434"
    ollama_llm_model: str = "qwen3.5:latest"
    ollama_embed_model: str = "bge-m3:latest"
    ollama_vision_model: str = "gemma4:latest"

    # Embedding dimension
    embed_dim: int = 1024

    # API keys (for api provider)
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    voyage_api_key: str = ""
    claude_model: str = "claude-sonnet-4-6"

    # Auth
    auth_provider: str = "none"  # "none", "basic", "supabase"
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_jwt_secret: str = ""
    allow_registration: bool = True  # basic provider: allow new signups

    # App
    environment: str = "development"
    max_upload_size_mb: int = 50
    generation_limit_per_day: int = 20
    cors_origins: str = "https://ficino.ai,https://ficino.local"
    upload_dir: str = "/app/uploads"
    figures_dir: str = "/app/figures"

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
