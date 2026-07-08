"""create_sessions_and_session_messages

Revision ID: 470c0546858f
Revises: f02140142f61
Create Date: 2026-07-05 23:49:57.445124

"""

from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "470c0546858f"
down_revision: Union[str, None] = "f02140142f61"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        DO $$ BEGIN
            CREATE TYPE session_mode_enum AS ENUM ('normal', 'interview');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;
        """
    )
    op.execute(
        """
        DO $$ BEGIN
            CREATE TYPE session_status_enum AS ENUM ('in_progress', 'completed');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;
        """
    )
    op.execute(
        """
        DO $$ BEGIN
            CREATE TYPE message_role_enum AS ENUM ('user', 'agent');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;
        """
    )
    op.execute(
        """
        DO $$ BEGIN
            CREATE TYPE message_type_enum AS ENUM ('question', 'hint', 'code_update', 'system');
        EXCEPTION
            WHEN duplicate_object THEN null;
        END $$;
        """
    )

    op.create_table(
        "sessions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("problem_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=False), nullable=True),
        sa.Column(
            "mode",
            postgresql.ENUM("normal", "interview", name="session_mode_enum", create_type=False),
            nullable=False,
        ),
        sa.Column(
            "status",
            postgresql.ENUM(
                "in_progress", "completed", name="session_status_enum", create_type=False
            ),
            nullable=False,
        ),
        sa.Column("hint_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("final_code", sa.Text(), nullable=True),
        sa.Column("passed", sa.Boolean(), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["problem_id"], ["problems.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "session_messages",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=False),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("session_id", postgresql.UUID(as_uuid=False), nullable=False),
        sa.Column(
            "role",
            postgresql.ENUM("user", "agent", name="message_role_enum", create_type=False),
            nullable=False,
        ),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "message_type",
            postgresql.ENUM(
                "question",
                "hint",
                "code_update",
                "system",
                name="message_type_enum",
                create_type=False,
            ),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("session_messages")
    op.drop_table("sessions")
    op.execute("DROP TYPE IF EXISTS message_type_enum")
    op.execute("DROP TYPE IF EXISTS message_role_enum")
    op.execute("DROP TYPE IF EXISTS session_status_enum")
    op.execute("DROP TYPE IF EXISTS session_mode_enum")
