"""Tests for secure German interview transcript persistence, ordering, and auth."""

from __future__ import annotations

from collections.abc import Generator
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas.transcripts import TranscriptSegmentCreate
from app.auth.security import token_hash
from app.core.config import settings
from app.db.session import create_database_engine, get_db_session
from app.main import app
from app.models import (
    AuditEvent,
    AuthSession,
    Base,
    Candidate,
    Company,
    InterviewSession,
    TranscriptSegment,
    User,
)

ADMIN_RAW_TOKEN = "test-admin-session-token"
ADMIN_CSRF_TOKEN = "test-admin-csrf-token"
REVIEWER_RAW_TOKEN = "test-reviewer-session-token"
REVIEWER_CSRF_TOKEN = "test-reviewer-csrf-token"
TRUSTED_ORIGIN = settings.cors_origin_list[0]


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
        csrf_token_hash=token_hash(ADMIN_CSRF_TOKEN),
        expires_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        last_seen_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
    )

    company = Company(name="Client Partner GmbH", slug="client-partner")
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
        csrf_token_hash=token_hash(REVIEWER_CSRF_TOKEN),
        expires_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        last_seen_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
    )

    candidate = Candidate(
        email="hassan@example.test",
        given_name="Hassan",
        family_name="El-Sayed",
        claimed_german_level="B2",
    )
    interview_session = InterviewSession(
        candidate=candidate,
        status="completed",
        language="de",
    )

    database_session.add_all(
        [
            admin_user,
            admin_session,
            company,
            reviewer_user,
            reviewer_session,
            candidate,
            interview_session,
        ]
    )
    database_session.commit()

    return {
        "admin_user": admin_user,
        "admin_session": admin_session,
        "reviewer_user": reviewer_user,
        "reviewer_session": reviewer_session,
        "candidate": candidate,
        "interview_session": interview_session,
    }


@pytest.fixture
def client(database_session: Session) -> Generator[TestClient, None, None]:
    def override_get_db() -> Generator[Session, None, None]:
        yield database_session

    app.dependency_overrides[get_db_session] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def admin_cookies() -> dict[str, str]:
    return {settings.auth_session_cookie_name: ADMIN_RAW_TOKEN}


def admin_headers() -> dict[str, str]:
    return {
        "Origin": TRUSTED_ORIGIN,
        "X-CSRF-Token": ADMIN_CSRF_TOKEN,
    }


def test_empty_transcript_when_none_exists(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    response = client.get(
        f"/interviews/{session.id}/transcript",
        cookies=admin_cookies(),
    )
    assert response.status_code == 200
    data = response.json()
    assert data["interview_session_id"] == str(session.id)
    assert data["language"] == "de"
    assert data["segment_count"] == 0
    assert data["segments"] == []

    # Raw segments endpoint returns empty array
    segments_response = client.get(
        f"/interviews/{session.id}/transcript/segments",
        cookies=admin_cookies(),
    )
    assert segments_response.status_code == 200
    assert segments_response.json() == []


def test_nonexistent_session_returns_404(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    random_id = uuid4()
    get_response = client.get(
        f"/interviews/{random_id}/transcript",
        cookies=admin_cookies(),
    )
    assert get_response.status_code == 404
    assert get_response.json()["detail"] == "Interview session not found."

    post_response = client.post(
        f"/interviews/{random_id}/transcript",
        json={"segments": [{"speaker": "interviewer", "content": "Hallo"}]},
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert post_response.status_code == 404


def test_admin_saves_and_retrieves_german_transcript(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    payload = {
        "segments": [
            {
                "speaker": "interviewer",
                "start_ms": 0,
                "end_ms": 2500,
                "content": "Guten Tag! Können Sie sich bitte kurz vorstellen?",
                "language": "de",
            },
            {
                "speaker": "candidate",
                "start_ms": 3000,
                "end_ms": 8500,
                "content": "Guten Tag. Mein Name ist Hassan und ich habe Informatik studiert.",
                "language": "de",
            },
        ]
    }

    save_response = client.post(
        f"/interviews/{session.id}/transcript",
        json=payload,
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert save_response.status_code == 201
    save_data = save_response.json()
    assert save_data["segment_count"] == 2
    assert len(save_data["segments"]) == 2

    # Verify positions and content
    intro_q = "Guten Tag! Können Sie sich bitte kurz vorstellen?"
    intro_a = "Guten Tag. Mein Name ist Hassan und ich habe Informatik studiert."
    assert save_data["segments"][0]["position"] == 1
    assert save_data["segments"][0]["speaker"] == "interviewer"
    assert save_data["segments"][0]["content"] == intro_q
    assert save_data["segments"][0]["start_ms"] == 0
    assert save_data["segments"][0]["end_ms"] == 2500
    assert save_data["segments"][0]["language"] == "de"

    assert save_data["segments"][1]["position"] == 2
    assert save_data["segments"][1]["speaker"] == "candidate"
    assert save_data["segments"][1]["content"] == intro_a
    assert save_data["segments"][1]["start_ms"] == 3000
    assert save_data["segments"][1]["end_ms"] == 8500

    # Retrieve transcript via GET
    get_response = client.get(
        f"/interviews/{session.id}/transcript",
        cookies=admin_cookies(),
    )
    assert get_response.status_code == 200
    get_data = get_response.json()
    assert get_data["segment_count"] == 2
    assert get_data["segments"][0]["id"] == save_data["segments"][0]["id"]
    assert get_data["segments"][1]["id"] == save_data["segments"][1]["id"]


def test_transcript_ordering_preserved(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    turns = [
        {"speaker": "interviewer", "start_ms": 100, "end_ms": 1000, "content": "Frage 1"},
        {"speaker": "candidate", "start_ms": 1200, "end_ms": 2000, "content": "Antwort 1"},
        {"speaker": "interviewer", "start_ms": 2200, "end_ms": 3000, "content": "Frage 2"},
        {"speaker": "candidate", "start_ms": 3200, "end_ms": 4000, "content": "Antwort 2"},
    ]

    res = client.post(
        f"/interviews/{session.id}/transcript",
        json={"segments": turns},
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert res.status_code == 201
    segments = res.json()["segments"]
    assert [s["position"] for s in segments] == [1, 2, 3, 4]
    assert [s["content"] for s in segments] == ["Frage 1", "Antwort 1", "Frage 2", "Antwort 2"]


def test_transcript_duplicate_prevention_on_repeated_requests(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    initial_payload = {
        "segments": [
            {"speaker": "interviewer", "start_ms": 0, "end_ms": 2000, "content": "Erste Frage"},
            {"speaker": "candidate", "start_ms": 2500, "end_ms": 5000, "content": "Erste Antwort"},
        ]
    }

    # First request
    res1 = client.post(
        f"/interviews/{session.id}/transcript",
        json=initial_payload,
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert res1.status_code == 201
    assert res1.json()["segment_count"] == 2

    # Repeated identical request (e.g. client network retry)
    res2 = client.post(
        f"/interviews/{session.id}/transcript",
        json=initial_payload,
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert res2.status_code == 201
    assert res2.json()["segment_count"] == 2

    # Ensure database only contains 2 segments, not 4
    db_segments = database_session.scalars(
        select(TranscriptSegment).where(TranscriptSegment.interview_session_id == session.id)
    ).all()
    assert len(db_segments) == 2

    # Appending a batch that includes existing segments and a new one
    extended_payload = {
        "segments": [
            {"speaker": "interviewer", "start_ms": 0, "end_ms": 2000, "content": "Erste Frage"},
            {"speaker": "candidate", "start_ms": 2500, "end_ms": 5000, "content": "Erste Antwort"},
            {"speaker": "interviewer", "start_ms": 5500, "end_ms": 7000, "content": "Zweite Frage"},
        ]
    }
    res3 = client.post(
        f"/interviews/{session.id}/transcript",
        json=extended_payload,
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert res3.status_code == 201
    data3 = res3.json()
    assert data3["segment_count"] == 3
    assert [s["position"] for s in data3["segments"]] == [1, 2, 3]
    assert data3["segments"][2]["content"] == "Zweite Frage"


def test_transcript_deduplicates_within_same_batch(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    payload_with_duplicates = {
        "segments": [
            {"speaker": "interviewer", "start_ms": 0, "end_ms": 1000, "content": "Gleiche Frage"},
            {"speaker": "interviewer", "start_ms": 0, "end_ms": 1000, "content": "Gleiche Frage"},
        ]
    }

    res = client.post(
        f"/interviews/{session.id}/transcript",
        json=payload_with_duplicates,
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert res.status_code == 201
    assert res.json()["segment_count"] == 1


def test_transcript_single_segment_and_list_payload_support(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    # Post single segment object directly
    res_single = client.post(
        f"/interviews/{session.id}/transcript",
        json={
            "speaker": "interviewer",
            "content": "Direkte Frage",
            "start_ms": 500,
            "end_ms": 1500,
        },
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert res_single.status_code == 201
    assert res_single.json()["segment_count"] == 1

    # Post raw list of segments
    res_list = client.post(
        f"/interviews/{session.id}/transcript/segments",
        json=[
            {
                "speaker": "candidate",
                "content": "Direkte Antwort",
                "start_ms": 1600,
                "end_ms": 2500,
            }
        ],
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert res_list.status_code == 201
    assert res_list.json()["segment_count"] == 2
    assert res_list.json()["segments"][1]["position"] == 2


def test_transcript_authentication_required(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    # Unauthenticated GET
    get_res = client.get(f"/interviews/{session.id}/transcript")
    assert get_res.status_code == 401
    assert get_res.json()["detail"] == "Authentication required."

    # Unauthenticated POST
    post_res = client.post(
        f"/interviews/{session.id}/transcript",
        json={"segments": [{"speaker": "interviewer", "content": "Hallo"}]},
    )
    assert post_res.status_code == 401


def test_transcript_role_authorization_admin_only(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    reviewer_cookies = {settings.auth_session_cookie_name: REVIEWER_RAW_TOKEN}
    reviewer_headers = {"Origin": TRUSTED_ORIGIN, "X-CSRF-Token": REVIEWER_CSRF_TOKEN}

    # Reviewer GET returns 403
    get_res = client.get(
        f"/interviews/{session.id}/transcript",
        cookies=reviewer_cookies,
    )
    assert get_res.status_code == 403
    assert get_res.json()["detail"] == "Access denied."

    # Reviewer POST returns 403
    post_res = client.post(
        f"/interviews/{session.id}/transcript",
        json={"segments": [{"speaker": "interviewer", "content": "Hallo"}]},
        headers=reviewer_headers,
        cookies=reviewer_cookies,
    )
    assert post_res.status_code == 403


def test_transcript_csrf_and_origin_enforced(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    # Missing CSRF
    no_csrf = client.post(
        f"/interviews/{session.id}/transcript",
        json={"segments": [{"speaker": "interviewer", "content": "Hallo"}]},
        headers={"Origin": TRUSTED_ORIGIN},
        cookies=admin_cookies(),
    )
    assert no_csrf.status_code == 403

    # Invalid origin
    untrusted_origin = client.post(
        f"/interviews/{session.id}/transcript",
        json={"segments": [{"speaker": "interviewer", "content": "Hallo"}]},
        headers={"Origin": "https://attacker.example.com", "X-CSRF-Token": ADMIN_CSRF_TOKEN},
        cookies=admin_cookies(),
    )
    assert untrusted_origin.status_code == 403


def test_transcript_speaker_normalization_and_timing_defaults() -> None:
    # "ai" maps to "interviewer"
    seg1 = TranscriptSegmentCreate(speaker="ai", content="Guten Tag")
    assert seg1.speaker == "interviewer"
    assert seg1.start_ms == 0
    assert seg1.end_ms == 0

    # "user" maps to "candidate"
    seg2 = TranscriptSegmentCreate(speaker="user", content="Hallo", start_ms=1000)
    assert seg2.speaker == "candidate"
    assert seg2.start_ms == 1000
    assert seg2.end_ms == 1000  # adjusted to start_ms

    # Empty content raises validation error
    with pytest.raises(ValueError):
        TranscriptSegmentCreate(speaker="interviewer", content="   ")


def test_audit_event_recorded_without_sensitive_transcript_leak(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    session = test_setup["interview_session"]
    assert isinstance(session, InterviewSession)

    res = client.post(
        f"/interviews/{session.id}/transcript",
        json={
            "segments": [
                {
                    "speaker": "candidate",
                    "content": "Geheime Information",
                    "start_ms": 0,
                    "end_ms": 1000,
                }
            ]
        },
        headers=admin_headers(),
        cookies=admin_cookies(),
    )
    assert res.status_code == 201

    events = database_session.scalars(
        select(AuditEvent).where(AuditEvent.entity_type == "transcript")
    ).all()
    assert len(events) >= 1
    event = events[-1]
    assert event.action == "transcript.saved"
    assert event.entity_id == session.id
    # Ensure sensitive transcript content was not leaked into the audit event context
    assert event.context is None or "Geheime Information" not in str(event.context)
