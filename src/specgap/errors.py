"""Expected user-facing failures; callers must not expose raw provider bodies."""


class SpecGapError(ValueError):
    """Invalid input, configuration or local artifact integrity."""


class StaleRunError(SpecGapError):
    """A historical snapshot may be read but not mutated."""


class SequenceConflictError(SpecGapError):
    """The displayed event history is no longer current; refresh before acting."""


class ProviderError(SpecGapError):
    """The explicitly requested model call did not yield a valid review."""
