from collections.abc import Generator
from functools import lru_cache

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import get_settings


class DatabaseConfigurationError(RuntimeError):
    """Raised when database access is requested without a configured URL."""


def create_database_engine(database_url: str | None) -> Engine:
    """Create an engine without opening a database connection."""
    if not database_url:
        raise DatabaseConfigurationError(
            "DATABASE_URL must be configured before using database-backed features."
        )

    url = make_url(database_url)
    engine_options: dict[str, object] = {"pool_pre_ping": True}

    if url.get_backend_name() == "sqlite":
        engine_options["connect_args"] = {"check_same_thread": False}
        if url.database in {None, ":memory:"}:
            engine_options["poolclass"] = StaticPool

    engine = create_engine(url, **engine_options)

    if url.get_backend_name() == "sqlite":

        @event.listens_for(engine, "connect")
        def enable_sqlite_foreign_keys(dbapi_connection: object, _: object) -> None:
            cursor = dbapi_connection.cursor()  # type: ignore[union-attr]
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


@lru_cache
def get_engine() -> Engine:
    """Return the application engine only when database access is required."""
    return create_database_engine(get_settings().database_url)


@lru_cache
def get_session_factory() -> sessionmaker[Session]:
    return sessionmaker(
        bind=get_engine(),
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )


def get_db_session() -> Generator[Session, None, None]:
    """Yield one SQLAlchemy session per FastAPI request."""
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()
