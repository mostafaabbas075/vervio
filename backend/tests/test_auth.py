from __future__ import annotations

from collections.abc import Generator
from http.cookies import SimpleCookie

import pytest
from fastapi import HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.api.routes.auth import admin_access, login, logout, me
from app.auth.dependencies import (
    get_current_auth_context,
    require_csrf,
    require_roles,
    require_trusted_origin,
)
from app.auth.rate_limit import login_attempt_limiter
from app.auth.schemas import LoginRequest, LoginResponse
from app.auth.security import hash_password
from app.db.session import create_database_engine
from app.main import app
from app.models import AuthSession, Base, Company, User

TRUSTED_ORIGIN = "http://localhost:3000"


@pytest.fixture
def database_session() -> Generator[Session, None, None]:
    """Return an isolated database without starting Starlette's test portal."""
    engine = create_database_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine, expire_on_commit=False)
    login_attempt_limiter.clear()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()
        login_attempt_limiter.clear()


def make_request(
    *,
    origin: str | None = None,
    session_token: str | None = None,
    csrf_token: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if origin:
        headers.append((b"origin", origin.encode()))
    if session_token:
        headers.append((b"cookie", f"vervio_session={session_token}".encode()))
    if csrf_token:
        headers.append((b"x-csrf-token", csrf_token.encode()))

    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/auth",
            "raw_path": b"/auth",
            "query_string": b"",
            "headers": headers,
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
        }
    )


def create_user(
    database_session: Session,
    *,
    email: str,
    password: str,
    role: str = "admin",
    company: Company | None = None,
) -> User:
    user = User(
        email=email,
        full_name="Test User",
        password_hash=hash_password(password),
        role=role,
        company=company,
    )
    database_session.add(user)
    database_session.commit()
    database_session.refresh(user)
    return user


def cookie_value(response: Response) -> str:
    cookies = SimpleCookie()
    cookies.load(response.headers["set-cookie"])
    return cookies["vervio_session"].value


def login_user(
    database_session: Session,
    *,
    email: str,
    password: str,
) -> tuple[LoginResponse, str, Response]:
    response = Response()
    result = login(
        LoginRequest(email=email, password=password),
        make_request(origin=TRUSTED_ORIGIN),
        response,
        database_session=database_session,
    )
    return result, cookie_value(response), response


def test_auth_routes_are_registered() -> None:
    paths = {route.path for route in app.routes}

    assert {"/auth/login", "/auth/me", "/auth/logout", "/auth/admin/access"} <= paths


def test_correct_login_sets_an_httponly_session_cookie(database_session: Session) -> None:
    user = create_user(
        database_session,
        email="admin@example.com",
        password="correct horse battery staple",
    )

    result, session_token, response = login_user(
        database_session,
        email=user.email,
        password="correct horse battery staple",
    )

    assert result.user.email == user.email
    assert result.user.role == "admin"
    assert result.user.company_id is None
    assert result.csrf_token
    assert session_token
    cookie_header = response.headers["set-cookie"].lower()
    assert "httponly" in cookie_header
    assert "samesite=lax" in cookie_header
    assert database_session.scalar(select(AuthSession)) is not None


@pytest.mark.parametrize(
    ("email", "password"),
    [
        ("admin@example.com", "wrong password"),
        ("unknown@example.com", "any password"),
    ],
)
def test_invalid_login_uses_a_generic_error(
    database_session: Session,
    email: str,
    password: str,
) -> None:
    create_user(
        database_session,
        email="admin@example.com",
        password="correct horse battery staple",
    )

    with pytest.raises(HTTPException) as error:
        login(
            LoginRequest(email=email, password=password),
            make_request(origin=TRUSTED_ORIGIN),
            Response(),
            database_session=database_session,
        )

    assert error.value.status_code == 401
    assert error.value.detail == "Invalid email or password."


def test_session_persists_and_logout_revokes_it(database_session: Session) -> None:
    user = create_user(
        database_session,
        email="admin@example.com",
        password="correct horse battery staple",
    )
    login_result, session_token, _ = login_user(
        database_session,
        email=user.email,
        password="correct horse battery staple",
    )
    authenticated_request = make_request(session_token=session_token)
    auth_context = get_current_auth_context(authenticated_request, database_session)

    me_result = me(auth_context, database_session)

    assert me_result.user.id == user.id
    assert me_result.csrf_token

    logout_request = make_request(
        origin=TRUSTED_ORIGIN,
        session_token=session_token,
        csrf_token=me_result.csrf_token,
    )
    require_trusted_origin(logout_request)
    require_csrf(logout_request, auth_context)
    logout_response = logout(Response(), auth_context, database_session=database_session)

    assert logout_response.status_code == 204
    assert "max-age=0" in logout_response.headers["set-cookie"].lower()
    saved_session = database_session.scalar(
        select(AuthSession).where(AuthSession.user_id == user.id)
    )
    assert saved_session is not None
    assert saved_session.revoked_at
    with pytest.raises(HTTPException, match="Authentication required"):
        get_current_auth_context(authenticated_request, database_session)


def test_missing_session_is_unauthorized(database_session: Session) -> None:
    with pytest.raises(HTTPException) as error:
        get_current_auth_context(make_request(), database_session)

    assert error.value.status_code == 401


def test_client_reviewer_is_scoped_to_company_and_denied_admin_access(
    database_session: Session,
) -> None:
    company = Company(name="Client GmbH", slug="client-gmbh", country_code="DE")
    database_session.add(company)
    database_session.commit()
    reviewer = create_user(
        database_session,
        email="reviewer@example.com",
        password="correct horse battery staple",
        role="client_reviewer",
        company=company,
    )

    login_result, session_token, _ = login_user(
        database_session,
        email=reviewer.email,
        password="correct horse battery staple",
    )
    auth_context = get_current_auth_context(
        make_request(session_token=session_token), database_session
    )

    assert login_result.user.company_id == company.id
    assert auth_context.user.company_id == company.id
    with pytest.raises(HTTPException) as error:
        require_roles("admin")(auth_context)

    assert error.value.status_code == 403


def test_admin_role_can_access_admin_route(database_session: Session) -> None:
    user = create_user(
        database_session,
        email="admin@example.com",
        password="correct horse battery staple",
    )
    _, session_token, _ = login_user(
        database_session,
        email=user.email,
        password="correct horse battery staple",
    )
    auth_context = get_current_auth_context(
        make_request(session_token=session_token), database_session
    )

    assert admin_access(require_roles("admin")(auth_context)) == {"status": "ok"}


def test_logout_requires_valid_csrf_token(database_session: Session) -> None:
    user = create_user(
        database_session,
        email="admin@example.com",
        password="correct horse battery staple",
    )
    _, session_token, _ = login_user(
        database_session,
        email=user.email,
        password="correct horse battery staple",
    )
    auth_context = get_current_auth_context(
        make_request(session_token=session_token), database_session
    )

    with pytest.raises(HTTPException) as error:
        require_csrf(
            make_request(origin=TRUSTED_ORIGIN, session_token=session_token),
            auth_context,
        )

    assert error.value.status_code == 403
    saved_session = database_session.scalar(
        select(AuthSession).where(AuthSession.user_id == user.id)
    )
    assert saved_session is not None
    assert saved_session.revoked_at is None


def test_untrusted_origin_is_denied() -> None:
    with pytest.raises(HTTPException) as error:
        require_trusted_origin(make_request(origin="https://untrusted.example"))

    assert error.value.status_code == 403


def test_failed_logins_are_rate_limited(database_session: Session) -> None:
    create_user(
        database_session,
        email="admin@example.com",
        password="correct horse battery staple",
    )

    for _ in range(5):
        with pytest.raises(HTTPException) as error:
            login(
                LoginRequest(email="admin@example.com", password="wrong password"),
                make_request(origin=TRUSTED_ORIGIN),
                Response(),
                database_session=database_session,
            )
        assert error.value.status_code == 401

    with pytest.raises(HTTPException) as error:
        login(
            LoginRequest(email="admin@example.com", password="wrong password"),
            make_request(origin=TRUSTED_ORIGIN),
            Response(),
            database_session=database_session,
        )

    assert error.value.status_code == 429
