"""Asynchronous collector for aggregating and persisting German interview transcripts."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.assessments.auto_evaluator import (
    register_active_collector,
    trigger_automatic_assessment_if_ready,
    unregister_active_collector,
)
from app.models import InterviewSession, TranscriptSegment
from app.realtime.gemini_service import GeminiTranscriptEvent

logger = logging.getLogger(__name__)


def parse_relative_offset_ms(offset_str: str | None) -> int | None:
    """Parse relative time offset string (e.g., '1500ms', '1.5s', '0s') to milliseconds.

    Never invents precise timestamps; returns None when no timestamp was provided.
    """
    if not offset_str:
        return None
    s = str(offset_str).strip().lower()
    if s.endswith("ms"):
        val = s[:-2].strip()
        try:
            return max(0, int(float(val)))
        except ValueError:
            return None
    if s.endswith("s"):
        val = s[:-1].strip()
        try:
            return max(0, int(float(val) * 1000))
        except ValueError:
            return None
    try:
        return max(0, int(float(s)))
    except ValueError:
        return None


def merge_transcript_fragments(existing: str, incoming: str) -> str:
    """Merge an incoming transcription fragment into existing accumulated text.

    Correctly handles:
    - Exact duplicate text (returns existing)
    - Cumulative extension (incoming starts with existing)
    - Subset/prefix update (existing starts with incoming)
    - Word-level overlap common in ASR streaming deltas
    - Clean whitespace and punctuation joining for purely incremental deltas
    """
    clean_existing = existing.strip()
    clean_incoming = incoming.strip()

    if not clean_existing:
        return clean_incoming
    if not clean_incoming:
        return clean_existing

    # Exact duplicate
    if clean_incoming == clean_existing:
        return clean_existing

    # Cumulative update (incoming contains all of existing plus new text)
    if clean_incoming.startswith(clean_existing):
        return clean_incoming

    # Subset update (existing already contains incoming)
    if clean_existing.startswith(clean_incoming):
        return clean_existing

    # Check for suffix/prefix word-level overlap
    existing_words = clean_existing.split()
    incoming_words = clean_incoming.split()

    max_overlap = min(len(existing_words), len(incoming_words))
    for k in range(max_overlap, 0, -1):
        if existing_words[-k:] == incoming_words[:k]:
            merged_words = existing_words + incoming_words[k:]
            return " ".join(merged_words)

    # Purely incremental fragment with no overlap
    if clean_incoming[0] in {".", ",", "!", "?", ";", ":", "-", "'", '"'}:
        return f"{clean_existing}{clean_incoming}"
    return f"{clean_existing} {clean_incoming}"


@dataclass(frozen=True)
class CompletedTranscriptTurn:
    """A finished speech turn ready for asynchronous persistence."""

    speaker: Literal["candidate", "interviewer"]
    content: str
    start_ms: int
    end_ms: int


class RealtimeTranscriptCollector:
    """Collects, aggregates, and asynchronously persists German interview transcripts.

    Runs persistence in an asynchronous queue worker to ensure database writes never
    block live microphone or model audio streaming.
    """

    def __init__(
        self,
        session_id: UUID,
        database_session: Session,
    ) -> None:
        self.session_id = session_id
        self.database_session = database_session
        self._current_speaker: Literal["candidate", "interviewer"] | None = None
        self._current_text: str = ""
        self._current_start_ms: int = 0
        self._current_end_ms: int = 0
        self._queue: asyncio.Queue[CompletedTranscriptTurn | None] = asyncio.Queue()
        self._worker_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self.next_position: int = 1
        self._saved_turns: list[TranscriptSegment] = []
        self._init_position()

    def _init_position(self) -> None:
        try:
            max_pos = self.database_session.scalar(
                select(func.max(TranscriptSegment.position)).where(
                    TranscriptSegment.interview_session_id == self.session_id
                )
            )
            self.next_position = (max_pos or 0) + 1
        except Exception:
            self.next_position = 1

    def start(self) -> None:
        """Start the background persistence queue worker."""
        register_active_collector(self.session_id)
        if self._worker_task is None:
            self._worker_task = asyncio.create_task(self._process_queue())

    async def record_event(self, event: GeminiTranscriptEvent) -> None:
        """Process an incoming transcript event.

        Interim updates are ignored for persistence to ensure only stable segments
        are stored in PostgreSQL.
        """
        if not event.is_final:
            return

        text = event.text.strip()
        if not text:
            return

        start_ms = parse_relative_offset_ms(event.start_offset) or 0
        end_ms = parse_relative_offset_ms(event.end_offset) or start_ms

        async with self._lock:
            # If the speaker changed, finalize the previous speaker's turn first
            if self._current_speaker is not None and self._current_speaker != event.speaker:
                self._finalize_current_turn()

            self._current_speaker = event.speaker
            self._current_text = merge_transcript_fragments(self._current_text, text)
            if self._current_start_ms == 0 and start_ms > 0:
                self._current_start_ms = start_ms
            if end_ms > self._current_end_ms:
                self._current_end_ms = end_ms

    async def on_turn_complete(self) -> None:
        """Signal that model turn generation has completed."""
        async with self._lock:
            if self._current_speaker == "interviewer":
                self._finalize_current_turn()

    async def on_interrupted(self) -> None:
        """Signal that candidate interrupted the interviewer."""
        async with self._lock:
            if self._current_speaker == "interviewer":
                self._finalize_current_turn()

    def _finalize_current_turn(self) -> None:
        """Enqueue the current turn if it has content."""
        if not self._current_speaker or not self._current_text.strip():
            self._current_speaker = None
            self._current_text = ""
            self._current_start_ms = 0
            self._current_end_ms = 0
            return

        turn = CompletedTranscriptTurn(
            speaker=self._current_speaker,
            content=self._current_text.strip(),
            start_ms=self._current_start_ms,
            end_ms=max(self._current_start_ms, self._current_end_ms),
        )
        self._queue.put_nowait(turn)

        self._current_speaker = None
        self._current_text = ""
        self._current_start_ms = 0
        self._current_end_ms = 0

    def _persist_turn_sync(self, turn: CompletedTranscriptTurn) -> TranscriptSegment | None:
        """Synchronously persist a completed turn with unique position ordering."""
        # Check if an identical segment already exists at this position (idempotency check)
        existing = self.database_session.scalar(
            select(TranscriptSegment).where(
                TranscriptSegment.interview_session_id == self.session_id,
                TranscriptSegment.position == self.next_position,
            )
        )
        if existing is not None:
            if (
                existing.speaker == turn.speaker
                and existing.content.strip() == turn.content.strip()
            ):
                self.next_position += 1
                return existing

            max_pos = (
                self.database_session.scalar(
                    select(func.max(TranscriptSegment.position)).where(
                        TranscriptSegment.interview_session_id == self.session_id
                    )
                )
                or 0
            )
            self.next_position = max_pos + 1

        segment = TranscriptSegment(
            interview_session_id=self.session_id,
            position=self.next_position,
            speaker=turn.speaker,
            start_ms=turn.start_ms,
            end_ms=max(turn.start_ms, turn.end_ms),
            content=turn.content,
            language="de",
        )
        self.database_session.add(segment)
        self.database_session.commit()
        self.next_position += 1
        self._saved_turns.append(segment)
        return segment

    async def _process_queue(self) -> None:
        """Worker task consuming turns from the queue without blocking audio."""
        while True:
            turn = await self._queue.get()
            if turn is None:
                self._queue.task_done()
                break
            try:
                self._persist_turn_sync(turn)
            except Exception as error:
                try:
                    self.database_session.rollback()
                except Exception:
                    pass
                logger.warning(
                    "transcript_persistence_failed operation=persist error_type=%s session_id=%s",
                    type(error).__name__,
                    self.session_id,
                )
            finally:
                self._queue.task_done()

    async def flush(self) -> None:
        """Finalize any pending turn and wait until all queued turns are persisted."""
        async with self._lock:
            self._finalize_current_turn()
        await self._queue.join()

    async def close(self) -> None:
        """Safely flush all pending transcripts and stop the background worker."""
        await self.flush()
        if self._worker_task is not None:
            self._queue.put_nowait(None)
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker_task
            self._worker_task = None

        # Mark transcript finalized in database
        try:
            session = self.database_session.get(InterviewSession, self.session_id)
            if session is not None:
                session.is_transcript_finalized = True
                self.database_session.commit()
        except Exception as error:
            try:
                self.database_session.rollback()
            except Exception:
                pass
            logger.warning(
                "failed_to_mark_transcript_finalized session_id=%s error=%s",
                self.session_id,
                error,
            )
        finally:
            unregister_active_collector(self.session_id)
            trigger_automatic_assessment_if_ready(self.session_id)
