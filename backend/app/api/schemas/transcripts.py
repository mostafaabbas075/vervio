"""Pydantic schemas for German interview transcript storage and retrieval."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class TranscriptSegmentCreate(BaseModel):
    position: int | None = Field(default=None, ge=1)
    speaker: Literal["candidate", "interviewer", "system"]
    start_ms: int = Field(default=0, ge=0)
    end_ms: int = Field(default=0, ge=0)
    content: str = Field(min_length=1)
    language: str = Field(default="de", min_length=2, max_length=8)

    @field_validator("speaker", mode="before")
    @classmethod
    def normalize_speaker(cls, value: object) -> object:
        if isinstance(value, str):
            val = value.strip().lower()
            if val in {"ai", "ai_interviewer", "assistant"}:
                return "interviewer"
            if val in {"user", "candidate"}:
                return "candidate"
            if val in {"system"}:
                return "system"
            return val
        return value

    @model_validator(mode="after")
    def validate_content_and_timing(self) -> TranscriptSegmentCreate:
        stripped = self.content.strip()
        if not stripped:
            raise ValueError("Transcript content cannot be empty.")
        self.content = stripped
        if self.end_ms < self.start_ms:
            self.end_ms = self.start_ms
        return self


class TranscriptSaveRequest(BaseModel):
    segments: list[TranscriptSegmentCreate] = Field(default_factory=list)


class TranscriptSegmentResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    interview_session_id: UUID
    position: int
    speaker: str
    start_ms: int
    end_ms: int
    content: str
    language: str
    created_at: datetime


class TranscriptResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    interview_session_id: UUID
    language: str = "de"
    segment_count: int
    segments: list[TranscriptSegmentResponse]
