from __future__ import annotations

import asyncio
import io
from collections.abc import AsyncIterator, Generator
from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError
from fastapi import HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import select
from sqlalchemy.orm import Session
from starlette.requests import Request

from app.api.routes import recordings
from app.api.routes.recordings import get_recording, stream_recording_content, upload_recording
from app.auth.dependencies import AuthContext, require_csrf, require_roles, require_trusted_origin
from app.auth.security import create_opaque_token, token_hash, utc_now
from app.db.session import create_database_engine
from app.models import AuthSession, Base, Candidate, InterviewSession, Recording, User
from app.recordings import (
    CloudflareR2Storage,
    InvalidRecordingMediaError,
    LocalRecordingStorage,
    RecordingStorageError,
    RecordingTooLargeError,
)

TRUSTED_ORIGIN = "http://localhost:3000"


def valid_webm_bytes() -> bytes:
    """A container header only; fixtures never contain interview media."""
    return b"\x1a\x45\xdf\xa3\x93B\x82webm" + (b"\x00" * 32)


async def chunks_for(*values: bytes) -> AsyncIterator[bytes]:
    for value in values:
        yield value


def upload_request(*, body: bytes, content_type: str, origin: str = TRUSTED_ORIGIN) -> Request:
    delivered = False

    async def receive() -> dict[str, object]:
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/interviews/recording",
            "raw_path": b"/interviews/recording",
            "query_string": b"",
            "headers": [
                (b"content-type", content_type.encode()),
                (b"content-length", str(len(body)).encode()),
                (b"origin", origin.encode()),
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("testserver", 80),
        },
        receive,
    )


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


def create_authorized_admin(database_session: Session) -> AuthContext:
    user = User(
        email="recording-admin@example.test",
        full_name="Recording Administrator",
        password_hash="not-used-by-recording-tests",
        role="admin",
    )
    database_session.add(user)
    database_session.flush()
    session_token = create_opaque_token()
    csrf_token = create_opaque_token()
    auth_session = AuthSession(
        user_id=user.id,
        token_hash=token_hash(session_token),
        csrf_token_hash=token_hash(csrf_token),
        expires_at=utc_now() + timedelta(hours=1),
        last_seen_at=utc_now(),
    )
    database_session.add(auth_session)
    database_session.commit()
    return AuthContext(user=user, session=auth_session)


def create_interview(database_session: Session) -> InterviewSession:
    candidate = Candidate(
        email="recording-candidate@example.test",
        given_name="Demo",
        family_name="Candidate",
    )
    database_session.add(candidate)
    database_session.flush()
    interview = InterviewSession(candidate_id=candidate.id, status="scheduled", language="de")
    database_session.add(interview)
    database_session.commit()
    return interview


def test_private_storage_rejects_invalid_media_and_respects_size_limit(tmp_path: Path) -> None:
    storage = LocalRecordingStorage(tmp_path)
    object_key = storage.build_object_key(str(uuid4()), "video/webm")

    with pytest.raises(InvalidRecordingMediaError):
        asyncio.run(
            storage.store(
                object_key=object_key,
                chunks=chunks_for(b"not a video"),
                content_type="video/webm",
                maximum_bytes=1_000,
            )
        )
    assert not storage.path_for(object_key).exists()

    with pytest.raises(RecordingTooLargeError):
        asyncio.run(
            storage.store(
                object_key=object_key,
                chunks=chunks_for(valid_webm_bytes()),
                content_type="video/webm",
                maximum_bytes=8,
            )
        )
    assert not storage.path_for(object_key).exists()


def test_private_storage_uses_opaque_safe_paths(tmp_path: Path) -> None:
    storage = LocalRecordingStorage(tmp_path)

    with pytest.raises(RecordingStorageError, match="Invalid private recording object key"):
        storage.path_for("../candidate-video.webm")

    object_key = storage.build_object_key(str(uuid4()), "video/webm")
    assert object_key.startswith("interviews/")
    assert ".webm" in object_key
    assert "candidate-video" not in object_key


def test_admin_uploads_and_reads_a_private_recording(
    database_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    storage = LocalRecordingStorage(tmp_path)
    monkeypatch.setattr(recordings, "recording_storage", lambda: storage)
    auth_context = create_authorized_admin(database_session)
    interview = create_interview(database_session)
    payload = valid_webm_bytes()

    saved = asyncio.run(
        upload_recording(
            interview.id,
            upload_request(body=payload, content_type="video/webm"),
            auth_context=auth_context,
            database_session=database_session,
        )
    )

    assert saved.status == "available"
    assert saved.storage_provider == "local_private"
    assert saved.byte_size == len(payload)
    assert storage.path_for(saved.object_key).read_bytes() == payload
    assert interview.status == "completed"
    assert interview.completed_at is not None

    metadata = get_recording(
        interview.id,
        database_session=database_session,
    )
    response = stream_recording_content(
        interview.id,
        database_session=database_session,
    )
    assert metadata.id == saved.id
    assert response.media_type == "video/webm"
    assert Path(response.path).read_bytes() == payload

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            upload_recording(
                interview.id,
                upload_request(body=payload, content_type="video/webm"),
                auth_context=auth_context,
                database_session=database_session,
            )
        )
    assert error.value.status_code == 409


def test_recording_mutation_requires_csrf_trusted_origin_and_admin_role(
    database_session: Session,
) -> None:
    auth_context = create_authorized_admin(database_session)
    csrf_request = upload_request(body=valid_webm_bytes(), content_type="video/webm")

    with pytest.raises(HTTPException) as csrf_error:
        require_csrf(csrf_request, auth_context)
    assert csrf_error.value.status_code == 403

    untrusted_request = upload_request(
        body=valid_webm_bytes(),
        content_type="video/webm",
        origin="https://untrusted.example",
    )
    with pytest.raises(HTTPException) as origin_error:
        require_trusted_origin(untrusted_request)
    assert origin_error.value.status_code == 403

    reviewer = User(
        email="reviewer@example.test",
        full_name="Client Reviewer",
        password_hash="not-used-by-recording-tests",
        role="client_reviewer",
        company_id=None,
    )
    # The database rule deliberately forbids a reviewer without a company, so
    # role enforcement is exercised against a detached context only.
    reviewer_context = AuthContext(user=reviewer, session=auth_context.session)
    with pytest.raises(HTTPException) as role_error:
        require_roles("admin")(reviewer_context)
    assert role_error.value.status_code == 403


async def read_streaming_response(response: StreamingResponse) -> bytes:
    chunks: list[bytes] = []
    async for chunk in response.body_iterator:
        chunks.append(chunk)
    return b"".join(chunks)


def test_admin_uploads_and_streams_r2_recording(
    database_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_s3 = MagicMock()
    r2_storage = CloudflareR2Storage(
        account_id="mock-account-12345",
        bucket_name="mock-recordings-bucket",
        access_key_id="mock-key-id",
        secret_access_key="mock-secret-key",
        client=mock_s3,
    )
    monkeypatch.setattr(recordings.settings, "storage_provider", "cloudflare_r2")
    monkeypatch.setattr(recordings, "recording_storage", lambda: r2_storage)
    monkeypatch.setattr(recordings, "get_r2_storage", lambda: r2_storage)

    auth_context = create_authorized_admin(database_session)
    interview = create_interview(database_session)
    payload = valid_webm_bytes()

    saved = asyncio.run(
        upload_recording(
            interview.id,
            upload_request(body=payload, content_type="video/webm"),
            auth_context=auth_context,
            database_session=database_session,
        )
    )

    assert saved.status == "available"
    assert saved.storage_provider == "cloudflare_r2"
    assert saved.byte_size == len(payload)
    mock_s3.put_object.assert_called_once_with(
        Bucket="mock-recordings-bucket",
        Key=saved.object_key,
        Body=payload,
        ContentType="video/webm",
    )

    metadata = get_recording(
        interview.id,
        database_session=database_session,
    )
    assert metadata.id == saved.id
    assert metadata.storage_provider == "cloudflare_r2"

    mock_s3.get_object.return_value = {
        "Body": io.BytesIO(payload),
        "ContentType": "video/webm",
        "ContentLength": len(payload),
    }

    response = stream_recording_content(
        interview.id,
        database_session=database_session,
    )
    assert isinstance(response, StreamingResponse)
    assert response.media_type == "video/webm"
    assert response.headers["content-disposition"] == 'inline; filename="interview-recording.webm"'
    content = asyncio.run(read_streaming_response(response))
    assert content == payload


def test_r2_failed_upload_does_not_persist_recording(
    database_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_s3 = MagicMock()
    mock_s3.put_object.side_effect = ClientError(
        {"Error": {"Code": "AccessDenied", "Message": "Access Denied"}},
        "PutObject",
    )
    r2_storage = CloudflareR2Storage(
        account_id="mock-account-12345",
        bucket_name="mock-recordings-bucket",
        access_key_id="mock-key-id",
        secret_access_key="mock-secret-key",
        client=mock_s3,
    )
    monkeypatch.setattr(recordings.settings, "storage_provider", "cloudflare_r2")
    monkeypatch.setattr(recordings, "recording_storage", lambda: r2_storage)

    auth_context = create_authorized_admin(database_session)
    interview = create_interview(database_session)

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            upload_recording(
                interview.id,
                upload_request(body=valid_webm_bytes(), content_type="video/webm"),
                auth_context=auth_context,
                database_session=database_session,
            )
        )
    assert error.value.status_code == 500

    # Verify no recording record was persisted in database
    persisted = database_session.scalar(
        select(Recording).where(Recording.interview_session_id == interview.id)
    )
    assert persisted is None


def test_existing_local_recording_compatibility_when_r2_active(
    database_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # 1. Setup local storage and save an older recording
    local_storage = LocalRecordingStorage(tmp_path)
    monkeypatch.setattr(recordings, "get_local_storage", lambda: local_storage)
    monkeypatch.setattr(recordings, "recording_storage", lambda: local_storage)
    monkeypatch.setattr(recordings.settings, "storage_provider", "local")

    auth_context = create_authorized_admin(database_session)
    local_interview = create_interview(database_session)
    local_payload = valid_webm_bytes()

    local_saved = asyncio.run(
        upload_recording(
            local_interview.id,
            upload_request(body=local_payload, content_type="video/webm"),
            auth_context=auth_context,
            database_session=database_session,
        )
    )
    assert local_saved.storage_provider == "local_private"
    assert local_storage.path_for(local_saved.object_key).read_bytes() == local_payload

    # 2. Switch configuration to Cloudflare R2
    mock_s3 = MagicMock()
    r2_storage = CloudflareR2Storage(
        account_id="mock-account-12345",
        bucket_name="mock-recordings-bucket",
        access_key_id="mock-key-id",
        secret_access_key="mock-secret-key",
        client=mock_s3,
    )
    monkeypatch.setattr(recordings.settings, "storage_provider", "cloudflare_r2")
    monkeypatch.setattr(recordings, "get_r2_storage", lambda: r2_storage)
    monkeypatch.setattr(recordings, "recording_storage", lambda: r2_storage)

    # 3. Upload a new recording under R2
    r2_interview = create_interview(database_session)
    r2_payload = valid_webm_bytes() + b"\x01\x02"

    r2_saved = asyncio.run(
        upload_recording(
            r2_interview.id,
            upload_request(body=r2_payload, content_type="video/webm"),
            auth_context=auth_context,
            database_session=database_session,
        )
    )
    assert r2_saved.storage_provider == "cloudflare_r2"

    # 4. Stream the older local recording - must succeed using FileResponse from local disk
    local_stream_response = stream_recording_content(
        local_interview.id,
        database_session=database_session,
    )
    assert isinstance(local_stream_response, FileResponse)
    assert Path(local_stream_response.path).read_bytes() == local_payload

    # 5. Stream the new R2 recording - must succeed using StreamingResponse from R2
    mock_s3.get_object.return_value = {
        "Body": io.BytesIO(r2_payload),
        "ContentType": "video/webm",
        "ContentLength": len(r2_payload),
    }
    r2_stream_response = stream_recording_content(
        r2_interview.id,
        database_session=database_session,
    )
    assert isinstance(r2_stream_response, StreamingResponse)
    assert asyncio.run(read_streaming_response(r2_stream_response)) == r2_payload


def test_failed_recording_upload_does_not_mark_interview_completed(
    database_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    storage = LocalRecordingStorage(tmp_path)
    monkeypatch.setattr(recordings, "recording_storage", lambda: storage)
    auth_context = create_authorized_admin(database_session)
    interview = create_interview(database_session)
    interview.status = "in_progress"
    database_session.commit()

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            upload_recording(
                interview.id,
                upload_request(body=b"not-a-valid-recording-header", content_type="video/webm"),
                auth_context=auth_context,
                database_session=database_session,
            )
        )
    assert error.value.status_code == 422
    database_session.refresh(interview)
    assert interview.status == "in_progress"
    assert interview.completed_at is None


def test_upload_recording_rejected_if_already_completed(
    database_session: Session,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    storage = LocalRecordingStorage(tmp_path)
    monkeypatch.setattr(recordings, "recording_storage", lambda: storage)
    auth_context = create_authorized_admin(database_session)
    interview = create_interview(database_session)
    interview.status = "completed"
    database_session.commit()

    with pytest.raises(HTTPException) as error:
        asyncio.run(
            upload_recording(
                interview.id,
                upload_request(body=valid_webm_bytes(), content_type="video/webm"),
                auth_context=auth_context,
                database_session=database_session,
            )
        )
    assert error.value.status_code == 409
    assert error.value.detail == "An interview recording has already been saved for this session."

