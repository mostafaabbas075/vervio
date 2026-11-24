from __future__ import annotations

import hmac
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from fastapi import Depends, HTTPException, Request, WebSocket, WebSocketException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth.schemas import UserRole
from app.auth.security import token_hash
from app.core.config import settings
from app.db.session import get_db_session
from app.models import AuthSession, User

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AuthContext:
    user: User
    session: AuthSession


def authentication_required() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication required.",
    )


def access_denied() -> HTTPException:
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied.")


def is_expired(expires_at: datetime) -> bool:
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= datetime.now(timezone.utc)


def get_current_auth_context(
    request: Request,
    database_session: Session = Depends(get_db_session),
) -> AuthContext:
    session_token = request.cookies.get(settings.auth_session_cookie_name)
    if not session_token:
        raise authentication_required()

    auth_session = database_session.scalar(
        select(AuthSession).where(AuthSession.token_hash == token_hash(session_token))
    )
    if (
        auth_session is None
        or auth_session.revoked_at is not None
        or is_expired(auth_session.expires_at)
        or auth_session.user.status != "active"
        or auth_session.user.role is None
    ):
        raise authentication_required()

    return AuthContext(user=auth_session.user, session=auth_session)


def require_trusted_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    trusted_origins = {value.rstrip("/") for value in settings.cors_origin_list}

    if origin and origin.rstrip("/") not in trusted_origins:
        raise access_denied()


def require_csrf(
    request: Request,
    auth_context: AuthContext = Depends(get_current_auth_context),
) -> None:
    csrf_token = request.headers.get("X-CSRF-Token")
    if not csrf_token or not hmac.compare_digest(
        token_hash(csrf_token), auth_context.session.csrf_token_hash
    ):
        raise access_denied()


def require_roles(*roles: UserRole) -> Callable[[AuthContext], AuthContext]:
    def dependency(
        auth_context: AuthContext = Depends(get_current_auth_context),
    ) -> AuthContext:
        if auth_context.user.role not in roles:
            raise access_denied()
        return auth_context

    return dependency


def get_websocket_auth_context(
    websocket: WebSocket,
    database_session: Session = Depends(get_db_session),
) -> AuthContext:
    session_token = websocket.cookies.get(settings.auth_session_cookie_name)
    if not session_token:
        logger.warning("websocket_auth_rejected category=missing_session_cookie close_code=1008")
        raise WebSocketException(
            code=status.WS_1008_POLICY_VIOLATION,
            reason="Authentication required.",
        )

    auth_session = database_session.scalar(
        select(AuthSession).where(AuthSession.token_hash == token_hash(session_token))
    )
    if (
        auth_session is None
        or auth_session.revoked_at is not None
        or is_expired(auth_session.expires_at)
        or auth_session.user.status != "active"
        or auth_session.user.role is None
    ):
        logger.warning(
            "websocket_auth_rejected category=invalid_or_expired_session close_code=1008"
        )
        raise WebSocketException(
            code=status.WS_1008_POLICY_VIOLATION,
            reason="Authentication required.",
        )

    return AuthContext(user=auth_session.user, session=auth_session)


def require_websocket_origin(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    trusted_origins = {value.rstrip("/") for value in settings.cors_origin_list}

    if origin and origin.rstrip("/") not in trusted_origins:
        logger.warning("websocket_origin_rejected category=untrusted_origin close_code=1008")
        raise WebSocketException(
            code=status.WS_1008_POLICY_VIOLATION,
            reason="Untrusted origin.",
        )


def require_websocket_roles(*roles: UserRole) -> Callable[[AuthContext], AuthContext]:
    def dependency(
        auth_context: AuthContext = Depends(get_websocket_auth_context),
    ) -> AuthContext:
        if auth_context.user.role not in roles:
            logger.warning(
                "websocket_authorization_rejected category=role_not_permitted close_code=1008"
            )
            raise WebSocketException(
                code=status.WS_1008_POLICY_VIOLATION,
                reason="Access denied.",
            )
        return auth_context

    return dependency

