"""Tests for automatic German language assessment generation after completed interviews.

Verifies:
- Normal interview completion (WebSocket closes then recording uploads)
- Reversed event order (recording uploads then WebSocket closes)
- Premature evaluation prevention while transcript is still finalizing
- Duplicate triggers and concurrency safety (at most one active assessment)
- Failed recording upload safety (never triggers assessment)
- Insufficient evidence handling
- Gemini provider failure (preserves failed state and allows safe retry)
- Restart recovery mechanism
- Automatic derivation of language recommendation without claimed-level anchoring
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Generator
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session, sessionmaker
from starlette.requests import Request

from app.api.routes.recordings import upload_recording
from app.assessments.auto_evaluator import (
    is_collector_active,
    is_interview_ready_for_assessment,
    recover_pending_assessments,
    run_assessment_task,
    set_db_session_factory_override,
)
from app.assessments.gemini_service import GeminiAssessmentService
from app.auth.dependencies import AuthContext
from app.auth.security import token_hash
from app.core.config import settings
from app.db.session import create_database_engine
from app.models import (
    AuthSession,
    Base,
    Candidate,
    Evaluation,
    InterviewSession,
    Recording,
    TranscriptSegment,
    User,
)
from app.realtime.transcript_collector import RealtimeTranscriptCollector

ADMIN_RAW_TOKEN = "test-admin-session-token-auto"
ADMIN_CSRF_TOKEN = "test-admin-csrf-token-auto"
TRUSTED_ORIGIN = settings.cors_origin_list[0]


def admin_cookies() -> dict[str, str]:
    return {settings.auth_session_cookie_name: ADMIN_RAW_TOKEN}


def admin_headers() -> dict[str, str]:
    return {
        "Origin": TRUSTED_ORIGIN,
        "X-CSRF-Token": ADMIN_CSRF_TOKEN,
    }


def valid_webm_bytes() -> bytes:
    return b"\x1a\x45\xdf\xa3\x93B\x82webm" + (b"\x00" * 32)


def create_mock_upload_request(body: bytes, content_type: str = "video/webm") -> Request:
    delivered = False

    async def receive() -> dict[str, object]:
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/interviews/test/recording",
        "raw_path": b"/interviews/test/recording",
        "query_string": b"",
        "headers": [
            (b"content-type", content_type.encode()),
            (b"content-length", str(len(body)).encode()),
            (b"origin", TRUSTED_ORIGIN.encode()),
            (b"x-csrf-token", ADMIN_CSRF_TOKEN.encode()),
        ],
        "client": ("127.0.0.1", 50000),
        "server": ("testserver", 80),
    }
    return Request(scope, receive)


def sample_gemini_completed_payload() -> dict[str, Any]:
    return {
        "assessment_status": "completed",
        "estimated_cefr_level": "B2",
        "overall_score": 85.0,
        "summary": "Candidate demonstrated strong B2 German proficiency with accurate syntax.",
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
                "quote": "Ich habe mehrjährige Erfahrung in der Softwareentwicklung gesammelt",
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

    # Set override for background tasks so they share the same in-memory DB during tests
    set_db_session_factory_override(session_factory)

    try:
        yield session
    finally:
        set_db_session_factory_override(None)
        session.close()
        engine.dispose()


@pytest.fixture
def test_setup(database_session: Session) -> dict[str, Any]:
    admin_user = User(
        email="admin@vervio.test",
        full_name="Admin Auto",
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

    candidate = Candidate(
        email="tariq@example.test",
        given_name="Tariq",
        family_name="Mansour",
        claimed_german_level="C2",  # Self-reported level (must be ignored)
    )

    interview_session = InterviewSession(
        candidate=candidate,
        status="in_progress",
        language="de",
        required_german_level="B2",  # Required standard for recommendation comparison
        is_transcript_finalized=False,
    )

    database_session.add_all([admin_user, admin_session, candidate, interview_session])
    database_session.commit()

    auth_context = AuthContext(user=admin_user, session=admin_session)

    return {
        "admin_user": admin_user,
        "admin_session": admin_session,
        "candidate": candidate,
        "interview_session": interview_session,
        "auth_context": auth_context,
    }


def add_sample_transcript_segments(
    database_session: Session,
    interview_session: InterviewSession,
) -> list[TranscriptSegment]:
    segments = [
        TranscriptSegment(
            interview_session_id=interview_session.id,
            position=1,
            speaker="interviewer",
            content="Guten Tag Herr Mansour, wie geht es Ihnen heute?",
            start_ms=0,
            end_ms=2500,
        ),
        TranscriptSegment(
            interview_session_id=interview_session.id,
            position=2,
            speaker="candidate",
            content=(
                "Guten Tag! Mir geht es sehr gut, vielen Dank. "
                "Ich habe mehrjährige Erfahrung in der Softwareentwicklung gesammelt "
                "und freue mich sehr auf dieses Gespräch."
            ),
            start_ms=3000,
            end_ms=9000,
        ),
        TranscriptSegment(
            interview_session_id=interview_session.id,
            position=3,
            speaker="interviewer",
            content="Erzählen Sie uns bitte von Ihren Programmiersprachen.",
            start_ms=9500,
            end_ms=13000,
        ),
        TranscriptSegment(
            interview_session_id=interview_session.id,
            position=4,
            speaker="candidate",
            content=(
                "Ich arbeite hauptsächlich mit Python und TypeScript. "
                "In den letzten drei Jahren habe ich skalierbare Microservices entworfen."
            ),
            start_ms=13500,
            end_ms=20000,
        ),
    ]
    database_session.add_all(segments)
    database_session.commit()
    return segments


# ==============================================================================
# 1. Normal Completion Order: WebSocket closes, then Recording uploads
# ==============================================================================


@pytest.mark.anyio
async def test_auto_assessment_normal_order_websocket_then_upload(
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """When WebSocket closes first, then recording uploads, assessment triggers on upload."""
    interview = test_setup["interview_session"]
    auth_ctx = test_setup["auth_context"]
    add_sample_transcript_segments(database_session, interview)

    # Step 1: WebSocket closes -> transcript collector flushes and marks finalized
    collector = RealtimeTranscriptCollector(interview.id, database_session)
    collector.start()
    assert is_collector_active(interview.id)

    await collector.close()
    assert not is_collector_active(interview.id)

    database_session.refresh(interview)
    assert interview.is_transcript_finalized is True
    # Recording not yet uploaded -> assessment must NOT have started
    assert interview.recording is None
    assert interview.evaluation is None
    assert not is_interview_ready_for_assessment(interview)

    # Step 2: Recording upload occurs
    mock_gemini_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.text = json.dumps(sample_gemini_completed_payload())
    mock_gemini_client.models.generate_content.return_value = mock_resp
    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_gemini_client)

    # Execute upload_recording
    req = create_mock_upload_request(valid_webm_bytes())
    recording = await upload_recording(
        session_id=interview.id,
        request=req,
        auth_context=auth_ctx,
        database_session=database_session,
    )
    assert recording.status == "available"

    database_session.refresh(interview)
    assert interview.status == "completed"
    assert is_interview_ready_for_assessment(interview)

    # Run the scheduled assessment task directly
    result = await run_assessment_task(
        interview.id, db=database_session, gemini_service=mock_service
    )

    assert result is not None
    assert result.assessment_status == "completed"
    assert result.estimated_cefr_level == "B2"
    assert result.overall_score == 85.0

    # Verify Task 12.3 recommendation was automatically derived
    assert result.recommendation is not None
    assert result.recommendation.recommendation_state == "meets_requirement"
    assert result.recommendation.required_german_level == "B2"
    assert result.recommendation.assessed_german_level == "B2"

    # Verify Gemini was invoked
    mock_gemini_client.models.generate_content.assert_called_once()


# ==============================================================================
# 2. Reversed Completion Order: Recording uploads, then WebSocket closes
# ==============================================================================


@pytest.mark.anyio
async def test_auto_assessment_reversed_order_upload_then_websocket(
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """When recording uploads first while WebSocket is still active, assessment waits."""
    interview = test_setup["interview_session"]
    auth_ctx = test_setup["auth_context"]

    # Step 1: Realtime collector is active
    collector = RealtimeTranscriptCollector(interview.id, database_session)
    collector.start()
    assert is_collector_active(interview.id)

    # Upload recording while collector is still streaming
    req = create_mock_upload_request(valid_webm_bytes())
    recording = await upload_recording(
        session_id=interview.id,
        request=req,
        auth_context=auth_ctx,
        database_session=database_session,
    )
    assert recording.status == "available"

    database_session.refresh(interview)
    assert interview.status == "completed"

    # Crucial assertion: Must NOT be ready for assessment while collector is active!
    assert not is_interview_ready_for_assessment(interview)
    assert interview.evaluation is None

    # Step 2: Interview speech finishes, WebSocket disconnects and flushes
    add_sample_transcript_segments(database_session, interview)

    mock_gemini_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.text = json.dumps(sample_gemini_completed_payload())
    mock_gemini_client.models.generate_content.return_value = mock_resp
    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_gemini_client)

    await collector.close()

    database_session.refresh(interview)
    assert interview.is_transcript_finalized is True
    assert not is_collector_active(interview.id)
    assert is_interview_ready_for_assessment(interview)

    # Execute assessment task
    result = await run_assessment_task(
        interview.id, db=database_session, gemini_service=mock_service
    )
    assert result is not None
    assert result.assessment_status == "completed"
    assert result.estimated_cefr_level == "B2"


# ==============================================================================
# 3. Duplicate Triggers & Concurrency Protection
# ==============================================================================


@pytest.mark.anyio
async def test_auto_assessment_duplicate_and_concurrent_triggers_call_gemini_once(
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Concurrent or repeated assessment triggers result in exactly one Gemini call."""
    interview = test_setup["interview_session"]
    add_sample_transcript_segments(database_session, interview)

    # Setup ready state
    interview.status = "completed"
    interview.is_transcript_finalized = True
    rec = Recording(
        interview_session_id=interview.id,
        storage_provider="local_private",
        object_key="test-key",
        content_type="video/webm",
        byte_size=1024,
        checksum="hash",
        status="available",
    )
    database_session.add(rec)
    database_session.commit()

    mock_gemini_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.text = json.dumps(sample_gemini_completed_payload())
    mock_gemini_client.models.generate_content.return_value = mock_resp
    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_gemini_client)

    # Launch 3 concurrent assessment tasks for the same session
    results = await asyncio.gather(
        run_assessment_task(interview.id, db=database_session, gemini_service=mock_service),
        run_assessment_task(interview.id, db=database_session, gemini_service=mock_service),
        run_assessment_task(interview.id, db=database_session, gemini_service=mock_service),
    )

    # Exactly one task performs the assessment; the others safely return None or existing
    completed_results = [r for r in results if r is not None and r.assessment_status == "completed"]
    assert len(completed_results) >= 1

    # Gemini must have been invoked exactly ONCE
    assert mock_gemini_client.models.generate_content.call_count == 1

    # Repeated subsequent call also returns without calling Gemini again
    repeated = await run_assessment_task(
        interview.id, db=database_session, gemini_service=mock_service
    )
    assert repeated is not None
    assert mock_gemini_client.models.generate_content.call_count == 1


# ==============================================================================
# 4. Failed Recording Upload: Never Triggers Assessment
# ==============================================================================


@pytest.mark.anyio
async def test_auto_assessment_failed_recording_upload_never_triggers_assessment(
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """If recording upload fails (e.g. invalid format), assessment is never triggered."""
    interview = test_setup["interview_session"]
    auth_ctx = test_setup["auth_context"]

    # Send invalid recording data (not webm/mp4)
    invalid_req = create_mock_upload_request(
        b"corrupted-non-media-bytes", content_type="video/webm"
    )

    with pytest.raises(Exception):
        await upload_recording(
            session_id=interview.id,
            request=invalid_req,
            auth_context=auth_ctx,
            database_session=database_session,
        )

    database_session.refresh(interview)
    # Interview was not marked completed
    assert interview.status != "completed"
    assert interview.recording is None
    assert interview.evaluation is None
    assert not is_interview_ready_for_assessment(interview)


# ==============================================================================
# 5. Insufficient Evidence Handling
# ==============================================================================


@pytest.mark.anyio
async def test_auto_assessment_handles_insufficient_evidence(
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Brief candidate speech saves insufficient_evidence with null scores."""
    interview = test_setup["interview_session"]

    # Only 1 brief turn (< 2 turns / < 15 words)
    brief_segment = TranscriptSegment(
        interview_session_id=interview.id,
        position=1,
        speaker="candidate",
        content="Ja danke.",
        start_ms=0,
        end_ms=1000,
    )
    database_session.add(brief_segment)

    interview.status = "completed"
    interview.is_transcript_finalized = True
    rec = Recording(
        interview_session_id=interview.id,
        storage_provider="local_private",
        object_key="key-brief",
        content_type="video/webm",
        byte_size=1024,
        checksum="hash",
        status="available",
    )
    database_session.add(rec)
    database_session.commit()

    mock_gemini_client = MagicMock()
    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_gemini_client)

    result = await run_assessment_task(
        interview.id, db=database_session, gemini_service=mock_service
    )

    assert result is not None
    assert result.assessment_status == "insufficient_evidence"
    assert result.estimated_cefr_level is None
    assert result.overall_score is None

    # Database evaluation row verification
    database_session.refresh(interview)
    assert interview.evaluation is not None
    assert interview.evaluation.status == "insufficient_evidence"
    assert interview.evaluation.overall_score is None

    # Pre-flight caught it; Gemini API was never called
    mock_gemini_client.models.generate_content.assert_not_called()


# ==============================================================================
# 6. Gemini Failure: Preserves Failed State and Allows Retry
# ==============================================================================


@pytest.mark.anyio
async def test_auto_assessment_gemini_failure_preserves_failed_state_and_allows_retry(
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Gemini API provider failure records status='failed' and allows retry."""
    interview = test_setup["interview_session"]
    add_sample_transcript_segments(database_session, interview)

    interview.status = "completed"
    interview.is_transcript_finalized = True
    rec = Recording(
        interview_session_id=interview.id,
        storage_provider="local_private",
        object_key="key-fail",
        content_type="video/webm",
        byte_size=1024,
        checksum="hash",
        status="available",
    )
    database_session.add(rec)
    database_session.commit()

    # Step 1: Gemini fails with 503
    failing_client = MagicMock()
    failing_client.models.generate_content.side_effect = RuntimeError("503 Service Unavailable")
    failing_service = GeminiAssessmentService(api_key="mock-key", client=failing_client)

    fail_result = await run_assessment_task(
        interview.id,
        db=database_session,
        gemini_service=failing_service,
    )
    assert fail_result is None

    # Verify failed evaluation state is recorded in database
    database_session.refresh(interview)
    assert interview.evaluation is not None
    assert interview.evaluation.status == "failed"
    assert "Gemini evaluation failed" in (interview.evaluation.summary or "")

    # Step 2: Gemini service recovers and retry succeeds
    recovering_client = MagicMock()
    recovering_resp = MagicMock()
    recovering_resp.text = json.dumps(sample_gemini_completed_payload())
    recovering_client.models.generate_content.return_value = recovering_resp
    recovering_service = GeminiAssessmentService(api_key="mock-key", client=recovering_client)

    retry_result = await run_assessment_task(
        interview.id,
        db=database_session,
        gemini_service=recovering_service,
    )

    assert retry_result is not None
    assert retry_result.assessment_status == "completed"
    assert retry_result.estimated_cefr_level == "B2"

    database_session.refresh(interview)
    assert interview.evaluation.status == "completed"
    assert interview.evaluation.overall_score == Decimal("85.00")


# ==============================================================================
# 7. Restart Recovery
# ==============================================================================


@pytest.mark.anyio
async def test_auto_assessment_restart_recovery(
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Pending completed interviews are discovered and scheduled on restart recovery."""
    interview = test_setup["interview_session"]
    add_sample_transcript_segments(database_session, interview)

    # Completed interview with recording and finalized transcript, but pending evaluation
    interview.status = "completed"
    interview.is_transcript_finalized = True
    rec = Recording(
        interview_session_id=interview.id,
        storage_provider="local_private",
        object_key="key-recov",
        content_type="video/webm",
        byte_size=1024,
        checksum="hash",
        status="available",
    )
    pending_eval = Evaluation(
        interview_session_id=interview.id,
        status="pending",
    )
    database_session.add_all([rec, pending_eval])
    database_session.commit()

    mock_gemini_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.text = json.dumps(sample_gemini_completed_payload())
    mock_gemini_client.models.generate_content.return_value = mock_resp
    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_gemini_client)

    # Simulate backend startup recovery
    recovered_ids = recover_pending_assessments(db=database_session, gemini_service=mock_service)
    assert interview.id in recovered_ids

    # Allow scheduled task to run
    await asyncio.sleep(0.05)

    database_session.refresh(interview)
    assert interview.evaluation.status == "completed"
    assert interview.evaluation.assessed_german_level == "B2"


# ==============================================================================
# 8. Recommendation Isolation from Candidate Claimed Level
# ==============================================================================


@pytest.mark.anyio
async def test_auto_assessment_ignores_candidate_claimed_level(
    database_session: Session,
    test_setup: dict[str, Any],
) -> None:
    """Candidate claimed level (C2) is completely ignored in derived recommendation."""
    interview = test_setup["interview_session"]
    candidate = test_setup["candidate"]
    assert candidate.claimed_german_level == "C2"

    add_sample_transcript_segments(database_session, interview)

    # Require C1
    interview.required_german_level = "C1"
    interview.status = "completed"
    interview.is_transcript_finalized = True
    rec = Recording(
        interview_session_id=interview.id,
        storage_provider="local_private",
        object_key="key-claim",
        content_type="video/webm",
        byte_size=1024,
        checksum="hash",
        status="available",
    )
    database_session.add(rec)
    database_session.commit()

    # Gemini assesses B2
    mock_gemini_client = MagicMock()
    mock_resp = MagicMock()
    mock_resp.text = json.dumps(sample_gemini_completed_payload())
    mock_gemini_client.models.generate_content.return_value = mock_resp
    mock_service = GeminiAssessmentService(api_key="mock-key", client=mock_gemini_client)

    result = await run_assessment_task(
        interview.id, db=database_session, gemini_service=mock_service
    )

    assert result is not None
    assert result.estimated_cefr_level == "B2"
    # Even though candidate claimed C2, required is C1 and assessed is B2 -> below_requirement!
    assert result.recommendation is not None
    assert result.recommendation.recommendation_state == "below_requirement"
    assert "is below the required interview standard (C1)" in result.recommendation.explanation
