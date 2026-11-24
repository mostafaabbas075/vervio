"""Pydantic schemas and contracts for evidence-based German language assessment."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

CEFRLevel = Literal["A1", "A2", "B1", "B2", "C1", "C2"]
AssessmentStatus = Literal["pending", "completed", "insufficient_evidence", "failed"]
CriterionStatus = Literal["evaluated", "unavailable", "insufficient_evidence"]
LanguageRecommendationState = Literal[
    "meets_requirement",
    "below_requirement",
    "insufficient_evidence",
    "not_configured",
]


class CriterionAssessment(BaseModel):
    """Evaluation of a specific linguistic criterion."""

    criterion_code: str
    label: str
    status: CriterionStatus = "evaluated"
    score: float | None = Field(default=None, ge=0.0, le=100.0)
    rationale: str | None = None
    unavailable_reason: str | None = None

    @model_validator(mode="after")
    def validate_criterion(self) -> CriterionAssessment:
        if self.status == "unavailable":
            if self.score is not None:
                raise ValueError(
                    f"Criterion '{self.criterion_code}' is marked unavailable "
                    "and cannot have a numeric score."
                )
            if not self.unavailable_reason or not self.unavailable_reason.strip():
                raise ValueError(
                    f"Criterion '{self.criterion_code}' is marked unavailable "
                    "and requires an unavailable_reason."
                )
        elif self.status == "evaluated":
            if self.score is None:
                raise ValueError(
                    f"Criterion '{self.criterion_code}' is marked evaluated "
                    "and must have a valid score (0–100)."
                )
        elif self.status == "insufficient_evidence":
            if self.score is not None:
                raise ValueError(
                    f"Criterion '{self.criterion_code}' has insufficient evidence "
                    "and cannot have a score."
                )
        return self


class GermanAssessmentCriteria(BaseModel):
    """The five core linguistic criteria evaluated for German proficiency."""

    grammar: CriterionAssessment
    vocabulary: CriterionAssessment
    comprehension: CriterionAssessment
    fluency: CriterionAssessment
    pronunciation: CriterionAssessment


class EvidenceItem(BaseModel):
    """Transcript-backed evidence item referencing a specific interview segment."""

    segment_position: int = Field(ge=1, description="1-based position in transcript")
    speaker: str = Field(description="Speaker label (e.g. 'candidate')")
    quote: str = Field(min_length=1, description="German quotation from the transcript")
    observation: str = Field(min_length=1, description="Linguistic observation or justification")
    criterion_code: str | None = Field(default=None, description="Related criterion code")
    segment_id: UUID | None = Field(default=None, description="Database UUID of referenced segment")


class GermanAssessmentCreate(BaseModel):
    """Payload to create or persist a German language assessment."""

    assessment_status: AssessmentStatus
    estimated_cefr_level: CEFRLevel | None = None
    overall_score: float | None = Field(default=None, ge=0.0, le=100.0)
    summary: str | None = None
    criteria: GermanAssessmentCriteria | None = None
    strengths: list[str] = Field(default_factory=list)
    areas_for_improvement: list[str] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    insufficient_evidence_reason: str | None = None

    @model_validator(mode="after")
    def validate_assessment_consistency(self) -> GermanAssessmentCreate:
        if self.assessment_status == "completed":
            if self.overall_score is None:
                raise ValueError("Completed assessment must have an overall_score (0–100).")
            if self.estimated_cefr_level is None:
                raise ValueError("Completed assessment must have an estimated_cefr_level (A1–C2).")
            if not self.summary or not self.summary.strip():
                raise ValueError("Completed assessment must have a non-empty summary.")
            if not self.strengths:
                raise ValueError("Completed assessment must provide at least one strength.")
            if not self.areas_for_improvement:
                raise ValueError(
                    "Completed assessment must provide at least one area for improvement."
                )
            if not self.evidence:
                raise ValueError("Completed assessment must provide transcript-backed evidence.")
            if self.criteria is None:
                raise ValueError("Completed assessment must provide criteria evaluations.")
            # Pronunciation and acoustic analysis rule:
            if self.criteria.pronunciation.status == "evaluated":
                raise ValueError(
                    "Pronunciation cannot be evaluated from transcript text alone; "
                    "audio acoustic analysis is required."
                )
        elif self.assessment_status == "insufficient_evidence":
            if self.overall_score is not None:
                raise ValueError("Insufficient evidence assessment cannot have an overall_score.")
            if self.estimated_cefr_level is not None:
                raise ValueError(
                    "Insufficient evidence assessment cannot have an estimated_cefr_level."
                )
            has_reason = (
                bool(self.insufficient_evidence_reason)
                and bool(self.insufficient_evidence_reason.strip())
            )
            if not has_reason:
                raise ValueError(
                    "Insufficient evidence assessment must provide an insufficient_evidence_reason."
                )
        elif self.assessment_status in {"pending", "failed"}:
            status_title = self.assessment_status.capitalize()
            if self.overall_score is not None:
                raise ValueError(f"{status_title} assessment cannot have an overall_score.")
            if self.estimated_cefr_level is not None:
                raise ValueError(
                    f"{status_title} assessment cannot have an estimated_cefr_level."
                )
        return self


class GermanRequirementUpdate(BaseModel):
    """Payload to configure or update the required German level for an interview."""

    required_german_level: CEFRLevel | None = None

    @field_validator("required_german_level", mode="before")
    @classmethod
    def validate_and_normalize_level(cls, value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            cleaned = value.strip().upper()
            if not cleaned:
                return None
            if cleaned not in {"A1", "A2", "B1", "B2", "C1", "C2"}:
                raise ValueError(
                    f"Invalid CEFR level: '{value}'. Must be one of A1, A2, B1, B2, C1, C2 or null."
                )
            return cleaned
        raise ValueError("required_german_level must be a string or null.")


class GermanRecommendationResponse(BaseModel):
    """Derived read-only recommendation comparing demonstrated vs required German level."""

    model_config = ConfigDict(from_attributes=True)

    interview_session_id: UUID
    required_german_level: CEFRLevel | None = None
    assessed_german_level: CEFRLevel | None = None
    recommendation_state: LanguageRecommendationState
    explanation: str

    # Contextual candidate & assessment fields
    candidate_id: UUID | None = None
    candidate_name: str | None = None
    candidate_claimed_level: str | None = None
    assessment_status: AssessmentStatus


class GermanAssessmentResponse(BaseModel):
    """Read-only view of a German language assessment."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID | None = None
    interview_session_id: UUID
    assessment_status: AssessmentStatus
    estimated_cefr_level: CEFRLevel | None = None
    overall_score: float | None = None
    summary: str | None = None
    criteria: GermanAssessmentCriteria | None = None
    strengths: list[str] = Field(default_factory=list)
    areas_for_improvement: list[str] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    insufficient_evidence_reason: str | None = None
    evaluated_at: datetime | None = None

    # Contextual candidate fields: strictly separate from assessed CEFR level!
    candidate_id: UUID | None = None
    candidate_name: str | None = None
    candidate_claimed_level: str | None = None

    # Required language requirement & derived recommendation
    required_german_level: CEFRLevel | None = None
    recommendation: GermanRecommendationResponse | None = None


class TranscriptReadinessResponse(BaseModel):
    """Transcript readiness and sufficiency diagnostics for German evaluation."""

    interview_session_id: UUID
    is_ready: bool
    is_sufficient: bool
    candidate_turn_count: int
    candidate_word_count: int
    interviewer_turn_count: int
    total_segment_count: int
    status_recommendation: AssessmentStatus
    reasons: list[str] = Field(default_factory=list)
