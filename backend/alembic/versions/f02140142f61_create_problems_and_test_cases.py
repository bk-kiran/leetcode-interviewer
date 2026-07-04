"""create_problems_and_test_cases

Revision ID: f02140142f61
Revises:
Create Date: 2026-07-02 16:42:49.957838

"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "f02140142f61"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    op.execute(
        """
        DO $$ BEGIN
            CREATE TYPE difficulty_enum AS ENUM ('Easy', 'Medium', 'Hard');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;
        """
    )

    op.create_table(
        "problems",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column(
            "difficulty",
            postgresql.ENUM("Easy", "Medium", "Hard", name="difficulty_enum", create_type=False),
            nullable=False,
        ),
        sa.Column("patterns", sa.ARRAY(sa.String()), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("starter_code", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "test_cases",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("problem_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("input", postgresql.JSONB(), nullable=False),
        sa.Column("expected_output", postgresql.JSONB(), nullable=False),
        sa.Column("is_hidden", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.ForeignKeyConstraint(["problem_id"], ["problems.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("test_cases")
    op.drop_table("problems")
    op.execute("DROP TYPE IF EXISTS difficulty_enum")
