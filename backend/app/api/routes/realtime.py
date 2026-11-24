from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    WebSocketException,
    status,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.schemas.realtime import RealtimeOfferRequest, RealtimeOfferResponse
from app.auth.dependencies import (
    AuthContext,
    require_csrf,
    require_roles,
    require_trusted_origin,
    require_websocket_origin,
    require_websocket_roles,
)
from app.auth.security import utc_now
from app.core.config import settings
from app.db.session import get_db_session
from app.models import InterviewSession, Recording
from app.realtime.gemini_service import (
    GeminiLiveConfigurationError,
    GeminiLiveConnectionError,
    GeminiLiveInputError,
    GeminiLiveServerEvent,
    GeminiLiveService,
    GeminiTranscriptEvent,
)
from app.realtime.service import RealtimeProviderError, create_realtime_call
from app.realtime.transcript_collector import RealtimeTranscriptCollector

router = APIRouter(prefix="/interviews", tags=["realtime"])
logger = logging.getLogger(__name__)


def privacy_preserving_safety_identifier(auth_context: AuthContext) -> str:
    """Return a stable safety identifier without passing internal IDs to OpenAI."""
    return hashlib.sha256(str(auth_context.user.id).encode("utf-8")).hexdigest()


def recording_for_session(database_session: Session, session_id: UUID) -> Recording | None:
    return database_session.scalar(
        select(Recording).where(Recording.interview_session_id == session_id)
    )


@router.post("/{session_id}/realtime/offer", response_model=RealtimeOfferResponse)
def initialize_realtime_interview(
    session_id: UUID,
    payload: RealtimeOfferRequest,
    _: None = Depends(require_csrf),
    __: None = Depends(require_trusted_origin),
    auth_context: AuthContext = Depends(require_roles("admin")),
    database_session: Session = Depends(get_db_session),
) -> RealtimeOfferResponse:
    """Create a Realtime WebRTC call for an authorized, active interview session."""
    interview_session = database_session.get(InterviewSession, session_id)
    if interview_session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Interview session not found.",
        )
    if interview_session.language != "de":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This interview session is not configured for a German voice interview.",
        )
    if interview_session.status not in {"scheduled", "in_progress"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This interview session cannot be started.",
        )
    if recording_for_session(database_session, session_id) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An interview recording has already been saved for this session.",
        )
    if not settings.openai_api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The AI voice service is not configured.",
        )

    try:
        answer_sdp = create_realtime_call(
            offer_sdp=payload.offer_sdp,
            api_key=settings.openai_api_key,
            model=settings.openai_realtime_model,
            safety_identifier=privacy_preserving_safety_identifier(auth_context),
        )
    except RealtimeProviderError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The AI voice service could not establish a connection. Please try again.",
        ) from error

    if interview_session.status == "scheduled":
        # An accepted SDP exchange has created an external live call. Completion remains
        # deliberately unsupported until recording/transcript/evaluation workflows exist.
        interview_session.status = "in_progress"
        if not interview_session.started_at:
            interview_session.started_at = utc_now()
        database_session.commit()

    return RealtimeOfferResponse(
        answer_sdp=answer_sdp,
        max_duration_seconds=settings.openai_interview_max_duration_seconds,
    )


MAX_AUDIO_CHUNK_BYTES: int = 64 * 1024
GEMINI_PCM_OUTPUT_BYTES_PER_SECOND = 24_000 * 2
MAX_GEMINI_OUTPUT_BACKLOG_SECONDS = 30.0


class GeminiLiveOutputBacklogError(RuntimeError):
    """Raised when provider audio exceeds the safe, lossless relay capacity."""


class GeminiPcmOutputPacer:
    """Relay provider PCM at playout speed while keeping VAD cancellation immediate."""

    def __init__(
        self,
        *,
        max_backlog_seconds: float = MAX_GEMINI_OUTPUT_BACKLOG_SECONDS,
    ) -> None:
        self._max_backlog_seconds = max_backlog_seconds
        self._queue: asyncio.Queue[tuple[int, bytes, float]] = asyncio.Queue()
        self._queued_duration_seconds = 0.0
        self._generation = 0
        self._wake_event = asyncio.Event()

    @property
    def queued_duration_seconds(self) -> float:
        return self._queued_duration_seconds

    def enqueue(self, pcm_bytes: bytes) -> None:
        duration_seconds = len(pcm_bytes) / GEMINI_PCM_OUTPUT_BYTES_PER_SECOND
        if duration_seconds <= 0:
            return
        if self._queued_duration_seconds + duration_seconds > self._max_backlog_seconds:
            raise GeminiLiveOutputBacklogError(
                "The AI voice service produced more audio than the safe relay capacity."
            )
        self._queue.put_nowait((self._generation, pcm_bytes, duration_seconds))
        self._queued_duration_seconds += duration_seconds

    def interrupt(self) -> int:
        """Discard only provider-cancelled speech that was not sent to the browser."""
        self._generation += 1
        cancelled_bytes = 0
        while True:
            try:
                _, pcm_bytes, duration_seconds = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            cancelled_bytes += len(pcm_bytes)
            self._queued_duration_seconds = max(
                0.0,
                self._queued_duration_seconds - duration_seconds,
            )
        self._wake_event.set()
        return cancelled_bytes

    async def run(self, send_audio: Callable[[bytes], Awaitable[None]]) -> None:
        next_send_at = time.monotonic()
        while True:
            generation, pcm_bytes, duration_seconds = await self._queue.get()
            self._queued_duration_seconds = max(
                0.0,
                self._queued_duration_seconds - duration_seconds,
            )
            if generation != self._generation:
                next_send_at = time.monotonic()
                continue

            scheduled_at = max(next_send_at, time.monotonic())
            if await self._wait_until(scheduled_at, generation):
                next_send_at = time.monotonic()
                continue
            if generation != self._generation:
                next_send_at = time.monotonic()
                continue

            await send_audio(pcm_bytes)
            next_send_at = scheduled_at + duration_seconds

    async def _wait_until(self, scheduled_at: float, generation: int) -> bool:
        """Return True when an interruption invalidates the pending frame."""
        while True:
            if generation != self._generation:
                return True
            wait_seconds = scheduled_at - time.monotonic()
            if wait_seconds <= 0:
                return False
            self._wake_event.clear()
            if generation != self._generation:
                return True
            try:
                await asyncio.wait_for(self._wake_event.wait(), timeout=wait_seconds)
            except TimeoutError:
                return generation != self._generation


def get_gemini_service() -> GeminiLiveService:
    """Dependency provider for GeminiLiveService instances."""
    return GeminiLiveService()


@router.websocket("/{session_id}/gemini/ws")
async def gemini_live_websocket(
    websocket: WebSocket,
    session_id: UUID,
    _: None = Depends(require_websocket_origin),
    auth_context: AuthContext = Depends(require_websocket_roles("admin")),
    database_session: Session = Depends(get_db_session),
    gemini_service: GeminiLiveService = Depends(get_gemini_service),
) -> None:
    """Establish an authorized Gemini Live WebSocket session for an interview."""
    interview_session = database_session.get(InterviewSession, session_id)
    if (
        interview_session is None
        or interview_session.language != "de"
        or interview_session.status not in {"scheduled", "in_progress"}
    ):
        raise WebSocketException(
            code=status.WS_1008_POLICY_VIOLATION,
            reason="Interview session not found or inaccessible.",
        )
    if recording_for_session(database_session, session_id) is not None:
        raise WebSocketException(
            code=status.WS_1008_POLICY_VIOLATION,
            reason="An interview recording has already been saved for this session.",
        )

    # The CEFR target calibrates only the interviewer's questions. It is never
    # used as an assessment result or a substitute for transcript evidence.
    gemini_service.configure_required_german_level(interview_session.required_german_level)

    await websocket.accept()
    logger.info("gemini_live_websocket_accepted")
    websocket_send_lock = asyncio.Lock()
    audio_forwarding_task: asyncio.Task[None] | None = None
    audio_pacing_task: asyncio.Task[None] | None = None
    output_pacer = GeminiPcmOutputPacer()
    initial_greeting_requested = False
    transcript_collector = RealtimeTranscriptCollector(
        session_id=session_id,
        database_session=database_session,
    )
    transcript_collector.start()

    async def send_control_message(payload: dict[str, str]) -> None:
        """Serialize JSON control messages with binary audio output frames."""
        async with websocket_send_lock:
            await websocket.send_json(payload)

    async def send_audio_chunk(pcm_bytes: bytes) -> None:
        """Forward Gemini's raw 24kHz PCM output without re-encoding it."""
        async with websocket_send_lock:
            await websocket.send_bytes(pcm_bytes)

    async def send_control_message_if_open(payload: dict[str, str]) -> None:
        try:
            await send_control_message(payload)
        except (RuntimeError, WebSocketDisconnect):
            pass

    async def pace_gemini_audio() -> None:
        try:
            await output_pacer.run(send_audio_chunk)
        except asyncio.CancelledError:
            raise
        except (RuntimeError, WebSocketDisconnect):
            # Browser transport teardown is handled by the websocket route.
            pass

    async def forward_gemini_audio() -> None:
        """Receive complete Gemini turns continuously while browser input remains active."""
        async def forward_interruption() -> None:
            # Gemini VAD, not raw browser microphone energy, is the authority for
            # clearing scheduled playback. This prevents speaker echo from chopping
            # the interviewer's own audio.
            output_pacer.interrupt()
            await transcript_collector.on_interrupted()
            await send_control_message({"type": "interrupted", "status": "interrupted"})

        async def forward_server_event(event: GeminiLiveServerEvent) -> None:
            if event in {"turn_complete", "generation_complete"}:
                await transcript_collector.on_turn_complete()

        async def forward_transcript_event(event: GeminiTranscriptEvent) -> None:
            await transcript_collector.record_event(event)

        receive_kwargs: dict[str, Any] = {
            "on_interrupted": forward_interruption,
            "on_server_event": forward_server_event,
        }
        receiver_fn = (
            getattr(gemini_service.receive_audio_chunks, "side_effect", None)
            or gemini_service.receive_audio_chunks
        )
        with contextlib.suppress(ValueError, TypeError):
            sig = inspect.signature(receiver_fn)
            if "on_transcript_event" in sig.parameters or any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()
            ):
                receive_kwargs["on_transcript_event"] = forward_transcript_event

        try:
            async for pcm_bytes in gemini_service.receive_audio_chunks(**receive_kwargs):
                if pcm_bytes:
                    output_pacer.enqueue(pcm_bytes)
        except asyncio.CancelledError:
            raise
        except GeminiLiveOutputBacklogError:
            logger.warning("gemini_live_audio_receiver_failed category=output_backlog")
            await gemini_service.close()
            await send_control_message_if_open(
                {
                    "type": "error",
                    "message": "The AI voice service produced too much audio to play safely.",
                }
            )
        except (RuntimeError, WebSocketDisconnect):
            # The browser transport is no longer usable; normal route cleanup follows.
            pass
        except GeminiLiveConnectionError:
            logger.warning("gemini_live_audio_receiver_failed category=provider_connection")
            await gemini_service.close()
            await send_control_message_if_open(
                {
                    "type": "error",
                    "message": "The AI voice service stopped sending audio.",
                }
            )
        except Exception:
            logger.warning("gemini_live_audio_receiver_failed category=unexpected")
            await gemini_service.close()
            await send_control_message_if_open(
                {
                    "type": "error",
                    "message": "Failed to receive audio from the AI voice service.",
                }
            )

    await send_control_message({"type": "ready", "status": "ready"})
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", status.WS_1000_NORMAL_CLOSURE))

            if "text" in message:
                raw_message = message["text"]
                try:
                    data = json.loads(raw_message)
                except (json.JSONDecodeError, TypeError):
                    await send_control_message(
                        {
                            "type": "error",
                            "message": "Invalid JSON message received.",
                        }
                    )
                    continue

                if not isinstance(data, dict):
                    await send_control_message(
                        {
                            "type": "error",
                            "message": "Expected JSON object message.",
                        }
                    )
                    continue

                message_type = data.get("type")
                if message_type == "start":
                    if gemini_service.is_active:
                        await send_control_message(
                            {
                                "type": "error",
                                "message": "Gemini Live session is already started.",
                            }
                        )
                        continue

                    try:
                        logger.info("gemini_live_start_requested")
                        await gemini_service.connect()
                        if interview_session.status == "scheduled":
                            interview_session.status = "in_progress"
                            if not interview_session.started_at:
                                interview_session.started_at = utc_now()
                            database_session.commit()
                        # The receiver remains blocked on this one long-lived provider session
                        # until the browser completes microphone and recording setup. The browser
                        # then sends ``client_ready`` before it can stream any PCM, which makes
                        # the greeting and every later candidate turn use realtime input only.
                        audio_pacing_task = asyncio.create_task(pace_gemini_audio())
                        audio_forwarding_task = asyncio.create_task(forward_gemini_audio())
                        await send_control_message(
                            {
                                "type": "provider_connected",
                                "status": "provider_connected",
                            }
                        )
                    except GeminiLiveConfigurationError as error:
                        logger.warning("gemini_live_start_failed category=configuration")
                        await send_control_message({"type": "error", "message": str(error)})
                    except GeminiLiveConnectionError:
                        logger.warning("gemini_live_start_failed category=provider_connection")
                        await send_control_message(
                            {
                                "type": "error",
                                "message": (
                                    "The AI voice service could not establish a connection. "
                                    "Please try again."
                                ),
                            }
                        )
                    except Exception:
                        logger.warning("gemini_live_start_failed category=unexpected")
                        await send_control_message(
                            {
                                "type": "error",
                                "message": "Failed to connect to the AI voice service.",
                            }
                        )
                elif message_type == "client_ready":
                    if not gemini_service.is_active:
                        await send_control_message(
                            {
                                "type": "error",
                                "message": (
                                    "Cannot start the interview before the session is connected."
                                ),
                            }
                        )
                        continue
                    if initial_greeting_requested:
                        await send_control_message(
                            {
                                "type": "error",
                                "message": "The interview greeting has already started.",
                            }
                        )
                        continue

                    initial_greeting_requested = True
                    try:
                        await gemini_service.request_initial_greeting()
                    except GeminiLiveConnectionError:
                        logger.warning("gemini_live_greeting_failed category=provider_connection")
                        await send_control_message(
                            {
                                "type": "error",
                                "message": "The AI voice service could not start the interview.",
                            }
                        )
                    except Exception:
                        logger.warning("gemini_live_greeting_failed category=unexpected")
                        await send_control_message(
                            {
                                "type": "error",
                                "message": "Failed to start the AI voice interview.",
                            }
                        )
                else:
                    await send_control_message(
                        {
                            "type": "error",
                            "message": (
                                f"Unsupported or unexpected message type: {message_type!r}."
                            ),
                        }
                    )
            elif "bytes" in message:
                pcm_bytes = message["bytes"]
                if not gemini_service.is_active:
                    await send_control_message(
                        {
                            "type": "error",
                            "message": "Cannot send audio before starting the session.",
                        }
                    )
                    continue

                if not pcm_bytes:
                    await send_control_message(
                        {"type": "error", "message": "Audio chunk cannot be empty."}
                    )
                    continue

                if len(pcm_bytes) > MAX_AUDIO_CHUNK_BYTES:
                    await send_control_message(
                        {
                            "type": "error",
                            "message": "Audio chunk exceeds maximum allowed size.",
                        }
                    )
                    continue

                try:
                    await gemini_service.send_audio_chunk(pcm_bytes)
                except (GeminiLiveInputError, ValueError) as error:
                    await send_control_message({"type": "error", "message": str(error)})
                except GeminiLiveConnectionError:
                    await send_control_message(
                        {
                            "type": "error",
                            "message": "Failed to forward audio to the AI voice service.",
                        }
                    )
                except Exception:
                    await send_control_message(
                        {"type": "error", "message": "Failed to process audio chunk."}
                    )
    except WebSocketDisconnect:
        logger.info("gemini_live_websocket_disconnected")
    except Exception:
        logger.warning("gemini_live_websocket_failed category=unexpected")
    finally:
        for task in (audio_forwarding_task, audio_pacing_task):
            if task is not None:
                task.cancel()
        for task in (audio_forwarding_task, audio_pacing_task):
            if task is not None:
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        if transcript_collector is not None:
            await transcript_collector.close()
        if gemini_service is not None:
            await gemini_service.close()
        try:
            await websocket.close()
        except Exception:
            pass
