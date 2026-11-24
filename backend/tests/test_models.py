from decimal import Decimal

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import create_database_engine
from app.models import (
    AuditEvent,
    Base,
    Candidate,
    Company,
    CriterionScore,
    Evaluation,
    InterviewQuestion,
    InterviewSession,
    Job,
    Recording,
    TranscriptSegment,
    User,
)


@pytest.fixture
def database_session() -> Session:
    engine = create_database_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine)

    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_all_initial_models_are_registered() -> None:
    expected_tables = {
        "audit_events",
        "auth_sessions",
        "candidates",
        "companies",
        "criterion_scores",
        "evaluations",
        "interview_questions",
        "interview_sessions",
        "jobs",
        "recordings",
        "transcript_segments",
        "users",
    }

    assert expected_tables == set(Base.metadata.tables)


def test_model_relationships_and_independent_german_assessment(database_session: Session) -> None:
    company = Company(name="Beispiel GmbH", slug="beispiel-gmbh", country_code="DE")
    user = User(email="coordinator@example.test", full_name="Coordinator", company=company)
    job = Job(
        company=company,
        title="Kundenberaterin",
        reference_code="KB-001",
        required_german_level="B2",
    )
    candidate = Candidate(
        email="candidate@example.test",
        given_name="Mina",
        family_name="Hassan",
        claimed_german_level="B1",
    )
    interview_session = InterviewSession(candidate=candidate, job=job)
    interview_session.questions.append(
        InterviewQuestion(position=1, question_text="Stellen Sie sich vor.")
    )
    interview_session.recording = Recording(
        storage_provider="r2",
        object_key="private/interviews/session-1.webm",
        content_type="video/webm",
        byte_size=1024,
        duration_seconds=60,
        status="available",
    )
    interview_session.transcript_segments.append(
        TranscriptSegment(
            position=1,
            speaker="candidate",
            start_ms=0,
            end_ms=1200,
            content="Guten Tag.",
        )
    )
    evaluation = Evaluation(assessed_german_level="C1", overall_score=Decimal("91.50"))
    evaluation.criterion_scores.append(
        CriterionScore(
            criterion_code="fluency",
            label="Fluency",
            score=Decimal("92.00"),
        )
    )
    interview_session.evaluation = evaluation
    audit_event = AuditEvent(
        company=company,
        user=user,
        action="candidate.created",
        entity_type="candidate",
        entity_id=candidate.id,
    )

    database_session.add_all([interview_session, audit_event])
    database_session.commit()
    database_session.expire_all()

    stored_session = database_session.get(InterviewSession, interview_session.id)

    assert stored_session is not None
    assert stored_session.job.required_german_level == "B2"
    assert stored_session.candidate.claimed_german_level == "B1"
    assert stored_session.evaluation is not None
    assert stored_session.evaluation.assessed_german_level == "C1"
    assert stored_session.recording is not None
    assert stored_session.recording.object_key == "private/interviews/session-1.webm"
    assert stored_session.transcript_segments[0].content == "Guten Tag."
    assert stored_session.evaluation.criterion_scores[0].score == Decimal("92.00")


def test_session_question_position_is_unique(database_session: Session) -> None:
    company = Company(name="Example GmbH", slug="example-gmbh")
    job = Job(company=company, title="Support")
    candidate = Candidate(email="candidate@example.test", given_name="Mina", family_name="Hassan")
    interview_session = InterviewSession(candidate=candidate, job=job)
    interview_session.questions.extend(
        [
            InterviewQuestion(position=1, question_text="Erste Frage"),
            InterviewQuestion(position=1, question_text="Doppelte Frage"),
        ]
    )
    database_session.add(interview_session)

    with pytest.raises(IntegrityError):
        database_session.commit()


def test_candidate_led_interview_session_does_not_require_a_job(
    database_session: Session,
) -> None:
    candidate = Candidate(
        email="candidate@example.test",
        given_name="Mina",
        family_name="Hassan",
    )
    interview_session = InterviewSession(candidate=candidate)
    database_session.add(interview_session)
    database_session.commit()
    database_session.expire_all()

    stored_session = database_session.get(InterviewSession, interview_session.id)

    assert stored_session is not None
    assert stored_session.job_id is None
    assert stored_session.job is None


def test_evaluation_model_supports_insufficient_evidence_and_assessment_fields(
    database_session: Session,
) -> None:
    candidate = Candidate(
        email="nour@example.test",
        given_name="Nour",
        family_name="Adel",
        claimed_german_level="B2",
    )
    interview_session = InterviewSession(candidate=candidate)
    evaluation = Evaluation(
        status="insufficient_evidence",
        insufficient_evidence_reason="Candidate answered in English only.",
        strengths=[],
        areas_for_improvement=[],
        evidence=[],
    )
    interview_session.evaluation = evaluation
    database_session.add(interview_session)
    database_session.commit()
    database_session.expire_all()

    stored_eval = database_session.get(Evaluation, evaluation.id)
    assert stored_eval is not None
    assert stored_eval.status == "insufficient_evidence"
    assert stored_eval.insufficient_evidence_reason == "Candidate answered in English only."
    assert stored_eval.overall_score is None
    assert stored_eval.assessed_german_level is None


