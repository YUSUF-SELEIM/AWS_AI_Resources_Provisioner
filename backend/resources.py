"""
Phase 3B - Resource interaction router.

All routes resolve physical resource IDs from the CloudFormation stack so the
frontend only needs logical IDs (as shown in the diagram).
"""

import base64
import io
import json
import os
import socket
import tarfile
from typing import Any

import boto3
import docker
import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


def _cfn_constructor(loader, tag_suffix, node):
    tag = tag_suffix.lstrip("!")
    if tag == "Ref":
        return {"Ref": loader.construct_scalar(node)}
    fn_name = f"Fn::{tag}"
    if isinstance(node, yaml.ScalarNode):
        return {fn_name: loader.construct_scalar(node)}
    elif isinstance(node, yaml.SequenceNode):
        return {fn_name: loader.construct_sequence(node, deep=True)}
    else:
        return {fn_name: loader.construct_mapping(node, deep=True)}

class CfnSafeLoader(yaml.SafeLoader):
    pass

CfnSafeLoader.add_multi_constructor("!", _cfn_constructor)


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
    Look up a resource by logical ID in the given stack's state file and
    return the full resource dict (includes PhysicalResourceId, ResourceType).
    Raises 404 if either the stack or the resource is not found.
    """
    from state_manager import load_stack_state
    try:
        state = load_stack_state(stack_name)
    except Exception as exc:
        raise HTTPException(
            status_code=404,
            detail=f"Stack '{stack_name}' not found in state: {exc}",
        )
    for r in state.get("Resources", []):
        if r["LogicalResourceId"] == logical_id:
            return r
    raise HTTPException(
        status_code=404,
        detail=f"Resource '{logical_id}' not found in stack state.",
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
        desc = ddb.describe_table(TableName=table_name)
        keys = [attr["AttributeName"] for attr in desc["Table"]["KeySchema"]]
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    items = [
        {k: _deserialize(v) for k, v in item.items()}
        for item in resp.get("Items", [])
    ]
    return {"items": items, "count": len(items), "keys": keys}


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


@router.get("/{stack_name}/{logical_id}/lambda/logs")
def get_lambda_logs(stack_name: str, logical_id: str):
    """Fetch recent execution logs from CloudWatch for the given Lambda function."""
    res = _resolve(stack_name, logical_id)
    function_name = res["PhysicalResourceId"]
    log_group_name = f"/aws/lambda/{function_name}"
    
    logs_client = _client("logs")
    try:
        streams_resp = logs_client.describe_log_streams(
            logGroupName=log_group_name,
            orderBy="LastEventTime",
            descending=True,
            limit=5
        )
        streams = streams_resp.get("logStreams", [])
        if not streams:
            return {"logs": "No log streams found (waiting for execution)."}
            
        log_content = ""
        # Read oldest to newest from the fetched streams
        for stream in reversed(streams):
            stream_name = stream["logStreamName"]
            events_resp = logs_client.get_log_events(
                logGroupName=log_group_name,
                logStreamName=stream_name,
                limit=100
            )
            for event in events_resp.get("events", []):
                log_content += event.get("message", "")
                
        return {"logs": log_content or "No log events found."}
    except logs_client.exceptions.ResourceNotFoundException:
        return {"logs": "No log group found yet. Trigger or invoke the function first to generate logs."}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))


# ---------------------------------------------------------------------------
# S3 endpoints
# ---------------------------------------------------------------------------

class DeleteS3ObjectRequest(BaseModel):
    key: str


class UploadS3ObjectRequest(BaseModel):
    key: str
    content: str


@router.get("/{stack_name}/{logical_id}/s3/objects")
def s3_list(stack_name: str, logical_id: str):
    """List up to 100 objects in the S3 bucket identified by logical_id."""
    res = _resolve(stack_name, logical_id)
    bucket_name = res["PhysicalResourceId"]
    s3 = _client("s3")
    try:
        resp = s3.list_objects_v2(Bucket=bucket_name, MaxKeys=100)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    
    objects = []
    for obj in resp.get("Contents", []):
        objects.append({
            "key": obj.get("Key"),
            "size": obj.get("Size", 0),
            "last_modified": obj.get("LastModified").isoformat() if obj.get("LastModified") else None,
        })
    
    return {"objects": objects, "count": len(objects)}


@router.delete("/{stack_name}/{logical_id}/s3/objects")
def s3_delete(stack_name: str, logical_id: str, req: DeleteS3ObjectRequest):
    """Delete a single object from the S3 bucket."""
    res = _resolve(stack_name, logical_id)
    bucket_name = res["PhysicalResourceId"]
    s3 = _client("s3")
    try:
        s3.delete_object(Bucket=bucket_name, Key=req.key)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    
    return {"ok": True}


@router.post("/{stack_name}/{logical_id}/s3/objects")
def s3_upload(stack_name: str, logical_id: str, req: UploadS3ObjectRequest):
    """Upload or update an object in the S3 bucket."""
    res = _resolve(stack_name, logical_id)
    bucket_name = res["PhysicalResourceId"]
    s3 = _client("s3")
    try:
        s3.put_object(Bucket=bucket_name, Key=req.key, Body=req.content.encode('utf-8'))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    
    return {"ok": True}


# ---------------------------------------------------------------------------
# EC2 endpoints
# ---------------------------------------------------------------------------

class Ec2StateRequest(BaseModel):
    action: str  # "start" | "stop" | "reboot"


def _copy_to_container(container, file_content: str, dest_path: str):
    """Copy string content into a container path using tar archive stream."""
    try:
        tar_stream = io.BytesIO()
        with tarfile.open(fileobj=tar_stream, mode='w') as tar:
            file_data = file_content.encode('utf-8')
            tarinfo = tarfile.TarInfo(name=os.path.basename(dest_path))
            tarinfo.size = len(file_data)
            tar.addfile(tarinfo, io.BytesIO(file_data))
        tar_stream.seek(0)
        container.put_archive(os.path.dirname(dest_path), tar_stream.read())
    except Exception as e:
        print(f"[Docker Sync] Failed to copy file to container: {e}")


def _manage_local_container(logical_id: str, action: str, stack_name: str = None):
    """
    Manage a real ephemeral Docker container on the host matching the logical_id.
    Ensures it is running in the same Docker network as MiniStack and has the network alias
    matching the logical_id so other containers/services (like Lambda) can address it.
    
    If stack_name is provided, it scans the stack resources for S3 objects, downloads them,
    and copies them inside the Nginx container to display custom S3 data to the user.
    """
    try:
        client = docker.from_env()
    except Exception as e:
        print(f"[Docker Sync] Client initialization failed: {e}")
        return
        
    container_name = f"AWS_AI_Resources_Provisioner-ec2-{logical_id.lower()}"
    
    # Identify the network this backend container is on
    network_name = None
    try:
        hostname = socket.gethostname()
        self_container = client.containers.get(hostname)
        networks = self_container.attrs.get("NetworkSettings", {}).get("Networks", {})
        if networks:
            network_name = list(networks.keys())[0]
    except Exception as e:
        print(f"[Docker Sync] Could not determine backend network: {e}")

    try:
        container = client.containers.get(container_name)
    except docker.errors.NotFound:
        container = None

    if action == "stop":
        if container:
            try:
                print(f"[Docker Sync] Stopping container {container_name}")
                container.stop()
            except Exception as e:
                print(f"[Docker Sync] Stop failed: {e}")
    elif action == "start":
        # If container exists and is already running, do not recreate it
        if container and container.status == "running":
            return

        # Always remove existing container to clear stale configuration or broken mounts
        if container:
            try:
                print(f"[Docker Sync] Removing existing container {container_name} to recreate it")
                container.remove(force=True)
            except Exception as e:
                print(f"[Docker Sync] Removal failed: {e}")
                
        # Check for S3 content to dynamically display in Nginx
        s3_content = ""
        if stack_name:
            try:
                cfn = _client("cloudformation")
                tpl_resp = cfn.get_template(StackName=stack_name)
                template_body = tpl_resp.get("TemplateBody", "")
                parsed = yaml.load(template_body, Loader=CfnSafeLoader)
                
                s3_client = _client("s3")
                resources = parsed.get("Resources", {})
                for r_id, r_val in resources.items():
                    r_type = r_val.get("Type")
                    if r_type in ("AWS::S3::BucketObject", "AWS::S3::Object", "Custom::MiniStackS3Object"):
                        props = r_val.get("Properties", {})
                        bucket_ref = props.get("Bucket")
                        
                        # Resolve bucket name
                        bucket_name = None
                        if isinstance(bucket_ref, dict) and "Ref" in bucket_ref:
                            bucket_logical = bucket_ref["Ref"]
                            try:
                                bucket_name = _resolve(stack_name, bucket_logical)["PhysicalResourceId"]
                            except Exception:
                                pass
                        elif isinstance(bucket_ref, str):
                            bucket_name = bucket_ref
                            
                        key = props.get("Key")
                        if bucket_name and key:
                            try:
                                s3_resp = s3_client.get_object(Bucket=bucket_name, Key=key)
                                val_str = s3_resp["Body"].read().decode("utf-8", errors="replace")
                                s3_content += f"<div style='margin-bottom:1rem;padding:1rem;background:#161920;border-radius:4px;border:1px solid #2d3139;'><div style='color:#a6e3a1;font-weight:bold;margin-bottom:0.5rem;'>📄 Object: {key} (Bucket: {bucket_name})</div><pre style='margin:0;color:#f4f4f5;'>{val_str}</pre></div>"
                            except Exception as s3_err:
                                print(f"[Docker Sync] Failed to get object {bucket_name}/{key}: {s3_err}")
            except Exception as tpl_err:
                print(f"[Docker Sync] Failed parsing template for S3 objects: {tpl_err}")

        # Check for DynamoDB content to dynamically display in Nginx
        dynamo_content = ""
        if stack_name:
            try:
                cfn = _client("cloudformation")
                tpl_resp = cfn.get_template(StackName=stack_name)
                template_body = tpl_resp.get("TemplateBody", "")
                parsed = yaml.load(template_body, Loader=CfnSafeLoader)
                resources = parsed.get("Resources", {})
                
                ddb_client = _client("dynamodb")
                for r_id, r_val in resources.items():
                    if r_val.get("Type") == "AWS::DynamoDB::Table":
                        try:
                            tbl_phys = _resolve(stack_name, r_id)["PhysicalResourceId"]
                            scan_resp = ddb_client.scan(TableName=tbl_phys, Limit=5)
                            items = scan_resp.get("Items", [])
                            items_html = ""
                            if items:
                                for item in items:
                                    deser = {k: _deserialize(v) for k, v in item.items()}
                                    items_html += f"<li style='margin-bottom:0.5rem;'><code style='color:#f9e2af;'>{json.dumps(deser)}</code></li>"
                            else:
                                items_html = "<li style='color:#7d8590;'>No items in table.</li>"
                            dynamo_content += f"<div style='margin-bottom:1rem;padding:1rem;background:#161920;border-radius:4px;border:1px solid #2d3139;'><div style='color:#f9e2af;font-weight:bold;margin-bottom:0.5rem;'>📊 Table: {tbl_phys}</div><ul style='margin:0;padding-left:1.25rem;'>{items_html}</ul></div>"
                        except Exception as ddb_err:
                            print(f"[Docker Sync] DDB Scan failed for {r_id}: {ddb_err}")
            except Exception as e:
                print(f"[Docker Sync] Failed parsing template for DDB: {e}")

        # Check for RDS content to dynamically display in Nginx
        rds_content = ""
        if stack_name:
            try:
                cfn = _client("cloudformation")
                tpl_resp = cfn.get_template(StackName=stack_name)
                template_body = tpl_resp.get("TemplateBody", "")
                parsed = yaml.load(template_body, Loader=CfnSafeLoader)
                resources = parsed.get("Resources", {})
                
                rds_client = _client("rds")
                rds_data = _client("rds-data")
                for r_id, r_val in resources.items():
                    if r_val.get("Type") == "AWS::RDS::DBInstance":
                        try:
                            db_phys = _resolve(stack_name, r_id)["PhysicalResourceId"]
                            desc_resp = rds_client.describe_db_instances(DBInstanceIdentifier=db_phys)
                            db_name = desc_resp["DBInstances"][0].get("DBName", "mydb")
                            db_arn = f"arn:aws:rds:us-east-1:000000000000:db:{db_phys}"
                            secret_name = f"AWS_AI_Resources_Provisioner-rds-secret-{db_phys.lower()}"
                            
                            show_resp = rds_data.execute_statement(
                                resourceArn=db_arn,
                                secretArn=secret_name,
                                sql="SHOW TABLES;",
                                database=db_name
                            )
                            tables = [row[0].get("stringValue") for row in show_resp.get("records", []) if row and isinstance(row[0], dict)]
                            tables_html = ""
                            if tables:
                                for table in tables:
                                    sel_resp = rds_data.execute_statement(
                                        resourceArn=db_arn,
                                        secretArn=secret_name,
                                        sql=f"SELECT * FROM {table} LIMIT 5;",
                                        database=db_name,
                                        includeResultMetadata=True
                                    )
                                    col_names = [col.get("name") for col in sel_resp.get("columnMetadata", [])]
                                    rows_html = ""
                                    for row in sel_resp.get("records", []):
                                        row_vals = []
                                        for col in row:
                                            row_vals.append(list(col.values())[0])
                                        row_dict = dict(zip(col_names, row_vals))
                                        rows_html += f"<li style='margin-bottom:0.25rem;'><code style='color:#89b4fa;'>{json.dumps(row_dict)}</code></li>"
                                    tables_html += f"<div style='margin-top:0.75rem;'><span style='color:#89b4fa;font-weight:bold;'>Table: {table}</span><ul style='margin:0.25rem 0;padding-left:1.25rem;'>{rows_html or '<li style=\"color:#7d8590;\">No records</li>'}</ul></div>"
                            else:
                                tables_html = "<div style='color:#7d8590;font-style:italic;'>No tables found.</div>"
                            rds_content += f"<div style='margin-bottom:1rem;padding:1rem;background:#161920;border-radius:4px;border:1px solid #2d3139;'><div style='color:#89dceb;font-weight:bold;margin-bottom:0.5rem;'>🗄️ Database: {db_phys} ({db_name})</div>{tables_html}</div>"
                        except Exception as rds_err:
                            print(f"[Docker Sync] RDS Query failed for {r_id}: {rds_err}")
            except Exception as e:
                print(f"[Docker Sync] Failed parsing template for RDS: {e}")

        # Build index.html
        html_body = f"""<!DOCTYPE html>
<html>
<head>
    <title>Mock EC2 Web Server</title>
    <style>
        body {{ font-family: system-ui, -apple-system, sans-serif; background: #080a0f; color: #f4f4f5; padding: 2rem; margin: 0; }}
        .card {{ max-width: 600px; margin: auto; background: #0d1117; padding: 2rem; border-radius: 8px; border: 1px solid #2d3139; }}
        h1 {{ color: #00e5ff; margin-top: 0; }}
        h3 {{ color: #89b4fa; margin-top: 1.5rem; margin-bottom: 0.5rem; border-bottom: 1px solid #2d3139; padding-bottom: 0.25rem; }}
        pre {{ background: #161920; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-family: monospace; }}
    </style>
</head>
<body>
    <div class="card">
        <h1>Hey! Local EC2 Web Server is running.</h1>
        <p>Resource ID: <strong>{logical_id}</strong></p>
        
        <h3>📦 S3 Buckets</h3>
        {s3_content or "<p style='color:#7d8590;font-style:italic;font-size:13px;'>No S3 objects found in the stack.</p>"}
        
        <h3>📊 DynamoDB Tables</h3>
        {dynamo_content or "<p style='color:#7d8590;font-style:italic;font-size:13px;'>No DynamoDB tables found in the stack.</p>"}
        
        <h3>🗄️ RDS Databases</h3>
        {rds_content or "<p style='color:#7d8590;font-style:italic;font-size:13px;'>No RDS MySQL instances found in the stack.</p>"}
    </div>
</body>
</html>"""

        # Create a fresh container matching the logical name
        try:
            print(f"[Docker Sync] Creating & running fresh container {container_name}")
            run_kwargs = {
                "image": "nginx:alpine",
                "name": container_name,
                "detach": True,
                "hostname": logical_id,
                "ports": {"80/tcp": None},
            }
            if network_name:
                run_kwargs["network"] = network_name
                
            new_container = client.containers.create(**run_kwargs)
            _copy_to_container(new_container, html_body, "/usr/share/nginx/html/index.html")
            new_container.start()
            
            # Attach logical ID alias so other services/containers can access it via logical ID
            if network_name:
                try:
                    net = client.networks.get(network_name)
                    # Disconnect/reconnect to apply network aliases properly
                    net.disconnect(new_container)
                    net.connect(new_container, aliases=[logical_id])
                except Exception as alias_err:
                    print(f"[Docker Sync] Failed to attach network alias {logical_id}: {alias_err}")
        except Exception as e:
            print(f"[Docker Sync] Container creation failed: {e}")
    elif action == "reboot":
        if container:
            try:
                print(f"[Docker Sync] Restarting container {container_name}")
                container.restart()
            except Exception as e:
                print(f"[Docker Sync] Restart failed: {e}")


@router.get("/{stack_name}/{logical_id}/ec2/info")
def get_ec2_info(stack_name: str, logical_id: str):
    res = _resolve(stack_name, logical_id)
    instance_id = res["PhysicalResourceId"]
    ec2 = _client("ec2")
    try:
        resp = ec2.describe_instances(InstanceIds=[instance_id])
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    
    reservations = resp.get("Reservations", [])
    if not reservations or not reservations[0].get("Instances"):
        raise HTTPException(status_code=404, detail="Instance not found.")
        
    instance = reservations[0]["Instances"][0]
    state = instance.get("State", {}).get("Name", "unknown")
    
    # Reconcile container state automatically on info retrieval
    if state == "running":
        _manage_local_container(logical_id, "start", stack_name=stack_name)
    elif state == "stopped":
        _manage_local_container(logical_id, "stop", stack_name=stack_name)

    # Fetch dynamic host port mapping
    host_port = None
    try:
        container_name = f"AWS_AI_Resources_Provisioner-ec2-{logical_id.lower()}"
        client = docker.from_env()
        container = client.containers.get(container_name)
        port_bindings = container.attrs.get("NetworkSettings", {}).get("Ports", {})
        if "80/tcp" in port_bindings and port_bindings["80/tcp"]:
            host_port = port_bindings["80/tcp"][0].get("HostPort")
    except Exception:
        pass

    return {
        "instance_id": instance_id,
        "state": state,
        "instance_type": instance.get("InstanceType", "unknown"),
        "public_ip": instance.get("PublicIpAddress"),
        "private_ip": instance.get("PrivateIpAddress"),
        "host_port": host_port,
    }


@router.post("/{stack_name}/{logical_id}/ec2/state")
def set_ec2_state(stack_name: str, logical_id: str, req: Ec2StateRequest):
    res = _resolve(stack_name, logical_id)
    instance_id = res["PhysicalResourceId"]
    ec2 = _client("ec2")
    try:
        if req.action == "start":
            ec2.start_instances(InstanceIds=[instance_id])
            _manage_local_container(logical_id, "start", stack_name=stack_name)
        elif req.action == "stop":
            ec2.stop_instances(InstanceIds=[instance_id])
            _manage_local_container(logical_id, "stop", stack_name=stack_name)
        elif req.action == "reboot":
            ec2.reboot_instances(InstanceIds=[instance_id])
            _manage_local_container(logical_id, "reboot", stack_name=stack_name)
        else:
            raise HTTPException(status_code=400, detail="Invalid action")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    
    return {"ok": True}


@router.get("/{stack_name}/{logical_id}/ec2/console")
def get_ec2_console(stack_name: str, logical_id: str):
    res = _resolve(stack_name, logical_id)
    instance_id = res["PhysicalResourceId"]
    ec2 = _client("ec2")
    try:
        resp = ec2.get_console_output(InstanceId=instance_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    
    output = resp.get("Output", "")
    if output:
        try:
            output = base64.b64decode(output).decode("utf-8", errors="replace")
        except Exception:
            pass
            
    return {"output": output}


class RdsActionRequest(BaseModel):
    action: str


def _ensure_rds_container(stack_name: str, logical_id: str, db_instance_id: str):
    docker_client = None
    try:
        docker_client = docker.from_env()
    except Exception:
        return
        
    container_name = f"ministack-rds-{db_instance_id.lower()}"
    container_exists = False
    container_running = False
    try:
        c = docker_client.containers.get(container_name)
        container_exists = True
        container_running = (c.status == "running")
    except Exception:
        pass
        
    if container_running:
        return
        
    if container_exists:
        try:
            c = docker_client.containers.get(container_name)
            c.remove(force=True)
        except Exception:
            pass
        
    cfn = _client("cloudformation")
    rds = _client("rds")
    try:
        template_resp = cfn.get_template(StackName=stack_name)
        template_body = template_resp.get("TemplateBody", "")
        if isinstance(template_body, str):
            tpl = yaml.load(template_body, Loader=CfnSafeLoader)
        else:
            tpl = template_body
            
        resources = tpl.get("Resources", {})
        db_resource = resources.get(logical_id, {})
        props = db_resource.get("Properties", {})
        
        def resolve_val(val, default=""):
            if not val:
                return default
            if isinstance(val, dict):
                if "Ref" in val:
                    ref_name = val["Ref"]
                    try:
                        stack_desc = cfn.describe_stacks(StackName=stack_name)
                        params = stack_desc["Stacks"][0].get("Parameters", [])
                        for p in params:
                            if p["ParameterKey"] == ref_name:
                                return p["ParameterValue"]
                    except Exception:
                        pass
                    return default
                return default
            return str(val)
            
        engine = resolve_val(props.get("Engine"), "mysql")
        engine_version = resolve_val(props.get("EngineVersion"), "8.0")
        db_class = resolve_val(props.get("DBInstanceClass"), "db.t3.micro")
        master_user = resolve_val(props.get("MasterUsername"), "admin")
        if master_user.lower() == "root":
            master_user = "admin"
        master_pass = resolve_val(props.get("MasterUserPassword"), "password")
        db_name = resolve_val(props.get("DBName"), "app_db")
        allocated_storage = int(resolve_val(props.get("AllocatedStorage"), "5"))
        
        # Deploy secret to SecretsManager for rds-data to consume
        try:
            secrets_client = _client("secretsmanager")
            secret_name = f"AWS_AI_Resources_Provisioner-rds-secret-{db_instance_id.lower()}"
            try:
                secrets_client.create_secret(
                    Name=secret_name,
                    SecretString=json.dumps({"username": master_user, "password": master_pass})
                )
            except Exception:
                try:
                    secrets_client.put_secret_value(
                        SecretId=secret_name,
                        SecretString=json.dumps({"username": master_user, "password": master_pass})
                    )
                except Exception:
                    pass
        except Exception:
            pass
            
        try:
            rds.delete_db_instance(DBInstanceIdentifier=db_instance_id, SkipFinalSnapshot=True)
        except Exception:
            pass
            
        rds.create_db_instance(
            DBInstanceIdentifier=db_instance_id,
            DBInstanceClass=db_class,
            Engine=engine,
            EngineVersion=engine_version,
            MasterUsername=master_user,
            MasterUserPassword=master_pass,
            DBName=db_name,
            AllocatedStorage=allocated_storage
        )
        
        import time
        for _ in range(10):
            try:
                inst_resp = rds.describe_db_instances(DBInstanceIdentifier=db_instance_id)
                inst = inst_resp["DBInstances"][0]
                if inst.get("DBInstanceStatus") == "available" or inst.get("_docker_container_id"):
                    break
            except Exception:
                pass
            time.sleep(0.5)
            
    except Exception as e:
        print(f"[RDS Self-Heal] Failed to spawn container: {e}")


@router.get("/{stack_name}/{logical_id}/rds/info")
def get_rds_info(stack_name: str, logical_id: str):
    res = _resolve(stack_name, logical_id)
    db_instance_id = res["PhysicalResourceId"]
    
    _ensure_rds_container(stack_name, logical_id, db_instance_id)
    
    rds = _client("rds")
    try:
        resp = rds.describe_db_instances(DBInstanceIdentifier=db_instance_id)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    
    instances = resp.get("DBInstances", [])
    if not instances:
        raise HTTPException(status_code=404, detail="DB Instance not found.")
        
    db = instances[0]
    
    endpoint = db.get("Endpoint", {})
    return {
        "db_instance_identifier": db_instance_id,
        "status": db.get("DBInstanceStatus", "unknown"),
        "address": endpoint.get("Address"),
        "port": endpoint.get("Port"),
        "engine": db.get("Engine", "unknown"),
        "engine_version": db.get("EngineVersion", "unknown"),
        "db_instance_class": db.get("DBInstanceClass", "unknown"),
        "allocated_storage": db.get("AllocatedStorage", 0),
        "db_name": db.get("DBName"),
        "master_username": db.get("MasterUsername"),
    }


@router.post("/{stack_name}/{logical_id}/rds/action")
def set_rds_action(stack_name: str, logical_id: str, req: RdsActionRequest):
    res = _resolve(stack_name, logical_id)
    db_instance_id = res["PhysicalResourceId"]
    
    _ensure_rds_container(stack_name, logical_id, db_instance_id)
    
    rds = _client("rds")
    try:
        if req.action == "reboot":
            rds.reboot_db_instance(DBInstanceIdentifier=db_instance_id)
        else:
            raise HTTPException(status_code=400, detail="Invalid action")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    
    return {"ok": True}


class RdsQueryRequest(BaseModel):
    sql: str


@router.post("/{stack_name}/{logical_id}/rds/query")
def run_rds_query(stack_name: str, logical_id: str, req: RdsQueryRequest):
    res = _resolve(stack_name, logical_id)
    db_instance_id = res["PhysicalResourceId"]
    
    _ensure_rds_container(stack_name, logical_id, db_instance_id)
    
    db_arn = f"arn:aws:rds:us-east-1:000000000000:db:{db_instance_id}"
    
    rds = _client("rds")
    try:
        resp = rds.describe_db_instances(DBInstanceIdentifier=db_instance_id)
        instances = resp.get("DBInstances", [])
        if not instances:
            raise HTTPException(status_code=404, detail="DB Instance not found.")
        db_name = instances[0].get("DBName", "mydb")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
        
    rds_data = _client("rds-data")
    secret_name = f"AWS_AI_Resources_Provisioner-rds-secret-{db_instance_id.lower()}"
    try:
        resp_stmt = rds_data.execute_statement(
            resourceArn=db_arn,
            secretArn=secret_name,
            sql=req.sql,
            database=db_name,
            includeResultMetadata=True
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))
        
    column_names = []
    if "columnMetadata" in resp_stmt:
        column_names = [col.get("name") for col in resp_stmt["columnMetadata"]]
        
    parsed_records = []
    for row in resp_stmt.get("records", []):
        parsed_row = {}
        for idx, col in enumerate(row):
            val = None
            if isinstance(col, dict):
                for k, v in col.items():
                    if k == 'isNull' and v:
                        val = None
                    else:
                        val = v
                        break
            else:
                val = col
            name = column_names[idx] if idx < len(column_names) else f"col_{idx}"
            parsed_row[name] = val
        parsed_records.append(parsed_row)
        
    return {
        "records": parsed_records,
        "numberOfRecordsUpdated": resp_stmt.get("numberOfRecordsUpdated", 0)
    }




