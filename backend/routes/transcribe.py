import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from transcribe_client import transcribe_stream

logger = logging.getLogger("transcribe_ws")
logger.setLevel(logging.INFO)
if not logger.handlers:
    # uvicorn's default logging config only attaches handlers to its own
    # "uvicorn"/"uvicorn.access" loggers and leaves the root logger with
    # none (default level WARNING) — so without this, every logger.info()
    # call below would be silently dropped and only exceptions would ever
    # surface (via Python's WARNING-level "handler of last resort").
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(_handler)
    logger.propagate = False

router = APIRouter()

# Allowlist, not a denylist: only these headers are ever logged. Cookie,
# Authorization, and any other credential-bearing header (including ones we
# haven't thought of) are excluded by construction, not by pattern-matching.
_SAFE_LOG_HEADERS = (
    "origin",
    "host",
    "connection",
    "upgrade",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "user-agent",
)


def _safe_headers_for_log(headers) -> dict:
    return {k: v for k, v in headers.items() if k.lower() in _SAFE_LOG_HEADERS}


async def _audio_chunks(websocket: WebSocket):
    """Yields binary audio frames from the client. A text frame (the
    frontend sends one JSON control message when the user releases
    push-to-talk) or a disconnect ends the stream so the caller can flush
    Transcribe and finalize the last result."""
    while True:
        try:
            message = await websocket.receive()
        except WebSocketDisconnect:
            return
        if message["type"] == "websocket.disconnect":
            return
        if message.get("bytes") is not None:
            yield message["bytes"]
        elif message.get("text") is not None:
            return


@router.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket):
    logger.info(
        "ws /ws/transcribe: connect attempt from %s, headers=%s",
        websocket.client,
        _safe_headers_for_log(websocket.headers),
    )
    try:
        await websocket.accept()
    except Exception:
        # If accept() itself fails, log the full traceback — a bare 400/403
        # here otherwise gives no indication of *why* the handshake was
        # rejected.
        logger.exception("ws /ws/transcribe: accept() failed")
        raise
    logger.info("ws /ws/transcribe: connection accepted")

    try:
        async for event in transcribe_stream(_audio_chunks(websocket)):
            await websocket.send_json(event)
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("ws /ws/transcribe: error while streaming")
        raise
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            pass  # already closed by the client
