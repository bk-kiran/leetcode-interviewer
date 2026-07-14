"""Thin client for AWS Polly text-to-speech."""

import json
import os

import boto3

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
POLLY_VOICE_ID = os.environ.get("POLLY_VOICE_ID", "Joanna")

_polly = boto3.client("polly", region_name=AWS_REGION)


def synthesize_speech(text: str) -> bytes:
    """Synthesize text to speech via Polly and return raw MP3 audio bytes."""
    response = _polly.synthesize_speech(
        Text=text,
        OutputFormat="mp3",
        VoiceId=POLLY_VOICE_ID,
        Engine="neural",
    )
    return response["AudioStream"].read()


def get_speech_marks(text: str) -> list[dict]:
    """Return word-level speech marks for text: a list of
    {time (ms), type, start, end, value} entries, one per spoken word,
    aligned to the same voice/engine used by synthesize_speech."""
    response = _polly.synthesize_speech(
        Text=text,
        OutputFormat="json",
        VoiceId=POLLY_VOICE_ID,
        Engine="neural",
        SpeechMarkTypes=["word"],
    )
    raw = response["AudioStream"].read().decode("utf-8")
    return [json.loads(line) for line in raw.splitlines() if line.strip()]
