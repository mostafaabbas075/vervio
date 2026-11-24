"""Private, local development storage for completed browser recordings."""

from __future__ import annotations

import hashlib
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4


class RecordingStorageError(RuntimeError):
    """Base error for private recording storage operations."""


class RecordingTooLargeError(RecordingStorageError):
    """Raised when an upload exceeds the configured limit."""


class InvalidRecordingMediaError(RecordingStorageError):
    """Raised when upload bytes do not match the declared supported container."""


SUPPORTED_RECORDING_MEDIA_TYPES = {
    "video/webm": "webm",
    "video/mp4": "mp4",
}


@dataclass(frozen=True)
class StoredRecording:
    object_key: str
    byte_size: int
    checksum: str


def normalize_media_type(content_type: str | None) -> str | None:
    if not content_type:
        return None
    normalized = content_type.split(";", maxsplit=1)[0].strip().lower()
    return normalized if normalized in SUPPORTED_RECORDING_MEDIA_TYPES else None


def validate_container_signature(content_type: str, first_bytes: bytes) -> None:
    if content_type == "video/webm":
        is_webm = first_bytes.startswith(b"\x1a\x45\xdf\xa3") and b"webm" in first_bytes[
            :4096
        ].lower()
        if not is_webm:
            raise InvalidRecordingMediaError("The uploaded file is not a valid WebM recording.")
        return
    if content_type == "video/mp4" and len(first_bytes) >= 8 and first_bytes[4:8] == b"ftyp":
        return
    raise InvalidRecordingMediaError("The uploaded file is not a supported video recording.")


class LocalRecordingStorage:
    """Stores opaque object keys beneath one non-public local root."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def build_object_key(self, interview_session_id: str, content_type: str) -> str:
        extension = SUPPORTED_RECORDING_MEDIA_TYPES[content_type]
        return f"interviews/{interview_session_id}/{uuid4()}.{extension}"

    def path_for(self, object_key: str) -> Path:
        relative_path = Path(object_key)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise RecordingStorageError("Invalid private recording object key.")
        candidate = (self.root / relative_path).resolve()
        if self.root not in candidate.parents:
            raise RecordingStorageError("Invalid private recording object key.")
        return candidate

    async def store(
        self,
        *,
        object_key: str,
        chunks: AsyncIterator[bytes],
        content_type: str,
        maximum_bytes: int,
    ) -> StoredRecording:
        destination = self.path_for(object_key)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.{uuid4()}.upload")
        checksum = hashlib.sha256()
        first_bytes = bytearray()
        total_bytes = 0

        try:
            with temporary.open("xb") as target:
                async for chunk in chunks:
                    if not chunk:
                        continue
                    total_bytes += len(chunk)
                    if total_bytes > maximum_bytes:
                        raise RecordingTooLargeError(
                            "The recording exceeds the maximum upload size."
                        )
                    if len(first_bytes) < 4096:
                        first_bytes.extend(chunk[: 4096 - len(first_bytes)])
                    checksum.update(chunk)
                    target.write(chunk)

            if total_bytes == 0:
                raise InvalidRecordingMediaError("The recording upload is empty.")
            validate_container_signature(content_type, bytes(first_bytes))
            os.replace(temporary, destination)
            return StoredRecording(
                object_key=object_key,
                byte_size=total_bytes,
                checksum=checksum.hexdigest(),
            )
        except Exception:
            temporary.unlink(missing_ok=True)
            raise

    def delete(self, object_key: str) -> None:
        self.path_for(object_key).unlink(missing_ok=True)
