"""Add is_transcript_finalized column to interview_sessions.

Revision ID: 20261119_0006
Revises: 20261119_0005
Create Date: 2026-11-19
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "20261119_0006"
down_revision: Union[str, Sequence[str], None] = "20261119_0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "interview_sessions",
        sa.Column(
            "is_transcript_finalized",
            sa.Boolean(),
            server_default=sa.false(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("interview_sessions", "is_transcript_finalized")
