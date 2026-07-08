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

Your job is to help them think, never to hand them the solution. For this response, \
follow this guidance on how specific to be:
{escalation_instruction}

This applies whether they asked a direct question or explicitly requested a hint. If \
asked directly for the full solution or complete code, politely decline and instead \
respond at the level of specificity described above.

Never output a complete working solution. Never mention hint numbers or counts, and \
never say things like "this is your first/second/next hint" — the level of detail is \
already decided by the guidance above, so just answer accordingly without narrating \
which hint this is. Keep responses to 2-4 sentences."""

VAGUE_ESCALATION_INSTRUCTION = (
    "Give a vague, Socratic nudge: ask a guiding question or gesture at the general "
    "category of thing to consider, without naming the specific algorithm, data "
    "structure, or pattern."
)

CONCRETE_ESCALATION_INSTRUCTION = (
    'Be concrete: name the general pattern or data structure family (e.g. "a hash '
    'map", "two pointers"), and briefly explain why it fits, but do not lay out the '
    "full algorithm step by step."
)


def _escalation_instruction(hint_count: int) -> str:
    return CONCRETE_ESCALATION_INSTRUCTION if hint_count >= 2 else VAGUE_ESCALATION_INSTRUCTION


class AgentState(TypedDict):
    problem: dict
    messages: list[dict]
    current_code: str
    hint_count: int
    user_input: str
    last_response: str


def idle(state: AgentState) -> AgentState:
    return state


def answer_or_hint(state: AgentState) -> AgentState:
    """Call Claude with the problem, current code, hint count, and the user's message.

    hint_count reflects the count as of this call — incrementing it (when the user
    explicitly asked for a hint) is the caller's responsibility, done before invoking
    the graph, so the escalation logic here always sees the correct, already-updated
    count.
    """
    client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

    system = SYSTEM_PROMPT.format(
        title=state["problem"]["title"],
        prompt=state["problem"]["prompt"],
        current_code=state["current_code"] or "(no code written yet)",
        escalation_instruction=_escalation_instruction(state["hint_count"]),
    )

    response = client.messages.create(
        model=MODEL,
        max_tokens=512,
        system=system,
        messages=state["messages"] + [{"role": "user", "content": state["user_input"]}],
    )
    reply = next(b.text for b in response.content if b.type == "text")

    return {
        **state,
        "messages": state["messages"]
        + [{"role": "user", "content": state["user_input"]}, {"role": "assistant", "content": reply}],
        "last_response": reply,
        "user_input": "",
    }


def route_from_idle(state: AgentState) -> str:
    return "answer_or_hint" if state["user_input"] else END


def build_graph():
    graph = StateGraph(AgentState)
    graph.add_node("idle", idle)
    graph.add_node("answer_or_hint", answer_or_hint)
    graph.set_entry_point("idle")
    graph.add_conditional_edges("idle", route_from_idle, {"answer_or_hint": "answer_or_hint", END: END})
    graph.add_edge("answer_or_hint", "idle")
    return graph.compile()


def run_agent_turn(
    problem: dict,
    messages: list[dict],
    current_code: str,
    hint_count: int,
    user_input: str,
) -> str:
    """Run one turn of the Normal-mode agent graph and return the agent's text reply.

    `messages` is the prior conversation history (Claude message format: role
    "user"/"assistant"), not including `user_input` itself. `hint_count` must already
    reflect any increment for this turn — the graph does not mutate it.
    """
    app = build_graph()
    state: AgentState = {
        "problem": problem,
        "messages": messages,
        "current_code": current_code,
        "hint_count": hint_count,
        "user_input": user_input,
        "last_response": "",
    }
    result = app.invoke(state)
    return result["last_response"]
