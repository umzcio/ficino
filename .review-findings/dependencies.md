# Dependency Audit Findings

## Tooling Status
- pip-audit: NOT RUNNABLE (sandbox blocked pip install)
- npm audit: NOT RUNNABLE (sandbox blocked npm)
- Findings below are from static lockfile inspection + known-CVE knowledge through 2026-01.

## HIGH (vulnerable floor pins)

### 1. python-multipart>=0.0.6 permits CVE-2024-24762 / CVE-2024-53981
- Fix: pin >=0.0.18 (api/requirements.txt)

### 2. Pillow>=10.0.0 permits CVE-2023-50447 (RCE) and CVE-2024-28219
- Fix: pin >=10.3.0 (worker/requirements.txt)

### 3. pymupdf>=1.23.0 permits CVE-2024-8722 (heap OOB read)
- Fix: pin >=1.24.10 (worker/requirements.txt)

### 4. fastapi>=0.104.0 permits vulnerable Starlette (CVE-2024-47874)
- Fix: pin >=0.115 (api/requirements.txt)

## MEDIUM

### 5. All Python reqs use `>=` (no upper bound)
- Recommend pin exact or use `~=` to prevent drift into vulnerable releases.

### 6. lucide-react Pinned to ^1.8.0 (likely wrong package/version)
- Modern lucide-react line is 0.4xx.x. `1.8.0` is legacy. Audit and swap.
- frontend/package.json

### 7. Likely Unused Dependencies
- worker/requirements.txt: `openai` — no `import openai` found; only httpx calls to OpenAI-compatible endpoints.
- frontend/package.json: `react-router-dom` — no imports of Routes/useNavigate/Link found.

## LOW

### 8. License Posture Clean
- Project AGPL-3.0; all transitive deps permissive (MIT/Apache/BSD/ISC/MPL-2.0). No conflicts.

### 9. Pydantic v2 Migration Clean
- No @validator, no .dict(), no inner Config class. api/config.py uses model_config dict.

### 10. Tailwind v4 Migration Clean
- No tailwind.config.*, no @apply, no @tailwind directives. Using @import "tailwindcss" + @theme correctly.

## Current Versions (from lockfiles; informational)

| Frontend package | Resolved |
|---|---|
| react / react-dom | 19.2.5 |
| tailwindcss | 4.2.2 |
| vite | 8.0.8 |
| vite-plugin-pwa | 1.2.0 |
| workbox-core | 7.4.0 |
| @playwright/test | 1.59.1 |
| typescript | 6.0.2 |

SQLAlchemy is NOT a dependency (asyncpg-only). No ORM mixing concern.
