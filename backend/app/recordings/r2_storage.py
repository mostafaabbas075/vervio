"""Cloudflare R2 private storage adapter using boto3 and the S3-compatible API."""

from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator
from typing import Any
from uuid import uuid4

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.core.config import Settings, settings
from app.recordings.local_storage import (
    SUPPORTED_RECORDING_MEDIA_TYPES,
    InvalidRecordingMediaError,
    RecordingStorageError,
    RecordingTooLargeError,
    StoredRecording,
    validate_container_signature,
)

CLOUDFLARE_R2_REGION = "auto"


class CloudflareR2ConfigurationError(RecordingStorageError):
    """Raised when Cloudflare R2 credentials or settings are missing or invalid."""


def build_r2_endpoint_url(account_id: str) -> str:
    """Build the official S3-compatible Cloudflare R2 endpoint URL."""
    cleaned = account_id.strip()
    if not cleaned:
        raise CloudflareR2ConfigurationError("Cloudflare R2 account ID must not be empty.")
    return f"https://{cleaned}.r2.cloudflarestorage.com"


class CloudflareR2Storage:
    """Stores opaque object keys in a private Cloudflare R2 bucket via S3 API."""

    def __init__(
        self,
        *,
        account_id: str | None = None,
        bucket_name: str | None = None,
        access_key_id: str | None = None,
        secret_access_key: str | None = None,
        client: Any | None = None,
    ) -> None:
        self.account_id = (account_id or "").strip()
        self.bucket_name = (bucket_name or "").strip()
        self.access_key_id = (access_key_id or "").strip()
        self.secret_access_key = (secret_access_key or "").strip()

        if not self.account_id:
            raise CloudflareR2ConfigurationError(
                "Cloudflare R2 storage is missing required account ID."
            )
        if not self.bucket_name:
            raise CloudflareR2ConfigurationError(
                "Cloudflare R2 storage is missing required bucket name."
            )
        if not self.access_key_id:
            raise CloudflareR2ConfigurationError(
                "Cloudflare R2 storage is missing required access key ID."
            )
        if not self.secret_access_key:
            raise CloudflareR2ConfigurationError(
                "Cloudflare R2 storage is missing required secret access key."
            )

        self.endpoint_url = build_r2_endpoint_url(self.account_id)

        if client is not None:
            self._client = client
        else:
            self._client = boto3.client(
                "s3",
                endpoint_url=self.endpoint_url,
                aws_access_key_id=self.access_key_id,
                aws_secret_access_key=self.secret_access_key,
                region_name=CLOUDFLARE_R2_REGION,
                config=Config(signature_version="s3v4"),
            )

    @property
    def client(self) -> Any:
        return self._client

    def build_object_key(self, interview_session_id: str, content_type: str) -> str:
        if content_type not in SUPPORTED_RECORDING_MEDIA_TYPES:
            raise InvalidRecordingMediaError(
                f"Unsupported recording content type: {content_type!r}"
            )
        extension = SUPPORTED_RECORDING_MEDIA_TYPES[content_type]
        return f"interviews/{interview_session_id}/{uuid4()}.{extension}"

    def validate_object_key(self, object_key: str) -> str:
        key = object_key.strip()
        if not key or key.startswith("/") or ".." in key.split("/"):
            raise RecordingStorageError("Invalid private recording object key.")
        return key

    async def store(
        self,
        *,
        object_key: str,
        chunks: AsyncIterator[bytes],
        content_type: str,
        maximum_bytes: int,
    ) -> StoredRecording:
        validated_key = self.validate_object_key(object_key)
        checksum = hashlib.sha256()
        first_bytes = bytearray()
        buffer = bytearray()
        total_bytes = 0

        async for chunk in chunks:
            if not chunk:
                continue
            total_bytes += len(chunk)
            if total_bytes > maximum_bytes:
                raise RecordingTooLargeError("The recording exceeds the maximum upload size.")
            if len(first_bytes) < 4096:
                first_bytes.extend(chunk[: 4096 - len(first_bytes)])
            checksum.update(chunk)
            buffer.extend(chunk)

        if total_bytes == 0:
            raise InvalidRecordingMediaError("The recording upload is empty.")

        validate_container_signature(content_type, bytes(first_bytes))

        try:
            self.client.put_object(
                Bucket=self.bucket_name,
                Key=validated_key,
                Body=bytes(buffer),
                ContentType=content_type,
            )
        except (BotoCoreError, ClientError) as error:
            raise RecordingStorageError(
                "Failed to store private recording in Cloudflare R2."
            ) from error
        except Exception as error:
            raise RecordingStorageError(
                "Unexpected error storing private recording in Cloudflare R2."
            ) from error

        return StoredRecording(
            object_key=validated_key,
            byte_size=total_bytes,
            checksum=checksum.hexdigest(),
        )

    def get_object(self, object_key: str) -> dict[str, Any]:
        validated_key = self.validate_object_key(object_key)
        try:
            return self.client.get_object(
                Bucket=self.bucket_name,
                Key=validated_key,
            )
        except (BotoCoreError, ClientError) as error:
            raise RecordingStorageError(
                "Failed to retrieve private recording from Cloudflare R2."
            ) from error
        except Exception as error:
            raise RecordingStorageError(
                "Unexpected error retrieving private recording from Cloudflare R2."
            ) from error

    def read_bytes(self, object_key: str) -> bytes:
        response = self.get_object(object_key)
        body = response.get("Body")
        if body is None:
            return b""
        if hasattr(body, "read"):
            return body.read()
        if isinstance(body, (bytes, bytearray)):
            return bytes(body)
        raise RecordingStorageError("Unexpected response body type from Cloudflare R2.")

    def delete(self, object_key: str) -> None:
        validated_key = self.validate_object_key(object_key)
        try:
            self.client.delete_object(
                Bucket=self.bucket_name,
                Key=validated_key,
            )
        except (BotoCoreError, ClientError) as error:
            raise RecordingStorageError(
                "Failed to delete private recording from Cloudflare R2."
            ) from error
        except Exception as error:
            raise RecordingStorageError(
                "Unexpected error deleting private recording from Cloudflare R2."
            ) from error

    def __repr__(self) -> str:
        return f"CloudflareR2Storage(bucket={self.bucket_name!r}, endpoint={self.endpoint_url!r})"


def create_r2_storage_from_settings(cfg: Settings | None = None) -> CloudflareR2Storage:
    active_settings = cfg or settings
    return CloudflareR2Storage(
        account_id=active_settings.r2_account_id,
        bucket_name=active_settings.r2_bucket_name,
        access_key_id=active_settings.r2_access_key_id,
        secret_access_key=active_settings.r2_secret_access_key,
    )
