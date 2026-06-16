import os
import re
import httpx

from groq import Groq
from dotenv import load_dotenv

load_dotenv()

_client = Groq(api_key=os.environ["GROQ_API_KEY"])

SYSTEM_PROMPT = """You are an AWS CloudFormation template generator.
Output ONLY raw YAML — no markdown code fences, no explanations, no comments.
The output must begin with exactly: AWSTemplateFormatVersion: '2010-09-09'

RULES:
- Supported resource types: AWS::S3::Bucket, AWS::S3::BucketObject, AWS::DynamoDB::Table, AWS::SQS::Queue, AWS::Lambda::Function, AWS::Lambda::EventSourceMapping, AWS::IAM::Role, AWS::EC2::Instance, AWS::EC2::SecurityGroup, AWS::EC2::EIP, AWS::EC2::EIPAssociation.
- Include a Description field summarising what the stack does.
- Use lowercase-hyphenated names where a name property is required.
- Do NOT add properties that are not explicitly requested.
- UserData MUST be a property inside AWS::EC2::Instance (never a separate top-level resource). Always format it using `Fn::Base64` or `Fn::Base64: !Sub |`.
- When generating a Lambda function, you MUST also include a minimal AWS::IAM::Role with an AssumeRolePolicyDocument that allows lambda.amazonaws.com to assume it, and wire the role to the Lambda via !GetAtt RoleName.Arn.
- Use CloudFormation intrinsic functions (!Ref, !GetAtt, !Sub) for all cross-resource references.
- IMPORTANT: When a Lambda's Python code needs to reference a resource (like a bucket or table name), pass it in via `Environment.Variables` using `!Ref` and read it with `os.environ` inside the ZipFile. Do NOT use string interpolation (e.g. `${Bucket}`) inside the ZipFile.
- The output must be valid CloudFormation YAML and nothing else.

EXAMPLES:

# --- S3 Bucket ---
AWSTemplateFormatVersion: '2010-09-09'
Description: S3 bucket for storing photos
Resources:
  PhotosBucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: my-photos

# --- DynamoDB Table ---
AWSTemplateFormatVersion: '2010-09-09'
Description: DynamoDB table for storing user profiles
Resources:
  UserProfilesTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: user-profiles
      AttributeDefinitions:
        - AttributeName: userId
          AttributeType: S
      KeySchema:
        - AttributeName: userId
          KeyType: HASH
      BillingMode: PAY_PER_REQUEST

# --- SQS Queue ---
AWSTemplateFormatVersion: '2010-09-09'
Description: SQS queue for processing orders
Resources:
  OrderQueue:
    Type: AWS::SQS::Queue
    Properties:
      QueueName: order-processing-queue

# --- Lambda Function with IAM Role ---
AWSTemplateFormatVersion: '2010-09-09'
Description: Lambda function with execution role
Resources:
  LambdaExecutionRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: my-function-role
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
  MyFunction:
    Type: AWS::Lambda::Function
    Properties:
      FunctionName: my-function
      Runtime: python3.12
      Handler: index.handler
      Role: !GetAtt LambdaExecutionRole.Arn
      Environment:
        Variables:
          MESSAGE: "Hello from env"
      Code:
        ZipFile: |
          import os
          def handler(event, context):
              msg = os.environ.get("MESSAGE", "Hello")
              return {"statusCode": 200, "body": msg}

# --- EC2 Instance with Elastic IP, Security Group, and S3 Object ---
AWSTemplateFormatVersion: '2010-09-09'
Description: EC2 Instance retrieving config from S3
Resources:
  MyS3Bucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: my-config-bucket
  ConfigObject:
    Type: AWS::S3::BucketObject
    Properties:
      Bucket: !Ref MyS3Bucket
      Key: config.json
      Content: '{"env": "local"}'
  WebServerSG:
    Type: AWS::EC2::SecurityGroup
    Properties:
      GroupDescription: Enable HTTP
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 80
          ToPort: 80
          CidrIp: 0.0.0.0/0
  MyInstance:
    Type: AWS::EC2::Instance
    Properties:
      InstanceType: t2.micro
      SecurityGroups:
        - !Ref WebServerSG
      UserData:
        Fn::Base64: !Sub |
          #!/bin/bash
          echo "Instance starting up"
  MyEIP:
    Type: AWS::EC2::EIP
    Properties:
      Domain: vpc
  MyEIPAssociation:
    Type: AWS::EC2::EIPAssociation
    Properties:
      AllocationId: !GetAtt MyEIP.AllocationId
      InstanceId: !Ref MyInstance
"""


def strip_code_fences(text: str) -> str:
    """Remove any accidental markdown code fences from LLM output."""
    text = re.sub(r"^```[a-zA-Z]*\n?", "", text.strip())
    text = re.sub(r"\n?```$", "", text.strip())
    return text.strip()


def generate_cfn_template(prompt: str) -> str:
    """Call Groq and return a clean CloudFormation YAML string."""
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

    # Local LLM endpoint reference commented out:
    # LOCAL_LLM_ENDPOINT = os.getenv("LOCAL_LLM_ENDPOINT", "http://host.docker.internal:1234/v1/chat/completions")
    # headers = {"Content-Type": "application/json"}
    # payload = {
    #     "model": "local-model",
    #     "messages": [
    #         {"role": "system", "content": SYSTEM_PROMPT},
    #         {"role": "user", "content": prompt}
    #     ],
    #     "temperature": 0.1,
    #     "max_tokens": 2048
    # }
    # try:
    #     resp = httpx.post(LOCAL_LLM_ENDPOINT, json=payload, headers=headers, timeout=120.0)
    #     resp.raise_for_status()
    #     data = resp.json()
    #     raw = data["choices"][0]["message"]["content"] or ""
    # except Exception as exc:
    #     raise Exception(f"Failed to generate template via local LLM at {LOCAL_LLM_ENDPOINT}: {exc}")
        
    return strip_code_fences(raw)
