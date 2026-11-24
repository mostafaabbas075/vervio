"""Automatic asynchronous evaluation manager for completed candidate interviews."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.schemas.assessments import GermanAssessmentResponse
from app.assessments.gemini_service import (
    GeminiAssessmentConfigurationError,
    GeminiAssessmentProviderError,
    GeminiAssessmentService,
    GeminiAssessmentTimeoutError,
    GeminiAssessmentValidationError,
)
from app.assessments.service import (
    generate_and_save_assessment,
    get_assessment_response,
    get_session_with_relations,
)
from app.db.session import get_session_factory
from app.models import Evaluation, InterviewSession, Recording

logger = logging.getLogger(__name__)

# Concurrency and state tracking
_active_assessments: set[UUID] = set()
_assessment_locks: dict[UUID, asyncio.Lock] = {}
_active_collectors: set[UUID] = set()
_background_tasks: set[asyncio.Task[Any]] = set()

# Optional factory override for testing (e.g. SQLite in-memory test database)
_db_session_factory_override: Callable[[], Session] | None = None


def set_db_session_factory_override(factory: Callable[[], Session] | None) -> None:
    """Override session creation for tests with custom databases."""
    global _db_session_factory_override
    _db_session_factory_override = factory


def get_db_for_task() -> Session:
    """Return a fresh database session for an asynchronous background task."""
    if _db_session_factory_override is not None:
        return _db_session_factory_override()
    return get_session_factory()()


def register_active_collector(session_id: UUID) -> None:
    """Record that a live transcript collector is streaming for an interview."""
    _active_collectors.add(session_id)


def unregister_active_collector(session_id: UUID) -> None:
    """Record that a transcript collector has stopped streaming."""
    _active_collectors.discard(session_id)


def is_collector_active(session_id: UUID) -> bool:
    """Check whether a live transcript collector is currently active."""
    return session_id in _active_collectors


def is_assessment_active(session_id: UUID) -> bool:
    """Check whether an assessment is currently running for an interview session."""
    return session_id in _active_assessments


def is_interview_ready_for_assessment(session: InterviewSession) -> bool:
    """Verify whether BOTH completion conditions are met for automatic assessment.

    1. Interview session is completed and recording was successfully saved.
    2. Transcript collector has finished flushing stable transcript events.
    """
    if session.status != "completed":
        return False

    if session.recording is None or session.recording.status != "available":
        return False

    # Transcript collector must have finalized and not be actively streaming
    has_finalized_transcript = getattr(session, "is_transcript_finalized", False) or (
        bool(session.transcript_segments) and not is_collector_active(session.id)
    )
    if is_collector_active(session.id) or not has_finalized_transcript:
        return False

    # Do not regenerate if already finalized
    if session.evaluation and session.evaluation.status in {"completed", "insufficient_evidence"}:
        return False

    return True


async def run_assessment_task(
    session_id: UUID,
    db: Session | None = None,
    gemini_service: GeminiAssessmentService | None = None,
) -> GermanAssessmentResponse | None:
    """Run asynchronous German language assessment for an interview session.

    Ensures at most one active assessment per interview session using locks.
    """
    if session_id not in _assessment_locks:
        _assessment_locks[session_id] = asyncio.Lock()

    async with _assessment_locks[session_id]:
        if session_id in _active_assessments:
            logger.info("auto_assessment_already_running session_id=%s", session_id)
            return None
        _active_assessments.add(session_id)

        db_session: Session = db if db is not None else get_db_for_task()
        close_db = db is None

        try:
            session = get_session_with_relations(db_session, session_id)
            if (
                session is not None
                and session.evaluation is not None
                and session.evaluation.status in {"completed", "insufficient_evidence"}
            ):
                return get_assessment_response(session)

            if not is_interview_ready_for_assessment(session):
                logger.info("auto_assessment_preconditions_unmet session_id=%s", session_id)
                return None

            # Ensure pending evaluation row exists or reset failed evaluation to pending
            if session.evaluation is None:
                pending_eval = Evaluation(
                    interview_session_id=session_id,
                    status="pending",
                )
                db_session.add(pending_eval)
                db_session.commit()
                db_session.refresh(session)
            elif session.evaluation.status == "failed":
                session.evaluation.status = "pending"
                session.evaluation.summary = None
                db_session.commit()
                db_session.refresh(session)

            # Run existing assessment service and persist result
            result = await generate_and_save_assessment(
                db=db_session,
                session_id=session_id,
                gemini_service=gemini_service,
            )
            logger.info(
                "auto_assessment_success session_id=%s status=%s cefr=%s",
                session_id,
                result.assessment_status,
                result.estimated_cefr_level,
            )
            return result

        except (
            GeminiAssessmentProviderError,
            GeminiAssessmentTimeoutError,
            GeminiAssessmentValidationError,
            GeminiAssessmentConfigurationError,
            Exception,
        ) as exc:
            try:
                db_session.rollback()
                eval_row = (
                    db_session.query(Evaluation)
                    .filter(Evaluation.interview_session_id == session_id)
                    .first()
                )
                if eval_row is not None:
                    eval_row.status = "failed"
                    eval_row.summary = f"Gemini evaluation failed: {exc}"
                    db_session.commit()
            except Exception:
                pass
            logger.warning(
                "auto_assessment_failed session_id=%s error_type=%s",
                session_id,
                type(exc).__name__,
            )
            return None
        finally:
            _active_assessments.discard(session_id)
            if close_db:
                try:
                    db_session.close()
                except Exception:
                    pass


def trigger_automatic_assessment_if_ready(
    session_id: UUID,
    db: Session | None = None,
    gemini_service: GeminiAssessmentService | None = None,
) -> asyncio.Task[GermanAssessmentResponse | None] | None:
    """Schedule automatic assessment in the background if an event loop is running."""
    if session_id in _active_assessments:
        return None

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return None

    task = loop.create_task(
        run_assessment_task(session_id, db=db, gemini_service=gemini_service)
    )
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)
    return task


def recover_pending_assessments(
    db: Session | None = None,
    gemini_service: GeminiAssessmentService | None = None,
) -> list[UUID]:
    """Recover and resume pending assessments after a backend restart."""
    db_session: Session = db if db is not None else get_db_for_task()
    close_db = db is None

    try:
        statement = (
            select(InterviewSession)
            .join(Recording, Recording.interview_session_id == InterviewSession.id)
            .outerjoin(Evaluation, Evaluation.interview_session_id == InterviewSession.id)
            .options(
                selectinload(InterviewSession.recording),
                selectinload(InterviewSession.evaluation),
            )
            .where(
                InterviewSession.status == "completed",
                InterviewSession.is_transcript_finalized.is_(True),
                Recording.status == "available",
                (Evaluation.id.is_(None)) | (Evaluation.status == "pending"),
            )
        )
        sessions = list(db_session.scalars(statement).all())
        scheduled_ids: list[UUID] = []
        for s in sessions:
            if not is_collector_active(s.id):
                trigger_automatic_assessment_if_ready(s.id, db=db, gemini_service=gemini_service)
                scheduled_ids.append(s.id)
        logger.info("recovered_pending_assessments count=%d", len(scheduled_ids))
        return scheduled_ids
    finally:
        if close_db:
            try:
                db_session.close()
            except Exception:
                pass
