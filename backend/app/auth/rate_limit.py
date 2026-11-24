from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field
from threading import Lock
from time import monotonic

MAX_FAILURES = 5
WINDOW_SECONDS = 15 * 60
BLOCK_SECONDS = 15 * 60


@dataclass
class AttemptState:
    failures: deque[float] = field(default_factory=deque)
    blocked_until: float = 0.0


class LoginAttemptLimiter:
    """Small in-memory throttle suitable for the single-process demo MVP."""

    def __init__(self) -> None:
        self._attempts: defaultdict[str, AttemptState] = defaultdict(AttemptState)
        self._lock = Lock()

    def is_blocked(self, key: str) -> bool:
        now = monotonic()
        with self._lock:
            state = self._attempts[key]
            return state.blocked_until > now

    def record_failure(self, key: str) -> None:
        now = monotonic()
        with self._lock:
            state = self._attempts[key]
            while state.failures and state.failures[0] <= now - WINDOW_SECONDS:
                state.failures.popleft()
            state.failures.append(now)
            if len(state.failures) >= MAX_FAILURES:
                state.blocked_until = now + BLOCK_SECONDS
                state.failures.clear()

    def reset(self, key: str) -> None:
        with self._lock:
            self._attempts.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._attempts.clear()


login_attempt_limiter = LoginAttemptLimiter()

