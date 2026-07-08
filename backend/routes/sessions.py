from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.exc import NoResultFound
from sqlalchemy.orm import Session as OrmSession

from agent.graph import run_agent_turn
from db.models import MessageRole, MessageType, Problem, SessionMode
from db.session import get_db
from db.sessions_crud import (
    add_message,
    complete_session,
    create_session,
    get_session_with_messages,
    increment_hint_count,
    update_session_code,
)
from judge0_service import run_submission
from schemas import TestCaseResult

router = APIRouter(prefix="/sessions", tags=["sessions"])


# --- schemas ---


class CreateSessionRequest(BaseModel):
    problem_id: str
    mode: SessionMode = SessionMode.normal


class ProblemInfo(BaseModel):
    id: str
    title: str
    prompt: str
    starter_code: str
    difficulty: str
    patterns: list[str]


class CreateSessionResponse(BaseModel):
    session_id: str
    problem: ProblemInfo


class MessageRequest(BaseModel):
    content: str
    message_type: MessageType


class MessageResponse(BaseModel):
    response: str
    hint_count: int


class CodeUpdateResponse(BaseModel):
    acknowledged: bool = True


class SubmitCodeRequest(BaseModel):
    source_code: str


class SessionSubmitResponse(BaseModel):
    session_id: str
    results: list[TestCaseResult]
    all_passed: bool


class SessionOut(BaseModel):
    id: str
    problem_id: str
    mode: str
    status: str
    hint_count: int
    final_code: str | None
    passed: bool | None
    started_at: datetime
    ended_at: datetime | None


class SessionMessageOut(BaseModel):
    id: str
    role: str
    content: str
    message_type: str
    created_at: datetime


class SessionDetailResponse(BaseModel):
    session: SessionOut
    messages: list[SessionMessageOut]


# --- helpers ---


def _get_session_or_404(db: OrmSession, session_id: str):
    try:
        return get_session_with_messages(db, session_id)
    except NoResultFound:
        raise HTTPException(status_code=404, detail="Session not found")


def _to_claude_role(role: MessageRole) -> str:
    return "assistant" if role == MessageRole.agent else "user"


def _session_out(session) -> SessionOut:
    return SessionOut(
        id=session.id,
        problem_id=session.problem_id,
        mode=session.mode.value,
        status=session.status.value,
        hint_count=session.hint_count,
        final_code=session.final_code,
        passed=session.passed,
        started_at=session.started_at,
        ended_at=session.ended_at,
    )


# --- routes ---


@router.post("", response_model=CreateSessionResponse)
def start_session(req: CreateSessionRequest, db: OrmSession = Depends(get_db)):
    problem = db.query(Problem).filter(Problem.id == req.problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    session = create_session(db, problem_id=problem.id, mode=req.mode)
    add_message(
        db,
        session.id,
        role=MessageRole.agent,
        content=f"Session started for {problem.title}",
        message_type=MessageType.system,
    )

    return CreateSessionResponse(
        session_id=session.id,
        problem=ProblemInfo(
            id=problem.id,
            title=problem.title,
            prompt=problem.prompt,
            starter_code=problem.starter_code,
            difficulty=problem.difficulty.value,
            patterns=problem.patterns,
        ),
    )


@router.post("/{session_id}/message")
def post_message(session_id: str, req: MessageRequest, db: OrmSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)

    # Snapshot prior conversation (question/hint turns only) before appending the
    # incoming message, so it isn't duplicated when passed to the graph below.
    prior_messages = [
        {"role": _to_claude_role(m.role), "content": m.content}
        for m in session.messages
        if m.message_type in (MessageType.question, MessageType.hint)
    ]
    current_code = session.final_code or ""
    problem = {"title": session.problem.title, "prompt": session.problem.prompt}

    add_message(db, session_id, role=MessageRole.user, content=req.content, message_type=req.message_type)

    if req.message_type == MessageType.code_update:
        update_session_code(db, session_id, req.content)
        return CodeUpdateResponse()

    if req.message_type == MessageType.hint:
        session = increment_hint_count(db, session_id)
        hint_count = session.hint_count
    else:
        hint_count = session.hint_count

    reply = run_agent_turn(
        problem=problem,
        messages=prior_messages,
        current_code=current_code,
        hint_count=hint_count,
        user_input=req.content,
    )

    add_message(db, session_id, role=MessageRole.agent, content=reply, message_type=req.message_type)

    return MessageResponse(response=reply, hint_count=hint_count)


@router.post("/{session_id}/submit", response_model=SessionSubmitResponse)
def submit_session(session_id: str, req: SubmitCodeRequest, db: OrmSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    problem = session.problem

    try:
        results, all_passed = run_submission(db, problem, req.source_code)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))

    update_session_code(db, session_id, req.source_code)

    if all_passed:
        complete_session(db, session_id, passed=True)

    return SessionSubmitResponse(session_id=session_id, results=results, all_passed=all_passed)


@router.get("/{session_id}", response_model=SessionDetailResponse)
def get_session(session_id: str, db: OrmSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)

    return SessionDetailResponse(
        session=_session_out(session),
        messages=[
            SessionMessageOut(
                id=m.id,
                role=m.role.value,
                content=m.content,
                message_type=m.message_type.value,
                created_at=m.created_at,
            )
            for m in session.messages
        ],
    )
