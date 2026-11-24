"""Transcript readiness and sufficiency checks for German language assessment."""

from __future__ import annotations

from collections.abc import Sequence
from uuid import UUID

from app.api.schemas.assessments import TranscriptReadinessResponse
from app.models.entities import TranscriptSegment

MIN_CANDIDATE_TURNS = 2
MIN_CANDIDATE_WORDS = 15


def count_words(text: str) -> int:
    """Count non-empty words in a given text string."""
    return len([word for word in text.strip().split() if word])


def assess_transcript_readiness(
    session_id: UUID,
    segments: Sequence[TranscriptSegment],
) -> TranscriptReadinessResponse:
    """Analyze interview transcript segments to determine readiness and evidence sufficiency.

    Readiness requires that the interview transcript has recorded candidate speech.
    Sufficiency requires enough spoken German volume (turns and words) for reliable CEFR evaluation.
    """
    total_segments = len(segments)
    candidate_segments = [s for s in segments if s.speaker == "candidate"]
    interviewer_segments = [s for s in segments if s.speaker == "interviewer"]

    candidate_turn_count = len(candidate_segments)
    interviewer_turn_count = len(interviewer_segments)
    candidate_word_count = sum(count_words(s.content) for s in candidate_segments)

    reasons: list[str] = []

    if total_segments == 0:
        return TranscriptReadinessResponse(
            interview_session_id=session_id,
            is_ready=False,
            is_sufficient=False,
            candidate_turn_count=0,
            candidate_word_count=0,
            interviewer_turn_count=0,
            total_segment_count=0,
            status_recommendation="pending",
            reasons=["No transcript segments recorded for this interview session."],
        )

    if candidate_turn_count == 0:
        return TranscriptReadinessResponse(
            interview_session_id=session_id,
            is_ready=False,
            is_sufficient=False,
            candidate_turn_count=0,
            candidate_word_count=0,
            interviewer_turn_count=interviewer_turn_count,
            total_segment_count=total_segments,
            status_recommendation="pending",
            reasons=["Transcript contains no candidate speech turns."],
        )

    # Candidate has spoken. Check whether speech volume is sufficient for a reliable CEFR level.
    if candidate_turn_count < MIN_CANDIDATE_TURNS or candidate_word_count < MIN_CANDIDATE_WORDS:
        reasons.append(
            f"Candidate speech is insufficient for a reliable CEFR assessment "
            f"({candidate_turn_count} turns, {candidate_word_count} words; "
            f"minimum required: {MIN_CANDIDATE_TURNS} turns and {MIN_CANDIDATE_WORDS} words)."
        )
        return TranscriptReadinessResponse(
            interview_session_id=session_id,
            is_ready=True,
            is_sufficient=False,
            candidate_turn_count=candidate_turn_count,
            candidate_word_count=candidate_word_count,
            interviewer_turn_count=interviewer_turn_count,
            total_segment_count=total_segments,
            status_recommendation="insufficient_evidence",
            reasons=reasons,
        )

    return TranscriptReadinessResponse(
        interview_session_id=session_id,
        is_ready=True,
        is_sufficient=True,
        candidate_turn_count=candidate_turn_count,
        candidate_word_count=candidate_word_count,
        interviewer_turn_count=interviewer_turn_count,
        total_segment_count=total_segments,
        status_recommendation="completed",
        reasons=[],
    )
