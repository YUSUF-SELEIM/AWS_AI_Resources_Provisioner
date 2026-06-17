import os
import re
import time
import yaml
import boto3
import json

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from groq_client import generate_cfn_template
from resources import router as resources_router

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="AWS_AI_Resources_Provisioner API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://frontend:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(resources_router)


MINISTACK_ENDPOINT = os.getenv("MINISTACK_ENDPOINT", "http://localhost:4566")


def get_cfn_client():
    return boto3.client(
        "cloudformation",
        endpoint_url=MINISTACK_ENDPOINT,
        aws_access_key_id="test",
        aws_secret_access_key="test",
        region_name="us-east-1",
    )
class GenerateRequest(BaseModel):
    prompt: str

class GenerateResponse(BaseModel):
    template: str

class DeployRequest(BaseModel):
    stack_name: str
    template: str

class DeployResponse(BaseModel):
    stack_name: str
    stack_id: str

class StackStatusResponse(BaseModel):
    stack_name: str
    status: str
    reason: str | None = None
    outputs: list[dict] | None = None
    failed_events: list[dict] | None = None

class StackResource(BaseModel):
    logical_id: str
    resource_type: str
    physical_id: str | None = None
    status: str

# --- Change set models ---

class ChangeSetRequest(BaseModel):
    template: str

class ChangeSetChange(BaseModel):
    action: str        # Add | Modify | Remove
    resource_type: str
    logical_id: str
    replacement: bool

class ChangeSetResponse(BaseModel):
    changeset_name: str
    changes: list[ChangeSetChange]

class ExecuteChangeSetResponse(BaseModel):
    ok: bool


class DiagramRequest(BaseModel):
    template: str

class DiagramNode(BaseModel):
    id: str
    type: str   # full resource type e.g. AWS::Lambda::Function
    label: str  # logical name

class DiagramEdge(BaseModel):
    source: str
    target: str
    label: str

class DiagramResponse(BaseModel):
    nodes: list[DiagramNode]
    edges: list[DiagramEdge]

# YAML helpers — CloudFormation-aware loader

def _cfn_constructor(loader, tag_suffix, node):
    """Convert CF short-form tags (!Ref, !GetAtt, etc.) to long-form dicts."""
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


def parse_cfn_yaml(template: str) -> dict:
    """Load CloudFormation YAML; raises HTTPException 400 on parse error."""
    try:
        parsed = yaml.load(template, Loader=CfnSafeLoader)
    except yaml.YAMLError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Generated template is not valid YAML: {exc}",
        )
    return parsed

import ast
import json

def validate_python(code: str) -> None:
    """Parse Python code and raise HTTPException 400 on syntax errors."""
    try:
        ast.parse(code)
    except SyntaxError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Generated script has invalid python syntax: {str(e)}",
        )

def build_diagram(template: str) -> DiagramResponse:
    """Parse the commented DIAGRAM_METADATA JSON block from Python script and return a node/edge graph."""
    nodes: list[DiagramNode] = []
    edges: list[DiagramEdge] = []
    
    # Extract commented JSON lines starting with "# DIAGRAM_METADATA:"
    metadata_lines = []
    recording = False
    for line in template.splitlines():
        line_strip = line.strip()
        if "DIAGRAM_METADATA:" in line_strip:
            recording = True
            continue
        if recording:
            if line_strip.startswith("#"):
                metadata_lines.append(line_strip.lstrip("#").strip())
            else:
                break
                
    if metadata_lines:
        try:
            metadata = json.loads("".join(metadata_lines))
            resources = metadata.get("resources", {})
            for logical_id, res_type in resources.items():
                nodes.append(DiagramNode(id=logical_id, type=res_type, label=logical_id))
            for ref in metadata.get("references", []):
                edges.append(DiagramEdge(source=ref["source"], target=ref["target"], label=ref.get("label", "ref")))
        except Exception as e:
            # Fallback if parsing fails
            print("Failed to parse diagram metadata:", e)
            
    return DiagramResponse(nodes=nodes, edges=edges)

# Misc helpers

def fetch_failed_events(cfn, stack_name: str) -> list[dict]:
    """Return failed resource events for a stack to surface root-cause errors."""
    try:
        resp = cfn.describe_stack_events(StackName=stack_name)
        events = resp.get("StackEvents", [])
        failed = [
            {
                "logical_id": e.get("LogicalResourceId", ""),
                "resource_type": e.get("ResourceType", ""),
                "status": e.get("ResourceStatus", ""),
                "reason": e.get("ResourceStatusReason", ""),
            }
            for e in events
            if "FAILED" in e.get("ResourceStatus", "")
        ]
        return failed
    except Exception:
        return []

# EC2 Custom Resource Workaround because it is not supported in MiniStack CloudFormation

LAMBDA_CODE = """
import boto3
import json
import urllib.request
import os

def handler(event, context):
    print("Event:", event)
    request_type = event['RequestType']
    props = event['ResourceProperties']
    res_type = event['ResourceType']
    ec2 = boto3.client('ec2', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
    physical_id = event.get('PhysicalResourceId', 'unknown')
    response_data = {}
    status = 'SUCCESS'

    try:
        if res_type == 'Custom::MiniStackInstance':
            if request_type == 'Create':
                ALLOWED_RUN_KEYS = {
                    'BlockDeviceMappings', 'ImageId', 'InstanceType', 'Ipv6AddressCount', 'Ipv6Addresses',
                    'KernelId', 'KeyName', 'MaxCount', 'MinCount', 'Monitoring', 'Placement', 'RamdiskId',
                    'SecurityGroupIds', 'SecurityGroups', 'SubnetId', 'UserData', 'ElasticGpuSpecification',
                    'ElasticInferenceAccelerators', 'TagSpecifications', 'LaunchTemplate', 'InstanceMarketOptions',
                    'CreditSpecification', 'CpuOptions', 'CapacityReservationSpecification', 'HibernationOptions',
                    'LicenseSpecifications', 'MetadataOptions', 'EnclaveOptions', 'PrivateDnsNameOptions',
                    'MaintenanceOptions', 'DisableApiStop', 'EnablePrimaryIpv6', 'NetworkPerformanceOptions',
                    'Operator', 'SecondaryInterfaces', 'DryRun', 'DisableApiTermination',
                    'InstanceInitiatedShutdownBehavior', 'PrivateIpAddress', 'ClientToken', 'AdditionalInfo',
                    'NetworkInterfaces', 'IamInstanceProfile', 'EbsOptimized'
                }
                run_kwargs = {k: v for k, v in props.items() if k in ALLOWED_RUN_KEYS}
                if 'MinCount' not in run_kwargs: run_kwargs['MinCount'] = 1
                if 'MaxCount' not in run_kwargs: run_kwargs['MaxCount'] = 1
                
                # Handle Tags
                if 'Tags' in props:
                    run_kwargs['TagSpecifications'] = [{
                        'ResourceType': 'instance',
                        'Tags': props['Tags']
                    }]
                    
                resp = ec2.run_instances(**run_kwargs)
                instance = resp['Instances'][0]
                physical_id = instance['InstanceId']
                response_data['PublicIp'] = instance.get('PublicIpAddress', '')
                response_data['PrivateIp'] = instance.get('PrivateIpAddress', '')

            elif request_type == 'Delete':
                if physical_id != 'unknown':
                    ec2.terminate_instances(InstanceIds=[physical_id])
                    
            elif request_type == 'Update':
                pass
                
        elif res_type == 'Custom::MiniStackEIP':
            if request_type == 'Create':
                resp = ec2.allocate_address(Domain='vpc')
                physical_id = resp['AllocationId']
                response_data['PublicIp'] = resp.get('PublicIp', '')
                response_data['AllocationId'] = resp.get('AllocationId', '')
            elif request_type == 'Delete':
                if physical_id != 'unknown':
                    ec2.release_address(AllocationId=physical_id)
            elif request_type == 'Update':
                pass
                
        elif res_type == 'Custom::MiniStackEIPAssociation':
            if request_type == 'Create':
                assoc_kwargs = {}
                if 'AllocationId' in props:
                    assoc_kwargs['AllocationId'] = props['AllocationId']
                if 'InstanceId' in props:
                    assoc_kwargs['InstanceId'] = props['InstanceId']
                if 'PublicIp' in props:
                    assoc_kwargs['PublicIp'] = props['PublicIp']
                resp = ec2.associate_address(**assoc_kwargs)
                physical_id = resp['AssociationId']
                response_data['AssociationId'] = resp['AssociationId']
            elif request_type == 'Delete':
                if physical_id != 'unknown':
                    ec2.disassociate_address(AssociationId=physical_id)
            elif request_type == 'Update':
                pass

        elif res_type == 'Custom::MiniStackS3Object':
            s3 = boto3.client('s3', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
            if request_type in ('Create', 'Update'):
                bucket = props.get('Bucket')
                key = props.get('Key')
                content = props.get('Content', props.get('Body', ''))
                
                # S3 put_object body parameter validation
                body_bytes = content.encode('utf-8') if isinstance(content, str) else content
                s3.put_object(Bucket=bucket, Key=key, Body=body_bytes)
                physical_id = f"{bucket}/{key}"
                response_data['Bucket'] = bucket
                response_data['Key'] = key
            elif request_type == 'Delete':
                if physical_id != 'unknown' and '/' in physical_id:
                    bucket, key = physical_id.split('/', 1)
                    try:
                        s3.delete_object(Bucket=bucket, Key=key)
                    except Exception:
                        pass
            elif request_type == 'Update':
                pass

    except Exception as e:
        print("Error:", e)
        status = 'FAILED'
        response_data['Error'] = str(e)

    response_body = json.dumps({
        "Status": status,
        "Reason": "See details in CloudWatch Log Stream",
        "PhysicalResourceId": physical_id,
        "StackId": event['StackId'],
        "RequestId": event['RequestId'],
        "LogicalResourceId": event['LogicalResourceId'],
        "Data": response_data
    }).encode('utf-8')
    
    req = urllib.request.Request(event['ResponseURL'], data=response_body, method='PUT')
    req.add_header('Content-Type', '')
    req.add_header('Content-Length', len(response_body))
    try:
        urllib.request.urlopen(req)
    except Exception as e:
        print("Failed to send response:", e)
"""

def inject_ec2_workaround(template_str: str) -> str:
    """Finds AWS::EC2::Instance, EIP, EIPAssociation, and S3 Objects, replacing them with Custom resources.
    Also merges standalone AWS::EC2::SecurityGroupIngress resources directly into AWS::EC2::SecurityGroup resources.
    """
    parsed = yaml.load(template_str, Loader=CfnSafeLoader)
    if not isinstance(parsed, dict) or "Resources" not in parsed:
        return template_str
        
    resources = parsed.get("Resources", {})
    
    # 1. Merge AWS::EC2::SecurityGroupIngress resources directly into AWS::EC2::SecurityGroup resources
    ingress_resources = []
    for logical_id, resource in list(resources.items()):
        if not isinstance(resource, dict):
            continue
        if resource.get("Type") == "AWS::EC2::SecurityGroupIngress":
            ingress_resources.append((logical_id, resource))

    has_custom = False
    for logical_id, resource in ingress_resources:
        props = resource.get("Properties", {})
        group_id_ref = props.get("GroupId")
        
        target_sg_id = None
        if isinstance(group_id_ref, dict):
            if "Ref" in group_id_ref:
                target_sg_id = group_id_ref["Ref"]
            elif "Fn::GetAtt" in group_id_ref:
                val = group_id_ref["Fn::GetAtt"]
                target_sg_id = val[0] if isinstance(val, list) else str(val).split(".")[0]
        elif isinstance(group_id_ref, str):
            target_sg_id = group_id_ref
            
        if target_sg_id and target_sg_id in resources:
            target_sg = resources[target_sg_id]
            if "Properties" not in target_sg:
                target_sg["Properties"] = {}
            if "SecurityGroupIngress" not in target_sg["Properties"]:
                target_sg["Properties"]["SecurityGroupIngress"] = []
                
            rule = {k: v for k, v in props.items() if k != "GroupId"}
            target_sg["Properties"]["SecurityGroupIngress"].append(rule)
            
            # Delete standalone resource
            del resources[logical_id]
            has_custom = True

    # 2. Intercept unsupported types and convert to custom resources
    for logical_id, resource in list(resources.items()):
        if not isinstance(resource, dict):
            continue
        res_type = resource.get("Type")
        if res_type in ("AWS::EC2::Instance", "AWS::EC2::EIP", "AWS::EC2::EIPAssociation"):
            has_custom = True
            custom_type = res_type.replace("AWS::EC2::", "Custom::MiniStack")
            resource["Type"] = custom_type
            if "Properties" not in resource:
                resource["Properties"] = {}
            resource["Properties"]["ServiceToken"] = {"Fn::GetAtt": ["AWS_AI_Resources_ProvisionerEC2Provider", "Arn"]}
        elif res_type in ("AWS::S3::BucketObject", "AWS::S3::Object"):
            has_custom = True
            resource["Type"] = "Custom::MiniStackS3Object"
            if "Properties" not in resource:
                resource["Properties"] = {}
            resource["Properties"]["ServiceToken"] = {"Fn::GetAtt": ["AWS_AI_Resources_ProvisionerEC2Provider", "Arn"]}

    if not has_custom:
        return template_str

    # Inject the provider Lambda and Role
    parsed["Resources"]["AWS_AI_Resources_ProvisionerEC2ProviderRole"] = {
        "Type": "AWS::IAM::Role",
        "Properties": {
            "AssumeRolePolicyDocument": {
                "Statement": [{
                    "Action": "sts:AssumeRole",
                    "Effect": "Allow",
                    "Principal": {"Service": "lambda.amazonaws.com"}
                }]
            },
            "ManagedPolicyArns": [
                "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
                "arn:aws:iam::aws:policy/AmazonEC2FullAccess",
                "arn:aws:iam::aws:policy/AmazonS3FullAccess"
            ]
        }
    }
    
    parsed["Resources"]["AWS_AI_Resources_ProvisionerEC2Provider"] = {
        "Type": "AWS::Lambda::Function",
        "Properties": {
            "Handler": "index.handler",
            "Role": {"Fn::GetAtt": ["AWS_AI_Resources_ProvisionerEC2ProviderRole", "Arn"]},
            "Runtime": "python3.12",
            "Timeout": 60,
            "Code": {"ZipFile": LAMBDA_CODE}
        }
    }

    # Dump back to YAML
    import io
    output = io.StringIO()
    yaml.dump(parsed, output, default_flow_style=False, sort_keys=False)
    return output.getvalue()



# Endpoints

@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest):
    """Generate a Python provisioning script from a natural-language prompt."""
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty.")
    try:
        template = generate_cfn_template(req.prompt)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Groq error: {exc}")

    validate_python(template)
    return GenerateResponse(template=template)


@app.post("/deploy", response_model=DeployResponse)
async def deploy(req: DeployRequest):
    """Deploy resources by running a Python script directly on MiniStack."""
    if not req.stack_name.strip() or not req.template.strip():
        raise HTTPException(status_code=400, detail="stack_name and template are required.")

    validate_python(req.template)

    import subprocess
    import tempfile
    import sys
    
    # Save script to a temporary file
    with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="w", encoding="utf-8") as f:
        f.write(req.template)
        temp_script_path = f.name
        
    try:
        # Run the script and capture output
        res = subprocess.run(
            [sys.executable, temp_script_path],
            capture_output=True,
            text=True,
            timeout=60
        )
        # Clean up temp file
        os.remove(temp_script_path)
        
        if res.returncode != 0:
            raise HTTPException(
                status_code=502,
                detail=f"Execution error:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
            )
            
        print("Script STDOUT:", res.stdout)
        print("Script STDERR:", res.stderr)
            
        # Parse the JSON at the end of the script
        lines = res.stdout.strip().split("\n") if res.stdout else []
        state_data = None
        for line in reversed(lines):
            try:
                state_data = json.loads(line)
                if "resources" in state_data:
                    break
            except Exception:
                continue
                
        resources = []
        if state_data and "resources" in state_data:
            resources = state_data["resources"]
        else:
            # Fallback: Parse DIAGRAM_METADATA and code to extract resources
            print("No state JSON printed. Falling back to code analysis.")
            diagram = build_diagram(req.template)
            for node in diagram.nodes:
                logical_id = node.id
                res_type = node.type
                
                physical_id = logical_id
                if res_type == "AWS::S3::Bucket":
                    match = re.search(r"(?:bucket_name|BucketName)\s*=\s*['\"]([^'\"]+)['\"]", req.template)
                    physical_id = match.group(1) if match else logical_id.lower()
                elif res_type == "AWS::Lambda::Function":
                    match = re.search(r"(?:FunctionName|function_name)\s*=\s*['\"]([^'\"]+)['\"]", req.template)
                    physical_id = match.group(1) if match else logical_id
                elif res_type == "AWS::DynamoDB::Table":
                    match = re.search(r"(?:TableName|table_name)\s*=\s*['\"]([^'\"]+)['\"]", req.template)
                    physical_id = match.group(1) if match else logical_id
                elif res_type == "AWS::SQS::Queue":
                    match = re.search(r"(?:QueueName|queue_name)\s*=\s*['\"]([^'\"]+)['\"]", req.template)
                    q_name = match.group(1) if match else logical_id.lower()
                    physical_id = f"http://localhost:4566/000000000000/{q_name}"
                elif res_type == "AWS::IAM::Role":
                    match = re.search(r"(?:RoleName|role_name)\s*=\s*['\"]([^'\"]+)['\"]", req.template)
                    physical_id = match.group(1) if match else logical_id

                resources.append({
                    "LogicalResourceId": logical_id,
                    "PhysicalResourceId": physical_id,
                    "ResourceType": res_type
                })
            
            if not resources:
                raise HTTPException(
                    status_code=502,
                    detail=f"Script execution completed but did not output resource state. Output:\n{res.stdout}"
                )
            
        # Save state locally
        from state_manager import save_stack_state
        save_stack_state(
            stack_name=req.stack_name,
            resources=resources,
            template="",
            python_script=req.template
        )
        
    except subprocess.TimeoutExpired:
        if os.path.exists(temp_script_path):
            os.remove(temp_script_path)
        raise HTTPException(status_code=504, detail="Script execution timed out after 60s.")
    except Exception as e:
        if os.path.exists(temp_script_path):
            os.remove(temp_script_path)
        raise HTTPException(status_code=500, detail=f"Failed to execute provisioning script: {str(e)}")

    return DeployResponse(stack_name=req.stack_name, stack_id=req.stack_name)


@app.post("/stacks/{stack_name}/changeset", response_model=ChangeSetResponse)
async def create_changeset(stack_name: str, req: ChangeSetRequest):
    """Create a mock change set for direct Python provisioning."""
    validate_python(req.template)

    diagram_data = build_diagram(req.template)
    changes: list[ChangeSetChange] = []
    for node in diagram_data.nodes:
        changes.append(ChangeSetChange(
            action="Add",
            resource_type=node.type,
            logical_id=node.id,
            replacement=False
        ))

    # Save the changeset python script temporarily
    from state_manager import ensure_stacks_dir, get_state_path
    ensure_stacks_dir()
    safe_name = "".join(c for c in stack_name if c.isalnum() or c in ("-", "_"))
    changeset_path = os.path.join(os.path.dirname(get_state_path(stack_name)), f"{safe_name}.changeset")
    with open(changeset_path, "w", encoding="utf-8") as f:
        f.write(req.template)

    changeset_name = f"cs-{int(time.time())}"
    return ChangeSetResponse(changeset_name=changeset_name, changes=changes)


@app.post(
    "/stacks/{stack_name}/changeset/{changeset_name}/execute",
    response_model=ExecuteChangeSetResponse,
)
async def execute_changeset(stack_name: str, changeset_name: str):
    """Execute a previously created Python change set."""
    from state_manager import get_state_path, save_stack_state
    safe_name = "".join(c for c in stack_name if c.isalnum() or c in ("-", "_"))
    changeset_path = os.path.join(os.path.dirname(get_state_path(stack_name)), f"{safe_name}.changeset")

    if not os.path.exists(changeset_path):
        raise HTTPException(status_code=404, detail="Changeset template not found.")

    with open(changeset_path, "r", encoding="utf-8") as f:
        script_code = f.read()

    import subprocess
    import tempfile
    import sys

    # Save script to a temporary file
    with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="w", encoding="utf-8") as f:
        f.write(script_code)
        temp_script_path = f.name

    try:
        # Run the script and capture output
        res = subprocess.run(
            [sys.executable, temp_script_path],
            capture_output=True,
            text=True,
            timeout=60
        )
        # Clean up temp file
        os.remove(temp_script_path)
        os.remove(changeset_path)

        if res.returncode != 0:
            raise HTTPException(
                status_code=502,
                detail=f"Execution error:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
            )

        print("Script STDOUT:", res.stdout)
        print("Script STDERR:", res.stderr)

        # Parse the JSON at the end of the script
        lines = res.stdout.strip().split("\n") if res.stdout else []
        state_data = None
        for line in reversed(lines):
            try:
                state_data = json.loads(line)
                if "resources" in state_data:
                    break
            except Exception:
                continue

        resources = []
        if state_data and "resources" in state_data:
            resources = state_data["resources"]
        else:
            # Fallback: Parse DIAGRAM_METADATA and code to extract resources
            print("No state JSON printed in changeset. Falling back to code analysis.")
            diagram = build_diagram(script_code)
            for node in diagram.nodes:
                logical_id = node.id
                res_type = node.type

                physical_id = logical_id
                if res_type == "AWS::S3::Bucket":
                    match = re.search(r"(?:bucket_name|BucketName)\s*=\s*['\"]([^'\"]+)['\"]", script_code)
                    physical_id = match.group(1) if match else logical_id.lower()
                elif res_type == "AWS::Lambda::Function":
                    match = re.search(r"(?:FunctionName|function_name)\s*=\s*['\"]([^'\"]+)['\"]", script_code)
                    physical_id = match.group(1) if match else logical_id
                elif res_type == "AWS::DynamoDB::Table":
                    match = re.search(r"(?:TableName|table_name)\s*=\s*['\"]([^'\"]+)['\"]", script_code)
                    physical_id = match.group(1) if match else logical_id
                elif res_type == "AWS::SQS::Queue":
                    match = re.search(r"(?:QueueName|queue_name)\s*=\s*['\"]([^'\"]+)['\"]", script_code)
                    q_name = match.group(1) if match else logical_id.lower()
                    physical_id = f"http://localhost:4566/000000000000/{q_name}"
                elif res_type == "AWS::IAM::Role":
                    match = re.search(r"(?:RoleName|role_name)\s*=\s*['\"]([^'\"]+)['\"]", script_code)
                    physical_id = match.group(1) if match else logical_id

                resources.append({
                    "LogicalResourceId": logical_id,
                    "PhysicalResourceId": physical_id,
                    "ResourceType": res_type
                })

            if not resources:
                raise HTTPException(
                    status_code=502,
                    detail=f"Script execution completed but did not output resource state. Output:\n{res.stdout}"
                )

        # Save state locally
        save_stack_state(
            stack_name=stack_name,
            resources=resources,
            template="",
            python_script=script_code
        )

    except subprocess.TimeoutExpired:
        if os.path.exists(temp_script_path):
            os.remove(temp_script_path)
        raise HTTPException(status_code=504, detail="Script execution timed out after 60s.")
    except Exception as e:
        if os.path.exists(temp_script_path):
            os.remove(temp_script_path)
        raise HTTPException(status_code=500, detail=f"Failed to execute provisioning script: {str(e)}")

    return ExecuteChangeSetResponse(ok=True)


@app.get("/stacks/{stack_name}", response_model=StackStatusResponse)
async def get_stack_status(stack_name: str):
    """Poll the status of a deployed stack."""
    from state_manager import load_stack_state
    try:
        state = load_stack_state(stack_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Stack '{stack_name}' not found.")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Error reading stack state: {exc}")

    return StackStatusResponse(
        stack_name=state["StackName"],
        status=state.get("StackStatus", "CREATE_COMPLETE"),
        reason="Direct API Provisioned",
        outputs=[],
        failed_events=None,
    )


@app.get("/stacks/{stack_name}/resources", response_model=list[StackResource])
async def get_stack_resources(stack_name: str):
    """List all resources in a deployed stack."""
    from state_manager import load_stack_state
    try:
        state = load_stack_state(stack_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Stack '{stack_name}' not found.")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Error reading stack state: {exc}")

    return [
        StackResource(
            logical_id=r["LogicalResourceId"],
            resource_type=r["ResourceType"],
            physical_id=r.get("PhysicalResourceId"),
            status="CREATE_COMPLETE",
        )
        for r in state.get("Resources", [])
    ]


@app.post("/diagram", response_model=DiagramResponse)
async def diagram(req: DiagramRequest):
    """Parse a Python script and return a node/edge graph."""
    validate_python(req.template)
    return build_diagram(req.template)


@app.delete("/stacks/{stack_name}")
async def delete_stack(stack_name: str):
    """Delete a stack and tear down all its resources from MiniStack."""
    from state_manager import load_stack_state, delete_stack_state
    try:
        state = load_stack_state(stack_name)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Stack '{stack_name}' not found.")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Error reading stack state: {exc}")

    resources = state.get("Resources", [])
    
    # We delete in reverse order of creation to respect dependencies (e.g. Lambdas before Roles)
    for r in reversed(resources):
        res_type = r.get("ResourceType")
        phys_id = r.get("PhysicalResourceId")
        if not phys_id:
            continue
            
        print(f"Tearing down resource {res_type}: {phys_id}")
        try:
            if res_type == "AWS::S3::Bucket":
                s3 = boto3.client('s3', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
                # Empty bucket first
                try:
                    objects = s3.list_objects_v2(Bucket=phys_id)
                    if 'Contents' in objects:
                        for obj in objects['Contents']:
                            s3.delete_object(Bucket=phys_id, Key=obj['Key'])
                except Exception as e:
                    print(f"Error emptying bucket {phys_id}: {e}")
                s3.delete_bucket(Bucket=phys_id)
                
            elif res_type == "AWS::Lambda::Function":
                awslambda = boto3.client('lambda', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
                awslambda.delete_function(FunctionName=phys_id)
                
            elif res_type == "AWS::IAM::Role":
                iam = boto3.client('iam', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
                # Detach managed policies
                try:
                    attached = iam.list_attached_role_policies(RoleName=phys_id)
                    for p in attached.get('AttachedPolicies', []):
                        iam.detach_role_policy(RoleName=phys_id, PolicyArn=p['PolicyArn'])
                except Exception:
                    pass
                # Delete inline policies
                try:
                    inline = iam.list_role_policies(RoleName=phys_id)
                    for p_name in inline.get('PolicyNames', []):
                        iam.delete_role_policy(RoleName=phys_id, PolicyName=p_name)
                except Exception:
                    pass
                iam.delete_role(RoleName=phys_id)
                
            elif res_type == "AWS::DynamoDB::Table":
                ddb = boto3.client('dynamodb', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
                ddb.delete_table(TableName=phys_id)
                
            elif res_type == "AWS::SQS::Queue":
                sqs = boto3.client('sqs', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
                sqs.delete_queue(QueueUrl=phys_id)
                
            elif res_type == "AWS::EC2::Instance":
                ec2 = boto3.client('ec2', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
                ec2.terminate_instances(InstanceIds=[phys_id])
                
            elif res_type == "AWS::EC2::SecurityGroup":
                ec2 = boto3.client('ec2', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
                ec2.delete_security_group(GroupId=phys_id)
        except Exception as e:
            # Continue teardown even if one resource fails
            print(f"Error tearing down {phys_id}: {e}")

    # Remove the state file
    delete_stack_state(stack_name)
    return {"ok": True}


@app.get("/health")
async def health():
    return {"status": "ok"}
