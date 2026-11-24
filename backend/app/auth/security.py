from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timezone

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

password_hasher = PasswordHasher(type=Type.ID)
_dummy_password_hash = password_hasher.hash(secrets.token_urlsafe(32))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def hash_password(password: str) -> str:
    return password_hasher.hash(password)


def validate_new_password(password: str) -> None:
    if not 12 <= len(password) <= 128:
        raise ValueError("Password must be between 12 and 128 characters long.")


def verify_password(password: str, password_hash: str | None) -> bool:
    hash_to_verify = password_hash or _dummy_password_hash
    try:
        return password_hasher.verify(hash_to_verify, password)
    except (InvalidHashError, VerificationError, VerifyMismatchError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return password_hasher.check_needs_rehash(password_hash)


def create_opaque_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def tokens_match(token: str, expected_hash: str) -> bool:
    return hmac.compare_digest(token_hash(token), expected_hash)

