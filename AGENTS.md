# Vervio engineering guide

## Project context

Vervio is an Egypt-based recruitment intermediary. Candidates take AI-led, German-language interviews. For an authorized German client company, Vervio may provide candidate details, interview recordings, transcripts, and assessment reports.

Vervio is an AI-powered German interview platform, not a job management system or applicant tracking system. Its workflow is candidate-led: an admin adds a candidate (optionally providing a CV as interview context), creates an interview session, and later authorized reviewers assess the resulting recording, transcript, and German-language assessment. Do not add job creation, job management, job descriptions, job posting, recruitment pipelines, applicant tracking, or employer-configured job evaluation criteria. New interview sessions must never require a job record. The AI conversation and original transcript remain German; application UI remains English or Arabic.

Future German-language evaluation is evidence-based and may assess grammar, vocabulary, fluency, pronunciation or intelligibility, listening comprehension, an overall CEFR estimate, and communication strengths and weaknesses. It must be based on demonstrated interview performance, never capped by a claimed CV level, and must not generate job-based acceptance or rejection decisions.

This repository is a demo MVP. Favor a clear, working implementation over enterprise-scale infrastructure. Treat candidate data, CVs, recordings, transcripts, and evaluations as sensitive personal data.

## Architecture

- `frontend/` is a Next.js, TypeScript, Tailwind CSS application. It owns browser UI and calls the backend through `NEXT_PUBLIC_API_BASE_URL`.
- `backend/` is one modular FastAPI application. Keep HTTP routes under `app/api/routes/` and shared configuration under `app/core/`.
- `backend/app/models/` defines SQLAlchemy entities, `backend/app/db/` owns lazy engine/session configuration, and `backend/alembic/` contains schema migrations. PostgreSQL is the application database; Alembic is the only supported schema-change path.
- `backend/app/auth/` holds password hashing, session validation, CSRF checks, rate limiting, and role dependencies. Authentication is server-side and cookie-based; never move session tokens into browser storage.
- OpenAI Realtime, Cloudflare R2, CV processing, and evaluation services are planned integrations. Add them only when a task explicitly requires them; do not split the MVP into microservices prematurely.
- The repository root contains developer commands and documentation. The root `package.json` orchestrates the frontend and backend during development.

## Implementation rules

- Keep features small, modular, typed, and easy to remove or extend.
- Application UI supports English (the default) and Arabic only. Do not add German UI translations. Keep code, API fields, database schemas, and developer documentation in English.
- German is exclusively the AI-led interview conversation language: the interviewer, candidate responses, and interviewer follow-up questions are in German, and the original German transcript is stored. UI localization must never change that interview language. Candidate evaluation measures demonstrated German proficiency independently of the claimed CV level.
- Read configuration from environment variables. Never hardcode secrets, API keys, credentials, or production URLs. Update the relevant `.env*.example` file whenever a new required variable is introduced.
- Do not add interview logic, AI calls, recording storage integrations, or candidate evaluation behavior unless explicitly requested.
- Protect all future state-changing cookie-authenticated routes with the shared CSRF dependency, and enforce authorization in backend dependencies rather than the frontend.
- Store only recording metadata and private object keys in PostgreSQL—never video bytes. Keep self-reported, required, and assessed German levels independent; a self-reported level must never cap an assessment result.
- Do not expose candidate data in logs, fixtures, screenshots, commits, or client-side code.
- Prefer one FastAPI service with well-defined modules over new services. Make storage and AI providers replaceable behind backend-facing interfaces when those features are added.
- Preserve existing user changes. Do not run destructive Git commands without explicit approval.

## Local development

Start from the repository root after installing frontend dependencies and activating the backend virtual environment:

```powershell
npm run dev
```

The frontend runs on `http://localhost:3000`; the backend runs on `http://localhost:8000` and exposes `GET /health`.

## Testing requirements

Before handing off a change, run the checks relevant to modified code:

```powershell
npm run check:frontend
npm run check:backend
```

- Frontend changes must pass TypeScript and ESLint checks; run a production build when routing, configuration, or framework behavior changes.
- Backend changes must pass Ruff and Pytest. Add focused tests for every route and behavior change.
- Authentication changes must test login, session revocation, CSRF protection, and every role boundary they introduce.
- Run migration tests against a disposable PostgreSQL database only when `TEST_DATABASE_URL` is configured. Never point migration tests at a shared or production database.
- For changes that involve both apps, run `npm run check` from the repository root.
