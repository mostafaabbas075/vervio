# Vervio

Vervio is a demo MVP for an AI-powered German-language interview and candidate-evaluation platform. It has a Next.js frontend, FastAPI backend, cookie-authenticated administration, Neon PostgreSQL, private recording storage, and Gemini Live interview support. The application UI is English or Arabic; the AI-led interview conversation remains German.

## Prerequisites

- Node.js 20 or later
- npm 10 (the repository pins `npm@10.9.10`)
- Python 3.11 or later
- Docker Desktop (optional, for containerized local runs)

## Local setup

From the repository root, install frontend tooling:

```powershell
npm install
```

Create and activate an isolated Python environment, then install backend dependencies:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
cd ..
```

Copy the environment templates before changing local configuration:

```powershell
Copy-Item frontend\.env.local.example frontend\.env.local
Copy-Item backend\.env.example backend\.env
```

The included values work for the default local ports. Do not commit the copied environment files.

## Run locally

Activate `backend/.venv` if it is not active, then run both applications from the repository root:

```powershell
npm run dev
```

- Frontend: [http://localhost:3000](http://localhost:3000)
- Backend health check: [http://localhost:8000/health](http://localhost:8000/health)
- Backend API docs: [http://localhost:8000/docs](http://localhost:8000/docs)

To run just one app:

```powershell
npm run dev:frontend
npm run dev:backend
```

## Docker

Docker Compose runs the frontend and backend as two separate production-mode
containers. It reads `backend/.env` only at backend-container runtime; that file
is excluded from both Docker build contexts and images. `NEXT_PUBLIC_API_BASE_URL`
is intentionally public and is baked into the frontend image at build time.

From the repository root:

```powershell
docker compose up --build
```

- Frontend: [http://localhost:3000](http://localhost:3000)
- Backend health check: [http://localhost:8000/health](http://localhost:8000/health)

Useful commands:

```powershell
# Stop the containers (data in Neon and R2 is unaffected)
docker compose down

# Rebuild without reusing image layers
docker compose build --no-cache

# Follow one service's logs
docker compose logs -f backend
docker compose logs -f frontend
```

The default Compose frontend build uses `http://localhost:8000` as its public API
base URL. To override it for a nonstandard local setup, set
`NEXT_PUBLIC_API_BASE_URL` in the invoking shell before `docker compose up --build`.
For a secret-safe Compose configuration preview, set
`BACKEND_ENV_FILE=backend/.env.example` for that one command instead of printing
the effective configuration with the real `backend/.env` file.

Docker is intended for production-parity checks. On Windows, `npm run dev` remains
the faster option for hot-reloading local development.

## Verification

Run the full local verification suite after installing dependencies:

```powershell
npm run check
npm run build --workspace=@vervio/frontend
```

The frontend check runs TypeScript and ESLint. The backend check runs Ruff and Pytest.

## Configuration

| File | Variable | Purpose |
| --- | --- | --- |
| `frontend/.env.local` | `NEXT_PUBLIC_API_BASE_URL` | Browser-visible base URL for the local backend. |
| `backend/.env` | `CORS_ORIGINS` | Comma-separated browser origins allowed to call the API. |
| `backend/.env` | `ENVIRONMENT` | Runtime environment label reported by the health endpoint. |

Never place API keys, credentials, or production secrets in this repository.

## Database and migrations

Vervio uses PostgreSQL through SQLAlchemy and Alembic. Set `DATABASE_URL` in
`backend/.env` before accessing database-backed functionality or running migrations:

```text
DATABASE_URL=postgresql+psycopg://USERNAME:PASSWORD@localhost:5432/vervio
```

Run these commands from `backend/` with the virtual environment activated:

```powershell
alembic upgrade head
alembic revision --autogenerate -m "describe the schema change"
```

The initial migration creates only relational metadata. Recording rows contain private
object keys and metadata; video bytes are never stored in PostgreSQL.

## Authentication setup

After applying migrations, create accounts only through the backend CLI. Passwords are
prompted interactively and are never accepted as command-line arguments:

```powershell
cd backend
python -m app.cli.create_user admin --email admin@example.com --full-name "Vervio Admin"
python -m app.cli.create_user client_reviewer --email reviewer@example.com --full-name "Client Reviewer" --company-slug client-company
```

The client reviewer command requires an existing company matching `--company-slug`.
There is no public registration endpoint. Local development uses an HttpOnly, `SameSite=Lax`
session cookie; set `AUTH_COOKIE_SECURE=true` for HTTPS deployments. For a genuinely
cross-site frontend and API deployment, set `AUTH_COOKIE_SAMESITE=none` only together
with `AUTH_COOKIE_SECURE=true`. `AUTH_COOKIE_DOMAIN` is optional and must contain a
domain only, not a URL.

## Generic Docker deployment

Deploy the two Docker images as separate services on any Docker-compatible host. The
frontend image requires `NEXT_PUBLIC_API_BASE_URL` at build time; set it to the public
HTTPS backend origin without a trailing slash. The browser converts that URL to WSS for
the Gemini interview socket.

The backend binds to `0.0.0.0` and reads the hosting provider's `PORT` at runtime. Set
`CORS_ORIGINS` to the exact frontend HTTPS origin so HTTP requests, CSRF origin
validation, and WebSocket origin validation agree. Do not run Alembic migrations,
create accounts, or initialize storage automatically at container startup; apply
existing migrations against the intended Neon database in a controlled environment.

Required backend environment-variable names:

```text
DATABASE_URL
CORS_ORIGINS
GEMINI_API_KEY
R2_ACCOUNT_ID
R2_BUCKET_NAME
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

Deployment configuration names (non-secret values):

```text
ENVIRONMENT
AUTH_COOKIE_SECURE
AUTH_COOKIE_SAMESITE
AUTH_COOKIE_DOMAIN
AI_REALTIME_PROVIDER
GEMINI_LIVE_MODEL
GEMINI_ASSESSMENT_MODEL
STORAGE_PROVIDER
RECORDING_MAX_UPLOAD_BYTES
AUTH_SESSION_TTL_HOURS
NEXT_PUBLIC_API_BASE_URL
```

Use `AUTH_COOKIE_SECURE=true` for HTTPS. For a genuinely cross-site frontend and API,
use `AUTH_COOKIE_SAMESITE=none` only with secure cookies. A shared-parent custom domain
can instead use `AUTH_COOKIE_DOMAIN` with `AUTH_COOKIE_SAMESITE=lax`.
