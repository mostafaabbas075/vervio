from pydantic import BaseModel, Field, field_validator


class RealtimeOfferRequest(BaseModel):
    """The browser's WebRTC offer. It must not contain credentials."""

    offer_sdp: str = Field(min_length=1, max_length=65_536)

    @field_validator("offer_sdp")
    @classmethod
    def require_sdp(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("A WebRTC SDP offer is required.")
        return value


class RealtimeOfferResponse(BaseModel):
    """The OpenAI WebRTC answer and locally enforced demo duration."""

    answer_sdp: str
    max_duration_seconds: int = Field(ge=1, le=7_200)
