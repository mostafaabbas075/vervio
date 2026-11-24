"""Authenticated endpoints for German interview transcript storage and retrieval."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas.transcripts import (
    TranscriptResponse,
    TranscriptSaveRequest,
    TranscriptSegmentCreate,
    TranscriptSegmentResponse,
)
from app.assessments.auto_evaluator import trigger_automatic_assessment_if_ready
from app.auth.dependencies import AuthContext, require_csrf, require_roles, require_trusted_origin
from app.db.session import get_db_session
from app.models import AuditEvent, InterviewSession, TranscriptSegment

router = APIRouter(prefix="/interviews", tags=["transcripts"])


def get_accessible_interview(database_session: Session, session_id: UUID) -> InterviewSession:
    interview_session = database_session.get(InterviewSession, session_id)
    if interview_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Interview session not found.",
        )
    return interview_session


@router.get(
    "/{session_id}/transcript",
    response_model=TranscriptResponse,
)
def get_transcript(
    session_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> TranscriptResponse:
    """Retrieve the German transcript for an interview session, or empty if none exists."""
    interview_session = get_accessible_interview(database_session, session_id)

    segments = list(
        database_session.scalars(
            select(TranscriptSegment)
            .where(TranscriptSegment.interview_session_id == session_id)
            .order_by(TranscriptSegment.position.asc())
        ).all()
    )

    return TranscriptResponse(
        interview_session_id=session_id,
        language=interview_session.language or "de",
        segment_count=len(segments),
        segments=segments,
    )


@router.get(
    "/{session_id}/transcript/segments",
    response_model=list[TranscriptSegmentResponse],
)
def get_transcript_segments(
    session_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> list[TranscriptSegment]:
    """Retrieve raw transcript segments in sequential position order."""
    get_accessible_interview(database_session, session_id)

    return list(
        database_session.scalars(
            select(TranscriptSegment)
            .where(TranscriptSegment.interview_session_id == session_id)
            .order_by(TranscriptSegment.position.asc())
        ).all()
    )


@router.post(
    "/{session_id}/transcript",
    response_model=TranscriptResponse,
    status_code=status.HTTP_201_CREATED,
)
@router.post(
    "/{session_id}/transcript/segments",
    response_model=TranscriptResponse,
    status_code=status.HTTP_201_CREATED,
)
def save_transcript(
    session_id: UUID,
    payload: TranscriptSaveRequest | list[TranscriptSegmentCreate] | TranscriptSegmentCreate,
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    auth_context: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> TranscriptResponse:
    """Save German transcript segments, preserving turn order and deduplicating retries."""
    interview_session = get_accessible_interview(database_session, session_id)

    if isinstance(payload, TranscriptSaveRequest):
        new_items = payload.segments
    elif isinstance(payload, list):
        new_items = payload
    else:
        new_items = [payload]

    existing_segments = list(
        database_session.scalars(
            select(TranscriptSegment)
            .where(TranscriptSegment.interview_session_id == session_id)
            .order_by(TranscriptSegment.position.asc())
        ).all()
    )

    used_positions = {s.position for s in existing_segments}
    next_position = max(used_positions, default=0) + 1
    added_any = False

    for item in new_items:
        # Check for duplicate segments from repeated requests or retries
        is_duplicate = False
        for s in existing_segments:
            if (
                s.speaker == item.speaker
                and s.content.strip() == item.content.strip()
                and s.start_ms == item.start_ms
                and s.end_ms == item.end_ms
            ):
                is_duplicate = True
                break
            if (
                item.position is not None
                and s.position == item.position
                and s.speaker == item.speaker
                and s.content.strip() == item.content.strip()
            ):
                is_duplicate = True
                break

        if is_duplicate:
            continue

        if item.position is not None and item.position not in used_positions:
            pos = item.position
        else:
            pos = next_position
            next_position += 1

        used_positions.add(pos)
        segment = TranscriptSegment(
            interview_session_id=session_id,
            position=pos,
            speaker=item.speaker,
            start_ms=item.start_ms,
            end_ms=item.end_ms,
            content=item.content.strip(),
            language=item.language or "de",
        )
        database_session.add(segment)
        existing_segments.append(segment)
        added_any = True

    if added_any or not interview_session.is_transcript_finalized:
        interview_session.is_transcript_finalized = True
        database_session.flush()
        # Audit event records action metadata only; never log sensitive transcript contents
        database_session.add(
            AuditEvent(
                user_id=auth_context.user.id,
                action="transcript.saved",
                entity_type="transcript",
                entity_id=session_id,
                status="success",
            )
        )
        database_session.commit()
        trigger_automatic_assessment_if_ready(session_id)

    final_segments = list(
        database_session.scalars(
            select(TranscriptSegment)
            .where(TranscriptSegment.interview_session_id == session_id)
            .order_by(TranscriptSegment.position.asc())
        ).all()
    )

    return TranscriptResponse(
        interview_session_id=session_id,
        language=interview_session.language or "de",
        segment_count=len(final_segments),
        segments=final_segments,
    )
