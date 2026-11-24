import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes.auth import router as auth_router
from app.api.routes.candidates import router as candidates_router
from app.api.routes.evaluations import router as evaluations_router
from app.api.routes.health import router as health_router
from app.api.routes.interviews import router as interviews_router
from app.api.routes.realtime import router as realtime_router
from app.api.routes.recordings import (
    recordings_catalog_router,
)
from app.api.routes.recordings import (
    router as recordings_router,
)
from app.api.routes.transcripts import router as transcripts_router
from app.assessments.auto_evaluator import recover_pending_assessments
from app.core.config import settings

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Durable recovery mechanism: resume pending assessments on backend restart
    try:
        recover_pending_assessments()
    except Exception as exc:
        logger.warning("recovery_of_pending_assessments_failed error=%s", exc)
    yield


app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="Backend foundation for the Vervio MVP.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-CSRF-Token"],
)

app.include_router(health_router)
app.include_router(auth_router)
app.include_router(candidates_router)
app.include_router(interviews_router)
app.include_router(recordings_router)
app.include_router(recordings_catalog_router)
app.include_router(transcripts_router)
app.include_router(evaluations_router)
app.include_router(realtime_router)
