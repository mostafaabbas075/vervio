"""Add German assessment foundation columns and status values.

Revision ID: 20261119_0004
Revises: 20261117_0003
Create Date: 2026-11-19
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "20261119_0004"
down_revision: Union[str, Sequence[str], None] = "20261117_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("evaluations", sa.Column("strengths", sa.JSON(), nullable=True))
    op.add_column("evaluations", sa.Column("areas_for_improvement", sa.JSON(), nullable=True))
    op.add_column("evaluations", sa.Column("evidence", sa.JSON(), nullable=True))
    op.add_column(
        "evaluations",
        sa.Column("insufficient_evidence_reason", sa.Text(), nullable=True),
    )
    op.add_column("evaluations", sa.Column("assessment_metadata", sa.JSON(), nullable=True))

    op.drop_constraint("ck_evaluations_status_valid", "evaluations", type_="check")
    op.create_check_constraint(
        "ck_evaluations_status_valid",
        "evaluations",
        "status IN ('pending', 'completed', 'insufficient_evidence', 'failed')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_evaluations_status_valid", "evaluations", type_="check")
    op.create_check_constraint(
        "ck_evaluations_status_valid",
        "evaluations",
        "status IN ('pending', 'completed', 'failed')",
    )

    op.drop_column("evaluations", "assessment_metadata")
    op.drop_column("evaluations", "insufficient_evidence_reason")
    op.drop_column("evaluations", "evidence")
    op.drop_column("evaluations", "areas_for_improvement")
    op.drop_column("evaluations", "strengths")
