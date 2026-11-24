from fastapi import APIRouter

from app.core.config import settings

router = APIRouter(tags=["health"])


@router.get("/health")
def health_check() -> dict[str, str]:
    """Return a minimal liveness response for local development and deployment checks."""
    return {
        "status": "ok",
        "service": settings.app_name,
        "environment": settings.environment,
    }
