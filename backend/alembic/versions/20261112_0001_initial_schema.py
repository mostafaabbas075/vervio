"""Create the initial Vervio relational schema.

Revision ID: 20261112_0001
Revises:
Create Date: 2026-11-12
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "20261112_0001"
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def timestamp_columns() -> list[sa.Column[object]]:
    return [
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    ]


def upgrade() -> None:
    op.create_table(
        "companies",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("slug", sa.String(length=120), nullable=False),
        sa.Column("country_code", sa.String(length=2), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="active", nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("status IN ('active', 'inactive')", name="ck_companies_status_valid"),
        sa.PrimaryKeyConstraint("id", name="pk_companies"),
    )
    op.create_index("ix_companies_slug", "companies", ["slug"], unique=True)

    op.create_table(
        "candidates",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("given_name", sa.String(length=120), nullable=False),
        sa.Column("family_name", sa.String(length=120), nullable=False),
        sa.Column("claimed_german_level", sa.String(length=16), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="active", nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint(
            "status IN ('active', 'withdrawn', 'placed')",
            name="ck_candidates_status_valid",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_candidates"),
    )
    op.create_index("ix_candidates_email", "candidates", ["email"], unique=False)

    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("full_name", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="active", nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("status IN ('active', 'inactive')", name="ck_users_status_valid"),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name="fk_users_company_id_companies",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
    )
    op.create_index("ix_users_company_id", "users", ["company_id"], unique=False)
    op.create_index("ix_users_company_status", "users", ["company_id", "status"], unique=False)
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("reference_code", sa.String(length=64), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("required_german_level", sa.String(length=16), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="draft", nullable=False),
        sa.Column("opens_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closes_at", sa.DateTime(timezone=True), nullable=True),
        *timestamp_columns(),
        sa.CheckConstraint(
            "status IN ('draft', 'open', 'closed', 'archived')",
            name="ck_jobs_status_valid",
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name="fk_jobs_company_id_companies",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_jobs"),
        sa.UniqueConstraint("company_id", "reference_code", name="uq_jobs_company_reference"),
    )
    op.create_index("ix_jobs_company_status", "jobs", ["company_id", "status"], unique=False)

    op.create_table(
        "interview_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("candidate_id", sa.Uuid(), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="scheduled", nullable=False),
        sa.Column("language", sa.String(length=8), server_default="de", nullable=False),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        *timestamp_columns(),
        sa.CheckConstraint(
            "status IN ('scheduled', 'in_progress', 'completed', 'cancelled', 'failed')",
            name="ck_interview_sessions_status_valid",
        ),
        sa.ForeignKeyConstraint(
            ["candidate_id"],
            ["candidates.id"],
            name="fk_interview_sessions_candidate_id_candidates",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["jobs.id"],
            name="fk_interview_sessions_job_id_jobs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_interview_sessions"),
    )
    op.create_index(
        "ix_interview_sessions_candidate_status",
        "interview_sessions",
        ["candidate_id", "status"],
        unique=False,
    )
    op.create_index(
        "ix_interview_sessions_job_status",
        "interview_sessions",
        ["job_id", "status"],
        unique=False,
    )

    op.create_table(
        "interview_questions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("interview_session_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("question_text", sa.Text(), nullable=False),
        sa.Column("category", sa.String(length=80), nullable=True),
        sa.Column("is_required", sa.Boolean(), server_default="true", nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint("position >= 1", name="ck_interview_questions_position_positive"),
        sa.ForeignKeyConstraint(
            ["interview_session_id"],
            ["interview_sessions.id"],
            name="fk_interview_questions_interview_session_id_interview_sessions",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_interview_questions"),
        sa.UniqueConstraint(
            "interview_session_id",
            "position",
            name="uq_interview_questions_session_position",
        ),
    )

    op.create_table(
        "recordings",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("interview_session_id", sa.Uuid(), nullable=False),
        sa.Column("storage_provider", sa.String(length=64), nullable=False),
        sa.Column("object_key", sa.String(length=1024), nullable=False),
        sa.Column("content_type", sa.String(length=128), nullable=True),
        sa.Column("byte_size", sa.Integer(), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=True),
        sa.Column("checksum", sa.String(length=128), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint(
            "byte_size IS NULL OR byte_size >= 0",
            name="ck_recordings_byte_size_nonnegative",
        ),
        sa.CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds >= 0",
            name="ck_recordings_duration_nonnegative",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'available', 'failed', 'deleted')",
            name="ck_recordings_status_valid",
        ),
        sa.ForeignKeyConstraint(
            ["interview_session_id"],
            ["interview_sessions.id"],
            name="fk_recordings_interview_session_id_interview_sessions",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_recordings"),
        sa.UniqueConstraint("interview_session_id", name="uq_recordings_interview_session_id"),
        sa.UniqueConstraint("object_key", name="uq_recordings_object_key"),
    )

    op.create_table(
        "transcript_segments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("interview_session_id", sa.Uuid(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("speaker", sa.String(length=32), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("language", sa.String(length=8), server_default="de", nullable=False),
        *timestamp_columns(),
        sa.CheckConstraint(
            "end_ms >= start_ms",
            name="ck_transcript_segments_end_after_start",
        ),
        sa.CheckConstraint(
            "position >= 1",
            name="ck_transcript_segments_position_positive",
        ),
        sa.CheckConstraint(
            "speaker IN ('candidate', 'interviewer', 'system')",
            name="ck_transcript_segments_speaker_valid",
        ),
        sa.CheckConstraint(
            "start_ms >= 0",
            name="ck_transcript_segments_start_nonnegative",
        ),
        sa.ForeignKeyConstraint(
            ["interview_session_id"],
            ["interview_sessions.id"],
            name="fk_transcript_segments_interview_session_id_interview_sessions",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_transcript_segments"),
        sa.UniqueConstraint(
            "interview_session_id",
            "position",
            name="uq_transcript_segments_session_position",
        ),
    )

    op.create_table(
        "evaluations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("interview_session_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=32), server_default="pending", nullable=False),
        sa.Column("assessed_german_level", sa.String(length=16), nullable=True),
        sa.Column("overall_score", sa.Numeric(precision=5, scale=2), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("evaluated_at", sa.DateTime(timezone=True), nullable=True),
        *timestamp_columns(),
        sa.CheckConstraint(
            "overall_score IS NULL OR (overall_score >= 0 AND overall_score <= 100)",
            name="ck_evaluations_overall_score_range",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'completed', 'failed')",
            name="ck_evaluations_status_valid",
        ),
        sa.ForeignKeyConstraint(
            ["interview_session_id"],
            ["interview_sessions.id"],
            name="fk_evaluations_interview_session_id_interview_sessions",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_evaluations"),
        sa.UniqueConstraint("interview_session_id", name="uq_evaluations_interview_session_id"),
    )

    op.create_table(
        "criterion_scores",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("evaluation_id", sa.Uuid(), nullable=False),
        sa.Column("criterion_code", sa.String(length=80), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("score", sa.Numeric(precision=5, scale=2), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=True),
        *timestamp_columns(),
        sa.CheckConstraint("score >= 0 AND score <= 100", name="ck_criterion_scores_score_range"),
        sa.ForeignKeyConstraint(
            ["evaluation_id"],
            ["evaluations.id"],
            name="fk_criterion_scores_evaluation_id_evaluations",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_criterion_scores"),
        sa.UniqueConstraint(
            "evaluation_id",
            "criterion_code",
            name="uq_criterion_scores_evaluation_criterion",
        ),
    )

    op.create_table(
        "audit_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("action", sa.String(length=120), nullable=False),
        sa.Column("entity_type", sa.String(length=80), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=32), server_default="success", nullable=False),
        sa.Column("context", sa.JSON(), nullable=True),
        *timestamp_columns(),
        sa.CheckConstraint(
            "status IN ('success', 'failure')",
            name="ck_audit_events_status_valid",
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name="fk_audit_events_company_id_companies",
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_audit_events_user_id_users",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_audit_events"),
    )
    op.create_index("ix_audit_events_company_id", "audit_events", ["company_id"], unique=False)
    op.create_index(
        "ix_audit_events_company_created",
        "audit_events",
        ["company_id", "created_at"],
        unique=False,
    )
    op.create_index("ix_audit_events_user_id", "audit_events", ["user_id"], unique=False)
    op.create_index(
        "ix_audit_events_user_created",
        "audit_events",
        ["user_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_audit_events_user_created", table_name="audit_events")
    op.drop_index("ix_audit_events_user_id", table_name="audit_events")
    op.drop_index("ix_audit_events_company_created", table_name="audit_events")
    op.drop_index("ix_audit_events_company_id", table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_table("criterion_scores")
    op.drop_table("evaluations")
    op.drop_table("transcript_segments")
    op.drop_table("recordings")
    op.drop_table("interview_questions")
    op.drop_index("ix_interview_sessions_job_status", table_name="interview_sessions")
    op.drop_index("ix_interview_sessions_candidate_status", table_name="interview_sessions")
    op.drop_table("interview_sessions")
    op.drop_index("ix_jobs_company_status", table_name="jobs")
    op.drop_table("jobs")
    op.drop_index("ix_users_email", table_name="users")
    op.drop_index("ix_users_company_status", table_name="users")
    op.drop_index("ix_users_company_id", table_name="users")
    op.drop_table("users")
    op.drop_index("ix_candidates_email", table_name="candidates")
    op.drop_table("candidates")
    op.drop_index("ix_companies_slug", table_name="companies")
    op.drop_table("companies")

