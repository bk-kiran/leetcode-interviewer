import os
import time
from typing import TypedDict

import anthropic
from langgraph.graph import END, StateGraph
from sqlalchemy.orm import Session as OrmSession

from agent.graph import CONCRETE_ESCALATION_INSTRUCTION, VAGUE_ESCALATION_INSTRUCTION
from db.models import Problem
from judge0_service import run_submission

MODEL = "claude-sonnet-5"

DEFAULT_CHECK_IN_THRESHOLD_SECONDS = 45.0

INTERVIEW_CONTEXT = """You are conducting a live technical coding interview (Interview mode) \
— not a coaching session. You are "in the room" the whole time: you proactively monitor the \
candidate's progress, decide when to check in, escalate hints only when truly warranted, and \
probe their reasoning like a real interviewer would rather than just answering on demand.

Problem:
Title: {title}
Prompt: {prompt}

Candidate's current code (may be empty):
```
{current_code}
```

Hints given so far: {hint_count}
Topics already probed: {probed_topics}

{instruction}"""

RESPOND_BASE_INSTRUCTION = """Respond to what the candidate just said, in character as the \
interviewer. If they asked a genuine clarifying question about the problem, answer it \
briefly. If they're describing their approach or thinking out loud, engage with it: \
acknowledge what's reasonable, and — like a real interviewer — sometimes turn a question \
back on them instead of volunteering information (e.g. "what do you think happens with an \
empty input?", "what's driving that choice?") rather than just answering. Keep responses to \
2-4 sentences.

Only give a hint if they are genuinely stuck or clearly and directly ask for one. When you \
do give a hint: {escalation} Never give the full solution.

If — and only if — this response includes an actual hint (not just answering a clarifying \
question or asking a Socratic question back), begin your reply with the exact token [HINT] \
on its own line, then your response. Otherwise do not include that token at all."""

CHECK_IN_INSTRUCTION = """The candidate has gone quiet — no code changes or messages for a \
while. Proactively check in like a real interviewer would: ask an open-ended, Socratic \
question about how they're thinking about the problem or where they've gotten to — WITHOUT \
giving away a hint or solution. Keep it brief, warm, and natural (1-2 sentences). Do not just \
ask "do you need a hint?" — probe their thinking first."""

PROBE_COMPLEXITY_INSTRUCTION = """The candidate appears to have a working or near-working \
solution but hasn't discussed its time/space complexity. Proactively and naturally ask them \
to state the time and space complexity of their current approach, like a real interviewer \
would at this point. Keep it to 1-2 sentences."""

SCORE_PROMPT = """You are scoring a completed technical coding interview. Review the full \
transcript and produce a structured debrief for the candidate.

Problem:
Title: {title}
Prompt: {prompt}

Final code submitted:
```
{current_code}
```

Test results: {test_summary}
Hints used: {hint_count}
Time to solve: {elapsed_minutes:.1f} minutes

Full conversation transcript:
{transcript}

Produce a debrief covering exactly these sections, each 1-3 sentences:
1. Correctness — did the final solution pass the tests?
2. Optimality — is the time/space complexity of their approach appropriate, and did they \
recognize it (based on what they said in the transcript)?
3. Communication — did they explain their reasoning, ask good clarifying questions, and \
engage when checked in on, or were they mostly silent/terse?
4. Hints — how many hints were needed and at what specificity?
5. Time to solve — was the pace reasonable for the difficulty?

End with one overall summary line: an overall read framed for practice purposes (e.g. \
"Overall: on track for interviews at this level" / "Overall: needs more practice on X"), \
plus the single most important thing to work on next."""


class InterviewState(TypedDict):
    problem: dict
    messages: list[dict]
    current_code: str
    last_activity_ts: float
    check_in_threshold_seconds: float
    hint_count: int
    probed_topics: list[str]
    phase: str  # "problem_intro" | "coding" | "wrap_up"
    event: str  # "start" | "message" | "tick" | "submit"
    user_input: str
    last_response: str
    submission_result: dict | None
    debrief: str | None


def _client() -> anthropic.Anthropic:
    return anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


def _extract_text(response) -> str:
    return next(b.text for b in response.content if b.type == "text")


def _build_system_prompt(state: InterviewState, instruction: str) -> str:
    return INTERVIEW_CONTEXT.format(
        title=state["problem"]["title"],
        prompt=state["problem"]["prompt"],
        current_code=state["current_code"] or "(no code written yet)",
        hint_count=state["hint_count"],
        probed_topics=", ".join(state["probed_topics"]) or "(none yet)",
        instruction=instruction,
    )


def _respond_instruction(hint_count: int) -> str:
    escalation = CONCRETE_ESCALATION_INSTRUCTION if hint_count >= 2 else VAGUE_ESCALATION_INSTRUCTION
    return RESPOND_BASE_INSTRUCTION.format(escalation=escalation)


def _say_unprompted(client: anthropic.Anthropic, system: str, messages: list[dict], trigger: str, max_tokens: int) -> str:
    """Calls Claude to produce a new proactive interjection (a check-in or a
    probe) rather than a reply to something the candidate said. The model
    rejects a `messages` list that ends in "assistant" (no prefill support —
    it must end in "user"), so a synthetic trigger turn describing *why* the
    interviewer is speaking is appended for this call only. It's never
    persisted to `state["messages"]" — the saved transcript only ever shows
    genuine interviewer/candidate lines, not this internal stage direction.
    """
    api_messages = messages + [{"role": "user", "content": trigger}]
    response = client.messages.create(model=MODEL, max_tokens=max_tokens, system=system, messages=api_messages)
    return _extract_text(response)


def _summarize_results(results, all_passed: bool) -> str:
    passed = sum(1 for r in results if r.passed)
    total = len(results)
    suffix = " (all passed)" if all_passed else ""
    return f"{passed}/{total} test cases passed{suffix}"


def _format_transcript(messages: list[dict]) -> str:
    lines = []
    for m in messages:
        speaker = "Candidate" if m["role"] == "user" else "Interviewer"
        lines.append(f"{speaker}: {m['content']}")
    return "\n".join(lines)


def present_problem(state: InterviewState) -> InterviewState:
    """No LLM call — the intro is templated, same as Normal mode's CLI printing
    the prompt directly, since there's nothing genuinely dynamic to generate here."""
    intro = (
        f"Alright, let's get started. Here's the problem:\n\n"
        f"{state['problem']['title']}\n{state['problem']['prompt']}\n\n"
        f"Starter code:\n```\n{state['problem']['starter_code']}\n```\n\n"
        "Take a moment to read through it — any clarifying questions before you start coding?"
    )
    return {
        **state,
        "messages": [{"role": "assistant", "content": intro}],
        "last_response": intro,
        "phase": "coding",
        "last_activity_ts": time.monotonic(),
    }


def monitor(state: InterviewState) -> InterviewState:
    return {**state, "last_response": ""}


def route_from_monitor(state: InterviewState) -> str:
    elapsed = time.monotonic() - state["last_activity_ts"]
    return "check_in" if elapsed >= state["check_in_threshold_seconds"] else END


def check_in(state: InterviewState) -> InterviewState:
    client = _client()
    system = _build_system_prompt(state, CHECK_IN_INSTRUCTION)
    reply = _say_unprompted(
        client,
        system,
        state["messages"],
        "[The candidate has been quiet — no code changes or messages for a while. Check in with them now.]",
        max_tokens=200,
    )
    return {
        **state,
        "messages": state["messages"] + [{"role": "assistant", "content": reply}],
        "last_response": reply,
        "last_activity_ts": time.monotonic(),
    }


def respond_to_user(state: InterviewState) -> InterviewState:
    client = _client()
    system = _build_system_prompt(state, _respond_instruction(state["hint_count"]))
    response = client.messages.create(
        model=MODEL,
        max_tokens=400,
        system=system,
        messages=state["messages"] + [{"role": "user", "content": state["user_input"]}],
    )
    reply = _extract_text(response)

    gave_hint = reply.startswith("[HINT]")
    if gave_hint:
        reply = reply[len("[HINT]"):].strip()

    return {
        **state,
        "messages": state["messages"]
        + [{"role": "user", "content": state["user_input"]}, {"role": "assistant", "content": reply}],
        "last_response": reply,
        "user_input": "",
        "hint_count": state["hint_count"] + 1 if gave_hint else state["hint_count"],
        "last_activity_ts": time.monotonic(),
    }


def _should_probe_complexity(state: InterviewState) -> bool:
    code = state["current_code"].strip()
    if not code or "return" not in code:
        return False
    return "complexity" not in state["probed_topics"]


def route_after_response(state: InterviewState) -> str:
    return "probe_complexity" if _should_probe_complexity(state) else END


def probe_complexity(state: InterviewState) -> InterviewState:
    client = _client()
    system = _build_system_prompt(state, PROBE_COMPLEXITY_INSTRUCTION)
    reply = _say_unprompted(
        client,
        system,
        state["messages"],
        "[The candidate seems to have a working approach but hasn't stated its time/space "
        "complexity. Ask them now.]",
        max_tokens=150,
    )
    return {
        **state,
        "messages": state["messages"] + [{"role": "assistant", "content": reply}],
        "last_response": state["last_response"] + "\n\n" + reply,
        "probed_topics": state["probed_topics"] + ["complexity"],
        "last_activity_ts": time.monotonic(),
    }


def build_evaluate_code(db: OrmSession, problem: Problem):
    def evaluate_code(state: InterviewState) -> InterviewState:
        results, all_passed = run_submission(db, problem, state["current_code"])
        summary = _summarize_results(results, all_passed)
        note = f"[Candidate submitted code. Test results: {summary}]"
        return {
            **state,
            "messages": state["messages"] + [{"role": "user", "content": note}],
            "submission_result": {"results": results, "all_passed": all_passed, "summary": summary},
            "last_response": f"Submission evaluated: {summary}",
            "phase": "wrap_up",
        }

    return evaluate_code


def build_score_session(start_ts: float):
    def score_session(state: InterviewState) -> InterviewState:
        client = _client()
        elapsed_minutes = (time.monotonic() - start_ts) / 60
        test_summary = (
            state["submission_result"]["summary"] if state["submission_result"] else "No submission was made."
        )
        prompt = SCORE_PROMPT.format(
            title=state["problem"]["title"],
            prompt=state["problem"]["prompt"],
            current_code=state["current_code"] or "(no code submitted)",
            test_summary=test_summary,
            hint_count=state["hint_count"],
            elapsed_minutes=elapsed_minutes,
            transcript=_format_transcript(state["messages"]),
        )
        response = client.messages.create(model=MODEL, max_tokens=700, messages=[{"role": "user", "content": prompt}])
        debrief = _extract_text(response)
        return {**state, "debrief": debrief, "last_response": debrief, "phase": "wrap_up"}

    return score_session


def route_entry(state: InterviewState) -> str:
    if state["event"] == "start":
        return "present_problem"
    if state["event"] == "tick":
        return "monitor"
    if state["event"] == "submit":
        return "evaluate_code"
    return "respond_to_user"  # event == "message"


def build_interview_graph(db: OrmSession, problem: Problem, start_ts: float):
    graph = StateGraph(InterviewState)
    graph.add_node("present_problem", present_problem)
    graph.add_node("monitor", monitor)
    graph.add_node("check_in", check_in)
    graph.add_node("respond_to_user", respond_to_user)
    graph.add_node("probe_complexity", probe_complexity)
    graph.add_node("evaluate_code", build_evaluate_code(db, problem))
    graph.add_node("score_session", build_score_session(start_ts))

    graph.set_conditional_entry_point(
        route_entry,
        {
            "present_problem": "present_problem",
            "monitor": "monitor",
            "respond_to_user": "respond_to_user",
            "evaluate_code": "evaluate_code",
        },
    )
    graph.add_edge("present_problem", END)
    graph.add_conditional_edges("monitor", route_from_monitor, {"check_in": "check_in", END: END})
    graph.add_edge("check_in", END)
    graph.add_conditional_edges(
        "respond_to_user", route_after_response, {"probe_complexity": "probe_complexity", END: END}
    )
    graph.add_edge("probe_complexity", END)
    graph.add_edge("evaluate_code", "score_session")
    graph.add_edge("score_session", END)
    return graph.compile()
