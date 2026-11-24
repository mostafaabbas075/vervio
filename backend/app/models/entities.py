"""Initial relational entities for the Vervio MVP.

These models intentionally define storage and ownership only. They do not implement
authentication, interview orchestration, AI evaluation, or object-storage access.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class Company(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "companies"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'inactive')", name="status_valid"),
    )

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    country_code: Mapped[str | None] = mapped_column(String(2))
    status: Mapped[str] = mapped_column(String(32), default="active", server_default="active")

    users: Mapped[list[User]] = relationship(back_populates="company")
    jobs: Mapped[list[Job]] = relationship(back_populates="company", cascade="all, delete-orphan")
    audit_events: Mapped[list[AuditEvent]] = relationship(back_populates="company")


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'inactive')", name="status_valid"),
        CheckConstraint(
            "role IS NULL OR "
            "(role = 'admin' AND company_id IS NULL) OR "
            "(role = 'client_reviewer' AND company_id IS NOT NULL)",
            name="role_company_valid",
        ),
        Index("ix_users_company_status", "company_id", "status"),
        Index("ix_users_role", "role"),
    )

    company_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="SET NULL"), index=True
    )
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True, nullable=False)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    role: Mapped[str | None] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32), default="active", server_default="active")

    company: Mapped[Company | None] = relationship(back_populates="users")
    audit_events: Mapped[list[AuditEvent]] = relationship(back_populates="user")
    auth_sessions: Mapped[list[AuthSession]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class AuthSession(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "auth_sessions"
    __table_args__ = (
        Index("ix_auth_sessions_user_expires", "user_id", "expires_at"),
    )

    user_id: Mapped[UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    csrf_token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="auth_sessions")


class Job(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('draft', 'open', 'closed', 'archived')", name="status_valid"
        ),
        UniqueConstraint("company_id", "reference_code", name="company_reference"),
        Index("ix_jobs_company_status", "company_id", "status"),
    )

    company_id: Mapped[UUID] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    reference_code: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(Text)
    required_german_level: Mapped[str | None] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(32), default="draft", server_default="draft")
    opens_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closes_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    company: Mapped[Company] = relationship(back_populates="jobs")
    interview_sessions: Mapped[list[InterviewSession]] = relationship(back_populates="job")


class Candidate(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "candidates"
    __table_args__ = (
        CheckConstraint("status IN ('active', 'withdrawn', 'placed')", name="status_valid"),
    )

    email: Mapped[str] = mapped_column(String(320), index=True, nullable=False)
    given_name: Mapped[str] = mapped_column(String(120), nullable=False)
    family_name: Mapped[str] = mapped_column(String(120), nullable=False)
    # This is a self-reported value. It must never cap an evaluation's assessed level.
    claimed_german_level: Mapped[str | None] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(32), default="active", server_default="active")

    interview_sessions: Mapped[list[InterviewSession]] = relationship(
        back_populates="candidate", cascade="all, delete-orphan"
    )

    @property
    def full_name(self) -> str:
        return f"{self.given_name} {self.family_name}".strip()


class InterviewSession(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "interview_sessions"
    __table_args__ = (
        CheckConstraint(
            "status IN ('scheduled', 'in_progress', 'completed', 'cancelled', 'failed')",
            name="status_valid",
        ),
        CheckConstraint(
            "required_german_level IS NULL OR "
            "required_german_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')",
            name="required_german_level_valid",
        ),
        Index("ix_interview_sessions_candidate_status", "candidate_id", "status"),
        Index("ix_interview_sessions_job_status", "job_id", "status"),
    )

    candidate_id: Mapped[UUID] = mapped_column(
        ForeignKey("candidates.id", ondelete="CASCADE"), nullable=False
    )
    # Legacy job linkage remains for historical compatibility, but interviews are candidate-led.
    # New sessions must not require a job record or job description.
    job_id: Mapped[UUID | None] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(
        String(32), default="scheduled", server_default="scheduled"
    )
    language: Mapped[str] = mapped_column(String(8), default="de", server_default="de")
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Admin-configured German requirement for this session (independent of candidate claim
    # and AI evaluation outcome).
    required_german_level: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Indicates whether stable transcript persistence/flushing has completed.
    is_transcript_finalized: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )

    candidate: Mapped[Candidate] = relationship(back_populates="interview_sessions")
    job: Mapped[Job | None] = relationship(back_populates="interview_sessions")
    questions: Mapped[list[InterviewQuestion]] = relationship(
        back_populates="interview_session",
        cascade="all, delete-orphan",
        order_by="InterviewQuestion.position",
    )
    recording: Mapped[Recording | None] = relationship(
        back_populates="interview_session", cascade="all, delete-orphan", uselist=False
    )
    transcript_segments: Mapped[list[TranscriptSegment]] = relationship(
        back_populates="interview_session",
        cascade="all, delete-orphan",
        order_by="TranscriptSegment.position",
    )
    evaluation: Mapped[Evaluation | None] = relationship(
        back_populates="interview_session", cascade="all, delete-orphan", uselist=False
    )

    @property
    def has_recording(self) -> bool:
        return self.recording is not None


class InterviewQuestion(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "interview_questions"
    __table_args__ = (
        CheckConstraint("position >= 1", name="position_positive"),
        UniqueConstraint("interview_session_id", "position", name="session_position"),
    )

    interview_session_id: Mapped[UUID] = mapped_column(
        ForeignKey("interview_sessions.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str | None] = mapped_column(String(80))
    is_required: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    interview_session: Mapped[InterviewSession] = relationship(back_populates="questions")


class Recording(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "recordings"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'available', 'failed', 'deleted')", name="status_valid"
        ),
        CheckConstraint("byte_size IS NULL OR byte_size >= 0", name="byte_size_nonnegative"),
        CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds >= 0", name="duration_nonnegative"
        ),
    )

    interview_session_id: Mapped[UUID] = mapped_column(
        ForeignKey("interview_sessions.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    storage_provider: Mapped[str] = mapped_column(String(64), nullable=False)
    # Private object key only. Video bytes are never stored in PostgreSQL.
    object_key: Mapped[str] = mapped_column(String(1024), unique=True, nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(128))
    byte_size: Mapped[int | None] = mapped_column()
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    checksum: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32), default="pending", server_default="pending")

    interview_session: Mapped[InterviewSession] = relationship(back_populates="recording")


class TranscriptSegment(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "transcript_segments"
    __table_args__ = (
        CheckConstraint("position >= 1", name="position_positive"),
        CheckConstraint("start_ms >= 0", name="start_nonnegative"),
        CheckConstraint("end_ms >= start_ms", name="end_after_start"),
        CheckConstraint("speaker IN ('candidate', 'interviewer', 'system')", name="speaker_valid"),
        UniqueConstraint("interview_session_id", "position", name="session_position"),
    )

    interview_session_id: Mapped[UUID] = mapped_column(
        ForeignKey("interview_sessions.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    speaker: Mapped[str] = mapped_column(String(32), nullable=False)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    language: Mapped[str] = mapped_column(String(8), default="de", server_default="de")

    interview_session: Mapped[InterviewSession] = relationship(back_populates="transcript_segments")


class Evaluation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "evaluations"
    __table_args__ = (
        CheckConstraint(
            "status IN ('pending', 'completed', 'insufficient_evidence', 'failed')",
            name="status_valid",
        ),
        CheckConstraint(
            "overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100)",
            name="overall_score_range",
        ),
    )

    interview_session_id: Mapped[UUID] = mapped_column(
        ForeignKey("interview_sessions.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    status: Mapped[str] = mapped_column(String(32), default="pending", server_default="pending")
    # Independent outcome of the assessment; never derive or cap it from a candidate claim.
    assessed_german_level: Mapped[str | None] = mapped_column(String(16))
    overall_score: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    summary: Mapped[str | None] = mapped_column(Text)
    evaluated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    strengths: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    areas_for_improvement: Mapped[list[str] | None] = mapped_column(JSON, nullable=True)
    evidence: Mapped[list[dict[str, object]] | None] = mapped_column(JSON, nullable=True)
    insufficient_evidence_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    assessment_metadata: Mapped[dict[str, object] | None] = mapped_column(JSON, nullable=True)

    interview_session: Mapped[InterviewSession] = relationship(back_populates="evaluation")
    criterion_scores: Mapped[list[CriterionScore]] = relationship(
        back_populates="evaluation", cascade="all, delete-orphan"
    )


class CriterionScore(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "criterion_scores"
    __table_args__ = (
        CheckConstraint("score >= 0 AND score <= 100", name="score_range"),
        UniqueConstraint("evaluation_id", "criterion_code", name="evaluation_criterion"),
    )

    evaluation_id: Mapped[UUID] = mapped_column(
        ForeignKey("evaluations.id", ondelete="CASCADE"), nullable=False
    )
    criterion_code: Mapped[str] = mapped_column(String(80), nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    score: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    rationale: Mapped[str | None] = mapped_column(Text)

    evaluation: Mapped[Evaluation] = relationship(back_populates="criterion_scores")


class AuditEvent(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "audit_events"
    __table_args__ = (
        CheckConstraint("status IN ('success', 'failure')", name="status_valid"),
        Index("ix_audit_events_company_created", "company_id", "created_at"),
        Index("ix_audit_events_user_created", "user_id", "created_at"),
    )

    company_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="SET NULL"), index=True
    )
    user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    action: Mapped[str] = mapped_column(String(120), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(80), nullable=False)
    entity_id: Mapped[UUID | None] = mapped_column()
    status: Mapped[str] = mapped_column(String(32), default="success", server_default="success")
    context: Mapped[dict[str, object] | None] = mapped_column(JSON)

    company: Mapped[Company | None] = relationship(back_populates="audit_events")
    user: Mapped[User | None] = relationship(back_populates="audit_events")
