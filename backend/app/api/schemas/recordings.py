from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class CandidateRecordingSummary(BaseModel):
    """Summary of a candidate's virtual folder of saved recordings."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    candidate_id: UUID
    full_name: str
    email: str
    recording_count: int


class RecordedInterviewEvaluation(BaseModel):
    """Evaluation outcomes attached to an interview recording."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    status: str
    overall_score: float | None = None
    assessed_german_level: str | None = None
    summary: str | None = None
    evaluated_at: datetime | None = None


class CandidateRecordedInterview(BaseModel):
    """One finalized recorded interview session in a candidate's virtual folder."""

    model_config = ConfigDict(from_attributes=True)

    interview_id: UUID
    recording_id: UUID
    candidate_id: UUID
    date: datetime
    storage_status: str
    storage_provider: str | None = None
    duration_seconds: int | None = None
    byte_size: int | None = None
    content_type: str | None = None
    interview_status: str
    evaluation_status: str = "pending"
    score: float | None = None
    evaluation: RecordedInterviewEvaluation | None = None
