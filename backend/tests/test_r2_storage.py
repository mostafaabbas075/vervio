from __future__ import annotations

import io
from collections.abc import AsyncIterator
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError

from app.core.config import Settings
from app.recordings.local_storage import (
    InvalidRecordingMediaError,
    RecordingStorageError,
    RecordingTooLargeError,
)
from app.recordings.r2_storage import (
    CLOUDFLARE_R2_REGION,
    CloudflareR2ConfigurationError,
    CloudflareR2Storage,
    build_r2_endpoint_url,
    create_r2_storage_from_settings,
)


def valid_webm_bytes() -> bytes:
    """A valid container signature prefix for WebM fixtures."""
    return b"\x1a\x45\xdf\xa3\x93B\x82webm" + (b"\x00" * 32)


async def chunks_for(*values: bytes) -> AsyncIterator[bytes]:
    for value in values:
        yield value


def create_mock_storage() -> tuple[CloudflareR2Storage, MagicMock]:
    mock_s3 = MagicMock()
    storage = CloudflareR2Storage(
        account_id="mock-account-12345",
        bucket_name="mock-recordings-bucket",
        access_key_id="mock-access-key-id",
        secret_access_key="mock-secret-access-key",
        client=mock_s3,
    )
    return storage, mock_s3


def test_settings_storage_provider_defaults_and_validation() -> None:
    settings = Settings(_env_file=None)
    assert settings.storage_provider == "local"
    assert settings.r2_account_id is None
    assert settings.r2_endpoint_url is None

    r2_settings = Settings(
        _env_file=None,
        storage_provider="cloudflare_r2",
        r2_account_id="test-account-id",
        r2_bucket_name="test-bucket",
        r2_access_key_id="test-key",
        r2_secret_access_key="test-secret",
    )
    assert r2_settings.storage_provider == "cloudflare_r2"
    assert r2_settings.r2_endpoint_url == "https://test-account-id.r2.cloudflarestorage.com"

    with pytest.raises(ValueError, match="Unsupported storage provider"):
        Settings(storage_provider="aws_s3")


def test_build_r2_endpoint_url() -> None:
    assert (
        build_r2_endpoint_url("abc123def456")
        == "https://abc123def456.r2.cloudflarestorage.com"
    )
    assert (
        build_r2_endpoint_url("  spaced-account  ")
        == "https://spaced-account.r2.cloudflarestorage.com"
    )
    with pytest.raises(CloudflareR2ConfigurationError, match="must not be empty"):
        build_r2_endpoint_url("   ")


def test_cloudflare_r2_configuration_errors() -> None:
    # Missing account ID
    with pytest.raises(CloudflareR2ConfigurationError, match="missing required account ID"):
        CloudflareR2Storage(
            account_id="",
            bucket_name="b",
            access_key_id="k",
            secret_access_key="s",
        )

    # Missing bucket name
    with pytest.raises(CloudflareR2ConfigurationError, match="missing required bucket name"):
        CloudflareR2Storage(
            account_id="a",
            bucket_name="",
            access_key_id="k",
            secret_access_key="s",
        )

    # Missing access key ID
    with pytest.raises(CloudflareR2ConfigurationError, match="missing required access key ID"):
        CloudflareR2Storage(
            account_id="a",
            bucket_name="b",
            access_key_id="",
            secret_access_key="s",
        )

    # Missing secret access key
    with pytest.raises(CloudflareR2ConfigurationError, match="missing required secret access key"):
        CloudflareR2Storage(
            account_id="a",
            bucket_name="b",
            access_key_id="k",
            secret_access_key="",
        )

    # From empty settings
    with pytest.raises(CloudflareR2ConfigurationError):
        create_r2_storage_from_settings(Settings(_env_file=None))


def test_build_object_key_and_validation() -> None:
    storage, _ = create_mock_storage()
    session_id = str(uuid4())

    webm_key = storage.build_object_key(session_id, "video/webm")
    assert webm_key.startswith(f"interviews/{session_id}/")
    assert webm_key.endswith(".webm")

    mp4_key = storage.build_object_key(session_id, "video/mp4")
    assert mp4_key.startswith(f"interviews/{session_id}/")
    assert mp4_key.endswith(".mp4")

    with pytest.raises(InvalidRecordingMediaError, match="Unsupported recording content type"):
        storage.build_object_key(session_id, "audio/mp3")

    # Path traversal rejection
    with pytest.raises(RecordingStorageError, match="Invalid private recording object key"):
        storage.validate_object_key("../escaped.webm")
    with pytest.raises(RecordingStorageError, match="Invalid private recording object key"):
        storage.validate_object_key("/absolute/key.webm")
    with pytest.raises(RecordingStorageError, match="Invalid private recording object key"):
        storage.validate_object_key("")


@pytest.mark.anyio
async def test_r2_store_successful() -> None:
    storage, mock_s3 = create_mock_storage()
    data = valid_webm_bytes()
    object_key = storage.build_object_key(str(uuid4()), "video/webm")

    stored = await storage.store(
        object_key=object_key,
        chunks=chunks_for(data),
        content_type="video/webm",
        maximum_bytes=100_000,
    )

    assert stored.object_key == object_key
    assert stored.byte_size == len(data)
    assert len(stored.checksum) == 64  # SHA-256 hex string

    mock_s3.put_object.assert_called_once_with(
        Bucket="mock-recordings-bucket",
        Key=object_key,
        Body=data,
        ContentType="video/webm",
    )


@pytest.mark.anyio
async def test_r2_store_rejects_empty_media() -> None:
    storage, mock_s3 = create_mock_storage()
    object_key = storage.build_object_key(str(uuid4()), "video/webm")

    with pytest.raises(InvalidRecordingMediaError, match="empty"):
        await storage.store(
            object_key=object_key,
            chunks=chunks_for(b""),
            content_type="video/webm",
            maximum_bytes=100_000,
        )

    mock_s3.put_object.assert_not_called()


@pytest.mark.anyio
async def test_r2_store_rejects_invalid_media_signature() -> None:
    storage, mock_s3 = create_mock_storage()
    object_key = storage.build_object_key(str(uuid4()), "video/webm")

    with pytest.raises(InvalidRecordingMediaError, match="not a valid WebM recording"):
        await storage.store(
            object_key=object_key,
            chunks=chunks_for(b"plain text audio stream that is not webm"),
            content_type="video/webm",
            maximum_bytes=100_000,
        )

    mock_s3.put_object.assert_not_called()


@pytest.mark.anyio
async def test_r2_store_rejects_oversized_media() -> None:
    storage, mock_s3 = create_mock_storage()
    object_key = storage.build_object_key(str(uuid4()), "video/webm")

    with pytest.raises(RecordingTooLargeError, match="exceeds the maximum upload size"):
        await storage.store(
            object_key=object_key,
            chunks=chunks_for(valid_webm_bytes()),
            content_type="video/webm",
            maximum_bytes=10,
        )

    mock_s3.put_object.assert_not_called()


@pytest.mark.anyio
async def test_r2_store_handles_client_error() -> None:
    storage, mock_s3 = create_mock_storage()
    mock_s3.put_object.side_effect = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "Access Denied"}},
        "PutObject",
    )
    object_key = storage.build_object_key(str(uuid4()), "video/webm")

    with pytest.raises(RecordingStorageError, match="Failed to store private recording"):
        await storage.store(
            object_key=object_key,
            chunks=chunks_for(valid_webm_bytes()),
            content_type="video/webm",
            maximum_bytes=100_000,
        )


def test_r2_get_object_and_read_bytes_successful() -> None:
    storage, mock_s3 = create_mock_storage()
    payload = valid_webm_bytes()
    mock_s3.get_object.return_value = {
        "Body": io.BytesIO(payload),
        "ContentType": "video/webm",
        "ContentLength": len(payload),
    }

    object_key = "interviews/session-123/abc.webm"
    result = storage.get_object(object_key)
    assert result["ContentType"] == "video/webm"

    # Reset stream for read_bytes
    mock_s3.get_object.return_value = {
        "Body": io.BytesIO(payload),
        "ContentType": "video/webm",
    }
    bytes_result = storage.read_bytes(object_key)
    assert bytes_result == payload
    mock_s3.get_object.assert_called_with(
        Bucket="mock-recordings-bucket",
        Key=object_key,
    )


def test_r2_get_object_handles_client_error() -> None:
    storage, mock_s3 = create_mock_storage()
    mock_s3.get_object.side_effect = ClientError(
        {"Error": {"Code": "NoSuchKey", "Message": "Key not found"}},
        "GetObject",
    )

    with pytest.raises(RecordingStorageError, match="Failed to retrieve private recording"):
        storage.get_object("interviews/session-123/missing.webm")


def test_r2_delete_successful() -> None:
    storage, mock_s3 = create_mock_storage()
    object_key = "interviews/session-123/to-delete.webm"

    storage.delete(object_key)
    mock_s3.delete_object.assert_called_once_with(
        Bucket="mock-recordings-bucket",
        Key=object_key,
    )


def test_r2_delete_handles_client_error() -> None:
    storage, mock_s3 = create_mock_storage()
    mock_s3.delete_object.side_effect = ClientError(
        {"Error": {"Code": "InternalError", "Message": "Service unavailable"}},
        "DeleteObject",
    )

    with pytest.raises(RecordingStorageError, match="Failed to delete private recording"):
        storage.delete("interviews/session-123/failed-delete.webm")


def test_r2_credentials_safety() -> None:
    storage, _ = create_mock_storage()
    representation = repr(storage)
    assert "mock-recordings-bucket" in representation
    assert "mock-account-12345" in representation
    assert "mock-access-key-id" not in representation
    assert "mock-secret-access-key" not in representation
    assert CLOUDFLARE_R2_REGION == "auto"
