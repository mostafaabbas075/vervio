from __future__ import annotations

from collections.abc import Generator
from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes.recordings import (
    get_candidate_recordings,
    get_candidates_with_recordings,
)
from app.auth.security import token_hash
from app.db.session import create_database_engine, get_db_session
from app.main import app
from app.models import (
    AuthSession,
    Base,
    Candidate,
    Company,
    Evaluation,
    InterviewSession,
    Recording,
    User,
)

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

    database_session.add_all(
        [
            admin_user,
            admin_session,
            company,
            reviewer_user,
            reviewer_session,
        ]
    )
    database_session.commit()

    return {
        "admin_user": admin_user,
        "admin_session": admin_session,
        "reviewer_user": reviewer_user,
        "reviewer_session": reviewer_session,
    }


@pytest.fixture
def client(database_session: Session) -> Generator[TestClient, None, None]:
    def override_get_db() -> Generator[Session, None, None]:
        yield database_session

    app.dependency_overrides[get_db_session] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def test_candidates_with_recordings_grouping_and_exclusion(
    database_session: Session,
) -> None:
    # Candidate A: 2 sessions, both with available recordings
    candidate_a = Candidate(
        email="mina@example.test",
        given_name="Mina",
        family_name="Hassan",
    )
    # Candidate B: 1 session with an available recording
    candidate_b = Candidate(
        email="sarah@example.test",
        given_name="Sarah",
        family_name="Mansour",
    )
    # Candidate C: 1 session, scheduled, no recording
    candidate_c = Candidate(
        email="tarek@example.test",
        given_name="Tarek",
        family_name="Zayed",
    )
    # Candidate D: 0 sessions
    candidate_d = Candidate(
        email="nour@example.test",
        given_name="Nour",
        family_name="Ali",
    )
    database_session.add_all([candidate_a, candidate_b, candidate_c, candidate_d])
    database_session.flush()

    # Sessions for Candidate A
    session_a1 = InterviewSession(candidate_id=candidate_a.id, status="completed", language="de")
    session_a2 = InterviewSession(candidate_id=candidate_a.id, status="completed", language="de")
    # Session for Candidate B
    session_b1 = InterviewSession(candidate_id=candidate_b.id, status="completed", language="de")
    # Session for Candidate C
    session_c1 = InterviewSession(candidate_id=candidate_c.id, status="scheduled", language="de")

    database_session.add_all([session_a1, session_a2, session_b1, session_c1])
    database_session.flush()

    # Recordings for A and B
    rec_a1 = Recording(
        interview_session_id=session_a1.id,
        storage_provider="local_private",
        object_key="interviews/a1/video.webm",
        content_type="video/webm",
        status="available",
    )
    rec_a2 = Recording(
        interview_session_id=session_a2.id,
        storage_provider="cloudflare_r2",
        object_key="interviews/a2/video.mp4",
        content_type="video/mp4",
        status="available",
    )
    rec_b1 = Recording(
        interview_session_id=session_b1.id,
        storage_provider="cloudflare_r2",
        object_key="interviews/b1/video.webm",
        content_type="video/webm",
        status="available",
    )
    database_session.add_all([rec_a1, rec_a2, rec_b1])
    database_session.commit()

    summaries = get_candidates_with_recordings(database_session)

    # Only candidates A and B must appear in the summary
    assert len(summaries) == 2
    summary_map = {s.candidate_id: s for s in summaries}

    assert candidate_a.id in summary_map
    assert summary_map[candidate_a.id].full_name == "Mina Hassan"
    assert summary_map[candidate_a.id].email == "mina@example.test"
    assert summary_map[candidate_a.id].recording_count == 2
    assert summary_map[candidate_a.id].id == candidate_a.id

    assert candidate_b.id in summary_map
    assert summary_map[candidate_b.id].full_name == "Sarah Mansour"
    assert summary_map[candidate_b.id].email == "sarah@example.test"
    assert summary_map[candidate_b.id].recording_count == 1

    # Candidates C and D have no saved recordings and must be excluded
    assert candidate_c.id not in summary_map
    assert candidate_d.id not in summary_map


def test_candidate_recordings_multiple_interviews(
    database_session: Session,
) -> None:
    candidate = Candidate(
        email="mina@example.test",
        given_name="Mina",
        family_name="Hassan",
    )
    database_session.add(candidate)
    database_session.flush()

    # 3 sessions: 2 recorded, 1 scheduled without recording
    session_1 = InterviewSession(candidate_id=candidate.id, status="completed", language="de")
    session_2 = InterviewSession(candidate_id=candidate.id, status="completed", language="de")
    session_3 = InterviewSession(candidate_id=candidate.id, status="scheduled", language="de")
    database_session.add_all([session_1, session_2, session_3])
    database_session.flush()

    rec_1 = Recording(
        interview_session_id=session_1.id,
        storage_provider="local_private",
        object_key="interviews/1/video.webm",
        content_type="video/webm",
        byte_size=1024,
        duration_seconds=60,
        status="available",
    )
    rec_2 = Recording(
        interview_session_id=session_2.id,
        storage_provider="cloudflare_r2",
        object_key="interviews/2/video.mp4",
        content_type="video/mp4",
        byte_size=2048,
        duration_seconds=120,
        status="available",
    )
    database_session.add_all([rec_1, rec_2])
    database_session.commit()

    recordings = get_candidate_recordings(candidate.id, database_session)

    assert len(recordings) == 2
    interview_ids = {r.interview_id for r in recordings}
    recording_ids = {r.recording_id for r in recordings}

    assert interview_ids == {session_1.id, session_2.id}
    assert recording_ids == {rec_1.id, rec_2.id}

    for item in recordings:
        assert item.candidate_id == candidate.id
        assert item.storage_status == "available"
        assert item.date is not None
        assert item.interview_status == "completed"


def test_empty_folder_for_candidate_without_recordings(
    database_session: Session,
) -> None:
    # Candidate with a session but no recording
    candidate_with_session = Candidate(
        email="empty1@example.test",
        given_name="Empty",
        family_name="One",
    )
    # Candidate with no sessions at all
    candidate_no_sessions = Candidate(
        email="empty2@example.test",
        given_name="Empty",
        family_name="Two",
    )
    database_session.add_all([candidate_with_session, candidate_no_sessions])
    database_session.flush()

    session = InterviewSession(
        candidate_id=candidate_with_session.id,
        status="scheduled",
        language="de",
    )
    database_session.add(session)
    database_session.commit()

    folder_1 = get_candidate_recordings(candidate_with_session.id, database_session)
    assert folder_1 == []

    folder_2 = get_candidate_recordings(candidate_no_sessions.id, database_session)
    assert folder_2 == []


def test_candidate_recordings_returns_404_for_unknown_candidate(
    database_session: Session,
) -> None:
    unknown_id = uuid4()
    with pytest.raises(HTTPException) as error:
        get_candidate_recordings(unknown_id, database_session)
    assert error.value.status_code == 404
    assert error.value.detail == "Candidate not found."


def test_candidate_recordings_real_evaluation_vs_pending(
    database_session: Session,
) -> None:
    candidate = Candidate(
        email="evaluated@example.test",
        given_name="Evaluated",
        family_name="Candidate",
    )
    database_session.add(candidate)
    database_session.flush()

    # Session 1: Has a real, completed evaluation with an overall score
    session_1 = InterviewSession(candidate_id=candidate.id, status="completed", language="de")
    # Session 2: Has a pending evaluation without score
    session_2 = InterviewSession(candidate_id=candidate.id, status="completed", language="de")
    # Session 3: Has NO evaluation record
    session_3 = InterviewSession(candidate_id=candidate.id, status="completed", language="de")
    database_session.add_all([session_1, session_2, session_3])
    database_session.flush()

    rec_1 = Recording(
        interview_session_id=session_1.id,
        storage_provider="cloudflare_r2",
        object_key="interviews/eval1/video.webm",
        content_type="video/webm",
        status="available",
    )
    rec_2 = Recording(
        interview_session_id=session_2.id,
        storage_provider="cloudflare_r2",
        object_key="interviews/eval2/video.webm",
        content_type="video/webm",
        status="available",
    )
    rec_3 = Recording(
        interview_session_id=session_3.id,
        storage_provider="cloudflare_r2",
        object_key="interviews/eval3/video.webm",
        content_type="video/webm",
        status="available",
    )

    eval_1 = Evaluation(
        interview_session_id=session_1.id,
        status="completed",
        assessed_german_level="B2",
        overall_score=Decimal("84.50"),
        summary="Demonstrated confident technical German communication.",
    )
    eval_2 = Evaluation(
        interview_session_id=session_2.id,
        status="pending",
        assessed_german_level=None,
        overall_score=None,
    )

    database_session.add_all([rec_1, rec_2, rec_3, eval_1, eval_2])
    database_session.commit()

    recordings = get_candidate_recordings(candidate.id, database_session)
    recordings_by_session = {r.interview_id: r for r in recordings}

    # Session 1: Real evaluation data exists
    item_1 = recordings_by_session[session_1.id]
    assert item_1.score == 84.5
    assert item_1.evaluation_status == "completed"
    assert item_1.evaluation is not None
    assert item_1.evaluation.status == "completed"
    assert item_1.evaluation.overall_score == 84.5
    assert item_1.evaluation.assessed_german_level == "B2"
    assert item_1.evaluation.summary == "Demonstrated confident technical German communication."

    # Session 2: Pending evaluation, no score
    item_2 = recordings_by_session[session_2.id]
    assert item_2.score is None
    assert item_2.evaluation_status == "pending"
    assert item_2.evaluation is not None
    assert item_2.evaluation.status == "pending"
    assert item_2.evaluation.overall_score is None

    # Session 3: No evaluation at all
    item_3 = recordings_by_session[session_3.id]
    assert item_3.score is None
    assert item_3.evaluation_status == "pending"
    assert item_3.evaluation is None


def test_non_available_recordings_are_excluded(
    database_session: Session,
) -> None:
    candidate = Candidate(
        email="pending_rec@example.test",
        given_name="Pending",
        family_name="Recording",
    )
    database_session.add(candidate)
    database_session.flush()

    session = InterviewSession(candidate_id=candidate.id, status="in_progress", language="de")
    database_session.add(session)
    database_session.flush()

    # Recording is still pending, not available
    rec_pending = Recording(
        interview_session_id=session.id,
        storage_provider="local_private",
        object_key="interviews/pending/video.webm",
        content_type="video/webm",
        status="pending",
    )
    database_session.add(rec_pending)
    database_session.commit()

    # Must be excluded from candidate summary
    summaries = get_candidates_with_recordings(database_session)
    assert candidate.id not in {s.candidate_id for s in summaries}

    # Recorded interviews folder must be empty
    recordings = get_candidate_recordings(candidate.id, database_session)
    assert recordings == []


def test_api_endpoints_authorization(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    candidate = Candidate(
        email="auth_test@example.test",
        given_name="Auth",
        family_name="Test",
    )
    database_session.add(candidate)
    database_session.flush()

    session = InterviewSession(candidate_id=candidate.id, status="completed", language="de")
    database_session.add(session)
    database_session.flush()

    rec = Recording(
        interview_session_id=session.id,
        storage_provider="local_private",
        object_key="interviews/auth/video.webm",
        content_type="video/webm",
        status="available",
    )
    database_session.add(rec)
    database_session.commit()

    # 1. Unauthenticated -> 401
    resp1 = client.get("/recordings")
    assert resp1.status_code == 401

    resp2 = client.get(f"/recordings/{candidate.id}")
    assert resp2.status_code == 401

    resp3 = client.get(f"/candidates/{candidate.id}/recordings")
    assert resp3.status_code == 401

    resp4 = client.get("/candidates/recordings")
    assert resp4.status_code == 401

    # 2. Reviewer (non-admin) -> 403
    client.cookies.set("vervio_session", REVIEWER_RAW_TOKEN)
    resp_rev1 = client.get("/recordings")
    assert resp_rev1.status_code == 403

    resp_rev2 = client.get(f"/recordings/{candidate.id}")
    assert resp_rev2.status_code == 403

    resp_rev3 = client.get(f"/candidates/{candidate.id}/recordings")
    assert resp_rev3.status_code == 403

    # 3. Admin -> 200
    client.cookies.set("vervio_session", ADMIN_RAW_TOKEN)
    resp_adm1 = client.get("/recordings")
    assert resp_adm1.status_code == 200
    data1 = resp_adm1.json()
    assert isinstance(data1, list)
    assert len(data1) == 1
    assert data1[0]["candidate_id"] == str(candidate.id)
    assert data1[0]["recording_count"] == 1
    assert data1[0]["full_name"] == "Auth Test"
    assert data1[0]["email"] == "auth_test@example.test"

    resp_adm2 = client.get(f"/recordings/{candidate.id}")
    assert resp_adm2.status_code == 200
    data2 = resp_adm2.json()
    assert isinstance(data2, list)
    assert len(data2) == 1
    assert data2[0]["recording_id"] == str(rec.id)
    assert data2[0]["storage_status"] == "available"

    # Also test /candidates/{candidate_id}/recordings
    resp_adm3 = client.get(f"/candidates/{candidate.id}/recordings")
    assert resp_adm3.status_code == 200
    assert resp_adm3.json() == data2

    # Also test /candidates/recordings
    resp_adm4 = client.get("/candidates/recordings")
    assert resp_adm4.status_code == 200
    assert resp_adm4.json() == data1
