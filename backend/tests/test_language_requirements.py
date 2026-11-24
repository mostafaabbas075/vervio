"""Tests for configurable German language requirements and recommendations."""

from __future__ import annotations

from collections.abc import Generator
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.assessments.recommendation import (
    CEFR_ORDER,
    compare_cefr_levels,
    derive_language_recommendation,
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
    User,
)

ADMIN_RAW_TOKEN = "admin-session-token-req"
ADMIN_CSRF_TOKEN = "admin-csrf-token-req"
REVIEWER_RAW_TOKEN = "reviewer-session-token-req"
REVIEWER_CSRF_TOKEN = "reviewer-csrf-token-req"
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
def test_setup(database_session: Session) -> dict[str, Any]:
    admin_user = User(
        email="admin@vervio.test",
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

    company = Company(name="Client Partner", slug="client-partner")
    reviewer_user = User(
        email="reviewer@partner.test",
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
        email="nour@example.test",
        given_name="Nour",
        family_name="Soliman",
        claimed_german_level="C2",  # Self-reported level (must be ignored in recommendation)
    )

    interview_session = InterviewSession(
        candidate=candidate,
        status="completed",
        language="de",
        required_german_level=None,  # Initially not configured
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
    test_client = TestClient(app)
    try:
        yield test_client
    finally:
        app.dependency_overrides.clear()


# ==============================================================================
# 1. Deterministic CEFR Hierarchy and Unit Logic Tests
# ==============================================================================


def test_cefr_hierarchy_order() -> None:
    """Official CEFR order A1 < A2 < B1 < B2 < C1 < C2 is strictly maintained."""
    levels = ["A1", "A2", "B1", "B2", "C1", "C2"]
    for i in range(len(levels) - 1):
        assert CEFR_ORDER[levels[i]] < CEFR_ORDER[levels[i + 1]]
        assert compare_cefr_levels(levels[i], levels[i + 1]) < 0
        assert compare_cefr_levels(levels[i + 1], levels[i]) > 0
        assert compare_cefr_levels(levels[i], levels[i]) == 0


def test_compare_cefr_invalid_values() -> None:
    """Comparing non-CEFR strings raises ValueError."""
    with pytest.raises(ValueError, match="Cannot compare non-CEFR levels"):
        compare_cefr_levels("B3", "B2")
    with pytest.raises(ValueError, match="Cannot compare non-CEFR levels"):
        compare_cefr_levels("A1", "fluent")


def test_recommendation_meets_requirement_equal_b2_vs_b2() -> None:
    """When assessed level equals required level (B2 vs B2), state is meets_requirement."""
    state, explanation = derive_language_recommendation(
        required_level="B2",
        assessment_status="completed",
        assessed_level="B2",
    )
    assert state == "meets_requirement"
    assert "meets the required interview standard (B2)" in explanation
    assert "Final employment decisions require human review." in explanation


def test_recommendation_meets_requirement_exceeds_c1_vs_b2() -> None:
    """When assessed level exceeds required level (C1 vs B2), state is meets_requirement."""
    state, explanation = derive_language_recommendation(
        required_level="B2",
        assessment_status="completed",
        assessed_level="C1",
    )
    assert state == "meets_requirement"
    assert "exceeds the required interview standard (B2)" in explanation
    assert "Final employment decisions require human review." in explanation


def test_recommendation_below_requirement_b2_vs_c1() -> None:
    """When assessed level is below required level (B2 vs C1), state is below_requirement."""
    state, explanation = derive_language_recommendation(
        required_level="C1",
        assessment_status="completed",
        assessed_level="B2",
    )
    assert state == "below_requirement"
    assert "is below the required interview standard (C1)" in explanation
    assert "Final employment decisions require human review." in explanation


def test_recommendation_below_requirement_a2_vs_b1() -> None:
    """When assessed level is below required level (A2 vs B1), state is below_requirement."""
    state, explanation = derive_language_recommendation(
        required_level="B1",
        assessment_status="completed",
        assessed_level="A2",
    )
    assert state == "below_requirement"
    assert "is below the required interview standard (B1)" in explanation


def test_recommendation_not_configured_when_no_requirement() -> None:
    """When no requirement is selected, state is not_configured regardless of assessment."""
    state_no_eval, expl1 = derive_language_recommendation(
        required_level=None,
        assessment_status="completed",
        assessed_level="B2",
    )
    assert state_no_eval == "not_configured"
    assert "No German language requirement has been configured" in expl1

    state_empty, expl2 = derive_language_recommendation(
        required_level="   ",
        assessment_status="completed",
        assessed_level="B2",
    )
    assert state_empty == "not_configured"


def test_recommendation_insufficient_evidence_when_assessment_not_completed() -> None:
    """Pending, failed, or insufficient_evidence assessments never generate meets or below."""
    # 1. Assessment pending
    state_pending, expl_p = derive_language_recommendation(
        required_level="B2",
        assessment_status="pending",
        assessed_level=None,
    )
    assert state_pending == "insufficient_evidence"
    assert "Language assessment is pending" in expl_p

    # 2. Assessment insufficient evidence
    state_insufficient, expl_i = derive_language_recommendation(
        required_level="B2",
        assessment_status="insufficient_evidence",
        assessed_level=None,
    )
    assert state_insufficient == "insufficient_evidence"
    assert "did not provide sufficient German speech evidence" in expl_i

    # 3. Assessment failed
    state_failed, expl_f = derive_language_recommendation(
        required_level="B2",
        assessment_status="failed",
        assessed_level=None,
    )
    assert state_failed == "insufficient_evidence"
    assert "Language assessment failed" in expl_f

    # 4. No assessment at all
    state_none, expl_n = derive_language_recommendation(
        required_level="B2",
        assessment_status=None,
        assessed_level=None,
    )
    assert state_none == "insufficient_evidence"
    assert "No completed language assessment is available" in expl_n


def test_recommendation_ignores_claimed_level_completely() -> None:
    """Candidate's self-reported level (e.g. C2) must never influence recommendation."""
    # Even if candidate claimed C2, if demonstrated level is A2 and requirement is B2:
    state, _ = derive_language_recommendation(
        required_level="B2",
        assessment_status="completed",
        assessed_level="A2",
    )
    assert state == "below_requirement"


# ==============================================================================
# 2. API Endpoint Tests (GET & PATCH /interviews/{session_id}/requirement)
# ==============================================================================


def test_get_requirement_not_configured_by_default(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Initial session without requirement returns recommendation_state='not_configured'."""
    interview = test_setup["interview_session"]

    response = client.get(
        f"/interviews/{interview.id}/requirement",
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["interview_session_id"] == str(interview.id)
    assert data["required_german_level"] is None
    assert data["assessed_german_level"] is None
    assert data["recommendation_state"] == "not_configured"
    assert data["candidate_name"] == "Nour Soliman"
    assert data["candidate_claimed_level"] == "C2"  # Contextual only


def test_patch_requirement_b2_meets_b2(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Setting requirement to B2 for an interview with demonstrated B2 yields meets_requirement."""
    interview = test_setup["interview_session"]
    db: Session = next(app.dependency_overrides[get_db_session]())

    # Attach completed B2 evaluation to the interview session
    evaluation = Evaluation(
        interview_session=interview,
        status="completed",
        assessed_german_level="B2",
        overall_score=Decimal("84.50"),
        summary="Demonstrated confident B2 professional German.",
        strengths=["Solid vocabulary"],
        areas_for_improvement=["Prepositional accuracy"],
        evidence=[],
    )
    db.add(evaluation)
    db.commit()

    # Admin configures requirement to B2
    response = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "B2"},
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["required_german_level"] == "B2"
    assert data["assessed_german_level"] == "B2"
    assert data["recommendation_state"] == "meets_requirement"
    assert "meets the required interview standard (B2)" in data["explanation"]

    # Verify session in database was updated
    db.refresh(interview)
    assert interview.required_german_level == "B2"
    # Verify evaluation was NOT altered
    assert interview.evaluation is not None
    assert interview.evaluation.status == "completed"
    assert interview.evaluation.overall_score == Decimal("84.50")


def test_patch_requirement_update_b2_to_c1_switches_recommendation_immediately(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Updating requirement from B2 to C1 immediately changes recommendation to below."""
    interview = test_setup["interview_session"]
    db: Session = next(app.dependency_overrides[get_db_session]())

    # Interview with completed B2 evaluation and initial requirement B2
    interview.required_german_level = "B2"
    evaluation = Evaluation(
        interview_session=interview,
        status="completed",
        assessed_german_level="B2",
        overall_score=Decimal("80.00"),
        summary="B2 evaluation",
        strengths=["Fluency"],
        areas_for_improvement=["Grammar"],
        evidence=[],
    )
    db.add(evaluation)
    db.commit()

    # Step 1: Verify initial state is meets_requirement
    res_b2 = client.get(
        f"/interviews/{interview.id}/requirement",
        cookies=admin_cookies(),
        headers=admin_headers(),
    )
    assert res_b2.status_code == 200
    assert res_b2.json()["recommendation_state"] == "meets_requirement"

    # Step 2: Admin raises requirement to C1
    res_c1 = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "C1"},
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert res_c1.status_code == 200
    data_c1 = res_c1.json()
    assert data_c1["required_german_level"] == "C1"
    assert data_c1["assessed_german_level"] == "B2"
    assert data_c1["recommendation_state"] == "below_requirement"
    assert "is below the required interview standard (C1)" in data_c1["explanation"]

    # Verify evaluation score and status remain completely untouched
    db.refresh(interview)
    assert interview.required_german_level == "C1"
    assert interview.evaluation.status == "completed"
    assert interview.evaluation.overall_score == Decimal("80.00")


def test_patch_requirement_c1_vs_b2_exceeds(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Assessed C1 with required B2 returns meets_requirement with explanation noting it exceeds."""
    interview = test_setup["interview_session"]
    db: Session = next(app.dependency_overrides[get_db_session]())

    evaluation = Evaluation(
        interview_session=interview,
        status="completed",
        assessed_german_level="C1",
        overall_score=Decimal("92.00"),
        summary="C1 evaluation",
        strengths=["Complex expressions"],
        areas_for_improvement=[],
        evidence=[],
    )
    db.add(evaluation)
    db.commit()

    response = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "B2"},
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["required_german_level"] == "B2"
    assert data["assessed_german_level"] == "C1"
    assert data["recommendation_state"] == "meets_requirement"
    assert "exceeds the required interview standard (B2)" in data["explanation"]


def test_patch_requirement_reset_to_none(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Updating requirement to null resets recommendation_state to not_configured."""
    interview = test_setup["interview_session"]
    db: Session = next(app.dependency_overrides[get_db_session]())
    interview.required_german_level = "B2"
    db.commit()

    response = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": None},
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["required_german_level"] is None
    assert data["recommendation_state"] == "not_configured"

    db.refresh(interview)
    assert interview.required_german_level is None


def test_patch_requirement_insufficient_evidence_assessment(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """When evaluation is insufficient_evidence, recommendation_state is insufficient_evidence."""
    interview = test_setup["interview_session"]
    db: Session = next(app.dependency_overrides[get_db_session]())

    evaluation = Evaluation(
        interview_session=interview,
        status="insufficient_evidence",
        assessed_german_level=None,
        overall_score=None,
        insufficient_evidence_reason="Candidate turn too short.",
    )
    db.add(evaluation)
    db.commit()

    response = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "B2"},
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["required_german_level"] == "B2"
    assert data["assessed_german_level"] is None
    assert data["recommendation_state"] == "insufficient_evidence"
    assert "did not provide sufficient German speech evidence" in data["explanation"]


def test_patch_requirement_invalid_cefr_rejected_422(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Invalid CEFR level values are rejected with HTTP 422 Unprocessable Entity."""
    interview = test_setup["interview_session"]

    # 1. Non-existent CEFR level
    res_b3 = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "B3"},
        cookies=admin_cookies(),
        headers=admin_headers(),
    )
    assert res_b3.status_code == 422

    # 2. Arbitrary text string
    res_fluent = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "fluent"},
        cookies=admin_cookies(),
        headers=admin_headers(),
    )
    assert res_fluent.status_code == 422


def test_requirement_authorization_and_csrf_protection(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Endpoints require authentication, admin role, and CSRF protection."""
    interview = test_setup["interview_session"]

    # 1. Unauthenticated GET rejected
    res_unauth_get = client.get(f"/interviews/{interview.id}/requirement")
    assert res_unauth_get.status_code == 401

    # 2. Unauthenticated PATCH rejected
    res_unauth_patch = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "B2"},
    )
    assert res_unauth_patch.status_code == 401

    # 3. Client reviewer role rejected (admin only)
    res_reviewer = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "B2"},
        cookies=reviewer_cookies(),
        headers=reviewer_headers(),
    )
    assert res_reviewer.status_code == 403

    # 4. Missing CSRF rejected
    res_no_csrf = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "B2"},
        cookies=admin_cookies(),
        headers={"Origin": TRUSTED_ORIGIN},
    )
    assert res_no_csrf.status_code == 403

    # 5. Untrusted origin rejected
    res_bad_origin = client.patch(
        f"/interviews/{interview.id}/requirement",
        json={"required_german_level": "B2"},
        cookies=admin_cookies(),
        headers={"Origin": "https://evil.test", "X-CSRF-Token": ADMIN_CSRF_TOKEN},
    )
    assert res_bad_origin.status_code == 403


def test_get_assessment_response_embeds_requirement_and_recommendation(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """GET /interviews/{session_id}/assessment includes required level and recommendation."""
    interview = test_setup["interview_session"]
    db: Session = next(app.dependency_overrides[get_db_session]())

    interview.required_german_level = "B2"
    evaluation = Evaluation(
        interview_session=interview,
        status="completed",
        assessed_german_level="B2",
        overall_score=Decimal("81.00"),
        summary="Completed assessment",
        strengths=["Vocabulary"],
        areas_for_improvement=["Grammar"],
        evidence=[],
    )
    db.add(evaluation)
    db.commit()

    response = client.get(
        f"/interviews/{interview.id}/assessment",
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["required_german_level"] == "B2"
    assert data["recommendation"] is not None
    assert data["recommendation"]["recommendation_state"] == "meets_requirement"
    assert data["recommendation"]["required_german_level"] == "B2"
    assert data["recommendation"]["assessed_german_level"] == "B2"


def test_create_interview_session_with_optional_required_german_level(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """POST /interviews can accept optional required_german_level."""
    candidate = test_setup["candidate"]

    response = client.post(
        "/interviews",
        json={"candidate_id": str(candidate.id), "required_german_level": "C1"},
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 201
    data = response.json()
    assert data["required_german_level"] == "C1"
    assert data["status"] == "scheduled"
