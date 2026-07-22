"use client";

import Editor from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const WS_URL = API_URL.replace(/^http/, "ws") + "/ws/transcribe";
const TRANSCRIBE_SAMPLE_RATE = 16000;
const PENDING_REVIEW_MS = 2500;

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
  user_message_id: string;
  agent_message_id: string;
};

type DeleteMessageResponse = {
  deleted: boolean;
  deleted_ids: string[];
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
  // The persisted DB row id, populated once the backend confirms the
  // message was saved — absent while a "Thinking…" placeholder is still in
  // flight. Deletion is keyed on this, not the local `id`.
  backendId?: string;
  // Set when the send request itself failed, so this message never got a
  // backendId and never will — it can only ever be removed locally.
  failed?: boolean;
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

type TranscribeEvent = {
  type: "partial" | "final" | "error";
  text?: string;
};

type RecordingSession = {
  micStream: MediaStream;
  audioContext: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  silentGain: GainNode;
  ws: WebSocket;
};

type RecordingState = "idle" | "connecting" | "recording" | "stopping";

function newId() {
  return Math.random().toString(36).slice(2);
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: contentType });
}

// The mic's AudioContext runs at the browser's native rate (usually 44.1kHz
// or 48kHz); Transcribe streaming requires 16kHz. Downsample by averaging
// each output sample's source window — cheap, and good enough for speech.
function downsampleTo16kHz(input: Float32Array, sourceSampleRate: number): Float32Array {
  if (sourceSampleRate === TRANSCRIBE_SAMPLE_RATE) return input;
  const ratio = sourceSampleRate / TRANSCRIBE_SAMPLE_RATE;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);
  let inputIndex = 0;
  for (let i = 0; i < outputLength; i++) {
    const nextInputIndex = Math.round((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (; inputIndex < nextInputIndex && inputIndex < input.length; inputIndex++) {
      sum += input[inputIndex];
      count++;
    }
    output[i] = count > 0 ? sum / count : 0;
  }
  return output;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
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

function MicIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
      <path d="M10 2a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M5.5 9.5a.75.75 0 0 0-1.5 0 6 6 0 0 0 5.25 5.955V17H7.5a.75.75 0 0 0 0 1.5h5a.75.75 0 0 0 0-1.5h-1.75v-1.545A6 6 0 0 0 16 9.5a.75.75 0 0 0-1.5 0 4.5 4.5 0 0 1-9 0Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path
        fillRule="evenodd"
        d="M8.75 1a.75.75 0 0 0-.75.75V2h-3.5a.75.75 0 0 0 0 1.5h9a.75.75 0 0 0 0-1.5H10v-.25a.75.75 0 0 0-.75-.75h-.5ZM4.5 5a.5.5 0 0 0-.5.5V15a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V5.5a.5.5 0 0 0-.5-.5h-11Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path d="M14.69 2.688a1.5 1.5 0 0 1 2.122 2.122L6.75 14.87l-3.06.85.85-3.06L14.69 2.688Z" />
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
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);

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

  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [liveTranscript, setLiveTranscript] = useState<string | null>(null);
  const recordingRef = useRef<RecordingSession | null>(null);
  // Transcribe finalizes on every utterance/pause, not just once at the end
  // of the session — accumulate finalized segments here and only submit the
  // combined transcript once the user actually stops recording, instead of
  // firing off a separate question mid-recording for every sentence-level
  // pause (which is what made the interaction feel like it kept restarting).
  const finalSegmentsRef = useRef<string[]>([]);

  // A voice transcript sits here for review before it's ever sent to the
  // agent — auto-sends after PENDING_REVIEW_MS unless the user edits or
  // discards it first.
  const [pendingTranscript, setPendingTranscript] = useState<{
    id: string;
    text: string;
    mode: "countdown" | "editing";
  } | null>(null);
  const [pendingEditText, setPendingEditText] = useState("");
  const [pendingProgress, setPendingProgress] = useState(0); // 0 -> 1 over the countdown window
  const pendingAutoSendTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProgressIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Release the mic and close the transcription socket on unmount, so
  // navigating away mid-recording doesn't leave the mic indicator on.
  useEffect(() => {
    return () => forceStopRecording();
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

  // Deletes a user message and its paired agent response. Only removes them
  // from local state once the backend confirms the delete — on failure the
  // messages stay put and an error shows, rather than optimistically hiding
  // something that's still in the DB.
  async function deleteMessageExchange(m: ChatMessage) {
    if (m.failed) {
      // Never reached the backend — there's nothing to delete server-side,
      // just drop it locally.
      setMessages((prev) => prev.filter((msg) => msg.id !== m.id));
      return;
    }
    if (!m.backendId || !sessionId) return;
    setDeletingMessageId(m.id);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/sessions/${sessionId}/message/${m.backendId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      const data: DeleteMessageResponse = await res.json();
      const deletedIds = new Set(data.deleted_ids);
      const playingMessage = messages.find((msg) => msg.id === speakingMessageId);
      if (playingMessage?.backendId && deletedIds.has(playingMessage.backendId)) stopSpeaking();
      setMessages((prev) => prev.filter((msg) => !msg.backendId || !deletedIds.has(msg.backendId)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete message");
    } finally {
      setDeletingMessageId(null);
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
  }, [messages, chatOpen, pendingTranscript]);

  function handleChatScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 80;
  }

  function clearPendingTimers() {
    if (pendingAutoSendTimeoutRef.current) {
      clearTimeout(pendingAutoSendTimeoutRef.current);
      pendingAutoSendTimeoutRef.current = null;
    }
    if (pendingProgressIntervalRef.current) {
      clearInterval(pendingProgressIntervalRef.current);
      pendingProgressIntervalRef.current = null;
    }
  }

  // Discards whatever's pending review with no side effects — no agent
  // call, nothing persisted. Used for explicit Delete clicks, but also for
  // session-level resets (new recording, new problem, unmount) since a
  // pending transcript shouldn't silently outlive the context it was
  // spoken in.
  function clearPendingReview() {
    clearPendingTimers();
    setPendingTranscript(null);
  }

  // Puts a finished voice transcript up for review instead of sending it
  // straight to the agent. If left untouched for PENDING_REVIEW_MS it
  // auto-sends; Edit or Delete (clearPendingTimers, called by both) cancels
  // that timer first, so the auto-send can never fire after either.
  function beginTranscriptReview(text: string) {
    clearPendingTimers();
    const id = newId();
    setPendingTranscript({ id, text, mode: "countdown" });
    setPendingEditText(text);
    setPendingProgress(0);

    const startTs = Date.now();
    pendingProgressIntervalRef.current = setInterval(() => {
      setPendingProgress(Math.min(1, (Date.now() - startTs) / PENDING_REVIEW_MS));
    }, 50);

    pendingAutoSendTimeoutRef.current = setTimeout(() => {
      pendingAutoSendTimeoutRef.current = null;
      if (pendingProgressIntervalRef.current) {
        clearInterval(pendingProgressIntervalRef.current);
        pendingProgressIntervalRef.current = null;
      }
      setPendingTranscript(null);
      void sendMessage(text, "question");
    }, PENDING_REVIEW_MS);
  }

  function handleEditPendingTranscript() {
    if (!pendingTranscript) return;
    clearPendingTimers();
    setPendingTranscript((prev) => (prev ? { ...prev, mode: "editing" } : prev));
  }

  function handleSubmitEditedTranscript() {
    const text = pendingEditText.trim();
    setPendingTranscript(null);
    if (text) void sendMessage(text, "question");
  }

  function releaseRecording(rec: RecordingSession) {
    rec.processor.disconnect();
    rec.source.disconnect();
    rec.silentGain.disconnect();
    rec.micStream.getTracks().forEach((t) => t.stop());
    void rec.audioContext.close();
  }

  // Immediately tears down any active/connecting recording without waiting
  // for a graceful server round-trip — used for session-level resets
  // (new problem, unmount) where we don't want to wait for the backend.
  function forceStopRecording() {
    clearPendingReview();
    const rec = recordingRef.current;
    if (!rec) return;
    recordingRef.current = null;
    rec.ws.onclose = null;
    rec.ws.onmessage = null;
    try {
      rec.ws.close();
    } catch {
      // already closed
    }
    releaseRecording(rec);
    finalSegmentsRef.current = [];
    setLiveTranscript(null);
    setRecordingState("idle");
  }

  async function startRecording() {
    if (recordingRef.current) return;
    stopSpeaking(); // avoid the coach's own voice bleeding into the mic
    clearPendingReview(); // don't let two pending transcripts stack up
    setError(null);
    setRecordingState("connecting");
    finalSegmentsRef.current = [];

    // Declared outside the try block (unlike the values it holds, which are
    // still created inside it) so the catch block below can release
    // whatever was actually acquired before a later step failed — a mic
    // stream or socket created here must not survive a failed setup.
    let micStream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let ws: WebSocket | null = null;

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new AudioContext();
      ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";

      await new Promise<void>((resolve, reject) => {
        ws!.onopen = () => resolve();
        ws!.onerror = () => reject(new Error("Could not connect to the transcription service"));
      });

      // Non-null local aliases: everything above either threw or succeeded,
      // so these three are guaranteed set from here on, without sprinkling
      // `!` over every remaining use of the outer (nullable) variables.
      const socket = ws;
      const ctx = audioContext;
      const stream = micStream;

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      // ScriptProcessorNode only fires callbacks once connected into the
      // graph; route it through a silent gain so we don't echo the mic
      // back out of the speakers.
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(ctx.destination);

      processor.onaudioprocess = (e) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const input = e.inputBuffer.getChannelData(0);
        const downsampled = downsampleTo16kHz(input, ctx.sampleRate);
        const pcm16 = floatTo16BitPCM(downsampled);
        socket.send(pcm16.buffer);
      };

      socket.onmessage = (event) => {
        const data: TranscribeEvent = JSON.parse(event.data);
        if (data.type === "partial") {
          const partial = data.text ?? "";
          setLiveTranscript([...finalSegmentsRef.current, partial].filter(Boolean).join(" "));
        } else if (data.type === "final") {
          const text = (data.text ?? "").trim();
          if (text) finalSegmentsRef.current = [...finalSegmentsRef.current, text];
          setLiveTranscript(finalSegmentsRef.current.join(" "));
        } else if (data.type === "error") {
          setError(data.text || "Transcription error");
        }
      };
      socket.onclose = () => {
        const rec = recordingRef.current;
        if (rec) {
          releaseRecording(rec);
          recordingRef.current = null;
        }
        // Put whatever was said during the whole session up for review, now
        // that recording has actually ended — not per sentence-level pause
        // while it was still in progress, and not sent to the agent until
        // the review window passes (or the user explicitly confirms it).
        const fullTranscript = finalSegmentsRef.current.join(" ").trim();
        finalSegmentsRef.current = [];
        if (fullTranscript) beginTranscriptReview(fullTranscript);
        setLiveTranscript(null);
        setRecordingState("idle");
      };
      socket.onerror = () => {
        setError("Transcription connection error");
      };

      recordingRef.current = { micStream: stream, audioContext: ctx, source, processor, silentGain, ws: socket };
      setRecordingState("recording");
    } catch (err) {
      // Release whatever was actually acquired before the failure — e.g. mic
      // permission granted but the socket never connected — so a failed
      // start never leaves the mic indicator on or a socket dangling.
      micStream?.getTracks().forEach((t) => t.stop());
      void audioContext?.close();
      try {
        ws?.close();
      } catch {
        // already closed
      }
      setError(err instanceof Error ? err.message : "Couldn't start recording");
      setRecordingState("idle");
    }
  }

  function stopRecording() {
    const rec = recordingRef.current;
    if (!rec) return;
    setRecordingState("stopping");
    if (rec.ws.readyState === WebSocket.OPEN) {
      // Tell the backend to stop sending audio to Transcribe and flush the
      // final result; the backend closes the socket once it has, which
      // triggers ws.onclose above and releases the mic.
      rec.ws.send(JSON.stringify({ action: "stop" }));
    } else {
      rec.ws.close();
    }
    // Safety net in case the backend never closes (e.g. it crashed mid-session).
    setTimeout(() => {
      if (recordingRef.current === rec && rec.ws.readyState !== WebSocket.CLOSED) {
        rec.ws.close();
      }
    }, 4000);
  }

  function toggleRecording() {
    if (recordingState === "idle") void startRecording();
    else if (recordingState === "recording") stopRecording();
  }

  async function startSession(problemId: string) {
    stopSpeaking();
    forceStopRecording();
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
    const userMsgId = newId();
    const agentMsgId = newId();
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: "user", content },
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
        prev.map((m) => {
          if (m.id === userMsgId) return { ...m, backendId: data.user_message_id };
          if (m.id === agentMsgId) {
            return { id: m.id, role: "agent", content: data.response, backendId: data.agent_message_id };
          }
          return m;
        })
      );
      setHintCount(data.hint_count);
      void playSpeech(data.response, agentMsgId);
    } catch (err) {
      // The agent placeholder never got a real reply, so it's removed — but
      // the user's own message stays visible (they should be able to see
      // what they tried to send) and is marked failed so it can still be
      // dismissed: it never got a backendId and never will, since the send
      // itself is what failed.
      setMessages((prev) =>
        prev.filter((m) => m.id !== agentMsgId).map((m) => (m.id === userMsgId ? { ...m, failed: true } : m))
      );
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
                forceStopRecording();
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
                className={`group flex items-end gap-1 ${m.role === "user" ? "justify-end" : "justify-start"}`}
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
                <div className="flex max-w-[85%] flex-col gap-1">
                  <div
                    className={`rounded-lg px-3 py-2 text-sm ${
                      m.role === "user"
                        ? m.failed
                          ? "border border-dashed border-red-400 bg-zinc-900 text-white dark:border-red-500 dark:bg-zinc-50 dark:text-zinc-900"
                          : "bg-zinc-900 text-white dark:bg-zinc-50 dark:text-zinc-900"
                        : "border border-zinc-200 bg-zinc-100 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
                    } ${m.pending ? "animate-pulse italic text-zinc-400 dark:text-zinc-500" : ""}`}
                  >
                    <MessageText
                      content={m.content}
                      marks={messageMarks[m.id]}
                      activeWordIndex={speakingMessageId === m.id ? activeWordIndex : null}
                    />
                  </div>
                  {m.failed && (
                    <span className="text-right text-xs text-red-600 dark:text-red-400">
                      Failed to send — tap the trash icon to remove
                    </span>
                  )}
                </div>
                {m.role === "user" && (m.backendId || m.failed) && (
                  <button
                    className="mb-0.5 shrink-0 rounded p-1 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-100 hover:text-red-600 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-50 group-hover:opacity-100 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-red-400"
                    onClick={() => deleteMessageExchange(m)}
                    disabled={deletingMessageId === m.id}
                    aria-label={m.failed ? "Remove this message" : "Delete this message and its response"}
                  >
                    <TrashIcon />
                  </button>
                )}
              </div>
            ))}
            {pendingTranscript && (
              <div className="ml-auto flex max-w-[85%] flex-col gap-1.5 rounded-lg border border-dashed border-zinc-400 bg-zinc-50 px-3 py-2 dark:border-zinc-600 dark:bg-zinc-800/60">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                  Review before sending…
                </span>
                {pendingTranscript.mode === "editing" ? (
                  <>
                    <textarea
                      className="w-full resize-none rounded border border-zinc-300 bg-white px-2 py-1 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                      rows={2}
                      value={pendingEditText}
                      onChange={(e) => setPendingEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSubmitEditedTranscript();
                        }
                      }}
                      autoFocus
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        className="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                        onClick={clearPendingReview}
                        aria-label="Discard"
                      >
                        <TrashIcon />
                      </button>
                      <button
                        className="rounded-md bg-zinc-900 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
                        onClick={handleSubmitEditedTranscript}
                        disabled={!pendingEditText.trim()}
                      >
                        Send
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-zinc-700 dark:text-zinc-200">{pendingTranscript.text}</p>
                    <div className="flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                        <div
                          className="h-full rounded-full bg-zinc-500 dark:bg-zinc-400"
                          style={{ width: `${(1 - pendingProgress) * 100}%` }}
                        />
                      </div>
                      <button
                        className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                        onClick={handleEditPendingTranscript}
                        aria-label="Edit before sending"
                      >
                        <EditIcon />
                      </button>
                      <button
                        className="shrink-0 rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-red-600 dark:text-zinc-400 dark:hover:bg-zinc-700 dark:hover:text-red-400"
                        onClick={clearPendingReview}
                        aria-label="Discard"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {error && (
            <p className="border-t border-zinc-200 p-2 text-xs text-red-600 dark:border-zinc-800 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="space-y-2 border-t border-zinc-200 p-3 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleRecording}
                disabled={recordingState === "connecting" || recordingState === "stopping" || pendingAction !== null}
                className={`flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  recordingState === "recording"
                    ? "animate-pulse bg-red-600 text-white hover:bg-red-500"
                    : "border border-zinc-300 text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-50 dark:hover:bg-zinc-800"
                }`}
                aria-pressed={recordingState === "recording"}
                aria-label={recordingState === "recording" ? "Stop recording" : "Push to talk"}
              >
                <MicIcon />
                {recordingState === "connecting"
                  ? "Connecting…"
                  : recordingState === "recording"
                    ? "Recording…"
                    : recordingState === "stopping"
                      ? "Finishing…"
                      : "Push to talk"}
              </button>
              {liveTranscript && (
                <p className="flex-1 truncate text-xs italic text-zinc-400 dark:text-zinc-500">
                  {liveTranscript}
                </p>
              )}
            </div>
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
