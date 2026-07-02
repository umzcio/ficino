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
    # Secure-by-default: registration is OFF unless the operator opts in.
    # basic_routes.py still allows the first-ever user to register so a
    # fresh install isn't locked out of creating its bootstrap account.
    allow_registration: bool = False  # basic provider: allow new signups

    # Rate limits (per user, per day — only enforced when AUTH_PROVIDER != none)
    rate_limit_uploads_per_day: int = 50
    rate_limit_generations_per_day: int = 20
    rate_limit_user_posts_per_day: int = 30
    # Covers first-time paper summaries (one call per paper), group-chat
    # synthesis creations, and any other one-shot LLM dispatch that isn't
    # a full feed generation.
    rate_limit_summary_per_day: int = 30
    # R10 BP-6: replies.py and personas.py hardcoded `RateLimit(..., 60)`
    # inline with no env override — every other dispatch site's limit
    # flows through this Settings class. Same default (60), now tunable.
    rate_limit_replies_per_day: int = 60
    rate_limit_persona_dm_per_day: int = 60

    # App
    environment: str = "development"
    max_upload_size_mb: int = 50
    generation_limit_per_day: int = 20
    cors_origins: str = "https://ficino.app,https://ficino.ai"

    # Cookie Domain attribute. Set to a parent like ".ficino.app" on hosted
    # deploys where the frontend (ficino.app) and api (api.ficino.app) are
    # on different subdomains and the frontend JS needs to read the CSRF
    # cookie. Leave blank on self-host where everything is same-origin;
    # browser uses host-only cookies by default.
    cookie_domain: str = ""
    upload_dir: str = "/app/uploads"
    figures_dir: str = "/app/figures"

    # Storage backend for PDFs + figure crops
    storage_provider: str = "local"  # "local" or "supabase"
    supabase_service_role_key: str = ""
    supabase_storage_bucket: str = "papers"

    # ElevenLabs TTS (feed audio playback). Empty key disables the feature —
    # the play button stays hidden in the frontend (feature-detected via the
    # /feed/{id}/audio endpoint returning 501).
    elevenlabs_api_key: str = ""
    elevenlabs_model_id: str = "eleven_turbo_v2_5"  # fast + cheap; good enough for post-length snippets

    # SaaS / hosted-deployment lock. When true:
    #   - the Settings → AI UI hides LLM provider + API-key controls
    #   - the settings-update endpoint silently drops any attempt to set
    #     provider-override keys (anthropic_api_key, llm_provider, etc.)
    # Operators of the hosted service supply API keys via .env.secrets;
    # self-hosters leave this false and users configure their own.
    public_deployment: bool = False

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
