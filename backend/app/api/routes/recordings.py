"""Authenticated private recording upload and playback endpoints."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.api.schemas.interviews import RecordingResponse
from app.api.schemas.recordings import (
    CandidateRecordedInterview,
    CandidateRecordingSummary,
    RecordedInterviewEvaluation,
)
from app.assessments.auto_evaluator import trigger_automatic_assessment_if_ready
from app.auth.dependencies import AuthContext, require_csrf, require_roles, require_trusted_origin
from app.auth.security import utc_now
from app.core.config import settings
from app.db.session import get_db_session
from app.models import AuditEvent, Candidate, InterviewSession, Recording
from app.recordings import (
    CloudflareR2Storage,
    InvalidRecordingMediaError,
    LocalRecordingStorage,
    RecordingStorageError,
    RecordingTooLargeError,
    create_r2_storage_from_settings,
    normalize_media_type,
)

router = APIRouter(prefix="/interviews", tags=["recordings"])


def get_local_storage() -> LocalRecordingStorage:
    return LocalRecordingStorage(settings.recording_storage_path)


def get_r2_storage() -> CloudflareR2Storage:
    return create_r2_storage_from_settings()


def recording_storage() -> LocalRecordingStorage | CloudflareR2Storage:
    if settings.storage_provider == "cloudflare_r2":
        return get_r2_storage()
    return get_local_storage()


def recording_for_session(database_session: Session, session_id: UUID) -> Recording | None:
    return database_session.scalar(
        select(Recording).where(Recording.interview_session_id == session_id)
    )


def get_accessible_interview(database_session: Session, session_id: UUID) -> InterviewSession:
    interview_session = database_session.get(InterviewSession, session_id)
    if interview_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Interview session not found.",
        )
    return interview_session


@router.post(
    "/{session_id}/recording",
    response_model=RecordingResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_recording(
    session_id: UUID,
    request: Request,
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    auth_context: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> Recording:
    """Store one finalized browser video privately for an authorized interview."""
    content_type = normalize_media_type(request.headers.get("content-type"))
    if content_type is None:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Only WebM or MP4 interview recordings are supported.",
        )

    content_length = request.headers.get("content-length")
    if (
        content_length
        and content_length.isdigit()
        and int(content_length) > settings.recording_max_upload_bytes
    ):
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="The recording exceeds the maximum upload size.",
        )

    interview_session = get_accessible_interview(database_session, session_id)
    if (
        interview_session.status == "completed"
        or recording_for_session(database_session, session_id) is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An interview recording has already been saved for this session.",
        )

    storage = recording_storage()
    object_key = storage.build_object_key(str(session_id), content_type)
    try:
        stored_recording = await storage.store(
            object_key=object_key,
            chunks=request.stream(),
            content_type=content_type,
            maximum_bytes=settings.recording_max_upload_bytes,
        )
    except RecordingTooLargeError as error:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="The recording exceeds the maximum upload size.",
        ) from error
    except InvalidRecordingMediaError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The uploaded file is not a valid supported interview recording.",
        ) from error
    except RecordingStorageError as error:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The recording could not be stored.",
        ) from error

    storage_provider_name = (
        "cloudflare_r2"
        if isinstance(storage, CloudflareR2Storage)
        else "local_private"
    )

    recording = Recording(
        interview_session_id=session_id,
        storage_provider=storage_provider_name,
        object_key=stored_recording.object_key,
        content_type=content_type,
        byte_size=stored_recording.byte_size,
        checksum=stored_recording.checksum,
        status="available",
    )
    database_session.add(recording)
    if interview_session.status in {"scheduled", "in_progress"}:
        interview_session.status = "completed"
        interview_session.completed_at = utc_now()
    try:
        database_session.flush()
        database_session.add(
            AuditEvent(
                user_id=auth_context.user.id,
                action="recording.uploaded",
                entity_type="recording",
                entity_id=recording.id,
                status="success",
            )
        )
        database_session.commit()
    except IntegrityError as error:
        database_session.rollback()
        storage.delete(stored_recording.object_key)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An interview recording has already been saved for this session.",
        ) from error

    database_session.refresh(recording)
    trigger_automatic_assessment_if_ready(session_id)
    return recording


@router.get("/{session_id}/recording", response_model=RecordingResponse)
def get_recording(
    session_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> Recording:
    get_accessible_interview(database_session, session_id)
    recording = recording_for_session(database_session, session_id)
    if recording is None or recording.status != "available":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")
    return recording


@router.get("/{session_id}/recording/content")
def stream_recording_content(
    session_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> Response:
    get_accessible_interview(database_session, session_id)
    recording = recording_for_session(database_session, session_id)
    if recording is None or recording.status != "available" or not recording.content_type:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")

    extension = "webm" if recording.content_type == "video/webm" else "mp4"
    filename = f"interview-recording.{extension}"

    if recording.storage_provider in {"cloudflare_r2", "r2"}:
        try:
            active_storage = recording_storage()
            r2 = (
                active_storage
                if isinstance(active_storage, CloudflareR2Storage)
                else get_r2_storage()
            )
            r2_object = r2.get_object(recording.object_key)
        except RecordingStorageError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Recording not found.",
            ) from error

        body = r2_object.get("Body")
        if body is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Recording not found.",
            )

        def iter_body():
            try:
                if hasattr(body, "iter_chunks"):
                    yield from body.iter_chunks(chunk_size=64 * 1024)
                elif hasattr(body, "read"):
                    while chunk := body.read(64 * 1024):
                        yield chunk
                elif isinstance(body, (bytes, bytearray)):
                    yield bytes(body)
            finally:
                if hasattr(body, "close"):
                    body.close()

        headers = {
            "Content-Disposition": f'inline; filename="{filename}"',
        }
        if recording.byte_size:
            headers["Content-Length"] = str(recording.byte_size)
        elif "ContentLength" in r2_object:
            headers["Content-Length"] = str(r2_object["ContentLength"])

        return StreamingResponse(
            iter_body(),
            media_type=recording.content_type,
            headers=headers,
        )

    try:
        active_storage = recording_storage()
        local = (
            active_storage
            if isinstance(active_storage, LocalRecordingStorage)
            else get_local_storage()
        )
        recording_path = local.path_for(recording.object_key)
    except RecordingStorageError as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Recording not found.",
        ) from error
    if not recording_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")

    return FileResponse(
        recording_path,
        media_type=recording.content_type,
        filename=filename,
        content_disposition_type="inline",
    )


recordings_catalog_router = APIRouter(prefix="/recordings", tags=["recordings"])


def get_candidates_with_recordings(
    database_session: Session,
) -> list[CandidateRecordingSummary]:
    """List candidates who have at least one saved recording."""
    statement = (
        select(
            Candidate.id,
            Candidate.given_name,
            Candidate.family_name,
            Candidate.email,
            Candidate.created_at,
            func.count(Recording.id).label("recording_count"),
        )
        .join(InterviewSession, InterviewSession.candidate_id == Candidate.id)
        .join(Recording, Recording.interview_session_id == InterviewSession.id)
        .where(Recording.status == "available")
        .group_by(
            Candidate.id,
            Candidate.given_name,
            Candidate.family_name,
            Candidate.email,
            Candidate.created_at,
        )
        .order_by(func.max(Recording.created_at).desc(), Candidate.created_at.desc())
    )
    rows = database_session.execute(statement).all()
    return [
        CandidateRecordingSummary(
            id=row.id,
            candidate_id=row.id,
            full_name=f"{row.given_name} {row.family_name}".strip(),
            email=row.email,
            recording_count=row.recording_count,
        )
        for row in rows
    ]


def get_candidate_recordings(
    candidate_id: UUID,
    database_session: Session,
) -> list[CandidateRecordedInterview]:
    """List all recorded interviews in one candidate's virtual folder."""
    candidate = database_session.get(Candidate, candidate_id)
    if candidate is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Candidate not found.",
        )

    statement = (
        select(InterviewSession)
        .join(Recording, Recording.interview_session_id == InterviewSession.id)
        .options(
            selectinload(InterviewSession.recording),
            selectinload(InterviewSession.evaluation),
        )
        .where(
            InterviewSession.candidate_id == candidate_id,
            Recording.status == "available",
        )
        .order_by(Recording.created_at.desc())
    )
    sessions = list(database_session.scalars(statement).all())

    results: list[CandidateRecordedInterview] = []
    for session in sessions:
        recording = session.recording
        if recording is None:
            continue

        evaluation = session.evaluation
        eval_summary: RecordedInterviewEvaluation | None = None
        eval_status = "pending"
        score: float | None = None

        if evaluation is not None:
            eval_status = evaluation.status
            if evaluation.overall_score is not None:
                score = float(evaluation.overall_score)
            eval_summary = RecordedInterviewEvaluation(
                id=evaluation.id,
                status=evaluation.status,
                overall_score=score,
                assessed_german_level=evaluation.assessed_german_level,
                summary=evaluation.summary,
                evaluated_at=evaluation.evaluated_at,
            )

        recorded_date = (
            recording.created_at
            or session.completed_at
            or session.started_at
            or session.created_at
        )

        results.append(
            CandidateRecordedInterview(
                interview_id=session.id,
                recording_id=recording.id,
                candidate_id=candidate.id,
                date=recorded_date,
                storage_status=recording.status,
                storage_provider=recording.storage_provider,
                duration_seconds=recording.duration_seconds,
                byte_size=recording.byte_size,
                content_type=recording.content_type,
                interview_status=session.status,
                evaluation_status=eval_status,
                score=score,
                evaluation=eval_summary,
            )
        )

    return results


@recordings_catalog_router.get("", response_model=list[CandidateRecordingSummary])
@recordings_catalog_router.get("/candidates", response_model=list[CandidateRecordingSummary])
def list_candidates_with_recordings(
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> list[CandidateRecordingSummary]:
    """Protected admin endpoint listing candidates with saved recordings."""
    return get_candidates_with_recordings(database_session)


@recordings_catalog_router.get("/{candidate_id}", response_model=list[CandidateRecordedInterview])
@recordings_catalog_router.get(
    "/candidates/{candidate_id}", response_model=list[CandidateRecordedInterview]
)
def list_candidate_recordings(
    candidate_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> list[CandidateRecordedInterview]:
    """Protected admin endpoint listing one candidate's recorded interviews."""
    return get_candidate_recordings(candidate_id, database_session)

