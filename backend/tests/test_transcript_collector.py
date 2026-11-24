"""Focused tests for German interview transcript aggregation and persistence."""

from __future__ import annotations

from collections.abc import Generator
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.session import create_database_engine
from app.models import Base, Candidate, InterviewSession, TranscriptSegment
from app.realtime.gemini_service import GeminiTranscriptEvent
from app.realtime.transcript_collector import (
    RealtimeTranscriptCollector,
    merge_transcript_fragments,
    parse_relative_offset_ms,
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def database_session() -> Generator[Session, None, None]:
    engine = create_database_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = Session(engine, expire_on_commit=False)
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def interview_session(database_session: Session) -> InterviewSession:
    candidate = Candidate(
        email="test.candidate@example.test",
        given_name="Lukas",
        family_name="Weber",
    )
    session = InterviewSession(
        candidate=candidate,
        status="in_progress",
        language="de",
        started_at=datetime.now(timezone.utc),
    )
    database_session.add_all([candidate, session])
    database_session.commit()
    return session


def test_parse_relative_offset_ms() -> None:
    assert parse_relative_offset_ms(None) is None
    assert parse_relative_offset_ms("") is None
    assert parse_relative_offset_ms("invalid") is None
    assert parse_relative_offset_ms("0s") == 0
    assert parse_relative_offset_ms("1500ms") == 1500
    assert parse_relative_offset_ms("2.5s") == 2500
    assert parse_relative_offset_ms("100") == 100


def test_merge_transcript_fragments_scenarios() -> None:
    # 1. Exact duplicate
    assert merge_transcript_fragments("Guten Tag", "Guten Tag") == "Guten Tag"

    # 2. Cumulative update
    assert (
        merge_transcript_fragments("Guten Tag", "Guten Tag! Wie geht es Ihnen?")
        == "Guten Tag! Wie geht es Ihnen?"
    )

    # 3. Subset update
    assert merge_transcript_fragments("Guten Tag! Wie geht es Ihnen?", "Guten Tag") == (
        "Guten Tag! Wie geht es Ihnen?"
    )

    # 4. Purely incremental fragment with space
    assert merge_transcript_fragments("Guten Tag,", "wie kann ich helfen?") == (
        "Guten Tag, wie kann ich helfen?"
    )

    # 5. Punctuation fragment
    assert merge_transcript_fragments("Guten Tag", "!") == "Guten Tag!"

    # 6. Word-level sliding overlap
    assert merge_transcript_fragments("Ich bin", "bin sehr motiviert.") == (
        "Ich bin sehr motiviert."
    )


@pytest.mark.anyio
async def test_collector_persists_multiple_turns_in_chronological_order(
    database_session: Session,
    interview_session: InterviewSession,
) -> None:
    collector = RealtimeTranscriptCollector(
        session_id=interview_session.id,
        database_session=database_session,
    )
    collector.start()

    # Turn 1: Interviewer
    await collector.record_event(
        GeminiTranscriptEvent(
            speaker="interviewer",
            text="Guten Tag! Herzlich willkommen zum Interview.",
            is_final=True,
            start_offset="0s",
            end_offset="2.5s",
        )
    )
    await collector.on_turn_complete()

    # Turn 2: Candidate
    await collector.record_event(
        GeminiTranscriptEvent(
            speaker="candidate",
            text="Guten Tag. Danke für die Einladung.",
            is_final=True,
            start_offset="3.0s",
            end_offset="5.5s",
        )
    )

    # Turn 3: Interviewer
    await collector.record_event(
        GeminiTranscriptEvent(
            speaker="interviewer",
            text="Können Sie sich bitte kurz vorstellen?",
            is_final=True,
            start_offset="6.0s",
            end_offset="8.5s",
        )
    )
    await collector.on_turn_complete()

    # Flush and close
    await collector.close()

    segments = database_session.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.interview_session_id == interview_session.id)
        .order_by(TranscriptSegment.position.asc())
    ).all()

    assert len(segments) == 3
    assert [s.position for s in segments] == [1, 2, 3]
    assert [s.speaker for s in segments] == ["interviewer", "candidate", "interviewer"]
    assert segments[0].content == "Guten Tag! Herzlich willkommen zum Interview."
    assert segments[0].start_ms == 0
    assert segments[0].end_ms == 2500
    assert segments[1].content == "Guten Tag. Danke für die Einladung."
    assert segments[1].start_ms == 3000
    assert segments[1].end_ms == 5500
    assert segments[2].content == "Können Sie sich bitte kurz vorstellen?"
    assert segments[2].start_ms == 6000
    assert segments[2].end_ms == 8500


@pytest.mark.anyio
async def test_collector_ignores_interim_transcription_updates(
    database_session: Session,
    interview_session: InterviewSession,
) -> None:
    collector = RealtimeTranscriptCollector(
        session_id=interview_session.id,
        database_session=database_session,
    )
    collector.start()

    # Interim candidate updates
    await collector.record_event(
        GeminiTranscriptEvent(
            speaker="candidate",
            text="Guten",
            is_final=False,
        )
    )
    await collector.record_event(
        GeminiTranscriptEvent(
            speaker="candidate",
            text="Guten Tag",
            is_final=False,
        )
    )

    await collector.close()

    # No segments should be persisted from interim updates
    segments = database_session.scalars(
        select(TranscriptSegment).where(
            TranscriptSegment.interview_session_id == interview_session.id
        )
    ).all()
    assert len(segments) == 0


@pytest.mark.anyio
async def test_collector_aggregates_incremental_fragments_per_turn(
    database_session: Session,
    interview_session: InterviewSession,
) -> None:
    collector = RealtimeTranscriptCollector(
        session_id=interview_session.id,
        database_session=database_session,
    )
    collector.start()

    # Interviewer speech streamed in fragments
    fragments = ["Guten Tag,", "mein Name ist", "die KI-Interviewer.", "Beginnen wir."]
    for frag in fragments:
        await collector.record_event(
            GeminiTranscriptEvent(
                speaker="interviewer",
                text=frag,
                is_final=True,
            )
        )

    await collector.on_turn_complete()
    await collector.close()

    segments = database_session.scalars(
        select(TranscriptSegment).where(
            TranscriptSegment.interview_session_id == interview_session.id
        )
    ).all()

    assert len(segments) == 1
    assert segments[0].position == 1
    assert segments[0].speaker == "interviewer"
    assert segments[0].content == "Guten Tag, mein Name ist die KI-Interviewer. Beginnen wir."


@pytest.mark.anyio
async def test_collector_handles_interruption_flushes_partial_turn(
    database_session: Session,
    interview_session: InterviewSession,
) -> None:
    collector = RealtimeTranscriptCollector(
        session_id=interview_session.id,
        database_session=database_session,
    )
    collector.start()

    # Interviewer starts speaking
    await collector.record_event(
        GeminiTranscriptEvent(
            speaker="interviewer",
            text="Ich möchte Ihnen heute eine detaillierte",
            is_final=True,
            start_offset="0ms",
            end_offset="1200ms",
        )
    )

    # Candidate interrupts
    await collector.on_interrupted()

    # Candidate speaks
    await collector.record_event(
        GeminiTranscriptEvent(
            speaker="candidate",
            text="Entschuldigung, darf ich kurz unterbrechen?",
            is_final=True,
            start_offset="1300ms",
            end_offset="3000ms",
        )
    )

    await collector.close()

    segments = database_session.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.interview_session_id == interview_session.id)
        .order_by(TranscriptSegment.position.asc())
    ).all()

    assert len(segments) == 2
    assert segments[0].position == 1
    assert segments[0].speaker == "interviewer"
    assert segments[0].content == "Ich möchte Ihnen heute eine detaillierte"
    assert segments[1].position == 2
    assert segments[1].speaker == "candidate"
    assert segments[1].content == "Entschuldigung, darf ich kurz unterbrechen?"


@pytest.mark.anyio
async def test_collector_handles_database_error_gracefully(
    database_session: Session,
    interview_session: InterviewSession,
) -> None:
    collector = RealtimeTranscriptCollector(
        session_id=interview_session.id,
        database_session=database_session,
    )
    collector.start()

    # Mock commit failure
    database_session.commit = MagicMock(side_effect=RuntimeError("DB disk full"))

    await collector.record_event(
        GeminiTranscriptEvent(
            speaker="candidate",
            text="Antwort während DB-Ausfall.",
            is_final=True,
        )
    )

    # close should not crash or raise error
    await collector.close()


@pytest.mark.anyio
async def test_collector_resumes_from_existing_position(
    database_session: Session,
    interview_session: InterviewSession,
) -> None:
    # Add pre-existing segment at position 1
    existing_segment = TranscriptSegment(
        interview_session_id=interview_session.id,
        position=1,
        speaker="interviewer",
        start_ms=0,
        end_ms=1000,
        content="Früheres Segment",
        language="de",
    )
    database_session.add(existing_segment)
    database_session.commit()

    collector = RealtimeTranscriptCollector(
        session_id=interview_session.id,
        database_session=database_session,
    )
    assert collector.next_position == 2
    collector.start()

    await collector.record_event(
        GeminiTranscriptEvent(
            speaker="candidate",
            text="Neues Segment nach Wiederverbindung",
            is_final=True,
        )
    )
    await collector.close()

    segments = database_session.scalars(
        select(TranscriptSegment)
        .where(TranscriptSegment.interview_session_id == interview_session.id)
        .order_by(TranscriptSegment.position.asc())
    ).all()

    assert len(segments) == 2
    assert segments[0].position == 1
    assert segments[0].content == "Früheres Segment"
    assert segments[1].position == 2
    assert segments[1].content == "Neues Segment nach Wiederverbindung"
