from dotenv import load_dotenv

load_dotenv()

from fastapi import Depends, FastAPI, HTTPException
from sqlalchemy.orm import Session

from db.models import Problem, TestCase
from db.session import get_db
from judge0_service import run_submission
from routes.sessions import router as sessions_router
from schemas import ProblemDetail, ProblemSummary, SubmitRequest, SubmitResponse, TestCaseOut

app = FastAPI(title="Interview Agent API")
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
