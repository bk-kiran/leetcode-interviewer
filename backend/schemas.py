from typing import Any

from pydantic import BaseModel


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


class SubmitRequest(BaseModel):
    problem_id: str
    source_code: str


class TestCaseResult(BaseModel):
    test_case_id: str
    passed: bool
    stdout: str
    stderr: str
    is_hidden: bool


class SubmitResponse(BaseModel):
    problem_id: str
    results: list[TestCaseResult]
    all_passed: bool


class TTSRequest(BaseModel):
    text: str


class SpeechMark(BaseModel):
    time: int
    type: str
    start: int
    end: int
    value: str


class TTSWithMarksResponse(BaseModel):
    audio_base64: str
    marks: list[SpeechMark]
