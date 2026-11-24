"""Reset the local-development password for the designated Vervio admin."""

from __future__ import annotations

import getpass
import sys

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.security import hash_password, validate_new_password, verify_password
from app.core.config import settings
from app.db.session import get_session_factory
from app.models import User

ADMIN_EMAIL = "admin@example.com"


def prompt_for_new_password() -> str:
    """Prompt twice without echoing password input to the terminal."""
    password = getpass.getpass(f"New password for {ADMIN_EMAIL}: ")
    confirmation = getpass.getpass("Confirm new password: ")
    if password != confirmation:
        raise ValueError("Passwords do not match.")
    validate_new_password(password)
    return password


def reset_admin_password(database_session: Session, password: str) -> None:
    """Replace only the designated active admin's password hash."""
    user = database_session.scalar(
        select(User).where(func.lower(User.email) == ADMIN_EMAIL).with_for_update()
    )
    if user is None:
        raise ValueError(f"The designated admin account ({ADMIN_EMAIL}) was not found.")
    if user.status != "active" or user.role != "admin":
        raise ValueError("The designated account is not an active admin account.")

    user.password_hash = hash_password(password)
    database_session.flush()
    if not user.password_hash or not verify_password(password, user.password_hash):
        raise RuntimeError("The new password hash could not be verified.")
    database_session.commit()


def main() -> int:
    if settings.environment.lower() != "development":
        print(
            "Error: This password reset command is available only in development.",
            file=sys.stderr,
        )
        return 1

    try:
        password = prompt_for_new_password()
        with get_session_factory()() as database_session:
            reset_admin_password(database_session, password)
    except (KeyboardInterrupt, EOFError):
        print("\nPassword reset cancelled.", file=sys.stderr)
        return 1
    except (RuntimeError, ValueError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    print("Admin password reset successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
