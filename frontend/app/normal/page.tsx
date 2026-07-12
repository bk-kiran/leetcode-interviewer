"use client";

import Editor from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

type ProblemSummary = {
  id: string;
  title: string;
  difficulty: string;
  patterns: string[];
};

type ProblemInfo = {
  id: string;
  title: string;
  prompt: string;
  starter_code: string;
  difficulty: string;
  patterns: string[];
};

type CreateSessionResponse = {
  session_id: string;
  problem: ProblemInfo;
};

type MessageResponse = {
  response: string;
  hint_count: number;
};

type TestCaseResult = {
  test_case_id: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  is_hidden: boolean;
};

type SessionSubmitResponse = {
  session_id: string;
  results: TestCaseResult[];
  all_passed: boolean;
};

type ChatMessage = {
  id: string;
  role: "user" | "agent";
  content: string;
  pending?: boolean;
};

function newId() {
  return Math.random().toString(36).slice(2);
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="currentColor"
      className={`h-4 w-4 ${direction === "left" ? "rotate-180" : ""}`}
    >
      <path
        fillRule="evenodd"
        d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export default function NormalMode() {
  const [problems, setProblems] = useState<ProblemSummary[] | null>(null);
  const [selectedProblemId, setSelectedProblemId] = useState("");
  const [starting, setStarting] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [problem, setProblem] = useState<ProblemInfo | null>(null);
  const [code, setCode] = useState("");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hintCount, setHintCount] = useState(0);
  const [chatInput, setChatInput] = useState("");
  const [pendingAction, setPendingAction] = useState<"question" | "hint" | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<SessionSubmitResponse | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);

  const isInitialCodeRef = useRef(true);

  useEffect(() => {
    fetch(`${API_URL}/problems`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load problems (${res.status})`);
        return res.json();
      })
      .then((data: ProblemSummary[]) => setProblems(data))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load problems"));
  }, []);

  // Debounced silent code_update sync — skip the run that fires right after a
  // session starts (when code is set from starter_code, not a user edit).
  useEffect(() => {
    if (!sessionId) return;
    if (isInitialCodeRef.current) {
      isInitialCodeRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      fetch(`${API_URL}/sessions/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: code, message_type: "code_update" }),
      }).catch(() => {
        // silent background sync — swallow errors
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [code, sessionId]);

  async function startSession(problemId: string) {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ problem_id: problemId, mode: "normal" }),
      });
      if (!res.ok) throw new Error(`Failed to start session (${res.status})`);
      const data: CreateSessionResponse = await res.json();
      isInitialCodeRef.current = true;
      setSessionId(data.session_id);
      setProblem(data.problem);
      setCode(data.problem.starter_code);
      setMessages([]);
      setHintCount(0);
      setSubmitResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start session");
    } finally {
      setStarting(false);
    }
  }

  async function sendMessage(content: string, messageType: "question" | "hint") {
    if (!sessionId) return;
    setPendingAction(messageType);
    setError(null);

    // Show the user's message and a "thinking" placeholder immediately —
    // the agent's real response can take several seconds, and with nothing
    // in the chat panel until then it's easy to mistake a slow response for
    // a broken button.
    const agentMsgId = newId();
    setMessages((prev) => [
      ...prev,
      { id: newId(), role: "user", content },
      { id: agentMsgId, role: "agent", content: "Thinking…", pending: true },
    ]);

    try {
      const res = await fetch(`${API_URL}/sessions/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, message_type: messageType }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data: MessageResponse = await res.json();
      setMessages((prev) =>
        prev.map((m) => (m.id === agentMsgId ? { id: m.id, role: "agent", content: data.response } : m))
      );
      setHintCount(data.hint_count);
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== agentMsgId));
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setPendingAction(null);
    }
  }

  function handleAsk() {
    const content = chatInput.trim();
    if (!content) return;
    setChatInput("");
    void sendMessage(content, "question");
  }

  function handleHint() {
    void sendMessage("Can I get a hint?", "hint");
  }

  async function handleSubmit() {
    if (!sessionId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/sessions/${sessionId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_code: code }),
      });
      if (!res.ok) throw new Error(`Submit failed (${res.status})`);
      const data: SessionSubmitResponse = await res.json();
      setSubmitResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (!sessionId || !problem) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center min-h-screen gap-6 px-6">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Normal Mode</h1>

        {problems === null ? (
          <p className="text-zinc-500 dark:text-zinc-400">Loading problems…</p>
        ) : (
          <div className="flex w-full max-w-sm flex-col gap-3">
            <select
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              value={selectedProblemId}
              onChange={(e) => setSelectedProblemId(e.target.value)}
            >
              <option value="" disabled>
                Select a problem…
              </option>
              {problems.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.difficulty})
                </option>
              ))}
            </select>
            <button
              className="rounded-md bg-zinc-900 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              disabled={!selectedProblemId || starting}
              onClick={() => startSession(selectedProblemId)}
            >
              {starting ? "Starting…" : "Start Session"}
            </button>
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-1 gap-4 overflow-hidden bg-zinc-50 p-4 dark:bg-zinc-950">
      {/* Left column: problem card + editor card */}
      <div className="flex flex-1 flex-col gap-4 overflow-hidden">
        {/* Problem card */}
        <div className="shrink-0 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              {problem.title}{" "}
              <span className="text-sm font-normal text-zinc-500 dark:text-zinc-400">
                ({problem.difficulty})
              </span>
            </h1>
            <button
              className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
              onClick={() => {
                setSessionId(null);
                setProblem(null);
              }}
            >
              Change problem
            </button>
          </div>
          <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">
            {problem.prompt}
          </p>
        </div>

        {/* Editor card */}
        <div className="flex flex-1 flex-col overflow-y-auto rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="h-[65vh] overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
            <Editor
              height="100%"
              defaultLanguage="python"
              value={code}
              onChange={(value) => setCode(value ?? "")}
              theme="vs-dark"
              options={{ minimap: { enabled: false }, fontSize: 14 }}
            />
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? "Running…" : "Submit"}
            </button>
            <button
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-900 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-800"
              onClick={handleHint}
              disabled={pendingAction !== null}
            >
              {pendingAction === "hint" ? "Thinking…" : "Get Hint"}
            </button>
          </div>

          {submitResult && (
            <div className="mt-4 space-y-2">
              {submitResult.all_passed ? (
                <p className="font-semibold text-emerald-600 dark:text-emerald-400">
                  All tests passed!
                </p>
              ) : (
                <p className="font-semibold text-red-600 dark:text-red-400">
                  Some tests failed.
                </p>
              )}
              <ul className="space-y-1 text-sm">
                {submitResult.results.map((r, i) => (
                  <li
                    key={r.test_case_id}
                    className="rounded border border-zinc-200 p-2 dark:border-zinc-800"
                  >
                    <div className="flex items-center justify-between">
                      <span>
                        {r.is_hidden ? `Hidden test ${i + 1}` : `Test ${i + 1}`}
                      </span>
                      <span className={r.passed ? "text-emerald-600" : "text-red-600"}>
                        {r.passed ? "Passed" : "Failed"}
                      </span>
                    </div>
                    {!r.is_hidden && (r.stdout || r.stderr) && (
                      <div className="mt-1 space-y-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
                        {r.stdout && <div>stdout: {r.stdout}</div>}
                        {r.stderr && <div>stderr: {r.stderr}</div>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/* Right: collapsible chat/hints card */}
      {chatOpen ? (
        <div className="flex w-[380px] shrink-0 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between border-b border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <button
                className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                onClick={() => setChatOpen(false)}
                aria-label="Collapse coach panel"
              >
                <ChevronIcon direction="right" />
              </button>
              <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                Coach
              </span>
            </div>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              Hints used: {hintCount}
            </span>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            {messages.length === 0 && (
              <p className="text-sm text-zinc-400 dark:text-zinc-500">
                Ask a question or request a hint to get started.
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                  m.role === "user"
                    ? "ml-auto bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                    : "mr-auto border border-zinc-200 bg-zinc-100 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                } ${m.pending ? "animate-pulse italic text-zinc-400 dark:text-zinc-500" : ""}`}
              >
                {m.content}
              </div>
            ))}
          </div>

          {error && (
            <p className="border-t border-zinc-200 p-2 text-xs text-red-600 dark:border-zinc-800 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
            <textarea
              className="w-full resize-none rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
              rows={2}
              placeholder="Ask a question…"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleAsk();
                }
              }}
            />
            <button
              className="w-full rounded-md bg-zinc-900 py-2 text-sm font-semibold text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              onClick={handleAsk}
              disabled={pendingAction !== null || !chatInput.trim()}
            >
              {pendingAction === "question" ? "Thinking…" : "Ask"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex w-12 shrink-0 flex-col items-center rounded-lg border border-zinc-200 bg-white py-4 dark:border-zinc-800 dark:bg-zinc-900">
          <button
            className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            onClick={() => setChatOpen(true)}
            aria-label="Expand coach panel"
          >
            <ChevronIcon direction="left" />
          </button>
        </div>
      )}
    </div>
  );
}
