"""merge s2-01 and s2-05 migration heads

Revision ID: 5b214df8c3c9
Revises: 2f63e1822a83, 9d7fe3cea8f6
Create Date: 2026-09-11 20:45:06.189413

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5b214df8c3c9'
down_revision: Union[str, Sequence[str], None] = ('2f63e1822a83', '9d7fe3cea8f6')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
