"""
Phase 3B - Resource interaction router.

All routes resolve physical resource IDs from the CloudFormation stack so the
frontend only needs logical IDs (as shown in the diagram).
"""

import base64
import json
import os
from typing import Any

import boto3
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

MINISTACK_ENDPOINT = os.getenv("MINISTACK_ENDPOINT", "http://localhost:4566")

router = APIRouter(prefix="/resources", tags=["resources"])


def _client(service: str):
    """Return a boto3 client pointed at MiniStack."""
    return boto3.client(
        service,
        endpoint_url=MINISTACK_ENDPOINT,
        aws_access_key_id="test",
        aws_secret_access_key="test",
        region_name="us-east-1",
    )


def _resolve(stack_name: str, logical_id: str) -> dict:
    """
    Look up a resource by logical ID in the given CloudFormation stack and
    return the full resource dict (includes PhysicalResourceId, ResourceType).
    Raises 404 if either the stack or the resource is not found.
    """
    cfn = _client("cloudformation")
    try:
        resp = cfn.describe_stack_resources(StackName=stack_name)
    except Exception as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Stack '{stack_name}' not found: {exc}",
        )
    for r in resp.get("StackResources", []):
        if r["LogicalResourceId"] == logical_id:
            return r
    raise HTTPException(
        status_code=404,
        detail=f"Resource '{logical_id}' not found in stack '{stack_name}'.",
    )


def _serialize(value: Any) -> dict:
    """Convert a plain Python value to a DynamoDB AttributeValue dict."""
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, (int, float)):
        return {"N": str(value)}
    if isinstance(value, str):
        return {"S": value}
    if isinstance(value, list):
        return {"L": [_serialize(v) for v in value]}
    if isinstance(value, dict):
        return {"M": {k: _serialize(v) for k, v in value.items()}}
    if value is None:
        return {"NULL": True}
    return {"S": str(value)}


def _deserialize(attr: dict) -> Any:
    """Convert a DynamoDB AttributeValue dict back to a plain Python value."""
    if "S" in attr:
        return attr["S"]
    if "N" in attr:
        n = attr["N"]
        return int(n) if "." not in n else float(n)
    if "BOOL" in attr:
        return attr["BOOL"]
    if "NULL" in attr:
        return None
    if "L" in attr:
        return [_deserialize(v) for v in attr["L"]]
    if "M" in attr:
        return {k: _deserialize(v) for k, v in attr["M"].items()}
    return str(attr)


class PutItemRequest(BaseModel):
    item: dict[str, Any]


class DeleteItemRequest(BaseModel):
    key: dict[str, Any]


@router.get("/{stack_name}/{logical_id}/dynamodb/items")
def dynamo_scan(stack_name: str, logical_id: str):
    """Scan up to 25 items from the DynamoDB table identified by logical_id."""
    res = _resolve(stack_name, logical_id)
    table_name = res["PhysicalResourceId"]
    ddb = _client("dynamodb")
    try:
        resp = ddb.scan(TableName=table_name, Limit=25)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    items = [
        {k: _deserialize(v) for k, v in item.items()}
        for item in resp.get("Items", [])
    ]
    return {"items": items, "count": len(items)}


@router.post("/{stack_name}/{logical_id}/dynamodb/items")
def dynamo_put(stack_name: str, logical_id: str, req: PutItemRequest):
    """Write an item to the DynamoDB table identified by logical_id."""
    res = _resolve(stack_name, logical_id)
    table_name = res["PhysicalResourceId"]
    ddb = _client("dynamodb")
    serialized = {k: _serialize(v) for k, v in req.item.items()}
    try:
        ddb.put_item(TableName=table_name, Item=serialized)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True}


@router.delete("/{stack_name}/{logical_id}/dynamodb/items")
def dynamo_delete(stack_name: str, logical_id: str, req: DeleteItemRequest):
    """Delete a single item from the DynamoDB table by primary key."""
    res = _resolve(stack_name, logical_id)
    table_name = res["PhysicalResourceId"]
    ddb = _client("dynamodb")
    serialized = {k: _serialize(v) for k, v in req.key.items()}
    try:
        ddb.delete_item(TableName=table_name, Key=serialized)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"ok": True}


class SendMessageRequest(BaseModel):
    body: str


@router.post("/{stack_name}/{logical_id}/sqs/messages")
def sqs_send(stack_name: str, logical_id: str, req: SendMessageRequest):
    """Send a message to the SQS queue identified by logical_id."""
    res = _resolve(stack_name, logical_id)
    queue_url = res["PhysicalResourceId"]
    sqs = _client("sqs")
    try:
        resp = sqs.send_message(QueueUrl=queue_url, MessageBody=req.body)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    return {"message_id": resp.get("MessageId"), "ok": True}


@router.get("/{stack_name}/{logical_id}/sqs/messages")
def sqs_receive(
    stack_name: str,
    logical_id: str,
    delete_after_read: bool = True,
):
    """Receive up to 10 messages from the SQS queue."""
    res = _resolve(stack_name, logical_id)
    queue_url = res["PhysicalResourceId"]
    sqs = _client("sqs")
    try:
        resp = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=1,
            AttributeNames=["All"],
            MessageAttributeNames=["All"],
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    messages = resp.get("Messages", [])
    result = []
    for m in messages:
        result.append({
            "message_id": m.get("MessageId"),
            "body": m.get("Body"),
            "sent_timestamp": m.get("Attributes", {}).get("SentTimestamp"),
            "receipt_handle": m.get("ReceiptHandle"),
        })
        if delete_after_read:
            try:
                sqs.delete_message(
                    QueueUrl=queue_url,
                    ReceiptHandle=m["ReceiptHandle"],
                )
            except Exception:
                pass

    return {"messages": result, "count": len(result)}


class InvokeLambdaRequest(BaseModel):
    payload: dict[str, Any] = {}


@router.post("/{stack_name}/{logical_id}/lambda/invoke")
def lambda_invoke(stack_name: str, logical_id: str, req: InvokeLambdaRequest):
    """
    Invoke a Lambda function (RequestResponse mode) and return its response
    payload plus the CloudWatch log tail (decoded from base64 LogResult).
    """
    res = _resolve(stack_name, logical_id)
    function_name = res["PhysicalResourceId"]
    lam = _client("lambda")
    try:
        resp = lam.invoke(
            FunctionName=function_name,
            InvocationType="RequestResponse",
            LogType="Tail",
            Payload=json.dumps(req.payload).encode(),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    raw_payload = resp["Payload"].read()
    try:
        response_body = json.loads(raw_payload)
    except Exception:
        response_body = raw_payload.decode("utf-8", errors="replace")

    log_b64 = resp.get("LogResult", "")
    try:
        logs = base64.b64decode(log_b64).decode("utf-8", errors="replace")
    except Exception:
        logs = ""

    return {
        "status_code": resp.get("StatusCode"),
        "response": response_body,
        "logs": logs,
        "function_error": resp.get("FunctionError"),
    }