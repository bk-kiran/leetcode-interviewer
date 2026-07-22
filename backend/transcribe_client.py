"""Thin wrapper around AWS Transcribe's streaming SDK for live speech-to-text."""

import asyncio
import os
from typing import AsyncIterator

from amazon_transcribe.client import TranscribeStreamingClient
from amazon_transcribe.handlers import TranscriptResultStreamHandler
from amazon_transcribe.model import TranscriptEvent

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
SAMPLE_RATE_HZ = 16000


class _QueueingHandler(TranscriptResultStreamHandler):
    """Pushes each transcript result onto a queue as a plain dict, so the
    caller can consume results via a simple async generator instead of
    subclassing the SDK's event handler itself."""

    def __init__(self, output_stream, queue: "asyncio.Queue[dict | None]"):
        super().__init__(output_stream)
        self._queue = queue

    async def handle_transcript_event(self, transcript_event: TranscriptEvent) -> None:
        for result in transcript_event.transcript.results:
            if not result.alternatives:
                continue
            await self._queue.put(
                {
                    "type": "partial" if result.is_partial else "final",
                    "text": result.alternatives[0].transcript,
                }
            )


async def transcribe_stream(audio_chunks: AsyncIterator[bytes]) -> AsyncIterator[dict]:
    """Streams raw 16kHz/16-bit/mono PCM chunks from `audio_chunks` to AWS
    Transcribe and yields {"type": "partial" | "final" | "error", "text": ...}
    dicts as recognition results arrive."""
    client = TranscribeStreamingClient(region=AWS_REGION)
    try:
        stream = await client.start_stream_transcription(
            language_code="en-US",
            media_sample_rate_hz=SAMPLE_RATE_HZ,
            media_encoding="pcm",
        )
    except Exception as e:
        # Auth/subscription/network failures happen here, before any of the
        # try/except below is even set up — without this, they'd crash the
        # ASGI app instead of surfacing as a clean message to the client.
        yield {"type": "error", "text": f"Could not start transcription: {e}"}
        return

    queue: "asyncio.Queue[dict | None]" = asyncio.Queue()

    async def write_chunks():
        try:
            async for chunk in audio_chunks:
                await stream.input_stream.send_audio_event(audio_chunk=chunk)
        except Exception as e:
            await queue.put({"type": "error", "text": str(e)})
        finally:
            # Always signal end-of-audio so Transcribe finalizes and
            # handle_events() below completes, even if the writer errored.
            await stream.input_stream.end_stream()

    handler = _QueueingHandler(stream.output_stream, queue)

    async def run_handler():
        try:
            await handler.handle_events()
        except Exception as e:
            await queue.put({"type": "error", "text": str(e)})
        finally:
            await queue.put(None)  # sentinel: no more events

    writer_task = asyncio.create_task(write_chunks())
    handler_task = asyncio.create_task(run_handler())

    try:
        while True:
            event = await queue.get()
            if event is None:
                break
            yield event
    finally:
        writer_task.cancel()
        handler_task.cancel()
        await asyncio.gather(writer_task, handler_task, return_exceptions=True)
