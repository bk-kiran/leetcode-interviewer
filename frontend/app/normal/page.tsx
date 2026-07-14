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

type SpeechMark = {
  time: number;
  type: string;
  start: number;
  end: number;
  value: string;
};

type TTSWithMarksResponse = {
  audio_base64: string;
  marks: SpeechMark[];
};

function newId() {
  return Math.random().toString(36).slice(2);
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// Slices message text into segments aligned to Polly's word speech marks, so
// the rendered spans are the exact same units the timeupdate handler indexes
// into — no risk of the highlight drifting from a separately-tokenized copy
// of the text. Polly's mark `start`/`end` are UTF-8 *byte* offsets, not JS
// UTF-16 string indices, so we slice the UTF-8-encoded byte buffer and decode
// each piece back to a string — slicing `content` directly would desync as
// soon as the text contains any multi-byte character (em dashes, curly
// quotes, etc., all common in LLM-generated text).
function buildWordSegments(content: string, marks: SpeechMark[]) {
  const bytes = utf8Encoder.encode(content);
  const segments: { text: string; wordIndex: number | null }[] = [];
  let cursor = 0;
  marks.forEach((mark, i) => {
    if (mark.start > cursor) {
      segments.push({ text: utf8Decoder.decode(bytes.slice(cursor, mark.start)), wordIndex: null });
    }
    segments.push({ text: utf8Decoder.decode(bytes.slice(mark.start, mark.end)), wordIndex: i });
    cursor = mark.end;
  });
  if (cursor < bytes.length) {
    segments.push({ text: utf8Decoder.decode(bytes.slice(cursor)), wordIndex: null });
  }
  return segments;
}

function MessageText({
  content,
  marks,
  activeWordIndex,
}: {
  content: string;
  marks: SpeechMark[] | undefined;
  activeWordIndex: number | null;
}) {
  if (!marks || marks.length === 0) return <>{content}</>;
  return (
    <>
      {buildWordSegments(content, marks).map((seg, i) =>
        seg.wordIndex === null ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span
            key={i}
            className={
              seg.wordIndex === activeWordIndex
                ? "rounded bg-emerald-400/70 px-0.5 text-zinc-900 dark:bg-emerald-500/80"
                : ""
            }
          >
            {seg.text}
          </span>
        )
      )}
    </>
  );
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

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M10.5 3.5a.75.75 0 0 0-1.264-.546L5.46 6.5H3.5A1.5 1.5 0 0 0 2 8v4a1.5 1.5 0 0 0 1.5 1.5h1.96l3.776 3.546A.75.75 0 0 0 10.5 16.5v-13Z" />
      {muted ? (
        <path d="M13.22 8.22a.75.75 0 0 1 1.06 0L16 9.94l1.72-1.72a.75.75 0 1 1 1.06 1.06L17.06 11l1.72 1.72a.75.75 0 1 1-1.06 1.06L16 12.06l-1.72 1.72a.75.75 0 1 1-1.06-1.06L14.94 11l-1.72-1.72a.75.75 0 0 1 0-1.06Z" />
      ) : (
        <path d="M14.53 7.22a.75.75 0 0 1 1.06 0 5.25 5.25 0 0 1 0 7.56.75.75 0 1 1-1.06-1.06 3.75 3.75 0 0 0 0-5.44.75.75 0 0 1 0-1.06Z" />
      )}
    </svg>
  );
}

// Renders a play triangle (state "play": idle, or active-but-paused — both
// mean "clicking this starts/resumes audio") or two pause bars (state
// "pause": actively playing, clicking halts it). Shared by the per-message
// replay control and the header transport button.
function PlaybackIcon({ state }: { state: "play" | "pause" }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      {state === "pause" ? (
        <>
          <rect x="5" y="4" width="3" height="12" rx="1" />
          <rect x="12" y="4" width="3" height="12" rx="1" />
        </>
      ) : (
        <path d="M6.3 4.6a1 1 0 0 1 1.55-.833l8.4 5.4a1 1 0 0 1 0 1.666l-8.4 5.4A1 1 0 0 1 6.3 15.4V4.6Z" />
      )}
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

  const [muted, setMuted] = useState(false);
  // id of the ChatMessage currently being synthesized/played, or null when idle.
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [activeWordIndex, setActiveWordIndex] = useState<number | null>(null);
  const [messageMarks, setMessageMarks] = useState<Record<string, SpeechMark[]>>({});
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrlRef = useRef<string | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);

  const isInitialCodeRef = useRef(true);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

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

  // Stop any in-flight/playing speech and free its resources.
  useEffect(() => {
    return () => {
      ttsAbortRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  // Hard stop: cancels any in-flight fetch and drops the current track
  // entirely (used for session-level resets and muting). Distinct from
  // pause, which keeps src/position intact so playback can resume exactly
  // where it left off.
  function stopSpeaking() {
    ttsAbortRef.current?.abort();
    ttsAbortRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setSpeakingMessageId(null);
    setActiveWordIndex(null);
    setIsPaused(false);
  }

  // Fetches audio + word-level speech marks together for a chat message and
  // plays it. Runs after the text is already shown, so a slow or failed
  // synthesis never blocks the chat. `respectMute` is false for manual
  // replay clicks: muting only silences auto-play, not an explicit
  // "play this again" request.
  async function playSpeech(text: string, messageId: string, { respectMute = true } = {}) {
    stopSpeaking();
    if (respectMute && muted) return;

    const controller = new AbortController();
    ttsAbortRef.current = controller;
    setSpeakingMessageId(messageId);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/tts-with-marks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(typeof body?.detail === "string" ? body.detail : `TTS failed (${res.status})`);
      }
      const data: TTSWithMarksResponse = await res.json();
      if (controller.signal.aborted) return;

      setMessageMarks((prev) => ({ ...prev, [messageId]: data.marks }));

      const url = URL.createObjectURL(base64ToBlob(data.audio_base64, "audio/mpeg"));
      audioUrlRef.current = url;
      if (audioRef.current) {
        audioRef.current.src = url;
        await audioRef.current.play();
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setSpeakingMessageId(null);
      setError("Couldn't generate audio for this response.");
    }
  }

  function toggleMute() {
    setMuted((prev) => {
      const next = !prev;
      if (next) stopSpeaking();
      return next;
    });
  }

  // Native pause()/play() preserve currentTime, so resuming continues from
  // the exact paused position — and since activeWordIndex is only touched
  // by timeupdate (driven by currentTime) and onEnded, the highlight picks
  // back up in sync without any extra bookkeeping here.
  function togglePauseResume() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }

  function handleMessagePlaybackClick(m: ChatMessage) {
    if (speakingMessageId === m.id) {
      togglePauseResume();
    } else {
      void playSpeech(m.content, m.id, { respectMute: false });
    }
  }

  function handleTimeUpdate() {
    const audio = audioRef.current;
    if (!audio || !speakingMessageId) return;
    const marks = messageMarks[speakingMessageId];
    if (!marks || marks.length === 0) return;

    const currentMs = audio.currentTime * 1000;
    let idx: number | null = null;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i].time <= currentMs) idx = i;
      else break;
    }
    setActiveWordIndex((prev) => (prev === idx ? prev : idx));
  }

  // Keeps the chat panel pinned to the bottom as new messages arrive, but
  // only when the user hasn't scrolled up to reread earlier history. Also
  // re-syncs when the panel is reopened, since messages can still arrive
  // (e.g. via "Get Hint") while it's collapsed and unmounted.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el || !isNearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, chatOpen]);

  function handleChatScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 80;
  }

  async function startSession(problemId: string) {
    stopSpeaking();
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
      void playSpeech(data.response, agentMsgId);
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
      <audio
        ref={audioRef}
        hidden
        onTimeUpdate={handleTimeUpdate}
        onPlay={() => setIsPaused(false)}
        onPause={() => setIsPaused(true)}
        onEnded={() => {
          setSpeakingMessageId(null);
          setActiveWordIndex(null);
          setIsPaused(false);
        }}
        onError={() => {
          setSpeakingMessageId(null);
          setActiveWordIndex(null);
          setIsPaused(false);
        }}
      />

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
                stopSpeaking();
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
              {speakingMessageId ? (
                <button
                  className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  onClick={togglePauseResume}
                  aria-label={isPaused ? "Resume playback" : "Pause playback"}
                >
                  <PlaybackIcon state={isPaused ? "play" : "pause"} />
                </button>
              ) : (
                <button
                  className="rounded p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  onClick={toggleMute}
                  aria-label={muted ? "Unmute voice playback" : "Mute voice playback"}
                  aria-pressed={muted}
                >
                  <SpeakerIcon muted={muted} />
                </button>
              )}
              {speakingMessageId && (
                <span className="flex items-center gap-1 text-xs text-zinc-400 dark:text-zinc-500">
                  <span className={`h-1.5 w-1.5 rounded-full bg-emerald-500 ${isPaused ? "" : "animate-pulse"}`} />
                  {isPaused ? "Paused" : "Speaking…"}
                </span>
              )}
            </div>
            <span className="text-sm text-zinc-500 dark:text-zinc-400">
              Hints used: {hintCount}
            </span>
          </div>

          <div
            ref={chatScrollRef}
            onScroll={handleChatScroll}
            className="flex-1 space-y-3 overflow-y-auto p-3"
          >
            {messages.length === 0 && (
              <p className="text-sm text-zinc-400 dark:text-zinc-500">
                Ask a question or request a hint to get started.
              </p>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`flex items-end gap-1 ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {m.role === "agent" && !m.pending && (
                  <button
                    className="mb-0.5 shrink-0 rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    onClick={() => handleMessagePlaybackClick(m)}
                    aria-label={
                      speakingMessageId === m.id
                        ? isPaused
                          ? "Resume playback"
                          : "Pause playback"
                        : "Play message"
                    }
                  >
                    <PlaybackIcon state={speakingMessageId === m.id && !isPaused ? "pause" : "play"} />
                  </button>
                )}
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                      : "border border-zinc-200 bg-zinc-100 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                  } ${m.pending ? "animate-pulse italic text-zinc-400 dark:text-zinc-500" : ""}`}
                >
                  <MessageText
                    content={m.content}
                    marks={messageMarks[m.id]}
                    activeWordIndex={speakingMessageId === m.id ? activeWordIndex : null}
                  />
                </div>
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
