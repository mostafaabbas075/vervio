from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.dependencies import (
    AuthContext,
    get_current_auth_context,
    require_csrf,
    require_roles,
    require_trusted_origin,
)
from app.auth.rate_limit import login_attempt_limiter
from app.auth.schemas import AuthenticatedUser, LoginRequest, LoginResponse, MeResponse
from app.auth.security import (
    create_opaque_token,
    hash_password,
    password_needs_rehash,
    token_hash,
    utc_now,
    verify_password,
)
from app.core.config import settings
from app.db.session import get_db_session
from app.models import AuthSession, User

router = APIRouter(prefix="/auth", tags=["authentication"])


def invalid_credentials() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid email or password.",
    )


def login_attempt_key(request: Request, email: str) -> str:
    client_host = request.client.host if request.client else "unknown"
    return f"{client_host}:{email}"


def user_response(user: User) -> AuthenticatedUser:
    if user.role not in {"admin", "client_reviewer"}:
        raise RuntimeError("Authenticated users must have a supported role.")

    return AuthenticatedUser(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        company_id=user.company_id,
    )


def new_csrf_token(auth_session: AuthSession) -> str:
    csrf_token = create_opaque_token()
    auth_session.csrf_token_hash = token_hash(csrf_token)
    return csrf_token


def set_session_cookie(response: Response, session_token: str) -> None:
    response.set_cookie(
        key=settings.auth_session_cookie_name,
        value=session_token,
        max_age=settings.auth_session_ttl_hours * 60 * 60,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite=settings.auth_cookie_samesite,
        domain=settings.session_cookie_domain,
        path="/",
    )


@router.post("/login", response_model=LoginResponse)
def login(
    credentials: LoginRequest,
    request: Request,
    response: Response,
    _: None = Depends(require_trusted_origin),
    database_session: Session = Depends(get_db_session),
) -> LoginResponse:
    attempt_key = login_attempt_key(request, credentials.email)
    if login_attempt_limiter.is_blocked(attempt_key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts. Please try again later.",
        )

    user = database_session.scalar(
        select(User).where(func.lower(User.email) == credentials.email)
    )
    password_is_valid = verify_password(credentials.password, user.password_hash if user else None)
    can_authenticate = (
        user is not None
        and user.status == "active"
        and user.role in {"admin", "client_reviewer"}
        and password_is_valid
    )
    if not can_authenticate:
        login_attempt_limiter.record_failure(attempt_key)
        raise invalid_credentials()

    if user.password_hash and password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(credentials.password)

    session_token = create_opaque_token()
    csrf_token = create_opaque_token()
    now = utc_now()
    auth_session = AuthSession(
        user=user,
        token_hash=token_hash(session_token),
        csrf_token_hash=token_hash(csrf_token),
        expires_at=now + timedelta(hours=settings.auth_session_ttl_hours),
        last_seen_at=now,
    )
    database_session.add(auth_session)
    database_session.commit()
    login_attempt_limiter.reset(attempt_key)
    set_session_cookie(response, session_token)

    return LoginResponse(user=user_response(user), csrf_token=csrf_token)


@router.get("/me", response_model=MeResponse)
def me(
    auth_context: AuthContext = Depends(get_current_auth_context),
    database_session: Session = Depends(get_db_session),
) -> MeResponse:
    csrf_token = new_csrf_token(auth_context.session)
    auth_context.session.last_seen_at = utc_now()
    database_session.commit()

    return MeResponse(user=user_response(auth_context.user), csrf_token=csrf_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def logout(
    response: Response,
    auth_context: AuthContext = Depends(get_current_auth_context),
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    database_session: Session = Depends(get_db_session),
) -> Response:
    auth_context.session.revoked_at = utc_now()
    database_session.commit()
    response.delete_cookie(
        key=settings.auth_session_cookie_name,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite=settings.auth_cookie_samesite,
        domain=settings.session_cookie_domain,
        path="/",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/admin/access")
def admin_access(
    _: AuthContext = Depends(require_roles("admin")),
) -> dict[str, str]:
    """Minimal protected route used to enforce the future administration boundary."""
    return {"status": "ok"}

