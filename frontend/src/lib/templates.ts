export interface PredefinedTemplate {
  id: string;
  name: string;
  description: string;
  script: string;
}

export const PREDEFINED_TEMPLATES: PredefinedTemplate[] = [
  {
    id: "s3-lambda-renamer",
    name: "S3 Image Renamer",
    description: "S3 bucket with a Lambda function that automatically prepends 'renamed-' to uploaded images safely.",
    script: `# DIAGRAM_METADATA:
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

bucket_name = 'my-image-bucket'
try:
    s3.create_bucket(Bucket=bucket_name)
except Exception:
    pass

role_name = 'image-rename-role'
assume_role_policy = {
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
}
try:
    role_resp = iam.create_role(RoleName=role_name, AssumeRolePolicyDocument=json.dumps(assume_role_policy))
    role_arn = role_resp['Role']['Arn']
except Exception:
    role_resp = iam.get_role(RoleName=role_name)
    role_arn = role_resp['Role']['Arn']

lambda_code = """
import os
import boto3
import urllib.parse

s3 = boto3.client('s3', endpoint_url='http://ministack:4566')

def handler(event, context):
    try:
        if 'Records' not in event:
            return {'statusCode': 200, 'body': 'No Records found'}
        bucket_name = os.environ.get("BUCKET_NAME")
        object_key = urllib.parse.unquote_plus(event['Records'][0]['s3']['object']['key'])
        if object_key.startswith('renamed-'):
            return {'statusCode': 200, 'body': 'Already processed'}
        new_object_key = 'renamed-' + object_key
        s3.copy_object(Bucket=bucket_name, CopySource={'Bucket': bucket_name, 'Key': object_key}, Key=new_object_key)
        s3.delete_object(Bucket=bucket_name, Key=object_key)
        return {'statusCode': 200, 'body': 'OK'}
    except Exception as e:
        print(str(e))
        return {'statusCode': 500, 'body': 'Error'}
"""
zip_buffer = io.BytesIO()
with zipfile.ZipFile(zip_buffer, 'a', zipfile.ZIP_DEFLATED) as zip_file:
    zip_file.writestr('index.py', lambda_code)
zip_buffer.seek(0)
zip_data = zip_buffer.read()

try:
    func_resp = awslambda.create_function(
        FunctionName='image-rename-function',
        Runtime='python3.12',
        Role=role_arn,
        Handler='index.handler',
        Code={'ZipFile': zip_data},
        Environment={'Variables': {'BUCKET_NAME': bucket_name}}
    )
    func_arn = func_resp['FunctionArn']
except Exception:
    awslambda.update_function_code(FunctionName='image-rename-function', ZipFile=zip_data)
    awslambda.update_function_configuration(
        FunctionName='image-rename-function',
        Role=role_arn,
        Environment={'Variables': {'BUCKET_NAME': bucket_name}}
    )
    func_info = awslambda.get_function(FunctionName='image-rename-function')
    func_arn = func_info['Configuration']['FunctionArn']

try:
    awslambda.add_permission(
        FunctionName='image-rename-function',
        StatementId='s3-invoke-permission',
        Action='lambda:InvokeFunction',
        Principal='s3.amazonaws.com',
        SourceArn=f'arn:aws:s3:::{bucket_name}'
    )
except Exception:
    pass

s3.put_bucket_notification_configuration(
    Bucket=bucket_name,
    NotificationConfiguration={
        'LambdaFunctionConfigurations': [
            {
                'LambdaFunctionArn': func_arn,
                'Events': ['s3:ObjectCreated:*']
            }
        ]
    }
)

state = {
    "resources": [
        {"LogicalResourceId": "ImageBucket", "PhysicalResourceId": bucket_name, "ResourceType": "AWS::S3::Bucket"},
        {"LogicalResourceId": "LambdaExecutionRole", "PhysicalResourceId": role_name, "ResourceType": "AWS::IAM::Role"},
        {"LogicalResourceId": "ImageRenameFunction", "PhysicalResourceId": "image-rename-function", "ResourceType": "AWS::Lambda::Function"}
    ]
}
print(json.dumps(state))
`
  },
  {
    id: "s3-bucket-object",
    name: "S3 Bucket & Object",
    description: "Simple private S3 bucket with a custom JSON configuration object initialized inside it.",
    script: `# DIAGRAM_METADATA:
# {
#   "resources": {
#     "MyS3Bucket": "AWS::S3::Bucket"
#   },
#   "references": []
# }

import json
import boto3

s3 = boto3.client('s3', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')

bucket_name = 'my-config-bucket'
try:
    s3.create_bucket(Bucket=bucket_name)
except Exception:
    pass

s3.put_object(
    Bucket=bucket_name,
    Key='config.json',
    Body=json.dumps({"env": "local", "debug": True}).encode('utf-8')
)

state = {
    "resources": [
        {"LogicalResourceId": "MyS3Bucket", "PhysicalResourceId": bucket_name, "ResourceType": "AWS::S3::Bucket"}
    ]
}
print(json.dumps(state))
`
  },
  {
    id: "ec2-web-server",
    name: "EC2 Web Server",
    description: "An EC2 instance with custom startup scripts, security group allowing HTTP, and an Elastic IP.",
    script: `# DIAGRAM_METADATA:
# {
#   "resources": {
#     "WebServerSG": "AWS::EC2::SecurityGroup",
#     "MyInstance": "AWS::EC2::Instance"
#   },
#   "references": [
#     {"source": "MyInstance", "target": "WebServerSG", "label": "security-group"}
#   ]
# }

import json
import boto3

ec2 = boto3.client('ec2', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')

sg_name = 'web-server-security-group'
try:
    sg_resp = ec2.create_security_group(
        GroupName=sg_name,
        Description='Enable HTTP traffic'
    )
    sg_id = sg_resp['GroupId']
except Exception:
    sgs = ec2.describe_security_groups(GroupNames=[sg_name])
    sg_id = sgs['SecurityGroups'][0]['GroupId']

try:
    ec2.authorize_security_group_ingress(
        GroupId=sg_id,
        IpPermissions=[
            {
                'IpProtocol': 'tcp',
                'FromPort': 80,
                'ToPort': 80,
                'IpRanges': [{'CidrIp': '0.0.0.0/0'}]
            }
        ]
    )
except Exception:
    pass

instance_resp = ec2.run_instances(
    ImageId='ami-df5de7b6',  # Mock local AMI
    MinCount=1,
    MaxCount=1,
    InstanceType='t2.micro',
    SecurityGroupIds=[sg_id],
    UserData="echo 'Server started'"
)
instance_id = instance_resp['Instances'][0]['InstanceId']

state = {
    "resources": [
        {"LogicalResourceId": "WebServerSG", "PhysicalResourceId": sg_id, "ResourceType": "AWS::EC2::SecurityGroup"},
        {"LogicalResourceId": "MyInstance", "PhysicalResourceId": instance_id, "ResourceType": "AWS::EC2::Instance"}
    ]
}
print(json.dumps(state))
`
  },
  {
    id: "sqs-lambda",
    name: "SQS Lambda Queue Trigger",
    description: "An SQS Queue that automatically triggers a Lambda function when new messages arrive.",
    script: `# DIAGRAM_METADATA:
# {
#   "resources": {
#     "MyQueue": "AWS::SQS::Queue",
#     "LambdaExecutionRole": "AWS::IAM::Role",
#     "MyQueueFunction": "AWS::Lambda::Function"
#   },
#   "references": [
#     {"source": "MyQueueFunction", "target": "MyQueue", "label": "event-source"},
#     {"source": "MyQueueFunction", "target": "LambdaExecutionRole", "label": "role"}
#   ]
# }

import json
import boto3
import zipfile
import io

sqs = boto3.client('sqs', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
iam = boto3.client('iam', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')
awslambda = boto3.client('lambda', endpoint_url='http://ministack:4566', region_name='us-east-1', aws_access_key_id='test', aws_secret_access_key='test')

queue_name = 'order-processing-queue'
try:
    q_resp = sqs.create_queue(QueueName=queue_name)
    q_url = q_resp['QueueUrl']
except Exception:
    q_url = sqs.get_queue_url(QueueName=queue_name)['QueueUrl']

q_attributes = sqs.get_queue_attributes(QueueUrl=q_url, AttributeNames=['QueueArn'])
q_arn = q_attributes['Attributes']['QueueArn']

role_name = 'sqs-lambda-role'
assume_role_policy = {
    "Version": "2012-10-17",
    "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
}
try:
    role_resp = iam.create_role(RoleName=role_name, AssumeRolePolicyDocument=json.dumps(assume_role_policy))
    role_arn = role_resp['Role']['Arn']
except Exception:
    role_resp = iam.get_role(RoleName=role_name)
    role_arn = role_resp['Role']['Arn']

lambda_code = """
import json

def handler(event, context):
    if 'Records' not in event:
        return {'statusCode': 200, 'body': 'No SQS records'}
    for record in event['Records']:
        print("Processing message:", record['body'])
    return {'statusCode': 200, 'body': 'OK'}
"""
zip_buffer = io.BytesIO()
with zipfile.ZipFile(zip_buffer, 'a', zipfile.ZIP_DEFLATED) as zip_file:
    zip_file.writestr('index.py', lambda_code)
zip_buffer.seek(0)
zip_data = zip_buffer.read()

try:
    func_resp = awslambda.create_function(
        FunctionName='sqs-trigger-function',
        Runtime='python3.12',
        Role=role_arn,
        Handler='index.handler',
        Code={'ZipFile': zip_data}
    )
    func_arn = func_resp['FunctionArn']
except Exception:
    awslambda.update_function_code(FunctionName='sqs-trigger-function', ZipFile=zip_data)
    func_info = awslambda.get_function(FunctionName='sqs-trigger-function')
    func_arn = func_info['Configuration']['FunctionArn']

try:
    awslambda.create_event_source_mapping(
        EventSourceArn=q_arn,
        FunctionName=func_arn,
        Enabled=True
    )
except Exception:
    pass

state = {
    "resources": [
        {"LogicalResourceId": "MyQueue", "PhysicalResourceId": q_url, "ResourceType": "AWS::SQS::Queue"},
        {"LogicalResourceId": "LambdaExecutionRole", "PhysicalResourceId": role_name, "ResourceType": "AWS::IAM::Role"},
        {"LogicalResourceId": "MyQueueFunction", "PhysicalResourceId": "sqs-trigger-function", "ResourceType": "AWS::Lambda::Function"}
    ]
}
print(json.dumps(state))
`
  }
];
