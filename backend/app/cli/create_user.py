from __future__ import annotations

import argparse
import getpass
import sys

from sqlalchemy import select

from app.auth.security import hash_password, validate_new_password
from app.db.session import get_session_factory
from app.models import Company, User


def normalize_email(email: str) -> str:
    normalized = email.strip().lower()
    if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
        raise ValueError("A valid email address is required.")
    return normalized


def prompt_for_password() -> str:
    password = getpass.getpass("Password: ")
    confirmation = getpass.getpass("Confirm password: ")
    if password != confirmation:
        raise ValueError("Passwords do not match.")
    validate_new_password(password)
    return password


def create_user(
    *,
    email: str,
    full_name: str,
    role: str,
    company_slug: str | None,
) -> User:
    normalized_email = normalize_email(email)
    password = prompt_for_password()

    with get_session_factory()() as database_session:
        if database_session.scalar(select(User.id).where(User.email == normalized_email)):
            raise ValueError("A user with that email already exists.")

        company = None
        if role == "client_reviewer":
            if not company_slug:
                raise ValueError("A company slug is required for a client reviewer.")
            company = database_session.scalar(select(Company).where(Company.slug == company_slug))
            if company is None:
                raise ValueError("No company exists with that slug.")

        user = User(
            email=normalized_email,
            full_name=full_name.strip(),
            password_hash=hash_password(password),
            role=role,
            company=company,
        )
        database_session.add(user)
        database_session.commit()
        database_session.refresh(user)
        return user


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Create a Vervio user account.")
    subparsers = parser.add_subparsers(dest="role", required=True)

    for role in ("admin", "client_reviewer"):
        command = subparsers.add_parser(role)
        command.add_argument("--email", required=True)
        command.add_argument("--full-name", required=True)
        if role == "client_reviewer":
            command.add_argument("--company-slug", required=True)

    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    try:
        user = create_user(
            email=arguments.email,
            full_name=arguments.full_name,
            role=arguments.role,
            company_slug=getattr(arguments, "company_slug", None),
        )
    except ValueError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1

    print(f"Created {user.role} account for {user.email}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

