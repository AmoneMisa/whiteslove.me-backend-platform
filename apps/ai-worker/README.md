# AI Worker

Private AI-enrichment service shared by WhitesLove vacancy/candidate flows and Flat Finder. Deterministic parsing stays in caller applications; this service handles ambiguous semantic extraction, translation and optional photo analysis.

## Architecture

```text
Personal-Site ───────────────┐
                             ├── private HTTP ──> ai-worker ──> FreeLLMAPI ──> free-tier providers/models
Flat Finder ─────────────────┘
```

Production uses **FreeLLMAPI as the only LLM gateway** for both text and vision. `ai-worker` does not choose a paid model or call a direct provider in the default Compose deployment. FreeLLMAPI owns provider/model health, free-quota routing and failover; `ai-worker` owns prompts, schemas, validation, caching, queueing and caller-facing contracts.

The LLM remains an enrichment layer. If inference is unavailable, caller applications keep their deterministic parser/canonical data rather than trusting or requiring an AI guess.

`ai-worker` is intentionally stateless apart from a bounded in-process queue and TTL/LRU result cache. It does **not** use Redis. Durable crawl/job state stays in the caller applications.

## Source layout

```text
src/
  server.js            HTTP entry point: routes, API-key auth, health/metrics wiring
  config.js             Fail-fast environment validation and typed config
  application/          Use cases — the only layer server.js calls into
    extraction.js        POST /ai/extract: queue + cache + provider dispatch for apartment/vacancy/candidate/translation
    job-handler.js        Queued-job lifecycle (submit, poll, versioned result)
    health.js              Health/readiness checks
  services/              Provider-facing logic, one file per concern
    extract.js, vision.js  Orchestrate a single extraction/vision call end to end
    text.js, text-providers.js, vision-providers.js  FreeLLMAPI (and provider-agnostic fallback) client logic
    free-translation.js    No-key MyMemory translation path, falls through to the FreeLLMAPI text gateway
  prompts/               One file per extraction kind (apartment/vacancy/candidate/translation/vision) + common.js shared instructions
  schemas/               Zod validation schemas, one per extraction kind — PROMPT_VERSION/SCHEMA_VERSION bumps live next to the schema they version
  queue/                 Bounded in-process queue (no Redis — see Architecture above)
  cache/                 TTL/LRU result cache, versioned by PROMPT_VERSION/SCHEMA_VERSION
  util/                  Cross-cutting: logging, metrics, privacy redaction, hashing, the FreeLLMAPI key reader, translation-guard heuristics
```

Add a new extraction `kind` by adding one file to each of `prompts/` and
`schemas/`, then wiring both into `services/extract.js` — don't grow
`application/extraction.js` with kind-specific parsing logic that belongs
in a schema or prompt file; it should stay a thin queue/cache/dispatch
layer. Provider selection/failover changes belong in `services/text*.js` /
`vision*.js`, not in `application/`.

## Zero-copy FreeLLMAPI setup

The production stack is designed so an existing `ai-worker/.env` does not need to be re-entered in the FreeLLMAPI dashboard.

On every FreeLLMAPI boot, Compose builds its declarative config from the non-empty provider credentials already present in `.env`:

- `GROQ_API_KEY`
- `GEMINI_API_KEY` → FreeLLMAPI `google`
- `NVIDIA_API_KEY`
- `HUGGINGFACE_API_KEY`
- `LLM7_API_KEY`
- `OPENROUTER_API_KEY`
- `MISTRAL_API_KEY`
- `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_AUTH_TOKEN`

Missing credentials are explicitly disabled, so removing a key from `.env` does not leave an old enabled credential in FreeLLMAPI's persisted database. OVH and AI Horde are also enabled as zero-key free fallbacks. Kilo is deliberately not auto-enabled because its anonymous free route may log prompts/outputs for training.

Provider credentials are encrypted at rest in FreeLLMAPI's persistent SQLite database. `deploy.sh` automatically generates `FREELLMAPI_ENCRYPTION_KEY` the first time it is needed and writes it to the server `.env`; later deploys preserve it.

FreeLLMAPI also generates its own `freellmapi-*` unified client key. There is **no copy/paste step** for that key: the FreeLLMAPI startup wrapper exports it into `unified.key` inside the persistent data volume, and its healthcheck does not pass until that file exists. Production mounts the same volume read-only into `ai-worker`, which reads `/run/freellmapi/unified.key`. `FREELLMAPI_API_KEY` remains only as an optional local-development override.

The default FreeLLMAPI runtime is pinned to `v0.9.0` so application code does not unexpectedly change during a deploy. FreeLLMAPI can still refresh its signed free-model catalog independently. Override `FREELLMAPI_IMAGE` deliberately when validating a newer release.

## Current scope

Implemented:

- apartment, vacancy, candidate and translation extraction with structured JSON + Zod validation;
- photo analysis through FreeLLMAPI's vision-capable free routes;
- Flat Finder vision coverage for supported visually/explicitly observable listing fields, with per-field confidence/evidence and conservative merge thresholds;
- up to 10 unique photos per listing by default;
- provider failover/quota routing in FreeLLMAPI plus bounded local concurrency/cooldown handling;
- versioned process-local result cache;
- API-key protection, metrics, readiness/health and graceful shutdown;
- fail-fast environment validation;
- Docker Compose deployment and automatic FreeLLMAPI credential bootstrap;
- deterministic tests and benchmark script.

Phone numbers, emails, URLs and Telegram usernames are redacted from text-extraction prompts. Source text/images are untrusted input, not executable prompt instructions. AI results never become canonical geography without the caller's deterministic normalization/validation pipeline.

## API

### Health and metrics

```text
GET /health
GET /ready
GET /metrics
```

### Structured extraction

```http
POST /ai/extract
X-AI-Key: <AI_API_KEY>
Content-Type: application/json

{
  "kind": "vacancy",
  "rawText": "...",
  "knownFacts": {
    "salaryMin": 2500,
    "currency": "USD",
    "skills": ["Vue.js", "TypeScript"]
  },
  "meta": {
    "source": "telegram",
    "country": "UZ"
  }
}
```

Supported kinds: `apartment`, `vacancy`, `candidate`, `translation`.

Non-cached semantic extraction normally returns:

```json
{ "status": "pending", "key": "vacancy-..." }
```

Poll with:

```text
GET /ai/result/vacancy-...
X-AI-Key: <AI_API_KEY>
```

Translation is a fourth extraction `kind` and runs synchronously (bypassing
the queue), keeping the interactive UI path low-latency. A confidently
detected short segment is first sent to the no-key MyMemory translation API
(within its official 500-byte segment limit). Unsupported languages, long
text, rate limits, or translator outages fall through to the FreeLLMAPI text
gateway. Set `FREE_TRANSLATOR_ENABLED=false` to disable the public translator.

### Photo analysis

```http
POST /ai/vision
X-AI-Key: <AI_API_KEY>
Content-Type: application/json

{
  "images": [
    "https://example.com/photo.jpg",
    { "id": "kitchen", "url": "https://example.com/kitchen.jpg" }
  ]
}
```

The default limit is `AI_MAX_PHOTOS_PER_LISTING=10`. The caller removes duplicate URLs before submission. Vision returns `null` when a property is not actually visible or explicitly written in an image; absence in a photo is not treated as `false`.

## Local development

Requires Node.js 24 or newer.

```bash
npm ci
npm test
npm run check
cp sample.env .env
```

Create the shared network once and start the complete stack:

```bash
docker network create ai-net 2>/dev/null || true
docker compose --env-file .env up -d freellmapi ai-worker
curl http://127.0.0.1:4030/health
```

When running `node src/server.js` directly without the Compose volume mount, set `FREELLMAPI_API_KEY` to an existing router key or set `FREELLMAPI_API_KEY_FILE` to a readable exported key file.

## Production deployment

```bash
cd ~/opt
git clone <repository-url> ai-worker
cd ai-worker
cp sample.env .env
chmod 600 .env
chmod +x deploy.sh
./deploy.sh
```

For an existing installation, keep the current `.env`: the provider keys already in it are reused automatically. The only existing secret that still needs to match caller backends is `AI_API_KEY`.

## Connecting applications

```env
AI_WORKER_URL=http://ai-worker:4030
AI_WORKER_KEY=<same value as AI_API_KEY>
```

Attach caller backends to `ai-net`. Only backend code should call this service; do not expose model selection, provider keys or prompts to browsers.

## Configuration

See `sample.env`. Important defaults:

```env
TEXT_PROVIDERS=freellmapi
VISION_PROVIDERS=freellmapi
FREELLMAPI_TEXT_MODEL=auto:balanced
FREELLMAPI_VISION_MODEL=auto:smart
AI_MAX_PHOTOS_PER_LISTING=10
AI_CONCURRENCY=1
VISION_CONCURRENCY=1
AI_TEXT_TIMEOUT_MS=120000
AI_WORKER_CPUS=0.5
AI_WORKER_MEMORY_LIMIT=1g
```

`PROMPT_VERSION` and `SCHEMA_VERSION` are part of cache keys and result metadata. Increment the corresponding version when prompts or schemas change.

Do not commit `.env`; it contains internal and upstream credentials.
