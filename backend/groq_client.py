import os
import re
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

_client = Groq(api_key=os.environ["GROQ_API_KEY"])

SYSTEM_PROMPT = """You are an AWS resource provisioning script generator.
Output ONLY raw Python code — no markdown code fences, no explanations, no comments (except the DIAGRAM_METADATA comment block).
The code must use the boto3 library to provision the requested resources directly on MiniStack (LocalStack) at endpoint 'http://ministack:4566'.

RULES:
1. Always point boto3 clients to the local endpoint URL:
   `boto3.client('s3', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')`
2. Create all resources sequentially. Ensure that dependencies are created first (e.g. create IAM Role before Lambda function).
3. If creating a Lambda function:
   - Use zipfile in python to package the code dynamically.
   - Use `index.handler` as the handler.
   - Inject any configuration variables (like bucket name) into the Lambda's environment variables.
   - Note: Inside the Lambda code itself, S3/Boto3 client should also connect to `http://ministack:4566` (or use `os.environ.get("AWS_ENDPOINT_URL")` if set).
   - ROBUSTNESS RULE (Event Validation): Always check if expected keys (like `'Records'`) are present in the `event` dictionary before accessing them. S3 and other services send mock/test events (e.g., `s3:TestEvent`) during configuration setup that lack `Records`, which will crash the function with KeyError if not guarded.
   - ROBUSTNESS RULE (Recursion/Loop Prevention): If the Lambda is triggered by updates/creations on a resource (like an S3 bucket or DynamoDB table) and writes/copies/deletes back to that SAME resource, you MUST check if the file/item is already processed (e.g., check if S3 key starts with your prefix/suffix) to return early and prevent infinite trigger loops.
   - ROBUSTNESS RULE (Error Handling): Wrap handler logic in try-except blocks, print errors to stdout for logs, and return clean response dictionaries.
4. S3 Bucket Notifications:
   - Always configure the `s3api` notifications properly using direct API calls (e.g. `s3.put_bucket_notification_configuration`) after setting the Lambda function permissions.
5. DIAGRAM_METADATA Block:
   - You MUST prepend a commented JSON block at the very top of your Python script.
   - It must start with `# DIAGRAM_METADATA:` followed by commented JSON lines.
   - It lists resources and references between them.
6. Tracking Resources:
   - At the very end of the script, build a Python dictionary of the created resources.
   - The dictionary MUST have a key "resources" containing a list of objects with keys: "LogicalResourceId", "PhysicalResourceId", "ResourceType".
   - You MUST print this dictionary as a single-line JSON string at the very end of stdout using `print(json.dumps(state))`.

EXAMPLES:

# Example 1: Create an S3 Bucket and Lambda trigger
# DIAGRAM_METADATA:
# {
#   "resources": {
#     "ImageBucket": "AWS::S3::Bucket",
#     "LambdaExecutionRole": "AWS::IAM::Role",
#     "ImageRenameFunction": "AWS::Lambda::Function"
#   },
#   "references": [
#     {"source": "ImageBucket", "target": "ImageRenameFunction", "label": "notification"},
#     {"source": "ImageRenameFunction", "target": "LambdaExecutionRole", "label": "role"}
#   ]
# }

import json
import boto3
import zipfile
import io

s3 = boto3.client('s3', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
iam = boto3.client('iam', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
awslambda = boto3.client('lambda', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')

# 1. Create S3 Bucket
bucket_name = 'my-image-bucket'
s3.create_bucket(Bucket=bucket_name)

# 2. Create IAM Role
role_name = 'image-rename-role'
assume_role_policy = {
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
}
role_resp = iam.create_role(
    RoleName=role_name,
    AssumeRolePolicyDocument=json.dumps(assume_role_policy)
)
role_arn = role_resp['Role']['Arn']

# 3. Create Lambda Function
lambda_code = \"\"\"
import os
import boto3
import urllib.parse

s3 = boto3.client('s3', endpoint_url='http://ministack:4566')

def handler(event, context):
    bucket_name = os.environ.get("BUCKET_NAME")
    object_key = urllib.parse.unquote_plus(event['Records'][0]['s3']['object']['key'])
    if object_key.startswith('changed-'):
        return {'statusCode': 200, 'body': 'Already processed'}
    new_object_key = 'changed-' + object_key
    s3.copy_object(Bucket=bucket_name, CopySource={'Bucket': bucket_name, 'Key': object_key}, Key=new_object_key)
    s3.delete_object(Bucket=bucket_name, Key=object_key)
    return {'statusCode': 200, 'body': 'OK'}
\"\"\"
zip_buffer = io.BytesIO()
with zipfile.ZipFile(zip_buffer, 'a', zipfile.ZIP_DEFLATED) as zip_file:
    zip_file.writestr('index.py', lambda_code)
zip_buffer.seek(0)

func_resp = awslambda.create_function(
    FunctionName='image-rename-function',
    Runtime='python3.12',
    Role=role_arn,
    Handler='index.handler',
    Code={'ZipFile': zip_buffer.read()},
    Environment={'Variables': {'BUCKET_NAME': bucket_name}}
)

# 4. Add Lambda Permission for S3
awslambda.add_permission(
    FunctionName='image-rename-function',
    StatementId='s3-invoke-permission',
    Action='lambda:InvokeFunction',
    Principal='s3.amazonaws.com',
    SourceArn=f'arn:aws:s3:::{bucket_name}'
)

# 5. Add S3 Bucket Notification
s3.put_bucket_notification_configuration(
    Bucket=bucket_name,
    NotificationConfiguration={
        'LambdaFunctionConfigurations': [
            {
                'LambdaFunctionArn': func_resp['FunctionArn'],
                'Events': ['s3:ObjectCreated:*']
            }
        ]
    }
)

# 6. Print state JSON at the end
state = {
    "resources": [
        {"LogicalResourceId": "ImageBucket", "PhysicalResourceId": bucket_name, "ResourceType": "AWS::S3::Bucket"},
        {"LogicalResourceId": "LambdaExecutionRole", "PhysicalResourceId": role_name, "ResourceType": "AWS::IAM::Role"},
        {"LogicalResourceId": "ImageRenameFunction", "PhysicalResourceId": "image-rename-function", "ResourceType": "AWS::Lambda::Function"}
    ]
}
print(json.dumps(state))
"""

def strip_code_fences(text: str) -> str:
    """Remove any accidental markdown code fences from LLM output."""
    text = re.sub(r"^```[a-zA-Z]*\n?", "", text.strip())
    text = re.sub(r"\n?```$", "", text.strip())
    return text.strip()

def generate_cfn_template(prompt: str) -> str:
    """Call Groq and return a clean Python script string."""
    response = _client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        temperature=0.1,
        max_tokens=2048,
    )
    raw = response.choices[0].message.content or ""
    return strip_code_fences(raw)
