import axios from "axios";
import type {
  ChangeSetResponse,
  DeployResponse,
  DiagramResponse,
  DynamoScanResponse,
  LambdaInvokeResponse,
  StackResource,
  StackStatusResponse,
  SqsMessagesResponse,
  TemplateResponse,
  S3ListResponse,
  Ec2InfoResponse,
  Ec2ConsoleResponse,
  RdsInfoResponse,
  RdsQueryResponse,
} from "./types";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:8000",
  headers: { "Content-Type": "application/json" },
});

export async function generateTemplate(prompt: string): Promise<TemplateResponse> {
  const { data } = await api.post<TemplateResponse>("/generate", { prompt });
  return data;
}

export async function deployStack(
  stackName: string,
  template: string
): Promise<DeployResponse> {
  const { data } = await api.post<DeployResponse>("/deploy", {
    stack_name: stackName,
    template,
  });
  return data;
}

export async function getStackStatus(stackName: string): Promise<StackStatusResponse> {
  const { data } = await api.get<StackStatusResponse>(`/stacks/${stackName}`);
  return data;
}

export async function getStackResources(stackName: string): Promise<StackResource[]> {
  const { data } = await api.get<StackResource[]>(`/stacks/${stackName}/resources`);
  return data;
}

// --- Phase 3A ---

export async function previewChangeset(
  stackName: string,
  template: string
): Promise<ChangeSetResponse> {
  const { data } = await api.post<ChangeSetResponse>(
    `/stacks/${stackName}/changeset`,
    { template }
  );
  return data;
}

export async function executeChangeset(
  stackName: string,
  changesetName: string
): Promise<{ ok: boolean }> {
  const { data } = await api.post<{ ok: boolean }>(
    `/stacks/${stackName}/changeset/${changesetName}/execute`
  );
  return data;
}

export async function getDiagram(template: string): Promise<DiagramResponse> {
  const { data } = await api.post<DiagramResponse>("/diagram", { template });
  return data;
}

// --- Phase 3B: Resource interactions ---

export async function getDynamoItems(
  stackName: string,
  logicalId: string
): Promise<DynamoScanResponse> {
  const { data } = await api.get<DynamoScanResponse>(
    `/resources/${stackName}/${logicalId}/dynamodb/items`
  );
  return data;
}

export async function putDynamoItem(
  stackName: string,
  logicalId: string,
  item: Record<string, unknown>
): Promise<{ ok: boolean }> {
  const { data } = await api.post<{ ok: boolean }>(
    `/resources/${stackName}/${logicalId}/dynamodb/items`,
    { item }
  );
  return data;
}

export async function deleteDynamoItem(
  stackName: string,
  logicalId: string,
  key: Record<string, unknown>
): Promise<{ ok: boolean }> {
  const { data } = await api.delete<{ ok: boolean }>(
    `/resources/${stackName}/${logicalId}/dynamodb/items`,
    { data: { key } }
  );
  return data;
}

export async function sendSqsMessage(
  stackName: string,
  logicalId: string,
  body: string
): Promise<{ message_id: string; ok: boolean }> {
  const { data } = await api.post<{ message_id: string; ok: boolean }>(
    `/resources/${stackName}/${logicalId}/sqs/messages`,
    { body }
  );
  return data;
}

export async function receiveSqsMessages(
  stackName: string,
  logicalId: string,
  deleteAfterRead = true
): Promise<SqsMessagesResponse> {
  const { data } = await api.get<SqsMessagesResponse>(
    `/resources/${stackName}/${logicalId}/sqs/messages`,
    { params: { delete_after_read: deleteAfterRead } }
  );
  return data;
}

export async function invokeLambda(
  stackName: string,
  logicalId: string,
  payload: Record<string, unknown>
): Promise<LambdaInvokeResponse> {
  const { data } = await api.post<LambdaInvokeResponse>(
    `/resources/${stackName}/${logicalId}/lambda/invoke`,
    { payload }
  );
  return data;
}

export async function getLambdaLogs(
  stackName: string,
  logicalId: string
): Promise<{ logs: string }> {
  const { data } = await api.get<{ logs: string }>(
    `/resources/${stackName}/${logicalId}/lambda/logs`
  );
  return data;
}

export async function listS3Objects(
  stackName: string,
  logicalId: string
): Promise<S3ListResponse> {
  const { data } = await api.get<S3ListResponse>(
    `/resources/${stackName}/${logicalId}/s3/objects`
  );
  return data;
}

export async function deleteS3Object(
  stackName: string,
  logicalId: string,
  key: string
): Promise<{ ok: boolean }> {
  const { data } = await api.delete<{ ok: boolean }>(
    `/resources/${stackName}/${logicalId}/s3/objects`,
    { data: { key } }
  );
  return data;
}

export async function uploadS3Object(
  stackName: string,
  logicalId: string,
  key: string,
  content: string
): Promise<{ ok: boolean }> {
  const { data } = await api.post<{ ok: boolean }>(
    `/resources/${stackName}/${logicalId}/s3/objects`,
    { key, content }
  );
  return data;
}

// --- Phase 3B: EC2 ---

export async function getEc2Info(
  stackName: string,
  logicalId: string
): Promise<Ec2InfoResponse> {
  const { data } = await api.get<Ec2InfoResponse>(
    `/resources/${stackName}/${logicalId}/ec2/info`
  );
  return data;
}

export async function setEc2State(
  stackName: string,
  logicalId: string,
  action: "start" | "stop" | "reboot"
): Promise<{ ok: boolean }> {
  const { data } = await api.post<{ ok: boolean }>(
    `/resources/${stackName}/${logicalId}/ec2/state`,
    { action }
  );
  return data;
}

export async function getEc2Console(
  stackName: string,
  logicalId: string
): Promise<Ec2ConsoleResponse> {
  const { data } = await api.get<Ec2ConsoleResponse>(
    `/resources/${stackName}/${logicalId}/ec2/console`
  );
  return data;
}

// --- Phase 3B: RDS ---

export async function getRdsInfo(
  stackName: string,
  logicalId: string
): Promise<RdsInfoResponse> {
  const { data } = await api.get<RdsInfoResponse>(
    `/resources/${stackName}/${logicalId}/rds/info`
  );
  return data;
}

export async function setRdsAction(
  stackName: string,
  logicalId: string,
  action: "reboot"
): Promise<{ ok: boolean }> {
  const { data } = await api.post<{ ok: boolean }>(
    `/resources/${stackName}/${logicalId}/rds/action`,
    { action }
  );
  return data;
}

export async function runRdsQuery(
  stackName: string,
  logicalId: string,
  sql: string
): Promise<RdsQueryResponse> {
  const { data } = await api.post<RdsQueryResponse>(
    `/resources/${stackName}/${logicalId}/rds/query`,
    { sql }
  );
  return data;
}



