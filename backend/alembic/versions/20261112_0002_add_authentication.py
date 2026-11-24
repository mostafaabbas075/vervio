"""Add user credentials, roles, and server-side sessions.

Revision ID: 20261112_0002
Revises: 20261112_0001
Create Date: 2026-11-12
"""

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "20261112_0002"
down_revision: Union[str, Sequence[str], None] = "20261112_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable columns intentionally keep pre-authentication user records disabled
    # until an operator assigns a password hash and supported role through the CLI.
    op.add_column("users", sa.Column("password_hash", sa.String(length=255), nullable=True))
    op.add_column("users", sa.Column("role", sa.String(length=32), nullable=True))
    op.create_check_constraint(
        "ck_users_role_company_valid",
        "users",
        "role IS NULL OR "
        "(role = 'admin' AND company_id IS NULL) OR "
        "(role = 'client_reviewer' AND company_id IS NOT NULL)",
    )
    op.create_index("ix_users_role", "users", ["role"], unique=False)

    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("csrf_token_hash", sa.String(length=64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
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
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_auth_sessions_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_auth_sessions"),
        sa.UniqueConstraint("token_hash", name="uq_auth_sessions_token_hash"),
    )
    op.create_index("ix_auth_sessions_user_expires", "auth_sessions", ["user_id", "expires_at"])


def downgrade() -> None:
    op.drop_index("ix_auth_sessions_user_expires", table_name="auth_sessions")
    op.drop_table("auth_sessions")
    op.drop_index("ix_users_role", table_name="users")
    op.drop_constraint("ck_users_role_company_valid", "users", type_="check")
    op.drop_column("users", "role")
    op.drop_column("users", "password_hash")

