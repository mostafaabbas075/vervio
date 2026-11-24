"""Tests for German assessment retry: POST /interviews/{session_id}/assessment/retry.

Verifies:
- Retry success using existing transcript segments and recording
- Updating failed evaluation status to completed
- Prevention of duplicate/concurrent retries (409 Conflict)
- Protection against overwriting already finalized assessments (400 Bad Request)
- Validation of session state (must be completed with available recording)
- Authentication, admin role, CSRF, and trusted-origin enforcement
- Gemini provider failure (502 Bad Gateway) and timeout (504 Gateway Timeout) handling
"""

from __future__ import annotations

import json
from collections.abc import Generator
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.evaluations import get_gemini_assessment_service
from app.assessments.auto_evaluator import (
    _active_assessments,
    set_db_session_factory_override,
)
from app.assessments.gemini_service import (
    GeminiAssessmentProviderError,
    GeminiAssessmentService,
    GeminiAssessmentTimeoutError,
)
from app.auth.security import token_hash
from app.core.config import settings
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
    TranscriptSegment,
    User,
)

ADMIN_RAW_TOKEN = "test-admin-retry-token"
ADMIN_CSRF_TOKEN = "test-admin-retry-csrf"
REVIEWER_RAW_TOKEN = "test-reviewer-retry-token"
REVIEWER_CSRF_TOKEN = "test-reviewer-retry-csrf"
TRUSTED_ORIGIN = settings.cors_origin_list[0]


def admin_cookies() -> dict[str, str]:
    return {settings.auth_session_cookie_name: ADMIN_RAW_TOKEN}


def reviewer_cookies() -> dict[str, str]:
    return {settings.auth_session_cookie_name: REVIEWER_RAW_TOKEN}


def admin_headers() -> dict[str, str]:
    return {
        "Origin": TRUSTED_ORIGIN,
        "X-CSRF-Token": ADMIN_CSRF_TOKEN,
    }


def reviewer_headers() -> dict[str, str]:
    return {
        "Origin": TRUSTED_ORIGIN,
        "X-CSRF-Token": REVIEWER_CSRF_TOKEN,
    }


def sample_gemini_completed_payload() -> dict[str, Any]:
    return {
        "assessment_status": "completed",
        "estimated_cefr_level": "B2",
        "overall_score": 85.0,
        "summary": "Demonstrated solid B2 German in software development context.",
        "criteria": {
            "grammar": {
                "criterion_code": "grammar",
                "label": "Grammatik & Sprachrichtigkeit",
                "status": "evaluated",
                "score": 84.0,
                "rationale": "Accurate case and tense agreement.",
            },
            "vocabulary": {
                "criterion_code": "vocabulary",
                "label": "Wortschatz & Ausdruckskraft",
                "status": "evaluated",
                "score": 86.0,
                "rationale": "Good technical workplace vocabulary.",
            },
            "comprehension": {
                "criterion_code": "comprehension",
                "label": "Hörverstehen & Interaktion",
                "status": "evaluated",
                "score": 88.0,
                "rationale": "Direct, relevant responses to interviewer questions.",
            },
            "fluency": {
                "criterion_code": "fluency",
                "label": "Gesprochene Sprachflüssigkeit (Text-basiert)",
                "status": "evaluated",
                "score": 82.0,
                "rationale": "Coherent sentence progression.",
            },
            "pronunciation": {
                "criterion_code": "pronunciation",
                "label": "Aussprache & Verständlichkeit",
                "status": "unavailable",
                "score": None,
                "unavailable_reason": (
                    "Pronunciation cannot be evaluated from transcript text alone; "
                    "audio acoustic analysis is required."
                ),
            },
        },
        "strengths": ["Complex subordinate clauses", "Accurate technical terminology"],
        "areas_for_improvement": ["Use varied conversational connectives"],
        "evidence": [
            {
                "segment_position": 2,
                "speaker": "candidate",
                "quote": "Ich habe fünf Jahre Erfahrung als Softwareentwickler gesammelt",
                "observation": "Accurate past perfect construction",
                "criterion_code": "grammar",
            }
        ],
        "insufficient_evidence_reason": None,
    }


@pytest.fixture
def database_session() -> Generator[Session, None, None]:
    engine = create_database_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    session = session_factory()

    set_db_session_factory_override(session_factory)
    _active_assessments.clear()

    try:
        yield session
    finally:
        _active_assessments.clear()
        set_db_session_factory_override(None)
        session.close()
        engine.dispose()


@pytest.fixture
def client(database_session: Session) -> Generator[TestClient, None, None]:
    def override_get_db() -> Generator[Session, None, None]:
        yield database_session

    app.dependency_overrides[get_db_session] = override_get_db
    try:
        with TestClient(app, base_url="http://localhost:8000") as test_client:
            yield test_client
    finally:
        app.dependency_overrides.pop(get_db_session, None)


@pytest.fixture
def test_setup(database_session: Session) -> dict[str, Any]:
    admin_user = User(
        email="admin-retry@vervio.test",
        full_name="Admin Retry",
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

    company = Company(name="Client Retry AG", slug="client-retry-ag")
    reviewer_user = User(
        email="reviewer-retry@client.test",
        full_name="Client Reviewer",
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
        family_name="Ibrahim",
        claimed_german_level="C1",
    )

    interview_session = InterviewSession(
        candidate=candidate,
        status="completed",
        language="de",
        required_german_level="B2",
        is_transcript_finalized=True,
    )

    recording = Recording(
        interview_session=interview_session,
        storage_provider="cloudflare_r2",
        object_key="recordings/hassan-retry.webm",
        content_type="video/webm",
        byte_size=2048000,
        duration_seconds=120,
        checksum="retry-chk",
        status="available",
    )

    segments = [
        TranscriptSegment(
            interview_session=interview_session,
            position=1,
            speaker="interviewer",
            content="Guten Tag Herr Ibrahim, bitte stellen Sie sich kurz vor.",
            start_ms=0,
            end_ms=3000,
        ),
        TranscriptSegment(
            interview_session=interview_session,
            position=2,
            speaker="candidate",
            content=(
                "Guten Tag. Mein Name ist Hassan Ibrahim und ich habe fünf Jahre "
                "Erfahrung als Softwareentwickler gesammelt."
            ),
            start_ms=3500,
            end_ms=10500,
        ),
        TranscriptSegment(
            interview_session=interview_session,
            position=3,
            speaker="interviewer",
            content="Mit welchen Technologien haben Sie bisher am meisten gearbeitet?",
            start_ms=11000,
            end_ms=14500,
        ),
        TranscriptSegment(
            interview_session=interview_session,
            position=4,
            speaker="candidate",
            content=(
                "Ich habe hauptsächlich mit Python, PostgreSQL und Docker gearbeitet "
                "und auch CI/CD-Pipelines aufgebaut."
            ),
            start_ms=15000,
            end_ms=22000,
        ),
    ]

    failed_evaluation = Evaluation(
        interview_session=interview_session,
        status="failed",
        summary="Gemini evaluation failed: 404 models/gemini-pro is not found",
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
            recording,
            *segments,
            failed_evaluation,
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
        "recording": recording,
        "segments": segments,
        "evaluation": failed_evaluation,
    }


def test_retry_assessment_success(
    client: TestClient,
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Admin successfully retries a failed assessment and receives completed assessment."""
    interview = test_setup["interview_session"]

    mock_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.text = json.dumps(sample_gemini_completed_payload())
    mock_client.models.generate_content.return_value = mock_resp
    service = GeminiAssessmentService(api_key="mock-key", client=mock_client)

    app.dependency_overrides[get_gemini_assessment_service] = lambda: service

    try:
        response = client.post(
            f"/interviews/{interview.id}/assessment/retry",
            cookies=admin_cookies(),
            headers=admin_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["assessment_status"] == "completed"
        assert data["estimated_cefr_level"] == "B2"
        assert data["overall_score"] == 85.0
        assert data["criteria"]["grammar"]["score"] == 84.0
        assert data["criteria"]["vocabulary"]["score"] == 86.0
        assert data["criteria"]["comprehension"]["score"] == 88.0
        assert data["criteria"]["fluency"]["score"] == 82.0
        assert len(data["evidence"]) >= 1

        # Recommendation should be derived against required B2 level
        assert data["recommendation"]["recommendation_state"] == "meets_requirement"

        # Verify evaluation in database was updated from failed to completed
        database_session.refresh(interview)
        eval_row = interview.evaluation
        assert eval_row is not None
        assert eval_row.status == "completed"
        assert eval_row.assessed_german_level == "B2"
        assert eval_row.overall_score == Decimal("85.00")
        assert eval_row.evaluated_at is not None
        assert len(eval_row.criterion_scores) == 4
    finally:
        app.dependency_overrides.pop(get_gemini_assessment_service, None)


def test_retry_assessment_concurrency_rejected(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """If an assessment is currently running, concurrent retry returns 409 Conflict."""
    interview = test_setup["interview_session"]
    _active_assessments.add(interview.id)

    try:
        response = client.post(
            f"/interviews/{interview.id}/assessment/retry",
            cookies=admin_cookies(),
            headers=admin_headers(),
        )
        assert response.status_code == 409
        assert "currently being processed" in response.json()["detail"]
    finally:
        _active_assessments.discard(interview.id)


def test_retry_assessment_already_completed_rejected(
    client: TestClient,
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Finalized completed assessment cannot be retried (returns 400 Bad Request)."""
    interview = test_setup["interview_session"]
    eval_row = test_setup["evaluation"]
    eval_row.status = "completed"
    eval_row.assessed_german_level = "B2"
    eval_row.overall_score = Decimal("85.00")
    database_session.commit()

    response = client.post(
        f"/interviews/{interview.id}/assessment/retry",
        cookies=admin_cookies(),
        headers=admin_headers(),
    )
    assert response.status_code == 400
    assert "already finalized" in response.json()["detail"]


def test_retry_assessment_already_insufficient_rejected(
    client: TestClient,
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Finalized insufficient_evidence assessment cannot be retried (returns 400 Bad Request)."""
    interview = test_setup["interview_session"]
    eval_row = test_setup["evaluation"]
    eval_row.status = "insufficient_evidence"
    eval_row.insufficient_evidence_reason = "Candidate spoke too briefly."
    database_session.commit()

    response = client.post(
        f"/interviews/{interview.id}/assessment/retry",
        cookies=admin_cookies(),
        headers=admin_headers(),
    )
    assert response.status_code == 400
    assert "already finalized" in response.json()["detail"]


def test_retry_assessment_invalid_session_state(
    client: TestClient,
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Retry rejects non-completed session or session without available recording."""
    interview = test_setup["interview_session"]

    # 1. Non-completed session
    interview.status = "in_progress"
    database_session.commit()

    res_in_progress = client.post(
        f"/interviews/{interview.id}/assessment/retry",
        cookies=admin_cookies(),
        headers=admin_headers(),
    )
    assert res_in_progress.status_code == 400
    assert "Only completed interviews can be evaluated" in res_in_progress.json()["detail"]

    # 2. Completed session but recording status is failed
    interview.status = "completed"
    recording = test_setup["recording"]
    recording.status = "failed"
    database_session.commit()

    res_rec_failed = client.post(
        f"/interviews/{interview.id}/assessment/retry",
        cookies=admin_cookies(),
        headers=admin_headers(),
    )
    assert res_rec_failed.status_code == 400
    assert "Recording is not available" in res_rec_failed.json()["detail"]

    # 3. Non-existent session
    res_not_found = client.post(
        f"/interviews/{uuid4()}/assessment/retry",
        cookies=admin_cookies(),
        headers=admin_headers(),
    )
    assert res_not_found.status_code == 404


def test_retry_assessment_authorization_and_csrf(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Retry endpoint requires authenticated admin, CSRF token, and trusted origin."""
    interview = test_setup["interview_session"]

    # 1. Unauthenticated request -> 401
    res_unauth = client.post(f"/interviews/{interview.id}/assessment/retry")
    assert res_unauth.status_code == 401

    # 2. Client reviewer (non-admin) -> 403
    res_reviewer = client.post(
        f"/interviews/{interview.id}/assessment/retry",
        cookies=reviewer_cookies(),
        headers=reviewer_headers(),
    )
    assert res_reviewer.status_code == 403

    # 3. Missing CSRF -> 403
    res_no_csrf = client.post(
        f"/interviews/{interview.id}/assessment/retry",
        cookies=admin_cookies(),
        headers={"Origin": TRUSTED_ORIGIN},
    )
    assert res_no_csrf.status_code == 403

    # 4. Untrusted origin -> 403
    res_bad_origin = client.post(
        f"/interviews/{interview.id}/assessment/retry",
        cookies=admin_cookies(),
        headers={"Origin": "https://malicious.test", "X-CSRF-Token": ADMIN_CSRF_TOKEN},
    )
    assert res_bad_origin.status_code == 403


def test_retry_assessment_gemini_provider_error_returns_502(
    client: TestClient,
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Gemini provider error during retry returns 502 and keeps failed evaluation status."""
    interview = test_setup["interview_session"]

    failing_service = MagicMock(spec=GeminiAssessmentService)
    failing_service.evaluate_transcript.side_effect = GeminiAssessmentProviderError(
        "Gemini service unavailable"
    )
    app.dependency_overrides[get_gemini_assessment_service] = lambda: failing_service

    try:
        response = client.post(
            f"/interviews/{interview.id}/assessment/retry",
            cookies=admin_cookies(),
            headers=admin_headers(),
        )
        assert response.status_code == 502
        assert "AI assessment retry failed" in response.json()["detail"]

        database_session.refresh(interview)
        assert interview.evaluation is not None
        assert interview.evaluation.status == "failed"
    finally:
        app.dependency_overrides.pop(get_gemini_assessment_service, None)


def test_retry_assessment_gemini_timeout_returns_504(
    client: TestClient,
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Gemini timeout during retry returns 504 and keeps failed evaluation status."""
    interview = test_setup["interview_session"]

    timeout_service = MagicMock(spec=GeminiAssessmentService)
    timeout_service.evaluate_transcript.side_effect = GeminiAssessmentTimeoutError(
        "Gemini evaluation call timed out"
    )
    app.dependency_overrides[get_gemini_assessment_service] = lambda: timeout_service

    try:
        response = client.post(
            f"/interviews/{interview.id}/assessment/retry",
            cookies=admin_cookies(),
            headers=admin_headers(),
        )
        assert response.status_code == 504
        assert "timed out" in response.json()["detail"]

        database_session.refresh(interview)
        assert interview.evaluation is not None
        assert interview.evaluation.status == "failed"
    finally:
        app.dependency_overrides.pop(get_gemini_assessment_service, None)
