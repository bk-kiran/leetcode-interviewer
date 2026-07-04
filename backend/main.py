from dotenv import load_dotenv

load_dotenv()

from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from db.models import Problem, TestCase
from db.session import get_db

app = FastAPI(title="Interview Agent API")


# --- schemas ---

class ProblemSummary(BaseModel):
    id: str
    title: str
    difficulty: str
    patterns: list[str]

    model_config = {"from_attributes": True}


class TestCaseOut(BaseModel):
    id: str
    input: Any
    expected_output: Any

    model_config = {"from_attributes": True}


class ProblemDetail(BaseModel):
    id: str
    title: str
    difficulty: str
    patterns: list[str]
    prompt: str
    starter_code: str
    test_cases: list[TestCaseOut]

    model_config = {"from_attributes": True}


# --- routes ---

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
