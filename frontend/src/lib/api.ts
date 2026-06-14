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
