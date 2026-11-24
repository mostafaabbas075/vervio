from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator, Generator
from datetime import datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.websockets import WebSocketDisconnect

from app.api.routes.realtime import (
    MAX_AUDIO_CHUNK_BYTES,
    GeminiPcmOutputPacer,
    get_gemini_service,
)
from app.auth.security import token_hash
from app.db.session import create_database_engine, get_db_session
from app.main import app
from app.models import (
    AuthSession,
    Base,
    Candidate,
    Company,
    InterviewSession,
    Recording,
    TranscriptSegment,
    User,
)
from app.realtime.gemini_service import (
    GeminiLiveConfigurationError,
    GeminiLiveConnectionError,
    GeminiLiveInputError,
    GeminiLiveService,
    GeminiTranscriptEvent,
)

TRUSTED_ORIGIN = "http://localhost:3000"
ADMIN_RAW_TOKEN = "test-admin-session-token"
REVIEWER_RAW_TOKEN = "test-reviewer-session-token"


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
def test_setup(database_session: Session) -> dict[str, object]:
    admin_user = User(
        email="admin@example.test",
        full_name="Admin User",
        password_hash="not-used",
        role="admin",
        status="active",
    )
    admin_session = AuthSession(
        user=admin_user,
        token_hash=token_hash(ADMIN_RAW_TOKEN),
        csrf_token_hash="a" * 64,
        expires_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        last_seen_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
    )

    company = Company(name="Test Company", slug="test-company")
    reviewer_user = User(
        email="reviewer@example.test",
        full_name="Reviewer User",
        password_hash="not-used",
        role="client_reviewer",
        status="active",
        company=company,
    )
    reviewer_session = AuthSession(
        user=reviewer_user,
        token_hash=token_hash(REVIEWER_RAW_TOKEN),
        csrf_token_hash="b" * 64,
        expires_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        last_seen_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
    )

    candidate = Candidate(
        email="candidate@example.test",
        given_name="Mina",
        family_name="Hassan",
    )
    scheduled_interview = InterviewSession(
        candidate=candidate,
        status="scheduled",
        language="de",
    )
    completed_interview = InterviewSession(
        candidate=candidate,
        status="completed",
        language="de",
    )
    english_interview = InterviewSession(
        candidate=candidate,
        status="scheduled",
        language="en",
    )

    database_session.add_all(
        [
            admin_user,
            admin_session,
            reviewer_user,
            reviewer_session,
            candidate,
            scheduled_interview,
            completed_interview,
            english_interview,
        ]
    )
    database_session.commit()

    return {
        "admin_user": admin_user,
        "admin_session": admin_session,
        "scheduled_interview": scheduled_interview,
        "completed_interview": completed_interview,
        "english_interview": english_interview,
    }


@pytest.fixture
def client(database_session: Session) -> Generator[TestClient, None, None]:
    def override_get_db() -> Generator[Session, None, None]:
        yield database_session

    app.dependency_overrides[get_db_session] = override_get_db
    test_client = TestClient(app)
    try:
        yield test_client
    finally:
        app.dependency_overrides.clear()


def test_gemini_websocket_route_is_registered() -> None:
    routes = {route.path for route in app.routes}
    assert "/interviews/{session_id}/gemini/ws" in routes


def test_gemini_websocket_authorized_connection_receives_ready(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        message = ws.receive_json()
        assert message["status"] == "ready"
        assert message["type"] == "ready"

    # Confirm the interview status was NOT modified
    database_session.refresh(interview)
    assert interview.status == "scheduled"


def test_gemini_websocket_unauthorized_missing_cookie(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/interviews/{interview.id}/gemini/ws",
            headers={"origin": TRUSTED_ORIGIN},
        ):
            pass

    assert exc.value.code == 1008



def test_gemini_websocket_unauthorized_non_admin_role(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", REVIEWER_RAW_TOKEN)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/interviews/{interview.id}/gemini/ws",
            headers={"origin": TRUSTED_ORIGIN},
        ):
            pass

    assert exc.value.code == 1008



def test_gemini_websocket_unauthorized_expired_session(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    admin_session = test_setup["admin_session"]
    assert isinstance(admin_session, AuthSession)
    admin_session.expires_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
    database_session.commit()

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/interviews/{interview.id}/gemini/ws",
            headers={"origin": TRUSTED_ORIGIN},
        ):
            pass

    assert exc.value.code == 1008



def test_gemini_websocket_unauthorized_revoked_session(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    admin_session = test_setup["admin_session"]
    assert isinstance(admin_session, AuthSession)
    admin_session.revoked_at = datetime.now(timezone.utc)
    database_session.commit()

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/interviews/{interview.id}/gemini/ws",
            headers={"origin": TRUSTED_ORIGIN},
        ):
            pass

    assert exc.value.code == 1008



def test_gemini_websocket_untrusted_origin_rejected(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/interviews/{interview.id}/gemini/ws",
            headers={"origin": "http://evil-attacker.example"},
        ):
            pass

    assert exc.value.code == 1008



def test_gemini_websocket_invalid_session_unknown_id(
    client: TestClient,
) -> None:
    unknown_id = uuid4()
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/interviews/{unknown_id}/gemini/ws",
            headers={"origin": TRUSTED_ORIGIN},
        ):
            pass

    assert exc.value.code == 1008



def test_gemini_websocket_invalid_session_non_german(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    interview = test_setup["english_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/interviews/{interview.id}/gemini/ws",
            headers={"origin": TRUSTED_ORIGIN},
        ):
            pass

    assert exc.value.code == 1008



def test_gemini_websocket_invalid_session_completed(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    interview = test_setup["completed_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/interviews/{interview.id}/gemini/ws",
            headers={"origin": TRUSTED_ORIGIN},
        ):
            pass

    assert exc.value.code == 1008



def test_gemini_websocket_invalid_session_malformed_uuid(
    client: TestClient,
) -> None:
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            "/interviews/not-a-valid-uuid/gemini/ws",
            headers={"origin": TRUSTED_ORIGIN},
        ):
            pass

    assert exc.value.code == 1008


def test_gemini_websocket_rejected_if_recording_already_exists(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    recording = Recording(
        interview_session_id=interview.id,
        storage_provider="local_private",
        object_key="interviews/test/existing.webm",
        content_type="video/webm",
        status="available",
    )
    database_session.add(recording)
    database_session.commit()

    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/interviews/{interview.id}/gemini/ws",
            headers={"origin": TRUSTED_ORIGIN},
        ):
            pass

    assert exc.value.code == 1008



def test_gemini_websocket_handles_disconnect_and_cleanup_safely(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ready = ws.receive_json()
        assert ready["status"] == "ready"
        ws.send_text("ping")

    # Closes cleanly when exiting context


def create_mock_gemini_service() -> MagicMock:
    mock_service = MagicMock(spec=GeminiLiveService)
    mock_service.is_active = False

    async def fake_connect() -> None:
        mock_service.is_active = True

    async def fake_close() -> None:
        mock_service.is_active = False

    mock_service.connect = AsyncMock(side_effect=fake_connect)
    mock_service.close = AsyncMock(side_effect=fake_close)
    mock_service.request_initial_greeting = AsyncMock()
    mock_service.send_audio_chunk = AsyncMock()

    async def wait_for_audio_forever(
        *, on_interrupted: Any | None = None, on_server_event: Any | None = None
    ) -> AsyncIterator[bytes]:
        # A connected Live session blocks while awaiting a model turn. Keeping this mocked
        # receiver pending avoids a synthetic empty stream from masking control messages.
        await asyncio.Event().wait()
        if False:  # pragma: no cover - marks this as an async generator for the mock contract.
            yield b""

    mock_service.receive_audio_chunks = MagicMock(side_effect=wait_for_audio_forever)
    return mock_service


def test_gemini_websocket_successful_start_returns_provider_connected(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    mock_service = create_mock_gemini_service()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ready = ws.receive_json()
        assert ready["type"] == "ready"

        ws.send_json({"type": "start"})
        connected = ws.receive_json()
        assert connected["type"] == "provider_connected"
        assert connected["status"] == "provider_connected"
        assert mock_service.is_active
        mock_service.connect.assert_awaited_once()
        mock_service.request_initial_greeting.assert_not_called()
        ws.send_json({"type": "client_ready"})
        mock_service.request_initial_greeting.assert_awaited_once()

    mock_service.close.assert_awaited_once()
    assert not mock_service.is_active
    database_session.refresh(interview)
    assert interview.status == "in_progress"
    assert interview.started_at is not None


def test_gemini_websocket_duplicate_start_returns_error(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready

        ws.send_json({"type": "start"})
        connected = ws.receive_json()
        assert connected["type"] == "provider_connected"

        ws.send_json({"type": "start"})
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "already" in err["message"].lower()
        mock_service.connect.assert_awaited_once()


def test_gemini_websocket_start_missing_api_key_returns_safe_error(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = MagicMock(spec=GeminiLiveService)
    mock_service.is_active = False
    mock_service.connect = AsyncMock(
        side_effect=GeminiLiveConfigurationError("Gemini API key is not configured.")
    )
    mock_service.close = AsyncMock()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready

        ws.send_json({"type": "start"})
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "not configured" in err["message"]


def test_gemini_websocket_start_connection_error_returns_safe_error(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = MagicMock(spec=GeminiLiveService)
    mock_service.is_active = False
    mock_service.connect = AsyncMock(
        side_effect=GeminiLiveConnectionError(
            "The AI voice service could not establish a connection."
        )
    )
    mock_service.close = AsyncMock()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready

        ws.send_json({"type": "start"})
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "could not establish a connection" in err["message"]


def test_gemini_websocket_start_unexpected_exception_returns_safe_error(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = MagicMock(spec=GeminiLiveService)
    mock_service.is_active = False
    mock_service.connect = AsyncMock(side_effect=RuntimeError("internal crash detail"))
    mock_service.close = AsyncMock()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready

        ws.send_json({"type": "start"})
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "Failed to connect" in err["message"]
        assert "internal crash detail" not in err["message"]


def test_gemini_websocket_invalid_json_message_returns_error(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready

        ws.send_text("not-a-json-object")
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "Invalid JSON" in err["message"]

        # WebSocket connection remains usable
        ws.send_json({"type": "start"})
        connected = ws.receive_json()
        assert connected["type"] == "provider_connected"


def test_gemini_websocket_unexpected_message_type_returns_error(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready

        ws.send_json({"type": "unknown_action"})
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "Unsupported" in err["message"]


def test_gemini_websocket_audio_forwarding_successful(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready
        ws.send_json({"type": "start"})
        connected = ws.receive_json()
        assert connected["type"] == "provider_connected"

        # Stream first PCM audio chunk
        first_chunk = b"\x00\x01" * 160
        ws.send_bytes(first_chunk)
        mock_service.send_audio_chunk.assert_awaited_once_with(first_chunk)

        # Stream second PCM audio chunk
        second_chunk = b"\x00\x02" * 320
        ws.send_bytes(second_chunk)
        assert mock_service.send_audio_chunk.await_count == 2
        assert mock_service.send_audio_chunk.call_args_list[1].args[0] == second_chunk


def test_gemini_websocket_audio_rejected_before_start(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready

        # Send audio before sending {"type": "start"}
        ws.send_bytes(b"\x00\x01" * 80)
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "before starting the session" in err["message"]

        mock_service.send_audio_chunk.assert_not_called()


def test_gemini_websocket_audio_rejected_when_empty(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready
        ws.send_json({"type": "start"})
        ws.receive_json()  # provider_connected

        # Send empty audio bytes
        ws.send_bytes(b"")
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "cannot be empty" in err["message"]

        mock_service.send_audio_chunk.assert_not_called()


def test_gemini_websocket_audio_rejected_when_oversized(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready
        ws.send_json({"type": "start"})
        ws.receive_json()  # provider_connected

        # Send audio exceeding maximum chunk size
        oversized = b"\x00" * (MAX_AUDIO_CHUNK_BYTES + 1)
        ws.send_bytes(oversized)
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "exceeds maximum allowed size" in err["message"]

        mock_service.send_audio_chunk.assert_not_called()


def test_gemini_websocket_audio_forwarding_connection_error_handled_safely(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    mock_service.send_audio_chunk = AsyncMock(
        side_effect=GeminiLiveConnectionError(
            "The AI voice service could not establish a connection."
        )
    )
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready
        ws.send_json({"type": "start"})
        ws.receive_json()  # provider_connected

        ws.send_bytes(b"\x00\x01" * 80)
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "Failed to forward audio" in err["message"]


def test_gemini_websocket_audio_forwarding_input_error_handled_safely(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    mock_service.send_audio_chunk = AsyncMock(
        side_effect=GeminiLiveInputError("Audio chunk must be bytes.")
    )
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready
        ws.send_json({"type": "start"})
        ws.receive_json()  # provider_connected

        ws.send_bytes(b"\x00\x01" * 80)
        err = ws.receive_json()
        assert err["type"] == "error"
        assert "Audio chunk must be bytes" in err["message"]


def test_gemini_websocket_disconnected_session_cleanup_after_audio(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready
        ws.send_json({"type": "start"})
        ws.receive_json()  # provider_connected

        ws.send_bytes(b"\x00\x01" * 160)
        mock_service.send_audio_chunk.assert_awaited_once()

    # Verify cleanup on disconnect
    mock_service.close.assert_awaited_once()
    assert not mock_service.is_active


def test_gemini_websocket_forwards_multiple_ai_audio_chunks_as_binary_frames(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    first_chunk = b"\x01\x02" * 240
    second_chunk = b"\x03\x04" * 360

    async def receive_multiple_turns(
        *, on_interrupted: Any | None = None, on_server_event: Any | None = None
    ) -> AsyncIterator[bytes]:
        yield first_chunk
        yield second_chunk
        await asyncio.Event().wait()

    mock_service.receive_audio_chunks = MagicMock(side_effect=receive_multiple_turns)
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "start"})
        assert ws.receive_json()["type"] == "provider_connected"

        assert ws.receive_bytes() == first_chunk
        assert ws.receive_bytes() == second_chunk

    mock_service.receive_audio_chunks.assert_called_once()


def test_gemini_output_pacer_preserves_consecutive_turn_audio_until_provider_interruption() -> None:
    pacer = GeminiPcmOutputPacer(max_backlog_seconds=1)
    first_turn_audio = b"\x01\x02" * 2_400
    second_turn_audio = b"\x03\x04" * 2_400

    pacer.enqueue(first_turn_audio)
    pacer.enqueue(second_turn_audio)

    assert pacer.queued_duration_seconds == pytest.approx(0.2)
    assert pacer.interrupt() == len(first_turn_audio) + len(second_turn_audio)
    assert pacer.queued_duration_seconds == 0


def test_gemini_websocket_keeps_microphone_input_active_while_forwarding_audio(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    ai_chunk = b"\x0a\x0b" * 320

    async def delayed_ai_audio(
        *, on_interrupted: Any | None = None, on_server_event: Any | None = None
    ) -> AsyncIterator[bytes]:
        await asyncio.sleep(0.02)
        yield ai_chunk
        await asyncio.Event().wait()

    mock_service.receive_audio_chunks = MagicMock(side_effect=delayed_ai_audio)
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)
    microphone_chunk = b"\x11\x12" * 160

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready
        ws.send_json({"type": "start"})
        assert ws.receive_json()["type"] == "provider_connected"

        ws.send_bytes(microphone_chunk)
        assert ws.receive_bytes() == ai_chunk
        mock_service.send_audio_chunk.assert_awaited_once_with(microphone_chunk)


def test_gemini_websocket_cancels_audio_receiver_on_disconnect(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    mock_service = create_mock_gemini_service()
    receiver_started = threading.Event()
    receiver_cancelled = threading.Event()

    async def receive_until_cancelled(
        *, on_interrupted: Any | None = None, on_server_event: Any | None = None
    ) -> AsyncIterator[bytes]:
        receiver_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            receiver_cancelled.set()
        if False:  # pragma: no cover - makes the cancellation mock an async generator.
            yield b""

    mock_service.receive_audio_chunks = MagicMock(side_effect=receive_until_cancelled)
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        ws.receive_json()  # ready
        ws.send_json({"type": "start"})
        assert ws.receive_json()["type"] == "provider_connected"
        assert receiver_started.wait(timeout=1)

    assert receiver_cancelled.wait(timeout=1)
    mock_service.close.assert_awaited_once()


def test_gemini_websocket_persists_transcript_segments_to_database(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    mock_service = create_mock_gemini_service()

    async def receive_with_transcripts(
        *,
        on_interrupted: Any | None = None,
        on_server_event: Any | None = None,
        on_transcript_event: Any | None = None,
    ) -> AsyncIterator[bytes]:
        if on_transcript_event is not None:
            # Interviewer turn
            await on_transcript_event(
                GeminiTranscriptEvent(
                    speaker="interviewer",
                    text="Guten Tag! Willkommen zum Interview.",
                    is_final=True,
                    start_offset="0s",
                    end_offset="2s",
                )
            )
            if on_server_event is not None:
                await on_server_event("turn_complete")

            # Candidate turn
            await on_transcript_event(
                GeminiTranscriptEvent(
                    speaker="candidate",
                    text="Hallo! Ich freue mich auf das Gespräch.",
                    is_final=True,
                    start_offset="2.5s",
                    end_offset="5s",
                )
            )

        yield b"\x00\x01" * 80

    mock_service.receive_audio_chunks = MagicMock(side_effect=receive_with_transcripts)
    app.dependency_overrides[get_gemini_service] = lambda: mock_service

    interview = test_setup["scheduled_interview"]
    assert isinstance(interview, InterviewSession)
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)

    with client.websocket_connect(
        f"/interviews/{interview.id}/gemini/ws",
        headers={"origin": TRUSTED_ORIGIN},
    ) as ws:
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "start"})
        assert ws.receive_json()["type"] == "provider_connected"
        audio_frame = ws.receive_bytes()
        assert len(audio_frame) > 0

    # After websocket closes, verify segments persisted in database
    segments = database_session.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.interview_session_id == interview.id)
        .order_by(TranscriptSegment.position.asc())
    ).all()

    assert len(segments) == 2
    assert segments[0].position == 1
    assert segments[0].speaker == "interviewer"
    assert segments[0].content == "Guten Tag! Willkommen zum Interview."
    assert segments[1].position == 2
    assert segments[1].speaker == "candidate"
    assert segments[1].content == "Hallo! Ich freue mich auf das Gespräch."
