import os
import re
import time
import yaml
import boto3

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from groq_client import generate_cfn_template
from resources import router as resources_router

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="Stackmind API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://frontend:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(resources_router)

# ---------------------------------------------------------------------------
# AWS / MiniStack client
# ---------------------------------------------------------------------------

MINISTACK_ENDPOINT = os.getenv("MINISTACK_ENDPOINT", "http://localhost:4566")


def get_cfn_client():
    return boto3.client(
        "cloudformation",
        endpoint_url=MINISTACK_ENDPOINT,
        aws_access_key_id="test",
        aws_secret_access_key="test",
        region_name="us-east-1",
    )

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

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

# --- Diagram models ---

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

# ---------------------------------------------------------------------------
# YAML helpers — CloudFormation-aware loader
# ---------------------------------------------------------------------------

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


def validate_yaml(template: str) -> None:
    """Parse YAML and raise HTTPException 400 on syntax or structure errors."""
    parsed = parse_cfn_yaml(template)
    if not isinstance(parsed, dict) or "Resources" not in parsed:
        raise HTTPException(
            status_code=400,
            detail="Generated template is missing a 'Resources' section.",
        )

# ---------------------------------------------------------------------------
# Diagram helpers
# ---------------------------------------------------------------------------

def _collect_refs(obj, logical_ids: set) -> list:
    """Recursively find all logical-ID references inside a property value."""
    found: list = []
    if isinstance(obj, dict):
        if "Ref" in obj and obj["Ref"] in logical_ids:
            found.append(obj["Ref"])
        elif "Fn::GetAtt" in obj:
            val = obj["Fn::GetAtt"]
            target = val[0] if isinstance(val, list) else str(val).split(".")[0]
            if target in logical_ids:
                found.append(target)
        elif "Fn::Sub" in obj:
            sub_val = obj["Fn::Sub"]
            if isinstance(sub_val, str):
                for m in re.findall(r"\$\{([^}]+)\}", sub_val):
                    base = m.split(".")[0]
                    if base in logical_ids:
                        found.append(base)
        for v in obj.values():
            found.extend(_collect_refs(v, logical_ids))
    elif isinstance(obj, list):
        for item in obj:
            found.extend(_collect_refs(item, logical_ids))
    return found


def build_diagram(template: str) -> DiagramResponse:
    parsed = parse_cfn_yaml(template)
    resources: dict = parsed.get("Resources", {})
    logical_ids = set(resources.keys())

    nodes: list[DiagramNode] = []
    edges: list[DiagramEdge] = []
    seen_edges: set = set()

    for logical_id, resource_def in resources.items():
        res_type = resource_def.get("Type", "Unknown")
        nodes.append(DiagramNode(id=logical_id, type=res_type, label=logical_id))

    for logical_id, resource_def in resources.items():
        props = resource_def.get("Properties", {}) or {}
        refs = _collect_refs(props, logical_ids)
        for target in refs:
            if target != logical_id:
                key = (logical_id, target)
                if key not in seen_edges:
                    seen_edges.add(key)
                    edges.append(DiagramEdge(source=logical_id, target=target, label="ref"))

        # DependsOn edges
        depends_on = resource_def.get("DependsOn", [])
        if isinstance(depends_on, str):
            depends_on = [depends_on]
        for dep in depends_on:
            if dep in logical_ids:
                key = (logical_id, dep)
                if key not in seen_edges:
                    seen_edges.add(key)
                    edges.append(DiagramEdge(source=logical_id, target=dep, label="DependsOn"))

    return DiagramResponse(nodes=nodes, edges=edges)

# ---------------------------------------------------------------------------
# Misc helpers
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# EC2 Custom Resource Workaround
# ---------------------------------------------------------------------------

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
            resource["Properties"]["ServiceToken"] = {"Fn::GetAtt": ["StackMindEC2Provider", "Arn"]}
        elif res_type in ("AWS::S3::BucketObject", "AWS::S3::Object"):
            has_custom = True
            resource["Type"] = "Custom::MiniStackS3Object"
            if "Properties" not in resource:
                resource["Properties"] = {}
            resource["Properties"]["ServiceToken"] = {"Fn::GetAtt": ["StackMindEC2Provider", "Arn"]}

    if not has_custom:
        return template_str

    # Inject the provider Lambda and Role
    parsed["Resources"]["StackMindEC2ProviderRole"] = {
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
    
    parsed["Resources"]["StackMindEC2Provider"] = {
        "Type": "AWS::Lambda::Function",
        "Properties": {
            "Handler": "index.handler",
            "Role": {"Fn::GetAtt": ["StackMindEC2ProviderRole", "Arn"]},
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



# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest):
    """Generate a CloudFormation template from a natural-language prompt."""
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty.")
    try:
        template = generate_cfn_template(req.prompt)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Groq error: {exc}")

    validate_yaml(template)
    return GenerateResponse(template=template)


@app.post("/deploy", response_model=DeployResponse)
async def deploy(req: DeployRequest):
    """Deploy a CloudFormation template to MiniStack (direct create_stack)."""
    if not req.stack_name.strip() or not req.template.strip():
        raise HTTPException(status_code=400, detail="stack_name and template are required.")

    validate_yaml(req.template)
    final_template = inject_ec2_workaround(req.template)

    cfn = get_cfn_client()
    try:
        resp = cfn.create_stack(
            StackName=req.stack_name,
            TemplateBody=final_template,
            Capabilities=["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
        )
    except cfn.exceptions.AlreadyExistsException:
        raise HTTPException(status_code=409, detail=f"Stack '{req.stack_name}' already exists.")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"MiniStack error: {exc}")

    return DeployResponse(stack_name=req.stack_name, stack_id=resp["StackId"])


@app.post("/stacks/{stack_name}/changeset", response_model=ChangeSetResponse)
async def create_changeset(stack_name: str, req: ChangeSetRequest):
    """Create a change set (CREATE type for new stacks, UPDATE for existing)."""
    validate_yaml(req.template)
    final_template = inject_ec2_workaround(req.template)

    cfn = get_cfn_client()

    # Detect if stack already exists to pick changeset type
    changeset_type = "CREATE"
    try:
        cfn.describe_stacks(StackName=stack_name)
        changeset_type = "UPDATE"
    except Exception as exc:
        if "does not exist" not in str(exc):
            raise HTTPException(status_code=502, detail=f"MiniStack error: {exc}")

    changeset_name = f"cs-{int(time.time())}"

    try:
        cfn.create_change_set(
            StackName=stack_name,
            TemplateBody=final_template,
            ChangeSetName=changeset_name,
            ChangeSetType=changeset_type,
            Capabilities=["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"MiniStack error creating change set: {exc}",
        )

    # Poll until change set is ready (up to 15 attempts × 1 s)
    changes: list[ChangeSetChange] = []
    for _ in range(15):
        time.sleep(1)
        try:
            cs_resp = cfn.describe_change_set(
                ChangeSetName=changeset_name,
                StackName=stack_name,
            )
        except Exception as exc:
            raise HTTPException(
                status_code=502,
                detail=f"MiniStack error describing change set: {exc}",
            )

        cs_status = cs_resp.get("Status", "")
        if cs_status in ("CREATE_COMPLETE", "FAILED", "DELETE_COMPLETE"):
            for c in cs_resp.get("Changes", []):
                rc = c.get("ResourceChange", {})
                replacement_val = rc.get("Replacement", "False")
                changes.append(ChangeSetChange(
                    action=rc.get("Action", "Add"),
                    resource_type=rc.get("ResourceType", ""),
                    logical_id=rc.get("LogicalResourceId", ""),
                    replacement=(replacement_val == "True"),
                ))
            break

    return ChangeSetResponse(changeset_name=changeset_name, changes=changes)


@app.post(
    "/stacks/{stack_name}/changeset/{changeset_name}/execute",
    response_model=ExecuteChangeSetResponse,
)
async def execute_changeset(stack_name: str, changeset_name: str):
    """Execute a previously created change set."""
    cfn = get_cfn_client()
    try:
        cfn.execute_change_set(
            ChangeSetName=changeset_name,
            StackName=stack_name,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"MiniStack error executing change set: {exc}",
        )
    return ExecuteChangeSetResponse(ok=True)


@app.get("/stacks/{stack_name}", response_model=StackStatusResponse)
async def get_stack_status(stack_name: str):
    """Poll the status of a deployed stack."""
    cfn = get_cfn_client()
    try:
        resp = cfn.describe_stacks(StackName=stack_name)
        stack = resp["Stacks"][0]
    except Exception as exc:
        if "does not exist" in str(exc):
            raise HTTPException(status_code=404, detail=f"Stack '{stack_name}' not found.")
        raise HTTPException(status_code=502, detail=f"MiniStack error: {exc}")

    status = stack["StackStatus"]
    failed_events = None
    if "FAILED" in status or status in ("ROLLBACK_COMPLETE", "ROLLBACK_IN_PROGRESS"):
        failed_events = fetch_failed_events(cfn, stack_name)

    outputs = stack.get("Outputs", [])
    return StackStatusResponse(
        stack_name=stack["StackName"],
        status=status,
        reason=stack.get("StackStatusReason"),
        outputs=[{"key": o["OutputKey"], "value": o["OutputValue"]} for o in outputs],
        failed_events=failed_events,
    )


@app.get("/stacks/{stack_name}/resources", response_model=list[StackResource])
async def get_stack_resources(stack_name: str):
    """List all resources in a deployed stack."""
    cfn = get_cfn_client()
    try:
        resp = cfn.describe_stack_resources(StackName=stack_name)
    except Exception as exc:
        if "does not exist" in str(exc):
            raise HTTPException(status_code=404, detail=f"Stack '{stack_name}' not found.")
        raise HTTPException(status_code=502, detail=f"MiniStack error: {exc}")

    return [
        StackResource(
            logical_id=r["LogicalResourceId"],
            resource_type=r["ResourceType"],
            physical_id=r.get("PhysicalResourceId"),
            status=r["ResourceStatus"],
        )
        for r in resp.get("StackResources", [])
    ]


@app.post("/diagram", response_model=DiagramResponse)
async def diagram(req: DiagramRequest):
    """Parse a CloudFormation YAML template and return a node/edge graph."""
    validate_yaml(req.template)
    return build_diagram(req.template)


@app.get("/health")
async def health():
    return {"status": "ok"}
