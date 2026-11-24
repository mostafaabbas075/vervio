"""Tests for German language assessment foundation, schemas, validation, and APIs."""

from __future__ import annotations

from collections.abc import Generator
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.api.schemas.assessments import (
    CriterionAssessment,
    EvidenceItem,
    GermanAssessmentCreate,
)
from app.assessments.readiness import assess_transcript_readiness
from app.assessments.validation import build_default_text_criteria
from app.auth.security import token_hash
from app.core.config import settings
from app.db.session import create_database_engine, get_db_session
from app.main import app
from app.models import (
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
def test_setup(database_session: Session) -> dict[str, object]:
    admin_user = User(
        email="admin@vervio.test",
        full_name="Admin Evaluator",
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

    company = Company(name="Partner GmbH", slug="partner-gmbh")
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
        email="tarek@example.test",
        given_name="Tarek",
        family_name="Mansour",
        claimed_german_level="B1",  # Self-reported level
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
    test_client = TestClient(app)
    try:
        yield test_client
    finally:
        app.dependency_overrides.clear()


# ==============================================================================
# 1. Schema, CEFR, Score, and Status Consistency Validation
# ==============================================================================


def test_valid_completed_assessment_schema() -> None:
    criteria = build_default_text_criteria(
        grammar_score=82.0,
        vocabulary_score=78.5,
        comprehension_score=85.0,
        fluency_score=80.0,
    )

    payload = GermanAssessmentCreate(
        assessment_status="completed",
        estimated_cefr_level="B2",
        overall_score=81.0,
        summary="Candidate demonstrated solid B2 proficiency with good complex sentences.",
        criteria=criteria,
        strengths=["Uses subordinate clauses accurately with 'weil' and 'obwohl'."],
        areas_for_improvement=["Minor gender agreements with compound nouns."],
        evidence=[
            EvidenceItem(
                segment_position=2,
                speaker="candidate",
                quote="Ich habe fünf Jahre als Ingenieur gearbeitet.",
                observation="Accurate use of Perfekt with 'gearbeitet'.",
            )
        ],
    )

    assert payload.assessment_status == "completed"
    assert payload.estimated_cefr_level == "B2"
    assert payload.overall_score == 81.0
    assert payload.criteria is not None
    assert payload.criteria.pronunciation.status == "unavailable"
    assert payload.criteria.pronunciation.score is None


def test_pronunciation_marked_evaluated_from_text_is_rejected() -> None:
    # Rule 7: Never claim pronunciation was assessed from text alone.
    criteria = build_default_text_criteria(
        grammar_score=80.0,
        vocabulary_score=80.0,
        comprehension_score=80.0,
        fluency_score=80.0,
    )
    # Attempt to mark pronunciation evaluated with a score
    criteria.pronunciation = CriterionAssessment(
        criterion_code="pronunciation",
        label="Aussprache",
        status="evaluated",
        score=75.0,
        rationale="Pronunciation seemed clear.",
    )

    with pytest.raises(ValidationError) as exc:
        GermanAssessmentCreate(
            assessment_status="completed",
            estimated_cefr_level="B2",
            overall_score=80.0,
            summary="Valid summary.",
            criteria=criteria,
            strengths=["Good fluency"],
            areas_for_improvement=["Grammar"],
            evidence=[
                EvidenceItem(
                    segment_position=1,
                    speaker="candidate",
                    quote="Hallo",
                    observation="Greeting",
                )
            ],
        )

    assert "Pronunciation cannot be evaluated from transcript text alone" in str(exc.value)


def test_unavailable_criterion_cannot_have_numeric_score() -> None:
    with pytest.raises(ValidationError) as exc:
        CriterionAssessment(
            criterion_code="pronunciation",
            label="Pronunciation",
            status="unavailable",
            score=70.0,
            unavailable_reason="Unavailable",
        )
    assert "cannot have a numeric score" in str(exc.value)


def test_invalid_cefr_level_rejected() -> None:
    criteria = build_default_text_criteria(grammar_score=80.0)
    with pytest.raises(ValidationError):
        GermanAssessmentCreate(
            assessment_status="completed",
            estimated_cefr_level="B3",  # Invalid CEFR level
            overall_score=80.0,
            summary="Summary",
            criteria=criteria,
            strengths=["Strength"],
            areas_for_improvement=["Improvement"],
            evidence=[
                EvidenceItem(
                    segment_position=1,
                    speaker="candidate",
                    quote="Hallo",
                    observation="Greeting",
                )
            ],
        )


def test_invalid_scores_rejected() -> None:
    criteria = build_default_text_criteria(grammar_score=80.0)
    with pytest.raises(ValidationError):
        GermanAssessmentCreate(
            assessment_status="completed",
            estimated_cefr_level="B2",
            overall_score=105.0,  # Score > 100
            summary="Summary",
            criteria=criteria,
            strengths=["Strength"],
            areas_for_improvement=["Improvement"],
            evidence=[
                EvidenceItem(
                    segment_position=1,
                    speaker="candidate",
                    quote="Hallo",
                    observation="Greeting",
                )
            ],
        )

    with pytest.raises(ValidationError):
        GermanAssessmentCreate(
            assessment_status="completed",
            estimated_cefr_level="B2",
            overall_score=-5.0,  # Negative score
            summary="Summary",
            criteria=criteria,
            strengths=["Strength"],
            areas_for_improvement=["Improvement"],
            evidence=[
                EvidenceItem(
                    segment_position=1,
                    speaker="candidate",
                    quote="Hallo",
                    observation="Greeting",
                )
            ],
        )


def test_status_consistency_completed_requires_score_cefr_and_evidence() -> None:
    criteria = build_default_text_criteria(grammar_score=80.0)

    # Missing overall_score
    with pytest.raises(ValidationError) as exc1:
        GermanAssessmentCreate(
            assessment_status="completed",
            estimated_cefr_level="B2",
            overall_score=None,
            summary="Summary",
            criteria=criteria,
            strengths=["Strength"],
            areas_for_improvement=["Improvement"],
            evidence=[
                EvidenceItem(
                    segment_position=1,
                    speaker="candidate",
                    quote="Hallo",
                    observation="Greeting",
                )
            ],
        )
    assert "Completed assessment must have an overall_score" in str(exc1.value)

    # Missing estimated_cefr_level
    with pytest.raises(ValidationError) as exc2:
        GermanAssessmentCreate(
            assessment_status="completed",
            estimated_cefr_level=None,
            overall_score=80.0,
            summary="Summary",
            criteria=criteria,
            strengths=["Strength"],
            areas_for_improvement=["Improvement"],
            evidence=[
                EvidenceItem(
                    segment_position=1,
                    speaker="candidate",
                    quote="Hallo",
                    observation="Greeting",
                )
            ],
        )
    assert "Completed assessment must have an estimated_cefr_level" in str(exc2.value)

    # Missing evidence
    with pytest.raises(ValidationError) as exc3:
        GermanAssessmentCreate(
            assessment_status="completed",
            estimated_cefr_level="B2",
            overall_score=80.0,
            summary="Summary",
            criteria=criteria,
            strengths=["Strength"],
            areas_for_improvement=["Improvement"],
            evidence=[],  # Empty evidence
        )
    assert "must provide transcript-backed evidence" in str(exc3.value)


def test_status_consistency_insufficient_evidence_cannot_have_score_or_cefr() -> None:
    # Insufficient evidence with an overall score is rejected
    with pytest.raises(ValidationError) as exc1:
        GermanAssessmentCreate(
            assessment_status="insufficient_evidence",
            overall_score=50.0,
            insufficient_evidence_reason="Candidate only gave one brief answer.",
        )
    assert "cannot have an overall_score" in str(exc1.value)

    # Insufficient evidence with a CEFR level is rejected
    with pytest.raises(ValidationError) as exc2:
        GermanAssessmentCreate(
            assessment_status="insufficient_evidence",
            estimated_cefr_level="A2",
            insufficient_evidence_reason="Candidate only gave one brief answer.",
        )
    assert "cannot have an estimated_cefr_level" in str(exc2.value)

    # Insufficient evidence without a reason is rejected
    with pytest.raises(ValidationError) as exc3:
        GermanAssessmentCreate(
            assessment_status="insufficient_evidence",
            insufficient_evidence_reason=None,
        )
    assert "must provide an insufficient_evidence_reason" in str(exc3.value)


# ==============================================================================
# 2. Transcript Readiness and Sufficiency Checks
# ==============================================================================


def test_transcript_readiness_empty_transcript() -> None:
    session_id = uuid4()
    readiness = assess_transcript_readiness(session_id, [])

    assert readiness.is_ready is False
    assert readiness.is_sufficient is False
    assert readiness.total_segment_count == 0
    assert readiness.candidate_turn_count == 0
    assert readiness.status_recommendation == "pending"
    assert "No transcript segments" in readiness.reasons[0]


def test_transcript_readiness_no_candidate_speech() -> None:
    session_id = uuid4()
    segments = [
        TranscriptSegment(
            interview_session_id=session_id,
            position=1,
            speaker="interviewer",
            start_ms=0,
            end_ms=2500,
            content="Guten Tag! Können Sie mich hören?",
        ),
        TranscriptSegment(
            interview_session_id=session_id,
            position=2,
            speaker="interviewer",
            start_ms=3000,
            end_ms=5000,
            content="Hallo? Sind Sie noch da?",
        ),
    ]
    readiness = assess_transcript_readiness(session_id, segments)

    assert readiness.is_ready is False
    assert readiness.is_sufficient is False
    assert readiness.candidate_turn_count == 0
    assert readiness.status_recommendation == "pending"
    assert "contains no candidate speech" in readiness.reasons[0]


def test_transcript_readiness_short_interview_yields_insufficient_evidence() -> None:
    session_id = uuid4()
    segments = [
        TranscriptSegment(
            interview_session_id=session_id,
            position=1,
            speaker="interviewer",
            start_ms=0,
            end_ms=2500,
            content="Guten Tag! Stellen Sie sich bitte vor.",
        ),
        TranscriptSegment(
            interview_session_id=session_id,
            position=2,
            speaker="candidate",
            start_ms=3000,
            end_ms=4500,
            content="Ja, hallo danke.",  # Only 3 words, 1 turn
        ),
    ]
    readiness = assess_transcript_readiness(session_id, segments)

    assert readiness.is_ready is True
    assert readiness.is_sufficient is False
    assert readiness.candidate_turn_count == 1
    assert readiness.candidate_word_count == 3
    assert readiness.status_recommendation == "insufficient_evidence"
    assert "insufficient for a reliable CEFR assessment" in readiness.reasons[0]


def test_transcript_readiness_sufficient_speech() -> None:
    session_id = uuid4()
    segments = [
        TranscriptSegment(
            interview_session_id=session_id,
            position=1,
            speaker="interviewer",
            start_ms=0,
            end_ms=2500,
            content="Guten Tag! Welche Erfahrungen bringen Sie mit?",
        ),
        TranscriptSegment(
            interview_session_id=session_id,
            position=2,
            speaker="candidate",
            start_ms=3000,
            end_ms=8000,
            content=(
                "Ich habe vier Jahre als Webentwickler in Kairo gearbeitet "
                "und Projekte geleitet."
            ),
        ),
        TranscriptSegment(
            interview_session_id=session_id,
            position=3,
            speaker="interviewer",
            start_ms=8500,
            end_ms=11000,
            content="Sehr interessant. Wie lösen Sie schwierige Teamkonflikte?",
        ),
        TranscriptSegment(
            interview_session_id=session_id,
            position=4,
            speaker="candidate",
            start_ms=11500,
            end_ms=17000,
            content="Ich suche immer das offene Gespräch, um Missverständnisse schnell zu klären.",
        ),
    ]
    readiness = assess_transcript_readiness(session_id, segments)

    assert readiness.is_ready is True
    assert readiness.is_sufficient is True
    assert readiness.candidate_turn_count == 2
    assert readiness.candidate_word_count > 15
    assert readiness.status_recommendation == "completed"
    assert len(readiness.reasons) == 0


# ==============================================================================
# 3. HTTP API Endpoints, Evidence Validation, and Authorization
# ==============================================================================


def test_get_assessment_pending_when_no_evaluation(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    interview = test_setup["interview_session"]
    candidate = test_setup["candidate"]

    response = client.get(
        f"/interviews/{interview.id}/assessment",
        cookies=admin_cookies(),
    )

    assert response.status_code == 200
    data = response.json()
    assert data["assessment_status"] == "pending"
    assert data["overall_score"] is None
    assert data["estimated_cefr_level"] is None
    # Verified separation: claimed CV level is exposed, but no assessed CEFR level exists yet
    assert data["candidate_claimed_level"] == candidate.claimed_german_level
    assert data["candidate_name"] == candidate.full_name


def test_get_assessment_readiness_diagnostics(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    interview = test_setup["interview_session"]

    # Initially empty transcript
    response = client.get(
        f"/interviews/{interview.id}/assessment/readiness",
        cookies=admin_cookies(),
    )
    assert response.status_code == 200
    data = response.json()
    assert data["is_ready"] is False
    assert data["is_sufficient"] is False
    assert data["status_recommendation"] == "pending"

    # Add sufficient transcript segments
    database_session.add_all(
        [
            TranscriptSegment(
                interview_session_id=interview.id,
                position=1,
                speaker="interviewer",
                start_ms=0,
                end_ms=2000,
                content="Guten Tag! Können Sie sich bitte vorstellen?",
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=2,
                speaker="candidate",
                start_ms=2500,
                end_ms=7500,
                content=(
                    "Guten Tag! Mein Name ist Tarek und ich bin Softwareentwickler aus Alexandria."
                ),
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=3,
                speaker="interviewer",
                start_ms=8000,
                end_ms=10000,
                content="Wie lange lernen Sie schon Deutsch?",
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=4,
                speaker="candidate",
                start_ms=10500,
                end_ms=16000,
                content="Ich lerne seit zwei Jahren Deutsch am Goethe-Institut und übe täglich.",
            ),
        ]
    )
    database_session.commit()

    response2 = client.get(
        f"/interviews/{interview.id}/assessment/readiness",
        cookies=admin_cookies(),
    )
    assert response2.status_code == 200
    data2 = response2.json()
    assert data2["is_ready"] is True
    assert data2["is_sufficient"] is True
    assert data2["status_recommendation"] == "completed"


def test_save_completed_assessment_success(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    interview = test_setup["interview_session"]
    candidate = test_setup["candidate"]

    # Populate valid transcript
    database_session.add_all(
        [
            TranscriptSegment(
                interview_session_id=interview.id,
                position=1,
                speaker="interviewer",
                start_ms=0,
                end_ms=2000,
                content="Guten Tag! Bitte beschreiben Sie Ihren Werdegang.",
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=2,
                speaker="candidate",
                start_ms=2500,
                end_ms=8500,
                content=(
                    "Ich habe mein Informatikstudium abgeschlossen und "
                    "arbeite seit drei Jahren in Kairo."
                ),
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=3,
                speaker="interviewer",
                start_ms=9000,
                end_ms=11000,
                content="Mit welchen Technologien arbeiten Sie?",
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=4,
                speaker="candidate",
                start_ms=11500,
                end_ms=17500,
                content=(
                    "Hauptsächlich mit Python und FastAPI, da diese "
                    "Frameworks sehr performant sind."
                ),
            ),
        ]
    )
    database_session.commit()

    criteria = build_default_text_criteria(
        grammar_score=85.0,
        vocabulary_score=82.0,
        comprehension_score=88.0,
        fluency_score=84.0,
    )

    payload = {
        "assessment_status": "completed",
        "estimated_cefr_level": "B2",
        "overall_score": 84.75,
        "summary": "Candidate clearly demonstrates professional B2 German proficiency.",
        "criteria": criteria.model_dump(mode="json"),
        "strengths": [
            "Good use of causal connectives with 'da' and 'weil'.",
            "Clear articulation of technical and professional background.",
        ],
        "areas_for_improvement": [
            "Could expand use of subjunctive II (Konjunktiv II) in hypothetical scenarios.",
        ],
        "evidence": [
            {
                "segment_position": 2,
                "speaker": "candidate",
                "quote": "Ich habe mein Informatikstudium abgeschlossen",
                "observation": "Accurate past tense (Perfekt) construction.",
                "criterion_code": "grammar",
            },
            {
                "segment_position": 4,
                "speaker": "candidate",
                "quote": "Hauptsächlich mit Python und FastAPI, da diese Frameworks",
                "observation": "Appropriate subordinate clause word order after 'da'.",
                "criterion_code": "grammar",
            },
        ],
    }

    response = client.post(
        f"/interviews/{interview.id}/assessment",
        json=payload,
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 201
    data = response.json()
    assert data["assessment_status"] == "completed"
    assert data["estimated_cefr_level"] == "B2"
    assert data["overall_score"] == 84.75
    # Strict separation verification: candidate's self-reported B1 is distinct from assessed B2
    assert candidate.claimed_german_level == "B1"
    assert data["candidate_claimed_level"] == "B1"
    assert data["estimated_cefr_level"] == "B2"
    assert len(data["strengths"]) == 2
    assert len(data["evidence"]) == 2
    assert data["criteria"]["pronunciation"]["status"] == "unavailable"

    # Verify subsequent GET returns the persisted evaluation
    get_response = client.get(
        f"/interviews/{interview.id}/assessment",
        cookies=admin_cookies(),
    )
    assert get_response.status_code == 200
    assert get_response.json()["overall_score"] == 84.75


def test_cannot_save_completed_assessment_when_transcript_is_insufficient(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    interview = test_setup["interview_session"]

    # Short interview: only 2 words
    database_session.add_all(
        [
            TranscriptSegment(
                interview_session_id=interview.id,
                position=1,
                speaker="interviewer",
                start_ms=0,
                end_ms=2000,
                content="Guten Tag!",
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=2,
                speaker="candidate",
                start_ms=2500,
                end_ms=3500,
                content="Ja danke.",
            ),
        ]
    )
    database_session.commit()

    criteria = build_default_text_criteria(grammar_score=70.0)
    payload = {
        "assessment_status": "completed",
        "estimated_cefr_level": "B1",
        "overall_score": 70.0,
        "summary": "Completed assessment claim.",
        "criteria": criteria.model_dump(mode="json"),
        "strengths": ["Greeting"],
        "areas_for_improvement": ["Vocabulary"],
        "evidence": [
            {
                "segment_position": 2,
                "speaker": "candidate",
                "quote": "Ja danke.",
                "observation": "Candidate spoke briefly.",
            }
        ],
    }

    response = client.post(
        f"/interviews/{interview.id}/assessment",
        json=payload,
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    # Must be rejected because evidence is insufficient for completed CEFR level
    assert response.status_code == 422
    assert "insufficient evidence" in response.json()["detail"].lower()


def test_saving_insufficient_evidence_assessment_succeeds(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    interview = test_setup["interview_session"]

    database_session.add(
        TranscriptSegment(
            interview_session_id=interview.id,
            position=1,
            speaker="candidate",
            start_ms=0,
            end_ms=1000,
            content="Hallo.",
        )
    )
    database_session.commit()

    payload = {
        "assessment_status": "insufficient_evidence",
        "insufficient_evidence_reason": (
            "Interview was interrupted after 1 turn; insufficient speech for CEFR assessment."
        ),
    }

    response = client.post(
        f"/interviews/{interview.id}/assessment",
        json=payload,
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 201
    data = response.json()
    assert data["assessment_status"] == "insufficient_evidence"
    assert data["overall_score"] is None
    assert data["estimated_cefr_level"] is None
    assert "interrupted" in data["insufficient_evidence_reason"]


def test_evidence_reference_validation_rejects_nonexistent_segment(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    interview = test_setup["interview_session"]

    database_session.add_all(
        [
            TranscriptSegment(
                interview_session_id=interview.id,
                position=1,
                speaker="candidate",
                start_ms=0,
                end_ms=5000,
                content="Ich lebe in Berlin und studiere hier Informatik an der Universität.",
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=2,
                speaker="candidate",
                start_ms=5500,
                end_ms=10000,
                content="Mein Schwerpunkt liegt im Bereich Softwarearchitektur und Cloud-Systeme.",
            ),
        ]
    )
    database_session.commit()

    criteria = build_default_text_criteria(grammar_score=80.0)
    payload = {
        "assessment_status": "completed",
        "estimated_cefr_level": "B2",
        "overall_score": 80.0,
        "summary": "Summary",
        "criteria": criteria.model_dump(mode="json"),
        "strengths": ["Strengths"],
        "areas_for_improvement": ["Improvement"],
        "evidence": [
            {
                "segment_position": 99,  # Segment 99 does not exist!
                "speaker": "candidate",
                "quote": "Informatik",
                "observation": "Observation",
            }
        ],
    }

    response = client.post(
        f"/interviews/{interview.id}/assessment",
        json=payload,
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 422
    assert "references segment position 99" in response.json()["detail"]


def test_evidence_reference_validation_rejects_mismatched_quote(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    interview = test_setup["interview_session"]

    database_session.add_all(
        [
            TranscriptSegment(
                interview_session_id=interview.id,
                position=1,
                speaker="candidate",
                start_ms=0,
                end_ms=5000,
                content="Ich lebe in Kairo und arbeite als Entwickler.",
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=2,
                speaker="candidate",
                start_ms=5500,
                end_ms=10000,
                content="Mein Schwerpunkt liegt auf Python und Django.",
            ),
        ]
    )
    database_session.commit()

    criteria = build_default_text_criteria(grammar_score=80.0)
    payload = {
        "assessment_status": "completed",
        "estimated_cefr_level": "B2",
        "overall_score": 80.0,
        "summary": "Summary",
        "criteria": criteria.model_dump(mode="json"),
        "strengths": ["Strengths"],
        "areas_for_improvement": ["Improvement"],
        "evidence": [
            {
                "segment_position": 1,
                "speaker": "candidate",
                "quote": "Ich wohne in München",  # Not in the transcript!
                "observation": "Observation",
            }
        ],
    }

    response = client.post(
        f"/interviews/{interview.id}/assessment",
        json=payload,
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 422
    assert "Evidence quote does not match transcript content" in response.json()["detail"]


def test_evidence_reference_validation_rejects_interviewer_quote_as_candidate(
    client: TestClient,
    test_setup: dict[str, object],
    database_session: Session,
) -> None:
    interview = test_setup["interview_session"]

    database_session.add_all(
        [
            TranscriptSegment(
                interview_session_id=interview.id,
                position=1,
                speaker="interviewer",
                start_ms=0,
                end_ms=3000,
                content="Guten Tag! Willkommen zum Interview.",
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=2,
                speaker="candidate",
                start_ms=3500,
                end_ms=8000,
                content="Vielen Dank, ich freue mich sehr über die Gelegenheit.",
            ),
            TranscriptSegment(
                interview_session_id=interview.id,
                position=3,
                speaker="candidate",
                start_ms=8500,
                end_ms=14000,
                content="Ich habe mich intensiv auf dieses Gespräch vorbereitet.",
            ),
        ]
    )
    database_session.commit()

    criteria = build_default_text_criteria(grammar_score=80.0)
    payload = {
        "assessment_status": "completed",
        "estimated_cefr_level": "B2",
        "overall_score": 80.0,
        "summary": "Summary",
        "criteria": criteria.model_dump(mode="json"),
        "strengths": ["Strengths"],
        "areas_for_improvement": ["Improvement"],
        "evidence": [
            {
                "segment_position": 1,  # Spoken by interviewer!
                "speaker": "candidate",  # Falsely claims candidate
                "quote": "Willkommen zum Interview",
                "observation": "Observation",
            }
        ],
    }

    response = client.post(
        f"/interviews/{interview.id}/assessment",
        json=payload,
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 422
    assert (
        "claims candidate speech, but segment was spoken by 'interviewer'"
        in response.json()["detail"]
    )


def test_assessment_authorization_and_csrf_protection(
    client: TestClient,
    test_setup: dict[str, object],
) -> None:
    interview = test_setup["interview_session"]

    # 1. Unauthenticated request rejected
    res_unauth = client.get(f"/interviews/{interview.id}/assessment")
    assert res_unauth.status_code == 401

    # 2. Client reviewer cannot post assessments (admin role required)
    res_reviewer = client.post(
        f"/interviews/{interview.id}/assessment",
        json={"assessment_status": "pending"},
        cookies=reviewer_cookies(),
        headers=reviewer_headers(),
    )
    assert res_reviewer.status_code == 403

    # 3. Admin request missing CSRF header rejected
    res_no_csrf = client.post(
        f"/interviews/{interview.id}/assessment",
        json={"assessment_status": "pending"},
        cookies=admin_cookies(),
        headers={"Origin": TRUSTED_ORIGIN},
    )
    assert res_no_csrf.status_code == 403
    assert res_no_csrf.status_code == 403
