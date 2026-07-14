from dotenv import load_dotenv

load_dotenv()

import base64
import io

from botocore.exceptions import ClientError
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from db.models import Problem, TestCase
from db.session import get_db
from judge0_service import run_submission
from polly_client import get_speech_marks, synthesize_speech
from routes.sessions import router as sessions_router
from schemas import (
    ProblemDetail,
    ProblemSummary,
    SubmitRequest,
    SubmitResponse,
    TestCaseOut,
    TTSRequest,
    TTSWithMarksResponse,
)

app = FastAPI(title="Interview Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sessions_router)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/problems", response_model=list[ProblemSummary])
def list_problems(db: Session = Depends(get_db)):
    problems = db.query(Problem).order_by(Problem.created_at).all()
    return [
        ProblemSummary(
            id=p.id,
            title=p.title,
            difficulty=p.difficulty.value,
            patterns=p.patterns,
        )
        for p in problems
    ]


@app.get("/problems/{problem_id}", response_model=ProblemDetail)
def get_problem(problem_id: str, db: Session = Depends(get_db)):
    problem = db.query(Problem).filter(Problem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    visible_cases = (
        db.query(TestCase)
        .filter(TestCase.problem_id == problem_id, TestCase.is_hidden == False)
        .all()
    )

    return ProblemDetail(
        id=problem.id,
        title=problem.title,
        difficulty=problem.difficulty.value,
        patterns=problem.patterns,
        prompt=problem.prompt,
        starter_code=problem.starter_code,
        test_cases=[
            TestCaseOut(id=tc.id, input=tc.input, expected_output=tc.expected_output)
            for tc in visible_cases
        ],
    )


@app.post("/submit", response_model=SubmitResponse)
def submit(req: SubmitRequest, db: Session = Depends(get_db)):
    problem = db.query(Problem).filter(Problem.id == req.problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    try:
        results, all_passed = run_submission(db, problem, req.source_code)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e))

    return SubmitResponse(problem_id=req.problem_id, results=results, all_passed=all_passed)


def _polly_error_response(e: Exception) -> HTTPException:
    """Maps a Polly failure to a clean HTTP error instead of an unhandled 500.
    Text-too-long/invalid-input errors are the caller's fault (400); anything
    else (throttling, credentials, network) is an upstream failure (502)."""
    if isinstance(e, ClientError):
        error = e.response.get("Error", {})
        code = error.get("Code", "")
        message = error.get("Message", str(e))
        status_code = 400 if code in ("TextLengthExceededException", "InvalidSsmlException") else 502
        return HTTPException(status_code=status_code, detail=f"Text-to-speech failed: {message}")
    return HTTPException(status_code=502, detail=f"Text-to-speech failed: {e}")


@app.post("/tts")
def text_to_speech(req: TTSRequest):
    try:
        audio_bytes = synthesize_speech(req.text)
    except Exception as e:
        raise _polly_error_response(e)
    return StreamingResponse(io.BytesIO(audio_bytes), media_type="audio/mpeg")


@app.post("/tts-with-marks", response_model=TTSWithMarksResponse)
def text_to_speech_with_marks(req: TTSRequest):
    try:
        audio_bytes = synthesize_speech(req.text)
        marks = get_speech_marks(req.text)
    except Exception as e:
        raise _polly_error_response(e)
    return TTSWithMarksResponse(
        audio_base64=base64.b64encode(audio_bytes).decode("ascii"),
        marks=marks,
    )
