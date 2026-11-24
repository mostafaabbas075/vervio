from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.api.schemas.interviews import InterviewSessionCreate, InterviewSessionResponse
from app.auth.dependencies import AuthContext, require_csrf, require_roles, require_trusted_origin
from app.db.session import get_db_session
from app.models import Candidate, InterviewSession

router = APIRouter(prefix="/interviews", tags=["interviews"])


def session_query():
    return select(InterviewSession).options(
        selectinload(InterviewSession.candidate),
        selectinload(InterviewSession.recording),
    )


@router.get("", response_model=list[InterviewSessionResponse])
def list_interview_sessions(
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> list[InterviewSession]:
    statement = session_query().order_by(InterviewSession.created_at.desc())
    return list(database_session.scalars(statement).all())


@router.post("", response_model=InterviewSessionResponse, status_code=status.HTTP_201_CREATED)
def create_interview_session(
    payload: InterviewSessionCreate,
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    ___: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> InterviewSession:
    candidate = database_session.get(Candidate, payload.candidate_id)
    if candidate is None or candidate.status != "active":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Candidate not found.")

    interview_session = InterviewSession(
        candidate=candidate,
        status="scheduled",
        language="de",
        required_german_level=payload.required_german_level,
    )
    database_session.add(interview_session)
    database_session.commit()

    return database_session.scalar(
        session_query().where(InterviewSession.id == interview_session.id)
    )


@router.get("/{session_id}", response_model=InterviewSessionResponse)
def get_interview_session(
    session_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> InterviewSession:
    interview_session = database_session.scalar(
        session_query().where(InterviewSession.id == session_id)
    )
    if interview_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Interview session not found.",
        )
    return interview_session
