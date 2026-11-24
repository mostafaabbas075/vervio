"""Service orchestration for German language assessment retrieval and persistence."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.schemas.assessments import (
    CriterionAssessment,
    EvidenceItem,
    GermanAssessmentCreate,
    GermanAssessmentCriteria,
    GermanAssessmentResponse,
    GermanRecommendationResponse,
    GermanRequirementUpdate,
    TranscriptReadinessResponse,
)
from app.assessments.gemini_service import (
    GeminiAssessmentConfigurationError,
    GeminiAssessmentProviderError,
    GeminiAssessmentService,
    GeminiAssessmentTimeoutError,
    GeminiAssessmentValidationError,
)
from app.assessments.readiness import assess_transcript_readiness
from app.assessments.recommendation import (
    derive_language_recommendation,
    normalize_cefr_level,
)
from app.assessments.validation import (
    AssessmentValidationError,
    build_default_text_criteria,
    validate_assessment_against_readiness,
    validate_evidence_against_transcript,
)
from app.models.entities import CriterionScore, Evaluation, InterviewSession, TranscriptSegment


def get_session_with_relations(db: Session, session_id: UUID) -> InterviewSession:
    """Retrieve an interview session with candidate, evaluation, and transcript relations."""
    statement = (
        select(InterviewSession)
        .options(
            selectinload(InterviewSession.candidate),
            selectinload(InterviewSession.evaluation).selectinload(Evaluation.criterion_scores),
            selectinload(InterviewSession.transcript_segments),
        )
        .where(InterviewSession.id == session_id)
        .execution_options(populate_existing=True)
    )
    session = db.scalar(statement)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Interview session not found.",
        )
    return session


def get_session_recommendation(session: InterviewSession) -> GermanRecommendationResponse:
    """Derive German language recommendation comparing demonstrated vs required level."""
    candidate = session.candidate
    candidate_id = candidate.id if candidate else None
    candidate_name = candidate.full_name if candidate else None
    candidate_claimed_level = candidate.claimed_german_level if candidate else None

    evaluation = session.evaluation
    assessment_status = evaluation.status if evaluation else "pending"
    assessed_level = evaluation.assessed_german_level if evaluation else None

    state, explanation = derive_language_recommendation(
        required_level=session.required_german_level,
        assessment_status=assessment_status,
        assessed_level=assessed_level,
    )

    req_cefr = normalize_cefr_level(session.required_german_level)
    assessed_cefr = normalize_cefr_level(assessed_level)

    return GermanRecommendationResponse(
        interview_session_id=session.id,
        required_german_level=req_cefr,  # type: ignore[arg-type]
        assessed_german_level=assessed_cefr,  # type: ignore[arg-type]
        recommendation_state=state,
        explanation=explanation,
        candidate_id=candidate_id,
        candidate_name=candidate_name,
        candidate_claimed_level=candidate_claimed_level,
        assessment_status=assessment_status,  # type: ignore[arg-type]
    )


def update_session_requirement(
    db: Session,
    session_id: UUID,
    payload: GermanRequirementUpdate,
) -> GermanRecommendationResponse:
    """Update required German level on an interview session and return updated recommendation."""
    session = get_session_with_relations(db, session_id)
    session.required_german_level = payload.required_german_level
    db.commit()
    db.refresh(session)
    return get_session_recommendation(session)


def get_assessment_response(session: InterviewSession) -> GermanAssessmentResponse:
    """Build a structured GermanAssessmentResponse from an InterviewSession."""
    recommendation = get_session_recommendation(session)
    candidate = session.candidate
    candidate_id = candidate.id if candidate else None
    candidate_name = candidate.full_name if candidate else None
    candidate_claimed_level = candidate.claimed_german_level if candidate else None

    evaluation = session.evaluation
    if evaluation is None:
        return GermanAssessmentResponse(
            id=None,
            interview_session_id=session.id,
            assessment_status="pending",
            estimated_cefr_level=None,
            overall_score=None,
            summary=None,
            criteria=None,
            strengths=[],
            areas_for_improvement=[],
            evidence=[],
            insufficient_evidence_reason=None,
            evaluated_at=None,
            candidate_id=candidate_id,
            candidate_name=candidate_name,
            candidate_claimed_level=candidate_claimed_level,
            required_german_level=recommendation.required_german_level,
            recommendation=recommendation,
        )

    # Reconstruct criteria from metadata or criterion_scores
    criteria: GermanAssessmentCriteria | None = None
    if evaluation.assessment_metadata and "criteria" in evaluation.assessment_metadata:
        try:
            criteria = GermanAssessmentCriteria.model_validate(
                evaluation.assessment_metadata["criteria"]
            )
        except Exception:
            criteria = None

    if criteria is None and evaluation.criterion_scores:
        scores_by_code: dict[str, CriterionScore] = {
            cs.criterion_code: cs for cs in evaluation.criterion_scores
        }
        criteria = build_default_text_criteria(
            grammar_score=float(scores_by_code["grammar"].score)
            if "grammar" in scores_by_code
            else None,
            vocabulary_score=float(scores_by_code["vocabulary"].score)
            if "vocabulary" in scores_by_code
            else None,
            comprehension_score=float(scores_by_code["comprehension"].score)
            if "comprehension" in scores_by_code
            else None,
            fluency_score=float(scores_by_code["fluency"].score)
            if "fluency" in scores_by_code
            else None,
        )

    # Reconstruct evidence items
    evidence_items: list[EvidenceItem] = []
    if evaluation.evidence:
        for ev in evaluation.evidence:
            try:
                evidence_items.append(EvidenceItem.model_validate(ev))
            except Exception:
                continue

    overall_score_val = (
        float(evaluation.overall_score) if evaluation.overall_score is not None else None
    )

    return GermanAssessmentResponse(
        id=evaluation.id,
        interview_session_id=session.id,
        assessment_status=evaluation.status,  # type: ignore[arg-type]
        estimated_cefr_level=evaluation.assessed_german_level,  # type: ignore[arg-type]
        overall_score=overall_score_val,
        summary=evaluation.summary,
        criteria=criteria,
        strengths=evaluation.strengths or [],
        areas_for_improvement=evaluation.areas_for_improvement or [],
        evidence=evidence_items,
        insufficient_evidence_reason=evaluation.insufficient_evidence_reason,
        evaluated_at=evaluation.evaluated_at,
        candidate_id=candidate_id,
        candidate_name=candidate_name,
        candidate_claimed_level=candidate_claimed_level,
        required_german_level=recommendation.required_german_level,
        recommendation=recommendation,
    )


def check_session_readiness(db: Session, session_id: UUID) -> TranscriptReadinessResponse:
    """Inspect transcript segments and diagnose readiness for language evaluation."""
    session = db.get(InterviewSession, session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Interview session not found.",
        )
    segments = list(
        db.scalars(
            select(TranscriptSegment)
            .where(TranscriptSegment.interview_session_id == session_id)
            .order_by(TranscriptSegment.position.asc())
        ).all()
    )
    return assess_transcript_readiness(session.id, segments)


def save_assessment(
    db: Session,
    session_id: UUID,
    payload: GermanAssessmentCreate,
) -> GermanAssessmentResponse:
    """Validate and persist a German language assessment."""
    session = get_session_with_relations(db, session_id)
    segments = list(
        db.scalars(
            select(TranscriptSegment)
            .where(TranscriptSegment.interview_session_id == session_id)
            .order_by(TranscriptSegment.position.asc())
        ).all()
    )

    # 1. Transcript readiness checks
    readiness = assess_transcript_readiness(session_id, segments)
    try:
        validate_assessment_against_readiness(payload, readiness)
    except AssessmentValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    # 2. Evidence references verification
    if payload.evidence:
        try:
            validate_evidence_against_transcript(payload.evidence, segments)
        except AssessmentValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            ) from exc

    # 3. Create or update Evaluation entity
    evaluation = session.evaluation
    if evaluation is None:
        evaluation = Evaluation(interview_session_id=session.id)
        db.add(evaluation)
        session.evaluation = evaluation

    evaluation.status = payload.assessment_status
    evaluation.assessed_german_level = payload.estimated_cefr_level
    evaluation.overall_score = (
        Decimal(str(payload.overall_score)) if payload.overall_score is not None else None
    )
    evaluation.summary = payload.summary
    evaluation.strengths = payload.strengths
    evaluation.areas_for_improvement = payload.areas_for_improvement
    evaluation.evidence = [item.model_dump(mode="json") for item in payload.evidence]
    evaluation.insufficient_evidence_reason = payload.insufficient_evidence_reason

    if payload.assessment_status in {"completed", "insufficient_evidence"}:
        evaluation.evaluated_at = datetime.now(timezone.utc)
    else:
        evaluation.evaluated_at = None

    # Persist criteria snapshot in assessment_metadata
    metadata: dict[str, Any] = {
        "assessment_status": payload.assessment_status,
        "estimated_cefr_level": payload.estimated_cefr_level,
        "overall_score": payload.overall_score,
        "criteria": payload.criteria.model_dump(mode="json") if payload.criteria else None,
        "evaluated_at": evaluation.evaluated_at.isoformat() if evaluation.evaluated_at else None,
    }
    evaluation.assessment_metadata = metadata

    # 4. Synchronize relational CriterionScore entities for evaluated numeric criteria
    evaluation.criterion_scores.clear()
    if payload.criteria is not None:
        criteria_dict: dict[str, CriterionAssessment] = {
            "grammar": payload.criteria.grammar,
            "vocabulary": payload.criteria.vocabulary,
            "comprehension": payload.criteria.comprehension,
            "fluency": payload.criteria.fluency,
            "pronunciation": payload.criteria.pronunciation,
        }
        for code, crit in criteria_dict.items():
            if crit.status == "evaluated" and crit.score is not None:
                evaluation.criterion_scores.append(
                    CriterionScore(
                        criterion_code=code,
                        label=crit.label,
                        score=Decimal(str(crit.score)),
                        rationale=crit.rationale,
                    )
                )

    db.commit()
    db.refresh(evaluation)

    return get_assessment_response(session)


async def generate_and_save_assessment(
    db: Session,
    session_id: UUID,
    gemini_service: GeminiAssessmentService | None = None,
) -> GermanAssessmentResponse:
    """Generate an evidence-based assessment via Gemini and persist it."""
    session = get_session_with_relations(db, session_id)

    # 1. Handle repeated requests without overwriting completed assessment
    if session.evaluation and session.evaluation.status in {"completed", "insufficient_evidence"}:
        return get_assessment_response(session)

    # 2. Verify interview is completed
    if session.status != "completed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Interview session status is '{session.status}'. "
                "Only completed interviews can be evaluated."
            ),
        )

    # 3. Retrieve actual ordered transcript segments
    segments = list(
        db.scalars(
            select(TranscriptSegment)
            .where(TranscriptSegment.interview_session_id == session_id)
            .order_by(TranscriptSegment.position.asc())
        ).all()
    )

    # 4. Check readiness
    readiness = assess_transcript_readiness(session_id, segments)
    if not readiness.is_ready:
        reasons_msg = "; ".join(readiness.reasons) if readiness.reasons else "No speech found."
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Interview cannot be evaluated: {reasons_msg}",
        )

    # 5. Evaluate via Gemini
    service = gemini_service or GeminiAssessmentService()
    try:
        assessment_create = await service.evaluate_transcript(session_id, segments)
    except GeminiAssessmentConfigurationError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except GeminiAssessmentTimeoutError as exc:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=str(exc),
        ) from exc
    except (GeminiAssessmentProviderError, GeminiAssessmentValidationError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    # 6. Save and return using persistence foundation
    return save_assessment(db, session_id, assessment_create)

