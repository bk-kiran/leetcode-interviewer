"""Throwaway diagnostic: confirm which AWS IAM identity backend/.env's
credentials resolve to, capture full error detail on the Transcribe
SubscriptionRequiredException (for an AWS Support case), and cross-check
against Polly + Service Quotas on the identical credentials/session.
Run with: uv run python check_aws_identity.py
"""

import json
import os

import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv

load_dotenv()

AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

print(f"AWS_REGION: {AWS_REGION}")
print()

sts = boto3.client("sts", region_name=AWS_REGION)
identity = sts.get_caller_identity()
print("--- sts.get_caller_identity() ---")
print(f"Account: {identity['Account']}")
print(f"UserId:  {identity['UserId']}")
print(f"Arn:     {identity['Arn']}")
print()


def print_full_client_error(label: str, e: ClientError) -> None:
    error = e.response.get("Error", {})
    meta = e.response.get("ResponseMetadata", {})
    print(f"FAILED: {label}")
    print(f"  RequestId:      {meta.get('RequestId')}")
    print(f"  HTTPStatusCode: {meta.get('HTTPStatusCode')}")
    print(f"  Error.Code:     {error.get('Code')}")
    print(f"  Error.Message:  {error.get('Message')}")
    print("  Full response dict:")
    print(json.dumps(e.response, indent=4, default=str))


print("--- transcribe.list_vocabularies() ---")
transcribe = boto3.client("transcribe", region_name=AWS_REGION)
try:
    resp = transcribe.list_vocabularies()
    print(f"SUCCESS: {len(resp.get('Vocabularies', []))} vocabularies returned")
except ClientError as e:
    print_full_client_error("transcribe.list_vocabularies()", e)
print()

print("--- service-quotas.list_service_quotas(ServiceCode='transcribe') ---")
quotas = boto3.client("service-quotas", region_name=AWS_REGION)
try:
    resp = quotas.list_service_quotas(ServiceCode="transcribe")
    quota_list = resp.get("Quotas", [])
    print(f"SUCCESS: {len(quota_list)} quotas returned")
    for q in quota_list[:10]:
        print(f"  - {q.get('QuotaName')}: {q.get('Value')}")
except ClientError as e:
    print_full_client_error("service-quotas.list_service_quotas()", e)
print()

print("--- polly.describe_voices() (control: same credentials, different service) ---")
polly = boto3.client("polly", region_name=AWS_REGION)
try:
    resp = polly.describe_voices(LanguageCode="en-US")
    print(f"SUCCESS: {len(resp.get('Voices', []))} voices returned")
except ClientError as e:
    print_full_client_error("polly.describe_voices()", e)
print()

print("=" * 70)
print("COPY-PASTE BLOCK FOR AWS SUPPORT CASE")
print("=" * 70)
print(f"Account:  {identity['Account']}")
print(f"UserId:   {identity['UserId']}")
print(f"Arn:      {identity['Arn']}")
print(f"Region:   {AWS_REGION}")
print("Issue: transcribe.list_vocabularies() and streaming StartStreamTranscription")
print("both fail with SubscriptionRequiredException on this IAM user, despite")
print("AmazonTranscribeFullAccess appearing attached in the console. Polly works")
print("fine on the identical credentials/session (see polly.describe_voices() above).")
print("See RequestId/HTTPStatusCode/full response captured above for the Transcribe call.")
print("=" * 70)
