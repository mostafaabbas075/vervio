from app.api.routes.health import health_check
from app.main import app


def test_health_check_returns_service_status() -> None:
    assert any(route.path == "/health" for route in app.routes)
    assert health_check() == {
        "status": "ok",
        "service": "Vervio API",
        "environment": "development",
    }
