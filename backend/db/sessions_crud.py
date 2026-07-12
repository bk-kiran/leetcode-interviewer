from datetime import datetime, timezone

from sqlalchemy.exc import NoResultFound
from sqlalchemy.orm import Session as OrmSession, joinedload

from db.models import (
    MessageRole,
    MessageType,
    Session,
    SessionMessage,
    SessionMode,
    SessionStatus,
)


def create_session(db: OrmSession, problem_id: str, mode: SessionMode) -> Session:
    session = Session(problem_id=problem_id, mode=mode)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def add_message(
    db: OrmSession,
    session_id: str,
    role: MessageRole,
    content: str,
    message_type: MessageType,
) -> SessionMessage:
    message = SessionMessage(
        session_id=session_id, role=role, content=content, message_type=message_type
    )
    db.add(message)
    db.commit()
    db.refresh(message)
    return message


def _get_session_or_404(db: OrmSession, session_id: str) -> Session:
    # db.get() checks the session's identity map before issuing a query, so
    # this is free when the caller already loaded the row earlier in the same
    # request (the common case: routes fetch the session once up front, then
    # pass its id into these helpers).
    session = db.get(Session, session_id)
    if session is None:
        raise NoResultFound(f"Session {session_id} not found")
    return session


def increment_hint_count(db: OrmSession, session_id: str) -> Session:
    session = _get_session_or_404(db, session_id)
    session.hint_count += 1
    db.commit()
    # No refresh: hint_count is a plain client-set value, not server-computed,
    # so the in-memory object is already correct post-commit.
    return session


def update_session_code(db: OrmSession, session_id: str, code: str) -> Session:
    session = _get_session_or_404(db, session_id)
    session.final_code = code
    db.commit()
    return session


def complete_session(db: OrmSession, session_id: str, passed: bool) -> Session:
    session = _get_session_or_404(db, session_id)
    session.status = SessionStatus.completed
    session.passed = passed
    session.ended_at = datetime.now(timezone.utc)
    db.commit()
    return session


def get_session_with_messages(db: OrmSession, session_id: str) -> Session:
    return (
        db.query(Session)
        .options(joinedload(Session.messages))
        .filter(Session.id == session_id)
        .one()
    )
