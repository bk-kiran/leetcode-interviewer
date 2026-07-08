from datetime import datetime, timezone

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


def increment_hint_count(db: OrmSession, session_id: str) -> Session:
    session = db.query(Session).filter(Session.id == session_id).one()
    session.hint_count += 1
    db.commit()
    db.refresh(session)
    return session


def update_session_code(db: OrmSession, session_id: str, code: str) -> Session:
    session = db.query(Session).filter(Session.id == session_id).one()
    session.final_code = code
    db.commit()
    db.refresh(session)
    return session


def complete_session(db: OrmSession, session_id: str, passed: bool) -> Session:
    session = db.query(Session).filter(Session.id == session_id).one()
    session.status = SessionStatus.completed
    session.passed = passed
    session.ended_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(session)
    return session


def get_session_with_messages(db: OrmSession, session_id: str) -> Session:
    return (
        db.query(Session)
        .options(joinedload(Session.messages))
        .filter(Session.id == session_id)
        .one()
    )
