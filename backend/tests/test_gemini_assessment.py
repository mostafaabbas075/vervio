"""Tests for Gemini-powered German language assessment service and API route.

All Gemini calls are mocked; no real external network requests are made.
"""

from __future__ import annotations

import json
from collections.abc import Generator
from datetime import datetime, timezone
from typing import Any
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.schemas.assessments import GermanAssessmentCreate
from app.assessments.gemini_service import (
    GeminiAssessmentConfigurationError,
    GeminiAssessmentProviderError,
    GeminiAssessmentService,
    GeminiAssessmentTimeoutError,
    GeminiAssessmentValidationError,
    format_transcript_for_prompt,
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
def test_setup(database_session: Session) -> dict[str, Any]:
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

    company = Company(name="Client AG", slug="client-ag")
    reviewer_user = User(
        email="reviewer@client.test",
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
        email="karim@example.test",
        given_name="Karim",
        family_name="Fahmy",
        claimed_german_level="B1",  # Self-reported level
    )

    interview_session = InterviewSession(
        candidate=candidate,
        status="completed",
        language="de",
    )

    # 4 transcript turns with sufficient German speech
    segments = [
        TranscriptSegment(
            interview_session=interview_session,
            position=1,
            speaker="interviewer",
            content="Guten Tag Herr Fahmy, bitte stellen Sie sich kurz vor.",
            start_ms=0,
            end_ms=3000,
        ),
        TranscriptSegment(
            interview_session=interview_session,
            position=2,
            speaker="candidate",
            content=(
                "Guten Tag. Mein Name ist Karim Fahmy und ich habe fünf Jahre "
                "Erfahrung als Python-Backend-Entwickler bei verschiedenen Firmen gesammelt."
            ),
            start_ms=3500,
            end_ms=11000,
        ),
        TranscriptSegment(
            interview_session=interview_session,
            position=3,
            speaker="interviewer",
            content="Können Sie uns von einer schwierigen technischen Herausforderung erzählen?",
            start_ms=11500,
            end_ms=15500,
        ),
        TranscriptSegment(
            interview_session=interview_session,
            position=4,
            speaker="candidate",
            content=(
                "Ja, gerne. In meinem letzten Projekt mussten wir eine synchrone API zu "
                "einer asynchronen Event-Architektur migrieren, ohne Ausfallzeiten zu verursachen."
            ),
            start_ms=16000,
            end_ms=25000,
        ),
    ]

    database_session.add_all(
        [
            admin_user,
            admin_session,
            company,
            reviewer_user,
            reviewer_session,
            candidate,
            interview_session,
            *segments,
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
        "segments": segments,
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


def sample_valid_gemini_payload() -> dict[str, Any]:
    return {
        "assessment_status": "completed",
        "estimated_cefr_level": "B2",
        "overall_score": 82.0,
        "summary": "Candidate demonstrated solid B2 professional German with good technical terms.",
        "criteria": {
            "grammar": {
                "criterion_code": "grammar",
                "label": "Grammatik & Sprachrichtigkeit",
                "status": "evaluated",
                "score": 80.0,
                "rationale": "Correct subordinate clause syntax with 'ohne ... zu verursachen'.",
            },
            "vocabulary": {
                "criterion_code": "vocabulary",
                "label": "Wortschatz & Ausdruckskraft",
                "status": "evaluated",
                "score": 85.0,
                "rationale": "Appropriate technical vocabulary such as 'Event-Architektur'.",
            },
            "comprehension": {
                "criterion_code": "comprehension",
                "label": "Hörverstehen & Interaktion",
                "status": "evaluated",
                "score": 85.0,
                "rationale": "Accurately answered both technical prompts without hesitation.",
            },
            "fluency": {
                "criterion_code": "fluency",
                "label": "Gesprochene Sprachflüssigkeit (Text-basiert)",
                "status": "evaluated",
                "score": 78.0,
                "rationale": "Complex compound sentences with smooth connectors.",
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
        "strengths": [
            "Good command of compound technical nouns",
            "Effective use of infinitive constructions with 'ohne ... zu'",
        ],
        "areas_for_improvement": [
            "Expand prepositional idioms in conversational transitions",
        ],
        "evidence": [
            {
                "segment_position": 2,
                "speaker": "candidate",
                "quote": "fünf Jahre Erfahrung als Python-Backend-Entwickler",
                "observation": "Clear and syntactically correct self-introduction",
                "criterion_code": "vocabulary",
            },
            {
                "segment_position": 4,
                "speaker": "candidate",
                "quote": "ohne Ausfallzeiten zu verursachen",
                "observation": "Advanced modal infinitive construction",
                "criterion_code": "grammar",
            },
        ],
        "insufficient_evidence_reason": None,
    }


# ==============================================================================
# 1. Privacy, Anchoring & Prompt Isolation Tests
# ==============================================================================


def test_transcript_formatting_omits_candidate_private_data_and_claimed_level(
    test_setup: dict[str, Any],
) -> None:
    """Verify format_transcript_for_prompt does not leak candidate claimed level or email."""
    segments = test_setup["segments"]
    candidate = test_setup["candidate"]

    formatted = format_transcript_for_prompt(segments)

    # Transcript should contain segment texts and turn positions
    assert "Turn [1] (Interviewer):" in formatted
    assert "Turn [2] (Candidate):" in formatted
    assert "Karim Fahmy" in formatted  # Stated in the spoken transcript text itself

    # But candidate's claimed level and database email must never be added by formatting
    assert candidate.claimed_german_level not in formatted
    assert candidate.email not in formatted


@pytest.mark.anyio
async def test_gemini_service_prompt_does_not_contain_claimed_level(
    test_setup: dict[str, Any],
) -> None:
    """Ensure GeminiAssessmentService never includes candidate's self-reported level in prompt."""
    segments = test_setup["segments"]
    session_id = test_setup["interview_session"].id

    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_gemini_payload())
    mock_client.models.generate_content.return_value = mock_response

    service = GeminiAssessmentService(
        api_key="test-key",
        client=mock_client,
    )

    assessment = await service.evaluate_transcript(session_id, segments)
    assert assessment.assessment_status == "completed"

    # Inspect call args sent to Gemini
    mock_client.models.generate_content.assert_called_once()
    _, kwargs = mock_client.models.generate_content.call_args
    sent_prompt = kwargs.get("contents", "")
    config = kwargs.get("config")
    system_inst = getattr(config, "system_instruction", "")

    # Neither prompt nor system instruction should mention candidate's self-reported "B1"
    assert "claimed_german_level" not in sent_prompt
    assert "self-reported" not in sent_prompt
    assert "claimed" not in system_inst


# ==============================================================================
# 2. Service-Level Evaluation Tests
# ==============================================================================


@pytest.mark.anyio
async def test_gemini_service_evaluates_candidate_speech_successfully(
    test_setup: dict[str, Any],
) -> None:
    """Valid Gemini response is parsed and validated into GermanAssessmentCreate."""
    segments = test_setup["segments"]
    session_id = test_setup["interview_session"].id

    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_gemini_payload())
    mock_client.models.generate_content.return_value = mock_response

    service = GeminiAssessmentService(
        api_key="test-key",
        client=mock_client,
    )

    result = await service.evaluate_transcript(session_id, segments)

    assert isinstance(result, GermanAssessmentCreate)
    assert result.assessment_status == "completed"
    assert result.estimated_cefr_level == "B2"
    assert result.overall_score == 82.0
    assert result.criteria is not None
    assert result.criteria.grammar.score == 80.0
    assert result.criteria.pronunciation.status == "unavailable"
    assert result.criteria.pronunciation.score is None
    assert len(result.evidence) == 2


@pytest.mark.anyio
async def test_gemini_service_preflight_insufficient_evidence(
    test_setup: dict[str, Any],
) -> None:
    """Pre-flight check intercepts insufficient speech without calling Gemini."""
    interview_session = test_setup["interview_session"]

    # Only 1 candidate turn with 2 words: fails preflight
    brief_segments = [
        TranscriptSegment(
            interview_session=interview_session,
            position=1,
            speaker="candidate",
            content="Hallo danke.",
            start_ms=0,
            end_ms=1000,
        )
    ]

    mock_client = MagicMock()
    service = GeminiAssessmentService(api_key="test-key", client=mock_client)

    result = await service.evaluate_transcript(interview_session.id, brief_segments)

    assert result.assessment_status == "insufficient_evidence"
    assert result.estimated_cefr_level is None
    assert result.overall_score is None
    assert "insufficient for a reliable CEFR assessment" in (
        result.insufficient_evidence_reason or ""
    )
    # Gemini client should NOT have been invoked
    mock_client.models.generate_content.assert_not_called()


@pytest.mark.anyio
async def test_gemini_service_handles_gemini_insufficient_evidence_decision(
    test_setup: dict[str, Any],
) -> None:
    """When Gemini determines candidate German is insufficient/non-German, handles safely."""
    segments = test_setup["segments"]
    session_id = test_setup["interview_session"].id

    gemini_payload = {
        "assessment_status": "insufficient_evidence",
        "estimated_cefr_level": None,
        "overall_score": None,
        "summary": None,
        "criteria": None,
        "strengths": None,
        "areas_for_improvement": None,
        "evidence": [],
        "insufficient_evidence_reason": (
            "Candidate spoke predominantly English with fragmented words."
        ),
    }

    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = json.dumps(gemini_payload)
    mock_client.models.generate_content.return_value = mock_response

    service = GeminiAssessmentService(api_key="test-key", client=mock_client)
    result = await service.evaluate_transcript(session_id, segments)

    assert result.assessment_status == "insufficient_evidence"
    assert result.estimated_cefr_level is None
    assert result.overall_score is None
    assert result.insufficient_evidence_reason == (
        "Candidate spoke predominantly English with fragmented words."
    )


@pytest.mark.anyio
async def test_gemini_service_malformed_json_raises_validation_error(
    test_setup: dict[str, Any],
) -> None:
    """Malformed non-JSON output from Gemini raises GeminiAssessmentValidationError."""
    segments = test_setup["segments"]
    session_id = test_setup["interview_session"].id

    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = "This is definitely not a JSON object."
    mock_client.models.generate_content.return_value = mock_response

    service = GeminiAssessmentService(api_key="test-key", client=mock_client)

    with pytest.raises(GeminiAssessmentValidationError, match="malformed non-JSON output"):
        await service.evaluate_transcript(session_id, segments)


@pytest.mark.anyio
async def test_gemini_service_fabricated_quote_rejected(
    test_setup: dict[str, Any],
) -> None:
    """Evidence quoting text not present in candidate segment raises validation error."""
    segments = test_setup["segments"]
    session_id = test_setup["interview_session"].id

    payload = sample_valid_gemini_payload()
    payload["evidence"] = [
        {
            "segment_position": 2,
            "speaker": "candidate",
            "quote": "Ich habe zehn Jahre bei Siemens in Berlin gearbeitet",  # Fabricated
            "observation": "Fabricated claim",
            "criterion_code": "vocabulary",
        }
    ]

    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = json.dumps(payload)
    mock_client.models.generate_content.return_value = mock_response

    service = GeminiAssessmentService(api_key="test-key", client=mock_client)

    with pytest.raises(
        GeminiAssessmentValidationError,
        match="does not match transcript content",
    ):
        await service.evaluate_transcript(session_id, segments)


@pytest.mark.anyio
async def test_gemini_service_fabricated_speaker_position_rejected(
    test_setup: dict[str, Any],
) -> None:
    """Evidence attributing interviewer turn to candidate raises validation error."""
    segments = test_setup["segments"]
    session_id = test_setup["interview_session"].id

    payload = sample_valid_gemini_payload()
    payload["evidence"] = [
        {
            "segment_position": 1,  # Turn 1 is Interviewer
            "speaker": "candidate",
            "quote": "Guten Tag Herr Fahmy",
            "observation": "Spoken by interviewer",
            "criterion_code": "vocabulary",
        }
    ]

    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = json.dumps(payload)
    mock_client.models.generate_content.return_value = mock_response

    service = GeminiAssessmentService(api_key="test-key", client=mock_client)

    with pytest.raises(
        GeminiAssessmentValidationError,
        match="claims candidate speech, but segment was spoken by 'interviewer'",
    ):
        await service.evaluate_transcript(session_id, segments)


@pytest.mark.anyio
async def test_gemini_service_timeout_raises_timeout_error(
    test_setup: dict[str, Any],
) -> None:
    """Slow response exceeding timeout raises GeminiAssessmentTimeoutError."""
    segments = test_setup["segments"]
    session_id = test_setup["interview_session"].id

    def slow_call(*args: Any, **kwargs: Any) -> Any:
        import time

        time.sleep(0.5)
        return MagicMock()

    mock_client = MagicMock()
    mock_client.models.generate_content.side_effect = slow_call

    service = GeminiAssessmentService(
        api_key="test-key",
        client=mock_client,
        timeout_seconds=0.05,  # 50ms timeout
    )

    with pytest.raises(GeminiAssessmentTimeoutError, match="timed out"):
        await service.evaluate_transcript(session_id, segments)


@pytest.mark.anyio
async def test_gemini_service_provider_error_raises_provider_error(
    test_setup: dict[str, Any],
) -> None:
    """Upstream API exceptions are wrapped in GeminiAssessmentProviderError."""
    segments = test_setup["segments"]
    session_id = test_setup["interview_session"].id

    mock_client = MagicMock()
    mock_client.models.generate_content.side_effect = RuntimeError("Resource exhausted: 429")

    service = GeminiAssessmentService(api_key="test-key", client=mock_client)

    with pytest.raises(
        GeminiAssessmentProviderError,
        match="Gemini evaluation provider call failed",
    ):
        await service.evaluate_transcript(session_id, segments)


def test_gemini_service_missing_api_key_raises_configuration_error() -> None:
    """Service without api_key raises GeminiAssessmentConfigurationError on access."""
    service = GeminiAssessmentService(api_key="", client=None)
    with pytest.raises(
        GeminiAssessmentConfigurationError,
        match="GEMINI_API_KEY must be configured",
    ):
        _ = service.client


# ==============================================================================
# 3. Endpoint POST /interviews/{session_id}/assessment/generate Tests
# ==============================================================================


def test_endpoint_generate_assessment_success(
    client: TestClient,
    test_setup: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Admin successfully triggers assessment generation via POST endpoint."""
    interview = test_setup["interview_session"]

    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = json.dumps(sample_valid_gemini_payload())
    mock_client.models.generate_content.return_value = mock_response

    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_client)

    from app.api.routes.evaluations import get_gemini_assessment_service

    app.dependency_overrides[get_gemini_assessment_service] = lambda: mock_service

    try:
        response = client.post(
            f"/interviews/{interview.id}/assessment/generate",
            cookies=admin_cookies(),
            headers=admin_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["assessment_status"] == "completed"
        assert data["estimated_cefr_level"] == "B2"
        assert data["overall_score"] == 82.0
        assert data["criteria"]["grammar"]["score"] == 80.0
        assert data["criteria"]["pronunciation"]["status"] == "unavailable"
        assert data["criteria"]["pronunciation"]["score"] is None
        assert len(data["evidence"]) == 2

        # Verify evaluation row was persisted in database
        db: Session = next(app.dependency_overrides[get_db_session]())
        eval_row = (
            db.query(Evaluation)
            .filter(Evaluation.interview_session_id == interview.id)
            .first()
        )
        assert eval_row is not None
        assert eval_row.status == "completed"
        assert eval_row.overall_score == 82.0
        assert eval_row.assessed_german_level == "B2"
        assert eval_row.assessment_metadata is not None
    finally:
        app.dependency_overrides.pop(get_gemini_assessment_service, None)


def test_endpoint_generate_assessment_insufficient_evidence(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Endpoint handles insufficient speech and persists insufficient_evidence status."""
    db: Session = next(app.dependency_overrides[get_db_session]())

    # Create new session with only 1 brief candidate utterance
    new_candidate = Candidate(email="brief@example.test", given_name="Brief", family_name="User")
    new_session = InterviewSession(candidate=new_candidate, status="completed", language="de")
    brief_segment = TranscriptSegment(
        interview_session=new_session,
        position=1,
        speaker="candidate",
        content="Ja.",
        start_ms=0,
        end_ms=500,
    )
    db.add_all([new_candidate, new_session, brief_segment])
    db.commit()

    mock_client = MagicMock()
    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_client)

    from app.api.routes.evaluations import get_gemini_assessment_service

    app.dependency_overrides[get_gemini_assessment_service] = lambda: mock_service

    try:
        response = client.post(
            f"/interviews/{new_session.id}/assessment/generate",
            cookies=admin_cookies(),
            headers=admin_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["assessment_status"] == "insufficient_evidence"
        assert data["estimated_cefr_level"] is None
        assert data["overall_score"] is None
        assert data["insufficient_evidence_reason"] is not None

        # Verify database record
        db.refresh(new_session)
        assert new_session.evaluation is not None
        assert new_session.evaluation.status == "insufficient_evidence"
        assert new_session.evaluation.overall_score is None
    finally:
        app.dependency_overrides.pop(get_gemini_assessment_service, None)


def test_endpoint_generate_assessment_duplicate_request_does_not_overwrite(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Repeated generation call returns existing completed assessment without invoking LLM."""
    interview = test_setup["interview_session"]
    db: Session = next(app.dependency_overrides[get_db_session]())

    # Attach already completed evaluation
    existing_eval = Evaluation(
        interview_session=interview,
        status="completed",
        assessed_german_level="C1",
        overall_score=90.0,
        summary="Existing completed evaluation",
        strengths=["Strong vocabulary"],
        areas_for_improvement=[],
        evidence=[],
    )
    db.add(existing_eval)
    db.commit()

    mock_client = MagicMock()
    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_client)

    from app.api.routes.evaluations import get_gemini_assessment_service

    app.dependency_overrides[get_gemini_assessment_service] = lambda: mock_service

    try:
        response = client.post(
            f"/interviews/{interview.id}/assessment/generate",
            cookies=admin_cookies(),
            headers=admin_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        # Returns existing evaluation untouched
        assert data["assessment_status"] == "completed"
        assert data["overall_score"] == 90.0
        assert data["estimated_cefr_level"] == "C1"
        assert data["summary"] == "Existing completed evaluation"

        # Gemini was NOT called
        mock_client.models.generate_content.assert_not_called()
    finally:
        app.dependency_overrides.pop(get_gemini_assessment_service, None)


def test_endpoint_generate_assessment_incomplete_interview_rejected_400(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Session not in 'completed' state cannot be assessed."""
    db: Session = next(app.dependency_overrides[get_db_session]())
    cand = Candidate(email="cand@test.com", given_name="A", family_name="B")
    active_session = InterviewSession(candidate=cand, status="in_progress", language="de")
    db.add_all([cand, active_session])
    db.commit()

    response = client.post(
        f"/interviews/{active_session.id}/assessment/generate",
        cookies=admin_cookies(),
        headers=admin_headers(),
    )

    assert response.status_code == 400
    assert "Only completed interviews can be evaluated" in response.json()["detail"]


def test_endpoint_generate_assessment_gemini_error_returns_502(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Gemini API provider error yields 502 Bad Gateway."""
    interview = test_setup["interview_session"]

    mock_client = MagicMock()
    mock_client.models.generate_content.side_effect = RuntimeError("503 Service Unavailable")
    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_client)

    from app.api.routes.evaluations import get_gemini_assessment_service

    app.dependency_overrides[get_gemini_assessment_service] = lambda: mock_service

    try:
        response = client.post(
            f"/interviews/{interview.id}/assessment/generate",
            cookies=admin_cookies(),
            headers=admin_headers(),
        )

        assert response.status_code == 502
        assert "Gemini evaluation provider call failed" in response.json()["detail"]
    finally:
        app.dependency_overrides.pop(get_gemini_assessment_service, None)
        app.dependency_overrides.pop(get_gemini_assessment_service, None)


def test_endpoint_generate_assessment_timeout_returns_504(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """Gemini call timeout yields 504 Gateway Timeout."""
    interview = test_setup["interview_session"]

    mock_service = MagicMock(spec=GeminiAssessmentService)
    mock_service.evaluate_transcript.side_effect = GeminiAssessmentTimeoutError(
        "Gemini evaluation request timed out."
    )

    from app.api.routes.evaluations import get_gemini_assessment_service

    app.dependency_overrides[get_gemini_assessment_service] = lambda: mock_service

    try:
        response = client.post(
            f"/interviews/{interview.id}/assessment/generate",
            cookies=admin_cookies(),
            headers=admin_headers(),
        )

        assert response.status_code == 504
        assert "timed out" in response.json()["detail"]
    finally:
        app.dependency_overrides.pop(get_gemini_assessment_service, None)


def test_endpoint_generate_assessment_authorization_and_csrf(
    client: TestClient,
    test_setup: dict[str, Any],
) -> None:
    """POST /interviews/{session_id}/assessment/generate enforces auth, admin role, and CSRF."""
    interview = test_setup["interview_session"]

    # 1. Unauthenticated request rejected
    res_unauth = client.post(f"/interviews/{interview.id}/assessment/generate")
    assert res_unauth.status_code == 401

    # 2. Client reviewer rejected (admin required)
    res_reviewer = client.post(
        f"/interviews/{interview.id}/assessment/generate",
        cookies=reviewer_cookies(),
        headers=reviewer_headers(),
    )
    assert res_reviewer.status_code == 403

    # 3. Missing CSRF rejected
    res_no_csrf = client.post(
        f"/interviews/{interview.id}/assessment/generate",
        cookies=admin_cookies(),
        headers={"Origin": TRUSTED_ORIGIN},
    )
    assert res_no_csrf.status_code == 403

    # 4. Untrusted origin rejected
    res_bad_origin = client.post(
        f"/interviews/{interview.id}/assessment/generate",
        cookies=admin_cookies(),
        headers={"Origin": "https://malicious-site.test", "X-CSRF-Token": ADMIN_CSRF_TOKEN},
    )
    assert res_bad_origin.status_code == 403
