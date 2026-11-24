"""Pydantic request and response schemas for the HTTP API."""

from app.api.schemas.assessments import (
    AssessmentStatus,
    CEFRLevel,
    CriterionAssessment,
    CriterionStatus,
    EvidenceItem,
    GermanAssessmentCreate,
    GermanAssessmentCriteria,
    GermanAssessmentResponse,
    TranscriptReadinessResponse,
)
from app.api.schemas.recordings import (
    CandidateRecordedInterview,
    CandidateRecordingSummary,
    RecordedInterviewEvaluation,
)
from app.api.schemas.transcripts import (
    TranscriptResponse,
    TranscriptSaveRequest,
    TranscriptSegmentCreate,
    TranscriptSegmentResponse,
)

__all__ = [
    "AssessmentStatus",
    "CandidateRecordedInterview",
    "CandidateRecordingSummary",
    "CEFRLevel",
    "CriterionAssessment",
    "CriterionStatus",
    "EvidenceItem",
    "GermanAssessmentCreate",
    "GermanAssessmentCriteria",
    "GermanAssessmentResponse",
    "RecordedInterviewEvaluation",
    "TranscriptReadinessResponse",
    "TranscriptResponse",
    "TranscriptSaveRequest",
    "TranscriptSegmentCreate",
    "TranscriptSegmentResponse",
]
