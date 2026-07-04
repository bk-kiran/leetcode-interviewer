import enum
from datetime import datetime, timezone

from sqlalchemy import (
    ARRAY,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.sql import func


class Base(DeclarativeBase):
    pass


class Difficulty(enum.Enum):
    Easy = "Easy"
    Medium = "Medium"
    Hard = "Hard"


class Problem(Base):
    __tablename__ = "problems"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    difficulty: Mapped[Difficulty] = mapped_column(
        Enum(Difficulty, name="difficulty_enum"), nullable=False
    )
    patterns: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    starter_code: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    test_cases: Mapped[list["TestCase"]] = relationship(
        "TestCase", back_populates="problem", cascade="all, delete-orphan"
    )


class TestCase(Base):
    __tablename__ = "test_cases"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        primary_key=True,
        server_default=func.gen_random_uuid(),
    )
    problem_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("problems.id", ondelete="CASCADE"),
        nullable=False,
    )
    input: Mapped[dict] = mapped_column(JSONB, nullable=False)
    expected_output: Mapped[dict] = mapped_column(JSONB, nullable=False)
    is_hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    problem: Mapped["Problem"] = relationship("Problem", back_populates="test_cases")
