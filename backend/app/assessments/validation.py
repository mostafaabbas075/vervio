"""Validation logic for German language assessments and transcript evidence."""

from __future__ import annotations

from collections.abc import Sequence

from app.api.schemas.assessments import (
    CriterionAssessment,
    EvidenceItem,
    GermanAssessmentCreate,
    GermanAssessmentCriteria,
    TranscriptReadinessResponse,
)
from app.models.entities import TranscriptSegment


class AssessmentValidationError(ValueError):
    """Raised when an assessment payload fails domain or evidence validation."""


def validate_evidence_against_transcript(
    evidence: list[EvidenceItem],
    segments: Sequence[TranscriptSegment],
) -> None:
    """Validate that every evidence item references a genuine transcript segment."""
    if not segments:
        raise AssessmentValidationError("Cannot validate evidence against an empty transcript.")

    segments_by_pos = {s.position: s for s in segments}

    for item in evidence:
        target_segment = segments_by_pos.get(item.segment_position)
        if target_segment is None:
            raise AssessmentValidationError(
                f"Evidence references segment position {item.segment_position}, "
                f"which does not exist in the session transcript."
            )

        # Populate segment_id if missing
        if item.segment_id is None:
            item.segment_id = target_segment.id

        # Verify quote matches actual transcript content
        normalized_quote = item.quote.strip().lower()
        normalized_content = target_segment.content.strip().lower()
        if normalized_quote not in normalized_content:
            raise AssessmentValidationError(
                f"Evidence quote does not match transcript content for "
                f"segment position {item.segment_position}."
            )

        # Verify speaker attribution
        if item.speaker.strip().lower() == "candidate" and target_segment.speaker != "candidate":
            raise AssessmentValidationError(
                f"Evidence at position {item.segment_position} claims candidate speech, "
                f"but segment was spoken by '{target_segment.speaker}'."
            )


def validate_assessment_against_readiness(
    payload: GermanAssessmentCreate,
    readiness: TranscriptReadinessResponse,
) -> None:
    """Ensure assessment status and claims are consistent with actual transcript readiness."""
    if not readiness.is_ready:
        reasons_msg = (
            "; ".join(readiness.reasons) if readiness.reasons else "Transcript is not ready."
        )
        raise AssessmentValidationError(f"Cannot record assessment: {reasons_msg}")

    if not readiness.is_sufficient and payload.assessment_status == "completed":
        reasons_msg = (
            "; ".join(readiness.reasons)
            if readiness.reasons
            else "Candidate speech is insufficient for CEFR evaluation."
        )
        raise AssessmentValidationError(
            f"Cannot assign completed assessment or CEFR level with insufficient evidence. "
            f"{reasons_msg}"
        )


def build_default_text_criteria(
    grammar_score: float | None = None,
    vocabulary_score: float | None = None,
    comprehension_score: float | None = None,
    fluency_score: float | None = None,
) -> GermanAssessmentCriteria:
    """Construct standard German assessment criteria where pronunciation is marked unavailable."""
    return GermanAssessmentCriteria(
        grammar=CriterionAssessment(
            criterion_code="grammar",
            label="Grammatik & Sprachrichtigkeit",
            status="evaluated" if grammar_score is not None else "unavailable",
            score=grammar_score,
            rationale="Evaluated from grammatical structures and syntactic accuracy in transcript."
            if grammar_score is not None
            else None,
            unavailable_reason="Grammar was not evaluated." if grammar_score is None else None,
        ),
        vocabulary=CriterionAssessment(
            criterion_code="vocabulary",
            label="Wortschatz & Ausdruckskraft",
            status="evaluated" if vocabulary_score is not None else "unavailable",
            score=vocabulary_score,
            rationale="Evaluated from lexical range and situational appropriateness in transcript."
            if vocabulary_score is not None
            else None,
            unavailable_reason="Vocabulary was not evaluated."
            if vocabulary_score is None
            else None,
        ),
        comprehension=CriterionAssessment(
            criterion_code="comprehension",
            label="Hörverstehen & Interaktion",
            status="evaluated" if comprehension_score is not None else "unavailable",
            score=comprehension_score,
            rationale="Evaluated from responsiveness and conversational coherence with interviewer."
            if comprehension_score is not None
            else None,
            unavailable_reason="Comprehension was not evaluated."
            if comprehension_score is None
            else None,
        ),
        fluency=CriterionAssessment(
            criterion_code="fluency",
            label="Gesprochene Sprachflüssigkeit (Text-basiert)",
            status="evaluated" if fluency_score is not None else "unavailable",
            score=fluency_score,
            rationale=(
                "Evaluated from utterance length and syntax flow; acoustic pauses unavailable."
            )
            if fluency_score is not None
            else None,
            unavailable_reason=(
                "Acoustic fluency analysis requires audio; only textual flow was observed."
            )
            if fluency_score is None
            else None,
        ),
        pronunciation=CriterionAssessment(
            criterion_code="pronunciation",
            label="Aussprache & Verständlichkeit",
            status="unavailable",
            score=None,
            rationale=None,
            unavailable_reason=(
                "Pronunciation and acoustic intelligibility cannot be evaluated from transcript "
                "text alone; audio acoustic analysis is required."
            ),
        ),
    )
