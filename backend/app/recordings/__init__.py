"""Private recording storage adapters for the Vervio demo."""

from app.recordings.local_storage import (
    SUPPORTED_RECORDING_MEDIA_TYPES,
    InvalidRecordingMediaError,
    LocalRecordingStorage,
    RecordingStorageError,
    RecordingTooLargeError,
    StoredRecording,
    normalize_media_type,
    validate_container_signature,
)
from app.recordings.r2_storage import (
    CLOUDFLARE_R2_REGION,
    CloudflareR2ConfigurationError,
    CloudflareR2Storage,
    build_r2_endpoint_url,
    create_r2_storage_from_settings,
)

__all__ = [
    "CLOUDFLARE_R2_REGION",
    "CloudflareR2ConfigurationError",
    "CloudflareR2Storage",
    "InvalidRecordingMediaError",
    "LocalRecordingStorage",
    "RecordingStorageError",
    "RecordingTooLargeError",
    "SUPPORTED_RECORDING_MEDIA_TYPES",
    "StoredRecording",
    "build_r2_endpoint_url",
    "create_r2_storage_from_settings",
    "normalize_media_type",
    "validate_container_signature",
]
