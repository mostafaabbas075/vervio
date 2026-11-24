from __future__ import annotations

from collections.abc import Generator

import pytest
from sqlalchemy.orm import Session

from app.auth.security import hash_password, verify_password
from app.cli.reset_admin_password import reset_admin_password
from app.db.session import create_database_engine
from app.models import Base, User


@pytest.fixture
def database_session() -> Generator[Session, None, None]:
    engine = create_database_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine, expire_on_commit=False)
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_reset_admin_password_updates_only_the_designated_active_admin(
    database_session: Session,
) -> None:
    admin = User(
        email="admin@example.com",
        full_name="Vervio Admin",
        password_hash=hash_password("previous password value"),
        role="admin",
    )
    other_user = User(
        email="other@example.com",
        full_name="Other User",
        password_hash=hash_password("other password value"),
        role="admin",
    )
    database_session.add_all([admin, other_user])
    database_session.commit()
    original_other_hash = other_user.password_hash

    reset_admin_password(database_session, "new development password")

    database_session.refresh(admin)
    database_session.refresh(other_user)
    assert verify_password("new development password", admin.password_hash)
    assert not verify_password("previous password value", admin.password_hash)
    assert other_user.password_hash == original_other_hash


def test_reset_admin_password_rejects_a_non_admin_target(database_session: Session) -> None:
    database_session.add(
        User(
            email="admin@example.com",
            full_name="Not An Admin",
            password_hash=hash_password("previous password value"),
            role=None,
        )
    )
    database_session.commit()

    with pytest.raises(ValueError, match="not an active admin"):
        reset_admin_password(database_session, "new development password")
