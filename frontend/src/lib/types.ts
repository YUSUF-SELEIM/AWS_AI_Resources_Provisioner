// Shared API response types for AWS_AI_Resources_Provisioner

export interface TemplateResponse {
  template: string;
}

export interface DeployResponse {
  stack_name: string;
  stack_id: string;
}

export interface StackOutput {
  key: string;
  value: string;
}

export interface FailedEvent {
  logical_id: string;
  resource_type: string;
  status: string;
  reason: string;
}

export interface StackStatusResponse {
  stack_name: string;
  status: string;
  reason?: string;
  outputs?: StackOutput[];
  failed_events?: FailedEvent[];
}

export interface StackResource {
  logical_id: string;
  resource_type: string;
  physical_id?: string;
  status: string;
}

export type StackStatus =
  | "idle"
  | "CREATE_IN_PROGRESS"
  | "CREATE_COMPLETE"
  | "CREATE_FAILED"
  | "ROLLBACK_IN_PROGRESS"
  | "ROLLBACK_COMPLETE";

// --- Phase 3A: Change set types ---

export interface ChangeSetChange {
  action: "Add" | "Modify" | "Remove";
  resource_type: string;
  logical_id: string;
  replacement: boolean;
}

export interface ChangeSetResponse {
  changeset_name: string;
  changes: ChangeSetChange[];
}

// --- Phase 3A: Diagram types ---

export interface DiagramNode {
  id: string;
  type: string;
  label: string;
}

export interface DiagramEdge {
  source: string;
  target: string;
  label: string;
}

export interface DiagramResponse {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

// --- Phase 3B: Resource interaction types ---

export type DynamoItem = Record<
  string,
  string | number | boolean | null | unknown
>;

export interface DynamoScanResponse {
  items: DynamoItem[];
  count: number;
  keys?: string[];
}

export interface SqsMessage {
  message_id: string;
  body: string;
  sent_timestamp?: string;
  receipt_handle: string;
}

export interface SqsMessagesResponse {
  messages: SqsMessage[];
  count: number;
}

export interface LambdaInvokeResponse {
  status_code: number;
  response: unknown;
  logs: string;
  function_error?: string;
}

// --- Phase 3B: S3 interaction types ---

export interface S3Object {
  key: string;
  size: number;
  last_modified: string | null;
}

export interface S3ListResponse {
  objects: S3Object[];
  count: number;
}

// --- Phase 3B: EC2 interaction types ---

export interface Ec2InfoResponse {
  instance_id: string;
  state: string;
  instance_type: string;
  public_ip: string | null;
  private_ip: string | null;
  host_port: string | null;
}

export interface Ec2ConsoleResponse {
  output: string;
}

// --- Phase 3B: RDS interaction types ---

export interface RdsInfoResponse {
  db_instance_identifier: string;
  status: string;
  address: string | null;
  port: number | null;
  engine: string;
  engine_version: string;
  db_instance_class: string;
  allocated_storage: number;
  db_name: string | null;
  master_username: string | null;
}

export interface RdsQueryResponse {
  records: Record<string, string | number | boolean | null | unknown>[];
  numberOfRecordsUpdated: number;
}
