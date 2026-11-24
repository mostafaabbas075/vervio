from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class CandidateCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    given_name: str = Field(min_length=1, max_length=120)
    family_name: str = Field(min_length=1, max_length=120)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        normalized = value.strip().lower()
        if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
            raise ValueError("Enter a valid email address.")
        return normalized

    @field_validator("given_name", "family_name")
    @classmethod
    def require_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("This field is required.")
        return normalized


class CandidateResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    given_name: str
    family_name: str
    status: str
    created_at: datetime


class InterviewSessionCreate(BaseModel):
    candidate_id: UUID
    required_german_level: str | None = None


class InterviewSessionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    candidate: CandidateResponse
    status: str
    required_german_level: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    completed_at: datetime | None = None
    has_recording: bool = False


class RecordingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    content_type: str
    byte_size: int
    duration_seconds: int | None
    status: str
    created_at: datetime
