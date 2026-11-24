"""Protected endpoints for evidence-based German language assessment."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.api.schemas.assessments import (
    GermanAssessmentCreate,
    GermanAssessmentResponse,
    GermanRecommendationResponse,
    GermanRequirementUpdate,
    TranscriptReadinessResponse,
)
from app.assessments.auto_evaluator import (
    is_assessment_active,
    is_collector_active,
    run_assessment_task,
)
from app.assessments.gemini_service import GeminiAssessmentService
from app.assessments.service import (
    check_session_readiness,
    generate_and_save_assessment,
    get_assessment_response,
    get_session_recommendation,
    get_session_with_relations,
    save_assessment,
    update_session_requirement,
)
from app.auth.dependencies import AuthContext, require_csrf, require_roles, require_trusted_origin
from app.db.session import get_db_session

router = APIRouter(prefix="/interviews", tags=["assessments"])


@router.get(
    "/{session_id}/assessment",
    response_model=GermanAssessmentResponse,
)
@router.get(
    "/{session_id}/evaluation",
    response_model=GermanAssessmentResponse,
)
def get_assessment(
    session_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    db: Session = Depends(get_db_session),
) -> GermanAssessmentResponse:
    """Retrieve German assessment for an interview session, or pending if not evaluated."""
    session = get_session_with_relations(db, session_id)
    return get_assessment_response(session)


@router.get(
    "/{session_id}/assessment/readiness",
    response_model=TranscriptReadinessResponse,
)
def get_assessment_readiness(
    session_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    db: Session = Depends(get_db_session),
) -> TranscriptReadinessResponse:
    """Diagnose whether transcript speech is sufficient for an evidence-based assessment."""
    return check_session_readiness(db, session_id)


@router.post(
    "/{session_id}/assessment",
    response_model=GermanAssessmentResponse,
    status_code=status.HTTP_201_CREATED,
)
def save_session_assessment(
    session_id: UUID,
    payload: GermanAssessmentCreate,
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    ___: AuthContext = Depends(require_roles("admin")),
    db: Session = Depends(get_db_session),
) -> GermanAssessmentResponse:
    """Persist a validated German language assessment backed by transcript evidence."""
    return save_assessment(db, session_id, payload)


def get_gemini_assessment_service() -> GeminiAssessmentService:
    return GeminiAssessmentService()


@router.post(
    "/{session_id}/assessment/generate",
    response_model=GermanAssessmentResponse,
)
async def generate_session_assessment(
    session_id: UUID,
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    ___: AuthContext = Depends(require_roles("admin")),
    db: Session = Depends(get_db_session),
    gemini_service: GeminiAssessmentService = Depends(get_gemini_assessment_service),
) -> GermanAssessmentResponse:
    """Generate an evidence-based German assessment from the transcript using Gemini."""
    return await generate_and_save_assessment(db, session_id, gemini_service=gemini_service)


@router.post(
    "/{session_id}/assessment/retry",
    response_model=GermanAssessmentResponse,
)
async def retry_session_assessment(
    session_id: UUID,
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    ___: AuthContext = Depends(require_roles("admin")),
    db: Session = Depends(get_db_session),
    gemini_service: GeminiAssessmentService = Depends(get_gemini_assessment_service),
) -> GermanAssessmentResponse:
    """Retry a failed German AI assessment for a completed interview session."""
    session = get_session_with_relations(db, session_id)
    if session.status != "completed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Interview session status is '{session.status}'. "
                "Only completed interviews can be evaluated."
            ),
        )

    if session.recording is None or session.recording.status != "available":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Recording is not available for this interview session.",
        )

    if session.evaluation and session.evaluation.status in {"completed", "insufficient_evidence"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Assessment is already finalized and cannot be retried.",
        )

    if is_assessment_active(session_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Assessment is currently being processed. Please wait for it to complete.",
        )

    if (
        not session.is_transcript_finalized
        and session.transcript_segments
        and not is_collector_active(session.id)
    ):
        session.is_transcript_finalized = True
        db.commit()
        db.refresh(session)

    result = await run_assessment_task(session_id, db=db, gemini_service=gemini_service)
    if result is not None:
        return result

    # When run_assessment_task returns None, assessment failed during generation
    session = get_session_with_relations(db, session_id)
    if session.evaluation and session.evaluation.status == "failed":
        summary_lower = (session.evaluation.summary or "").lower()
        if "timed out" in summary_lower:
            raise HTTPException(
                status_code=status.HTTP_504_GATEWAY_TIMEOUT,
                detail="AI assessment retry timed out. Please try again later.",
            )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI assessment retry failed. The evaluation could not be completed.",
        )

    return get_assessment_response(session)


@router.get(
    "/{session_id}/requirement",
    response_model=GermanRecommendationResponse,
)
@router.get(
    "/{session_id}/recommendation",
    response_model=GermanRecommendationResponse,
)
def get_interview_requirement(
    session_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    db: Session = Depends(get_db_session),
) -> GermanRecommendationResponse:
    """Retrieve the required German level and derived recommendation for an interview."""
    session = get_session_with_relations(db, session_id)
    return get_session_recommendation(session)


@router.patch(
    "/{session_id}/requirement",
    response_model=GermanRecommendationResponse,
)
@router.put(
    "/{session_id}/requirement",
    response_model=GermanRecommendationResponse,
)
def update_interview_requirement(
    session_id: UUID,
    payload: GermanRequirementUpdate,
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    ___: AuthContext = Depends(require_roles("admin")),
    db: Session = Depends(get_db_session),
) -> GermanRecommendationResponse:
    """Update required German level and immediately return the updated derived recommendation."""
    return update_session_requirement(db, session_id, payload)
