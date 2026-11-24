"""Server-side Gemini Live session management using Google GenAI SDK.

Establishes and closes low-latency bidirectional voice sessions with Gemini Live
for Vervio's German interview room.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Literal

from google import genai
from google.genai import types

from app.core.config import settings
from app.realtime.service import (
    GERMAN_INTERVIEWER_INSTRUCTIONS,
    build_german_interviewer_instructions,
)

logger = logging.getLogger(__name__)


class GeminiLiveError(RuntimeError):
    """Base error for Gemini Live service operations."""


class GeminiLiveConfigurationError(GeminiLiveError):
    """Raised when Gemini credentials or required settings are missing or invalid."""


class GeminiLiveConnectionError(GeminiLiveError):
    """Raised when establishing or communicating with Gemini Live fails."""


class GeminiLiveInputError(GeminiLiveError, ValueError):
    """Raised when input provided to Gemini Live is invalid."""


GEMINI_AUDIO_INPUT_MIME_TYPE = "audio/pcm;rate=16000"
GEMINI_AUDIO_OUTPUT_MIME_TYPE = "audio/pcm;rate=24000"
GEMINI_OUTPUT_LANGUAGE_CODE = "de"
GEMINI_LIVE_API_VERSION = "v1beta"
RECEIVE_RESTART_DELAY_SECONDS = 0.01
GeminiLiveServerEvent = Literal[
    "interrupted",
    "interim_input_transcription",
    "input_transcription",
    "output_transcription",
    "generation_complete",
    "turn_complete",
    "waiting_for_input",
]


@dataclass(frozen=True)
class GeminiTranscriptEvent:
    """Internal transcript event extracted from Gemini Live speech recognition.

    Never logs transcript text, raw audio, or API credentials.
    """

    speaker: Literal["candidate", "interviewer"]
    text: str
    is_final: bool
    start_offset: str | None = None
    end_offset: str | None = None
    finished: bool | None = None


def extract_transcription_payload(
    transcription_obj: Any,
) -> tuple[str | None, bool | None, str | None, str | None]:
    """Extract text and timing metadata from a Gemini Transcription payload.

    Returns (text, finished, start_offset, end_offset).
    Never logs or prints transcription text.
    """
    if transcription_obj is None:
        return None, None, None, None

    if isinstance(transcription_obj, str):
        text = transcription_obj.strip()
        return (text if text else None), None, None, None

    if isinstance(transcription_obj, dict):
        text = transcription_obj.get("text")
        finished = transcription_obj.get("finished")
        start_offset = transcription_obj.get("start_offset") or transcription_obj.get("startOffset")
        end_offset = transcription_obj.get("end_offset") or transcription_obj.get("endOffset")
    else:
        text = getattr(transcription_obj, "text", None)
        finished = getattr(transcription_obj, "finished", None)
        start_offset = getattr(transcription_obj, "start_offset", None)
        end_offset = getattr(transcription_obj, "end_offset", None)

    if isinstance(text, str):
        text = text.strip()
        if not text:
            text = None
    else:
        text = None

    if finished is not None and not isinstance(finished, bool):
        finished = bool(finished)

    return (
        text,
        finished,
        str(start_offset) if start_offset is not None else None,
        str(end_offset) if end_offset is not None else None,
    )
INITIAL_INTERVIEW_GREETING_TRIGGER = (
    "Beginne das Interview jetzt mit einer kurzen, natürlichen Begrüßung auf Deutsch "
    "und stelle anschließend die erste offene Frage."
)


def provider_failure_diagnostics(error: BaseException) -> tuple[str, int | None]:
    """Return non-sensitive diagnostics for a provider exception.

    Provider exception text can contain request data, so logs intentionally retain
    only the exception class and a valid HTTP-style status code when one exists.
    """
    status_code = getattr(error, "code", None)
    if isinstance(status_code, int) and 100 <= status_code <= 599:
        return type(error).__name__, status_code
    return type(error).__name__, None


def log_provider_failure(operation: str, error: BaseException) -> None:
    """Log a safe Gemini provider failure category without exception text."""
    error_category, status_code = provider_failure_diagnostics(error)
    logger.warning(
        "gemini_live_provider_failure operation=%s error_category=%s provider_status_code=%s",
        operation,
        error_category,
        status_code if status_code is not None else "unknown",
    )


def build_gemini_live_config(
    *,
    instructions: str | None = GERMAN_INTERVIEWER_INSTRUCTIONS,
    required_german_level: str | None = None,
    voice_name: str | None = None,
    enable_input_audio_transcription: bool = True,
    enable_output_audio_transcription: bool = True,
) -> types.LiveConnectConfig:
    """Build the configuration for a Gemini Live session with audio output and transcription."""
    if instructions == GERMAN_INTERVIEWER_INSTRUCTIONS:
        instructions = build_german_interviewer_instructions(required_german_level)
    system_instruction = None
    if instructions:
        system_instruction = types.Content(parts=[types.Part.from_text(text=instructions)])

    # The installed Google GenAI SDK exposes ``language_code`` for speech synthesis.
    # This server-side setting reinforces the German-only interviewer instruction;
    # it does not change the model or translate candidate input.
    speech_config = types.SpeechConfig(
        language_code=GEMINI_OUTPUT_LANGUAGE_CODE,
        voice_config=(
            types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)
            )
            if voice_name
            else None
        ),
    )

    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=system_instruction,
        speech_config=speech_config,
        # Keep server-side VAD enabled and make the intended default explicit.
        # Realtime microphone input therefore creates subsequent turns without
        # client-provided activity markers, while real candidate speech can
        # interrupt an active model response (barge-in).
        realtime_input_config=types.RealtimeInputConfig(
            automatic_activity_detection=types.AutomaticActivityDetection(disabled=False),
            activity_handling=types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
        ),
        input_audio_transcription=(
            types.AudioTranscriptionConfig()
            if enable_input_audio_transcription
            else None
        ),
        output_audio_transcription=(
            types.AudioTranscriptionConfig()
            if enable_output_audio_transcription
            else None
        ),
    )


class GeminiLiveService:
    """Manages the lifecycle of a Gemini Live API session."""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        model: str | None = None,
        config: types.LiveConnectConfig | None = None,
        client: genai.Client | None = None,
        required_german_level: str | None = None,
    ) -> None:
        self.api_key = api_key if api_key is not None else settings.gemini_api_key
        self.model = model if model is not None else settings.gemini_live_model
        self._uses_default_config = config is None
        self.required_german_level = required_german_level
        self.config = config or self._build_default_config()
        self._client = client
        self._cm: Any | None = None
        self.session: Any | None = None
        self.transcript_events: list[GeminiTranscriptEvent] = []
        self._last_emitted_event: dict[str, GeminiTranscriptEvent | None] = {
            "candidate": None,
            "interviewer": None,
        }

    def _build_default_config(self) -> types.LiveConnectConfig:
        return build_gemini_live_config(
            required_german_level=self.required_german_level,
            enable_input_audio_transcription=True,
            enable_output_audio_transcription=True,
        )

    def configure_required_german_level(self, required_german_level: str | None) -> None:
        """Set the optional CEFR target before opening this Live session."""
        if self.is_active:
            raise GeminiLiveConfigurationError(
                "Cannot configure the interview level after the Gemini Live session starts."
            )
        self.required_german_level = required_german_level
        if self._uses_default_config:
            self.config = self._build_default_config()

    @property
    def stable_transcript_events(self) -> list[GeminiTranscriptEvent]:
        """Return only stable (non-interim) transcript events collected so far."""
        return [e for e in self.transcript_events if e.is_final]

    @property
    def is_active(self) -> bool:
        """Return True if an active Live session is currently established."""
        return self.session is not None

    async def connect(self) -> Any:
        """Establish a new Gemini Live bidirectional session."""
        if not self.api_key or not self.api_key.strip():
            raise GeminiLiveConfigurationError("Gemini API key is not configured.")
        if not self.model or not self.model.strip():
            raise GeminiLiveConfigurationError("Gemini Live model is not configured.")

        # The Google GenAI SDK defaults Google AI requests to v1, while the
        # current Gemini Live API connection flow for gemini-3.8-live uses v1beta.
        # Set it explicitly so Live sessions do not depend on an SDK default.
        client = self._client or genai.Client(
            api_key=self.api_key.strip(),
            http_options=types.HttpOptions(api_version=GEMINI_LIVE_API_VERSION),
        )
        try:
            cm = client.aio.live.connect(model=self.model.strip(), config=self.config)
            session = await cm.__aenter__()
        except GeminiLiveConfigurationError:
            raise
        except Exception as error:
            log_provider_failure("connect", error)
            await self.close()
            raise GeminiLiveConnectionError(
                "The AI voice service could not establish a connection."
            ) from error

        self._cm = cm
        self.session = session
        return session

    async def send_audio_chunk(self, pcm_bytes: bytes | bytearray) -> None:
        """Send a raw 16-bit mono 16kHz PCM audio chunk to the active Gemini Live session."""
        if not pcm_bytes:
            raise GeminiLiveInputError("Audio chunk cannot be empty.")
        if not isinstance(pcm_bytes, (bytes, bytearray)):
            raise GeminiLiveInputError("Audio chunk must be bytes or bytearray.")
        if self.session is None or not self.is_active:
            raise GeminiLiveConnectionError(
                "Cannot send audio without an active Gemini Live session."
            )

        try:
            await self.session.send_realtime_input(
                audio=types.Blob(
                    data=bytes(pcm_bytes),
                    mime_type=GEMINI_AUDIO_INPUT_MIME_TYPE,
                )
            )
        except GeminiLiveError:
            raise
        except Exception as error:
            log_provider_failure("send_audio", error)
            raise GeminiLiveConnectionError(
                "Failed to send audio to the AI voice service."
            ) from error

    async def request_initial_greeting(self) -> None:
        """Start the interview using the same realtime input mode as microphone audio.

        Gemini Live explicitly cautions against interleaving turn-based
        ``send_client_content`` calls with ``send_realtime_input`` calls.  The
        interview is a continuous voice interaction, so the opening prompt is
        sent as realtime text and every later candidate chunk is sent as
        realtime audio on this one session.
        """
        if self.session is None or not self.is_active:
            raise GeminiLiveConnectionError(
                "Cannot start an interview without an active Gemini Live session."
            )

        try:
            await self.session.send_realtime_input(text=INITIAL_INTERVIEW_GREETING_TRIGGER)
        except GeminiLiveError:
            raise
        except Exception as error:
            log_provider_failure("request_initial_greeting", error)
            raise GeminiLiveConnectionError(
                "Failed to start the AI voice interview."
            ) from error

    async def receive_audio_chunks(
        self,
        *,
        on_interrupted: Callable[[], Awaitable[None]] | None = None,
        on_server_event: Callable[[GeminiLiveServerEvent], Awaitable[None]] | None = None,
        on_transcript_event: Callable[[GeminiTranscriptEvent], Awaitable[None]] | None = None,
    ) -> AsyncIterator[bytes]:
        """Yield model audio across successive complete Gemini Live turns.

        The Google GenAI SDK documents ``session.receive()`` as an async iterator for a
        complete model turn. Once that iterator ends, the active session remains usable,
        so a new receive iterator is opened for the next conversational turn. A short
        cooperative delay prevents an unexpected empty iterator from becoming a hot loop.
        """
        if self.session is None or not self.is_active:
            raise GeminiLiveConnectionError(
                "Cannot receive audio without an active Gemini Live session."
            )

        try:
            while self.is_active and self.session is not None:
                receiver = self.session.receive()
                async for response in receiver:
                    server_content = (
                        response.get("server_content")
                        if isinstance(response, dict)
                        else getattr(response, "server_content", None)
                    )
                    if server_content is None:
                        continue

                    def get_server_content_field(field_name: str) -> Any:
                        if isinstance(server_content, dict):
                            return server_content.get(field_name)
                        return getattr(server_content, field_name, None)

                    async def report_server_event(event: GeminiLiveServerEvent) -> None:
                        if on_server_event is not None:
                            await on_server_event(event)

                    async def emit_transcript_event(event: GeminiTranscriptEvent) -> None:
                        # Deduplicate consecutive identical updates for the same speaker and state
                        last = self._last_emitted_event.get(event.speaker)
                        if (
                            last is not None
                            and last.text == event.text
                            and last.is_final == event.is_final
                        ):
                            return

                        self._last_emitted_event[event.speaker] = event
                        self.transcript_events.append(event)
                        if on_transcript_event is not None:
                            await on_transcript_event(event)

                    # Diagnostic server events for VAD and state tracking
                    if get_server_content_field("interim_input_transcription") is not None:
                        await report_server_event("interim_input_transcription")
                    if get_server_content_field("input_transcription") is not None:
                        await report_server_event("input_transcription")
                    if get_server_content_field("output_transcription") is not None:
                        await report_server_event("output_transcription")
                    if get_server_content_field("generation_complete"):
                        await report_server_event("generation_complete")
                    if get_server_content_field("turn_complete"):
                        await report_server_event("turn_complete")
                    if get_server_content_field("waiting_for_input"):
                        await report_server_event("waiting_for_input")

                    # Extract candidate transcription:
                    # 1. Interim updates (partial / low-latency while candidate is speaking)
                    interim_input = get_server_content_field("interim_input_transcription")
                    if interim_input is not None:
                        text, finished, start_off, end_off = extract_transcription_payload(
                            interim_input
                        )
                        if text:
                            await emit_transcript_event(
                                GeminiTranscriptEvent(
                                    speaker="candidate",
                                    text=text,
                                    is_final=False,
                                    start_offset=start_off,
                                    end_offset=end_off,
                                    finished=finished,
                                )
                            )

                    # 2. Stable candidate transcription (speech boundary / VAD endpoint)
                    stable_input = get_server_content_field("input_transcription")
                    if stable_input is not None:
                        text, finished, start_off, end_off = extract_transcription_payload(
                            stable_input
                        )
                        if text:
                            await emit_transcript_event(
                                GeminiTranscriptEvent(
                                    speaker="candidate",
                                    text=text,
                                    is_final=True,
                                    start_offset=start_off,
                                    end_offset=end_off,
                                    finished=finished,
                                )
                            )

                    # 3. Stable interviewer transcription (model speech output)
                    stable_output = get_server_content_field("output_transcription")
                    if stable_output is not None:
                        text, finished, start_off, end_off = extract_transcription_payload(
                            stable_output
                        )
                        if text:
                            await emit_transcript_event(
                                GeminiTranscriptEvent(
                                    speaker="interviewer",
                                    text=text,
                                    is_final=True,
                                    start_offset=start_off,
                                    end_offset=end_off,
                                    finished=finished,
                                )
                            )

                    interrupted = get_server_content_field("interrupted")
                    if interrupted:
                        self._last_emitted_event["interviewer"] = None
                        if on_interrupted is not None:
                            await on_interrupted()
                        await report_server_event("interrupted")
                        # Gemini documents that audio from an interrupted model turn
                        # is discarded. Do not forward a stale part if it accompanies
                        # the interruption event.
                        continue

                    model_turn = get_server_content_field("model_turn")
                    if model_turn is None:
                        continue

                    parts = (
                        model_turn.get("parts")
                        if isinstance(model_turn, dict)
                        else getattr(model_turn, "parts", None)
                    )
                    if not parts:
                        continue

                    for part in parts:
                        inline_data = (
                            part.get("inline_data")
                            if isinstance(part, dict)
                            else getattr(part, "inline_data", None)
                        )
                        if inline_data is None:
                            continue

                        raw_data = (
                            inline_data.get("data")
                            if isinstance(inline_data, dict)
                            else getattr(inline_data, "data", None)
                        )
                        if not raw_data:
                            continue

                        mime_type = (
                            inline_data.get("mime_type")
                            if isinstance(inline_data, dict)
                            else getattr(inline_data, "mime_type", None)
                        )
                        if mime_type and not str(mime_type).startswith("audio"):
                            continue

                        if isinstance(raw_data, (bytes, bytearray)):
                            yield bytes(raw_data)
                        elif isinstance(raw_data, str):
                            try:
                                decoded = base64.b64decode(raw_data)
                                if decoded:
                                    yield decoded
                            except Exception:
                                continue

                if self.is_active:
                    await asyncio.sleep(RECEIVE_RESTART_DELAY_SECONDS)
        except asyncio.CancelledError:
            raise
        except GeminiLiveError:
            raise
        except Exception as error:
            log_provider_failure("receive_audio", error)
            raise GeminiLiveConnectionError(
                "Failed to receive audio from the AI voice service."
            ) from error

    async def close(self) -> None:
        """Safely close and clean up the active Live session."""
        session = self.session
        cm = self._cm
        self.session = None
        self._cm = None

        if session is not None:
            try:
                await session.close()
            except Exception:
                pass

        if cm is not None:
            try:
                await cm.__aexit__(None, None, None)
            except Exception:
                pass

    async def __aenter__(self) -> Any:
        return await self.connect()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()

    def __repr__(self) -> str:
        return f"GeminiLiveService(model={self.model!r}, is_active={self.is_active})"


@contextlib.asynccontextmanager
async def open_gemini_live_session(
    *,
    api_key: str | None = None,
    model: str | None = None,
    config: types.LiveConnectConfig | None = None,
    client: genai.Client | None = None,
) -> AsyncIterator[Any]:
    """Context manager for opening and automatically closing a Gemini Live session."""
    service = GeminiLiveService(
        api_key=api_key,
        model=model,
        config=config,
        client=client,
    )
    async with service as session:
        yield session

