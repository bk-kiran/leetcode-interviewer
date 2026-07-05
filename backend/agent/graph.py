import os
from typing import TypedDict

import anthropic
from langgraph.graph import END, StateGraph

MODEL = "claude-sonnet-5"

SYSTEM_PROMPT = """You are a coding interview coach in Normal (practice) mode. The \
candidate is working on this problem:

Title: {title}
Prompt: {prompt}

Their current code (may be empty or incomplete):
```
{current_code}
```

They have received {hint_count} hint(s) so far this session.

Your job is to help them think, never to hand them the solution:
- If this is their 1st hint (hint_count == 1): give a vague, Socratic nudge — ask a \
guiding question or point at the general category of thing to consider, without \
naming the specific algorithm, data structure, or pattern.
- If this is their 2nd+ hint (hint_count >= 2): be more concrete — name the general \
pattern or data structure family (e.g. "a hash map", "two pointers"), and briefly say \
why it fits, but do not lay out the algorithm step by step.
- If they ask a regular question rather than requesting a hint, answer at a level of \
specificity consistent with how many hints they've already received.
- If asked directly for the full solution or full code, politely decline and instead \
give the most concrete hint appropriate to the current hint count.
Never output a complete working solution. Keep responses to 2-4 sentences."""


class AgentState(TypedDict):
    problem: dict
    messages: list[dict]
    current_code: str
    hint_count: int
    user_input: str
    is_hint_request: bool
    last_response: str


def idle(state: AgentState) -> AgentState:
    return state


def answer_or_hint(state: AgentState) -> AgentState:
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    hint_count = state["hint_count"] + 1 if state["is_hint_request"] else state["hint_count"]

    system = SYSTEM_PROMPT.format(
        title=state["problem"]["title"],
        prompt=state["problem"]["prompt"],
        current_code=state["current_code"] or "(no code written yet)",
        hint_count=hint_count,
    )

    user_message = "Please give me a hint." if state["is_hint_request"] else state["user_input"]

    response = client.messages.create(
        model=MODEL,
        max_tokens=512,
        system=system,
        messages=state["messages"] + [{"role": "user", "content": user_message}],
    )
    reply = next(b.text for b in response.content if b.type == "text")

    return {
        **state,
        "hint_count": hint_count,
        "messages": state["messages"]
        + [{"role": "user", "content": user_message}, {"role": "assistant", "content": reply}],
        "last_response": reply,
        "user_input": "",
        "is_hint_request": False,
    }


def route_from_idle(state: AgentState) -> str:
    return "answer_or_hint" if state["user_input"] or state["is_hint_request"] else END


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("idle", idle)
    graph.add_node("answer_or_hint", answer_or_hint)
    graph.set_entry_point("idle")
    graph.add_conditional_edges("idle", route_from_idle, {"answer_or_hint": "answer_or_hint", END: END})
    graph.add_edge("answer_or_hint", "idle")
    return graph.compile()
