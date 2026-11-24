from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.routes.recordings import get_candidate_recordings, get_candidates_with_recordings
from app.api.schemas.interviews import CandidateCreate, CandidateResponse
from app.api.schemas.recordings import CandidateRecordedInterview, CandidateRecordingSummary
from app.auth.dependencies import AuthContext, require_csrf, require_roles, require_trusted_origin
from app.db.session import get_db_session
from app.models import Candidate

router = APIRouter(prefix="/candidates", tags=["candidates"])


@router.get("", response_model=list[CandidateResponse])
def list_candidates(
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> list[Candidate]:
    return list(
        database_session.scalars(select(Candidate).order_by(Candidate.created_at.desc())).all()
    )


@router.post("", response_model=CandidateResponse, status_code=status.HTTP_201_CREATED)
def create_candidate(
    payload: CandidateCreate,
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    ___: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> Candidate:
    existing_candidate = database_session.scalar(
        select(Candidate.id).where(func.lower(Candidate.email) == payload.email)
    )
    if existing_candidate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A candidate with this email already exists.",
        )

    candidate = Candidate(
        email=payload.email,
        given_name=payload.given_name,
        family_name=payload.family_name,
    )
    database_session.add(candidate)
    database_session.commit()
    database_session.refresh(candidate)
    return candidate


@router.get("/recordings", response_model=list[CandidateRecordingSummary])
def list_candidates_with_recordings(
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> list[CandidateRecordingSummary]:
    """Protected admin API listing candidates with saved recordings."""
    return get_candidates_with_recordings(database_session)


@router.get("/{candidate_id}/recordings", response_model=list[CandidateRecordedInterview])
def list_candidate_recordings(
    candidate_id: UUID,
    _: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> list[CandidateRecordedInterview]:
    """Protected admin API listing one candidate's recorded interviews."""
    return get_candidate_recordings(candidate_id, database_session)

