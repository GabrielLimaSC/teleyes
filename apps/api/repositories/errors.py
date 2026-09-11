class ValidationError(Exception):
    """Raised instead of writing to the database when input fails a business rule."""


class NotFoundError(Exception):
    """Raised when an update/pause/delete targets an id that doesn't exist."""
