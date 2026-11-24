import pytest

from app.core.config import Settings
from app.db.session import DatabaseConfigurationError, create_database_engine


def test_database_url_can_be_set_from_settings() -> None:
    settings = Settings(_env_file=None, database_url="sqlite+pysqlite:///:memory:")

    assert settings.database_url == "sqlite+pysqlite:///:memory:"


def test_cross_site_cookie_setting_requires_secure_transport() -> None:
    settings = Settings(
        _env_file=None,
        environment="production",
        auth_cookie_secure=True,
        auth_cookie_samesite="none",
        auth_cookie_domain=".example.com",
    )

    assert settings.auth_cookie_samesite == "none"
    assert settings.session_cookie_domain == ".example.com"

    with pytest.raises(ValueError, match="AUTH_COOKIE_SAMESITE=none"):
        Settings(
            _env_file=None,
            environment="development",
            auth_cookie_secure=False,
            auth_cookie_samesite="none",
        )


def test_engine_requires_a_database_url() -> None:
    with pytest.raises(DatabaseConfigurationError, match="DATABASE_URL"):
        create_database_engine(None)


def test_sqlite_engine_can_be_created_for_isolated_tests() -> None:
    engine = create_database_engine("sqlite+pysqlite:///:memory:")

    assert engine.url.drivername == "sqlite+pysqlite"
    engine.dispose()

