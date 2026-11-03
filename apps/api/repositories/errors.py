class ValidationError(Exception):
    """Raised instead of writing to the database when input fails a business rule."""


class NotFoundError(Exception):
    """Raised when an update/pause/delete targets an id that doesn't exist."""


class InvalidSettingsError(ValidationError):
    """A recipient's delivery settings (S21-06) break a business rule; maps to 422."""
