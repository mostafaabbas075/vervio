from __future__ import annotations

import pytest

from app.api.routes.realtime import GeminiLiveOutputBacklogError, GeminiPcmOutputPacer


def pcm_for_duration(milliseconds: int) -> bytes:
    """Return inert PCM-shaped bytes without placing audio content in a fixture."""
    return b"\x00" * (48 * milliseconds)


def test_output_pacer_preserves_an_eight_times_realtime_burst_until_vad_cancels_it() -> None:
    pacer = GeminiPcmOutputPacer(max_backlog_seconds=10)

    # Eight seconds of 24 kHz PCM may arrive during one second of provider output.
    for _ in range(80):
        pacer.enqueue(pcm_for_duration(100))

    assert pacer.queued_duration_seconds == pytest.approx(8.0)
    assert pacer.interrupt() == 384_000
    assert pacer.queued_duration_seconds == 0


def test_output_pacer_reports_an_explicit_error_instead_of_silently_dropping_overflow() -> None:
    pacer = GeminiPcmOutputPacer(max_backlog_seconds=0.1)

    with pytest.raises(GeminiLiveOutputBacklogError, match="safe relay capacity"):
        pacer.enqueue(pcm_for_duration(200))
