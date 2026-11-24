from __future__ import annotations

from collections.abc import Generator
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.api.routes.candidates import create_candidate, list_candidates
from app.api.routes.interviews import (
    create_interview_session,
    get_interview_session,
    list_interview_sessions,
)
from app.api.schemas.interviews import CandidateCreate, InterviewSessionCreate
from app.db.session import create_database_engine
from app.models import Base


@pytest.fixture
def database_session() -> Generator[Session, None, None]:
    engine = create_database_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine)
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_admin_workflow_creates_and_lists_a_jobless_interview_session(
    database_session: Session,
) -> None:
    candidate = create_candidate(
        CandidateCreate(
            email="mina@example.test",
            given_name="Mina",
            family_name="Hassan",
        ),
        database_session=database_session,
    )
    created_session = create_interview_session(
        InterviewSessionCreate(candidate_id=candidate.id),
        database_session=database_session,
    )

    candidates = list_candidates(database_session=database_session)
    sessions = list_interview_sessions(database_session=database_session)
    details = get_interview_session(created_session.id, database_session=database_session)

    assert candidates == [candidate]
    assert created_session.candidate.id == candidate.id
    assert created_session.job_id is None
    assert created_session.status == "scheduled"
    assert sessions[0].id == created_session.id
    assert details.candidate.email == "mina@example.test"
    assert details.created_at is not None
    assert details.has_recording is False


def test_interview_creation_requires_an_existing_active_candidate(
    database_session: Session,
) -> None:
    with pytest.raises(HTTPException) as error:
        create_interview_session(
            InterviewSessionCreate(candidate_id=uuid4()),
            database_session=database_session,
        )

    assert error.value.status_code == 404


def test_candidate_email_is_normalized_and_not_duplicated(database_session: Session) -> None:
    candidate = create_candidate(
        CandidateCreate(
            email=" Mina@Example.TEST ",
            given_name="Mina",
            family_name="Hassan",
        ),
        database_session=database_session,
    )

    assert candidate.email == "mina@example.test"
    with pytest.raises(HTTPException) as error:
        create_candidate(
            CandidateCreate(
                email="mina@example.test",
                given_name="Another",
                family_name="Candidate",
            ),
            database_session=database_session,
        )

    assert error.value.status_code == 409
