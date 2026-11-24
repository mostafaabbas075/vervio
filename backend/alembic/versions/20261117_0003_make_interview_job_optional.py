"""Allow candidate-led interview sessions without a job.

Revision ID: 20261117_0003
Revises: 20261112_0002
Create Date: 2026-11-17
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "20261117_0003"
down_revision: Union[str, Sequence[str], None] = "20261112_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "interview_sessions",
        "job_id",
        existing_type=sa.Uuid(),
        existing_nullable=False,
        nullable=True,
    )


def downgrade() -> None:
    connection = op.get_bind()
    jobless_sessions = connection.scalar(
        sa.text("SELECT COUNT(*) FROM interview_sessions WHERE job_id IS NULL")
    )
    if jobless_sessions:
        raise RuntimeError("Cannot restore required job_id while jobless interview sessions exist.")

    op.alter_column(
        "interview_sessions",
        "job_id",
        existing_type=sa.Uuid(),
        existing_nullable=True,
        nullable=False,
    )
