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


def delete_message_pair(db: OrmSession, session_id: str, message_id: str) -> list[str]:
    """Deletes a message and, if it's a user message immediately followed by
    an agent message in the ordered history, that paired response too.
    Raises NoResultFound if the session or the message doesn't exist."""
    session = get_session_with_messages(db, session_id)
    messages = session.messages  # ordered by created_at via the relationship

    target_index = next((i for i, m in enumerate(messages) if m.id == message_id), None)
    if target_index is None:
        raise NoResultFound(f"Message {message_id} not found in session {session_id}")

    to_delete = [messages[target_index]]
    next_index = target_index + 1
    if (
        messages[target_index].role == MessageRole.user
        and next_index < len(messages)
        and messages[next_index].role == MessageRole.agent
    ):
        to_delete.append(messages[next_index])

    deleted_ids = [m.id for m in to_delete]
    for m in to_delete:
        db.delete(m)
    db.commit()
    return deleted_ids
