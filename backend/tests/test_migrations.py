import os
from pathlib import Path

import pytest

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not TEST_DATABASE_URL,
    reason="TEST_DATABASE_URL is required to test migrations against a database.",
)


def test_initial_migration_applies_to_test_database() -> None:
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect

    from alembic import command

    backend_directory = Path(__file__).resolve().parents[1]
    config = Config(str(backend_directory / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", TEST_DATABASE_URL or "")

    command.upgrade(config, "head")

    engine = create_engine(TEST_DATABASE_URL)
    try:
        table_names = set(inspect(engine).get_table_names())
    finally:
        engine.dispose()

    assert {
        "auth_sessions",
        "companies",
        "candidates",
        "interview_sessions",
        "evaluations",
    } <= table_names

