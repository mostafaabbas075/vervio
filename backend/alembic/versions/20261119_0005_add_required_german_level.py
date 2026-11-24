"""Add required_german_level column and constraint to interview_sessions.

Revision ID: 20261119_0005
Revises: 20261119_0004
Create Date: 2026-11-19
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "20261119_0005"
down_revision: Union[str, Sequence[str], None] = "20261119_0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "interview_sessions",
        sa.Column("required_german_level", sa.String(length=16), nullable=True),
    )
    op.create_check_constraint(
        "ck_interview_sessions_required_german_level_valid",
        "interview_sessions",
        "required_german_level IS NULL OR "
        "required_german_level IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_interview_sessions_required_german_level_valid",
        "interview_sessions",
        type_="check",
    )
    op.drop_column("interview_sessions", "required_german_level")
