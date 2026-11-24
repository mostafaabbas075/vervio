"""Deterministic CEFR comparison and language requirement recommendation logic."""

from __future__ import annotations

from typing import Literal

LanguageRecommendationState = Literal[
    "meets_requirement",
    "below_requirement",
    "insufficient_evidence",
    "not_configured",
]

# Official CEFR ordering: A1 < A2 < B1 < B2 < C1 < C2
CEFR_ORDER: dict[str, int] = {
    "A1": 1,
    "A2": 2,
    "B1": 3,
    "B2": 4,
    "C1": 5,
    "C2": 6,
}

VALID_CEFR_LEVELS: frozenset[str] = frozenset(CEFR_ORDER.keys())


def normalize_cefr_level(level: str | None) -> str | None:
    """Normalize and validate a CEFR level string, returning uppercase code or None."""
    if not level:
        return None
    cleaned = level.strip().upper()
    return cleaned if cleaned in VALID_CEFR_LEVELS else None


def compare_cefr_levels(level_a: str, level_b: str) -> int:
    """Compare two CEFR levels deterministically.

    Returns:
        < 0 if level_a < level_b
        0 if level_a == level_b
        > 0 if level_a > level_b

    Raises:
        ValueError: if either level is not a recognized CEFR level.
    """
    rank_a = CEFR_ORDER.get(level_a.strip().upper())
    rank_b = CEFR_ORDER.get(level_b.strip().upper())
    if rank_a is None or rank_b is None:
        raise ValueError(f"Cannot compare non-CEFR levels: {level_a!r} vs {level_b!r}")
    return rank_a - rank_b


def derive_language_recommendation(
    required_level: str | None,
    assessment_status: str | None,
    assessed_level: str | None,
) -> tuple[LanguageRecommendationState, str]:
    """Derive recommendation state and explanation without altering assessment data.

    Important rules:
    - Candidate claimed level is NEVER passed or used here.
    - If required_level is None -> not_configured.
    - If assessment is pending, failed, or insufficient_evidence -> insufficient_evidence.
    - Never generate meets_requirement or below_requirement without completed assessment.
    - Final employment decisions always require human review (no automated hiring decisions).
    """
    req = normalize_cefr_level(required_level)
    if req is None:
        return (
            "not_configured",
            "No German language requirement has been configured for this interview session.",
        )

    norm_status = (assessment_status or "").strip().lower()
    norm_assessed = normalize_cefr_level(assessed_level)

    # If the assessment is not completed with a verified CEFR level, evidence is insufficient
    if norm_status != "completed" or norm_assessed is None:
        if norm_status == "insufficient_evidence":
            explanation = (
                f"Candidate interview did not provide sufficient German speech evidence to "
                f"determine if the required {req} standard is met. "
                "Final employment decisions require human review."
            )
        elif norm_status == "failed":
            explanation = (
                f"Language assessment failed; unable to compare against the required {req} "
                "standard. Final employment decisions require human review."
            )
        elif norm_status == "pending":
            explanation = (
                f"Language assessment is pending; reliable transcript evidence has not yet been "
                f"evaluated to compare against the required {req} standard. "
                "Final employment decisions require human review."
            )
        else:
            explanation = (
                f"No completed language assessment is available to compare against the "
                f"required {req} standard. Final employment decisions require human review."
            )
        return ("insufficient_evidence", explanation)

    # Both required and assessed levels are valid CEFR levels, and assessment is completed
    comparison = compare_cefr_levels(norm_assessed, req)

    if comparison >= 0:
        if comparison == 0:
            explanation = (
                f"Demonstrated German proficiency ({norm_assessed}) meets the required interview "
                f"standard ({req}). Final employment decisions require human review."
            )
        else:
            explanation = (
                f"Demonstrated German proficiency ({norm_assessed}) exceeds the required "
                f"interview standard ({req}). Final employment decisions require human review."
            )
        return ("meets_requirement", explanation)

    explanation = (
        f"Demonstrated German proficiency ({norm_assessed}) is below the required interview "
        f"standard ({req}). Final employment decisions require human review."
    )
    return ("below_requirement", explanation)
