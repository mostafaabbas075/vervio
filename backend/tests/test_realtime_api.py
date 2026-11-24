from __future__ import annotations

from collections.abc import Generator
from datetime import datetime, timezone
from urllib.error import URLError
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.routes import realtime as realtime_routes
from app.api.routes.realtime import initialize_realtime_interview
from app.api.schemas.realtime import RealtimeOfferRequest
from app.auth.dependencies import AuthContext, require_roles
from app.core.config import Settings
from app.db.session import create_database_engine
from app.main import app
from app.models import AuthSession, Base, Candidate, Company, InterviewSession, Recording, User
from app.realtime import service as realtime_service
from app.realtime.service import RealtimeProviderError, build_realtime_session_config


@pytest.fixture
def database_session() -> Generator[Session, None, None]:
    engine = create_database_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine, expire_on_commit=False)
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def authorized_interview(database_session: Session) -> tuple[AuthContext, InterviewSession]:
    user = User(
        email="admin@example.test",
        full_name="Test Admin",
        password_hash="not-used-by-this-route-test",
        role="admin",
    )
    auth_session = AuthSession(
        user=user,
        token_hash="a" * 64,
        csrf_token_hash="b" * 64,
        expires_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        last_seen_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
    )
    candidate = Candidate(
        email="candidate@example.test",
        given_name="Mina",
        family_name="Hassan",
    )
    interview_session = InterviewSession(candidate=candidate, status="scheduled", language="de")
    database_session.add_all([auth_session, interview_session])
    database_session.commit()
    return AuthContext(user=user, session=auth_session), interview_session


def set_realtime_config(
    monkeypatch: pytest.MonkeyPatch, *, api_key: str | None = "test-key"
) -> None:
    monkeypatch.setattr(realtime_routes.settings, "openai_api_key", api_key)
    monkeypatch.setattr(realtime_routes.settings, "openai_realtime_model", "gpt-realtime-2.1-mini")
    monkeypatch.setattr(realtime_routes.settings, "openai_interview_max_duration_seconds", 60)


def test_realtime_route_is_registered() -> None:
    assert "/interviews/{session_id}/realtime/offer" in {route.path for route in app.routes}


def test_authorized_session_initialization_exchanges_only_sdp(
    database_session: Session,
    authorized_interview: tuple[AuthContext, InterviewSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_context, interview_session = authorized_interview
    set_realtime_config(monkeypatch)
    received: dict[str, str] = {}

    def fake_create_realtime_call(**kwargs: str) -> str:
        received.update(kwargs)
        return "v=0\r\na=answer"

    monkeypatch.setattr(realtime_routes, "create_realtime_call", fake_create_realtime_call)
    response = initialize_realtime_interview(
        interview_session.id,
        RealtimeOfferRequest(offer_sdp="v=0\r\na=offer"),
        auth_context=auth_context,
        database_session=database_session,
    )

    assert response.answer_sdp == "v=0\r\na=answer"
    assert response.max_duration_seconds == 60
    assert received["offer_sdp"] == "v=0\r\na=offer"
    assert received["model"] == "gpt-realtime-2.1-mini"
    assert received["api_key"] == "test-key"
    assert received["safety_identifier"] != str(auth_context.user.id)
    persisted = database_session.get(InterviewSession, interview_session.id)
    assert persisted.status == "in_progress"
    assert persisted.started_at is not None


def test_missing_api_key_stops_before_any_provider_call(
    database_session: Session,
    authorized_interview: tuple[AuthContext, InterviewSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_context, interview_session = authorized_interview
    set_realtime_config(monkeypatch, api_key=None)
    monkeypatch.setattr(
        realtime_routes,
        "create_realtime_call",
        lambda **_: pytest.fail("The provider must not be called without configuration."),
    )

    with pytest.raises(HTTPException) as error:
        initialize_realtime_interview(
            interview_session.id,
            RealtimeOfferRequest(offer_sdp="v=0"),
            auth_context=auth_context,
            database_session=database_session,
        )

    assert error.value.status_code == 503


def test_provider_error_returns_a_safe_gateway_error(
    database_session: Session,
    authorized_interview: tuple[AuthContext, InterviewSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_context, interview_session = authorized_interview
    set_realtime_config(monkeypatch)

    def fail_provider(**_: str) -> str:
        raise RealtimeProviderError("upstream details must not reach the browser")

    monkeypatch.setattr(realtime_routes, "create_realtime_call", fail_provider)
    with pytest.raises(HTTPException) as error:
        initialize_realtime_interview(
            interview_session.id,
            RealtimeOfferRequest(offer_sdp="v=0"),
            auth_context=auth_context,
            database_session=database_session,
        )

    assert error.value.status_code == 502
    assert "upstream" not in error.value.detail


def test_unknown_session_is_not_sent_to_openai(
    database_session: Session,
    authorized_interview: tuple[AuthContext, InterviewSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_context, _ = authorized_interview
    set_realtime_config(monkeypatch)
    monkeypatch.setattr(
        realtime_routes,
        "create_realtime_call",
        lambda **_: pytest.fail("The provider must not be called for an unknown session."),
    )

    with pytest.raises(HTTPException) as error:
        initialize_realtime_interview(
            uuid4(),
            RealtimeOfferRequest(offer_sdp="v=0"),
            auth_context=auth_context,
            database_session=database_session,
        )

    assert error.value.status_code == 404


def test_client_reviewer_cannot_initialize_admin_only_realtime_sessions(
    database_session: Session,
) -> None:
    company = Company(name="Client GmbH", slug="client-gmbh")
    reviewer = User(
        email="reviewer@example.test",
        full_name="Client Reviewer",
        password_hash="not-used-by-this-route-test",
        role="client_reviewer",
        company=company,
    )
    auth_session = AuthSession(
        user=reviewer,
        token_hash="c" * 64,
        csrf_token_hash="d" * 64,
        expires_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        last_seen_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
    )
    database_session.add(auth_session)
    database_session.commit()

    with pytest.raises(HTTPException) as error:
        require_roles("admin")(AuthContext(user=reviewer, session=auth_session))

    assert error.value.status_code == 403


def test_realtime_service_uses_ga_session_configuration() -> None:
    config = build_realtime_session_config("gpt-realtime-2.1-mini")

    assert config["type"] == "realtime"
    assert config["model"] == "gpt-realtime-2.1-mini"
    assert config["output_modalities"] == ["audio"]
    assert "auf Deutsch" in str(config["instructions"])
    assert config["audio"] == {
        "input": {
            "turn_detection": {
                "type": "server_vad",
                "prefix_padding_ms": 300,
                "silence_duration_ms": 700,
                "create_response": True,
                "interrupt_response": True,
            }
        },
        "output": {"voice": "marin"},
    }


def test_realtime_service_wraps_network_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_request(*_: object, **__: object) -> object:
        raise URLError("offline")

    monkeypatch.setattr(realtime_service, "urlopen", fail_request)
    with pytest.raises(RealtimeProviderError, match="could not be reached"):
        realtime_service.create_realtime_call(
            offer_sdp="v=0",
            api_key="test-key",
            model="gpt-realtime-2.1-mini",
            safety_identifier="privacy-safe-id",
        )


def test_gemini_live_configuration_defaults_and_validation() -> None:
    settings = Settings(
        _env_file=None,
        ai_realtime_provider="gemini",
        gemini_api_key="test-gemini-key",
        gemini_live_model="gemini-3.8-live",
    )
    assert settings.ai_realtime_provider == "gemini"
    assert settings.gemini_api_key == "test-gemini-key"
    assert settings.gemini_live_model == "gemini-3.8-live"

    default_settings = Settings(_env_file=None)
    assert default_settings.ai_realtime_provider == "gemini"
    assert default_settings.gemini_live_model == "gemini-3.8-live"
    assert default_settings.gemini_api_key is None

    openai_settings = Settings(_env_file=None, ai_realtime_provider="openai")
    assert openai_settings.ai_realtime_provider == "openai"

    with pytest.raises(ValueError, match="Unsupported AI realtime provider"):
        Settings(_env_file=None, ai_realtime_provider="invalid_provider")

    with pytest.raises(ValueError, match="GEMINI_LIVE_MODEL must not be empty"):
        Settings(_env_file=None, gemini_live_model="   ")


def test_initialize_realtime_interview_rejected_if_recording_already_exists(
    database_session: Session,
    authorized_interview: tuple[AuthContext, InterviewSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    auth_context, interview_session = authorized_interview
    set_realtime_config(monkeypatch)
    recording = Recording(
        interview_session_id=interview_session.id,
        storage_provider="local_private",
        object_key="interviews/test/existing.webm",
        content_type="video/webm",
        status="available",
    )
    database_session.add(recording)
    database_session.commit()

    with pytest.raises(HTTPException) as error:
        initialize_realtime_interview(
            interview_session.id,
            RealtimeOfferRequest(offer_sdp="v=0"),
            auth_context=auth_context,
            database_session=database_session,
        )

    assert error.value.status_code == 409
    assert error.value.detail == "An interview recording has already been saved for this session."

