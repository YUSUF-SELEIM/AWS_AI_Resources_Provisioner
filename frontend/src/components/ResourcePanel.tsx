import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getDynamoItems,
  putDynamoItem,
  deleteDynamoItem,
  sendSqsMessage,
  receiveSqsMessages,
  invokeLambda,
  getLambdaLogs,
  listS3Objects,
  deleteS3Object,
  uploadS3Object,
  getEc2Info,
  setEc2State,
  getEc2Console,
  getRdsInfo,
  setRdsAction,
  runRdsQuery,
} from "../lib/api";
import type { DiagramNode, DynamoItem, SqsMessage, LambdaInvokeResponse } from "../lib/types";

// ---------------------------------------------------------------------------
// Interactive resource types
// ---------------------------------------------------------------------------
const INTERACTIVE_TYPES = new Set([
  "AWS::DynamoDB::Table",
  "AWS::SQS::Queue",
  "AWS::Lambda::Function",
  "AWS::S3::Bucket",
  "AWS::EC2::Instance",
  "AWS::RDS::DBInstance",
]);

export function isInteractive(resourceType: string): boolean {
  return INTERACTIVE_TYPES.has(resourceType);
}

// ---------------------------------------------------------------------------
// Skeleton loader
// ---------------------------------------------------------------------------
function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-group">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton-line" style={{ width: `${70 + (i % 3) * 15}%` }} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error alert
// ---------------------------------------------------------------------------
function ErrorAlert({ message }: { message: string }) {
  return (
    <div className="alert alert-error" style={{ marginTop: "0.75rem" }}>
      <strong>Error:</strong> {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DynamoDB Panel
// ---------------------------------------------------------------------------
function DynamoPanel({ stackName, logicalId }: { stackName: string; logicalId: string }) {
  const qc = useQueryClient();
  const [newItem, setNewItem] = useState<{ key: string; value: string }[]>([
    { key: "", value: "" },
  ]);
  const [addError, setAddError] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["dynamo", stackName, logicalId],
    queryFn: () => getDynamoItems(stackName, logicalId),
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (data?.keys && data.keys.length > 0 && newItem.length === 1 && newItem[0].key === "") {
      setNewItem(data.keys.map(k => ({ key: k, value: "" })));
    }
  }, [data?.keys]);

  const putMutation = useMutation({
    mutationFn: (item: Record<string, unknown>) =>
      putDynamoItem(stackName, logicalId, item),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dynamo", stackName, logicalId] });
      if (data?.keys && data.keys.length > 0) {
        setNewItem(data.keys.map(k => ({ key: k, value: "" })));
      } else {
        setNewItem([{ key: "", value: "" }]);
      }
      setAddError("");
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (e as Error).message;
      setAddError(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: Record<string, unknown>) =>
      deleteDynamoItem(stackName, logicalId, key),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dynamo", stackName, logicalId] });
    },
  });

  function handleAdd() {
    const item: Record<string, unknown> = {};
    for (const pair of newItem) {
      if (pair.key.trim()) {
        item[pair.key.trim()] = pair.value;
      }
    }
    if (Object.keys(item).length === 0) {
      setAddError("Add at least one key-value pair.");
      return;
    }
    putMutation.mutate(item);
  }

  const items: DynamoItem[] = data?.items ?? [];

  // Collect all column names
  const allKeys = Array.from(new Set(items.flatMap((it) => Object.keys(it))));

  return (
    <div className="panel-content">
      <div className="panel-section-title">Items ({data?.count ?? 0})</div>

      {isLoading && <Skeleton lines={4} />}
      {error && (
        <ErrorAlert message={(error as Error).message} />
      )}

      {!isLoading && items.length === 0 && (
        <div className="panel-empty">No items yet. Add one below.</div>
      )}

      {items.length > 0 && (
        <div className="dynamo-table-wrapper">
          <table className="dynamo-table">
            <thead>
              <tr>
                {allKeys.map((k) => <th key={k}>{k}</th>)}
                <th>Delete</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={i}>
                  {allKeys.map((k) => (
                    <td key={k}>
                      <span className="resource-id">
                        {item[k] == null ? "" : String(item[k])}
                      </span>
                    </td>
                  ))}
                  <td>
                    <button
                      className="btn-icon btn-delete"
                      title="Delete item"
                      onClick={() => {
                        // Use the first key as the primary key for deletion
                        const pk: Record<string, unknown> = {};
                        const firstKey = allKeys[0];
                        if (firstKey && item[firstKey] !== undefined) {
                          pk[firstKey] = item[firstKey];
                        }
                        deleteMutation.mutate(pk);
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add item form */}
      <div className="dynamo-add-form">
        <div className="panel-section-title" style={{ marginBottom: "0.5rem" }}>
          Add item
        </div>
        {newItem.map((pair, i) => (
          <div key={i} className="kv-row">
            <input
              className="kv-input"
              placeholder="key"
              value={pair.key}
              onChange={(e) => {
                const next = [...newItem];
                next[i] = { ...next[i], key: e.target.value };
                setNewItem(next);
              }}
            />
            <span className="kv-sep">=</span>
            <input
              className="kv-input"
              placeholder="value"
              value={pair.value}
              onChange={(e) => {
                const next = [...newItem];
                next[i] = { ...next[i], value: e.target.value };
                setNewItem(next);
              }}
            />
            {newItem.length > 1 && (
              <button
                className="btn-icon"
                onClick={() => setNewItem(newItem.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setNewItem([...newItem, { key: "", value: "" }])}
          >
            + Field
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleAdd}
            disabled={putMutation.isPending}
          >
            {putMutation.isPending ? "Saving…" : "Put Item"}
          </button>
        </div>
        {addError && <ErrorAlert message={addError} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SQS Panel
// ---------------------------------------------------------------------------
function SqsPanel({ stackName, logicalId }: { stackName: string; logicalId: string }) {
  const [messageBody, setMessageBody] = useState('{"event": "test"}');
  const [received, setReceived] = useState<SqsMessage[]>([]);
  const [sendStatus, setSendStatus] = useState("");
  const [pollError, setPollError] = useState("");

  const sendMutation = useMutation({
    mutationFn: () => sendSqsMessage(stackName, logicalId, messageBody),
    onSuccess: (d) => {
      setSendStatus(`Sent! Message ID: ${d.message_id}`);
      setTimeout(() => setSendStatus(""), 4000);
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (e as Error).message;
      setSendStatus(`Error: ${msg}`);
    },
  });

  const pollMutation = useMutation({
    mutationFn: () => receiveSqsMessages(stackName, logicalId, true),
    onSuccess: (d) => {
      setReceived((prev) => [...d.messages, ...prev].slice(0, 50));
      setPollError("");
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (e as Error).message;
      setPollError(msg);
    },
  });

  return (
    <div className="panel-content">
      {/* Send */}
      <div className="panel-section-title">Send message</div>
      <textarea
        className="panel-textarea"
        rows={4}
        value={messageBody}
        onChange={(e) => setMessageBody(e.target.value)}
        placeholder='{"key": "value"}'
      />
      <button
        className="btn btn-primary btn-sm"
        style={{ marginTop: "0.5rem" }}
        onClick={() => sendMutation.mutate()}
        disabled={sendMutation.isPending}
      >
        {sendMutation.isPending ? "Sending…" : "Send Message"}
      </button>
      {sendStatus && (
        <div className={`alert ${sendStatus.startsWith("Error") ? "alert-error" : "alert-success"}`}
          style={{ marginTop: "0.5rem" }}>
          {sendStatus}
        </div>
      )}

      {/* Poll */}
      <div className="panel-section-title" style={{ marginTop: "1.25rem" }}>
        Received messages ({received.length})
      </div>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => pollMutation.mutate()}
        disabled={pollMutation.isPending}
      >
        {pollMutation.isPending ? "Polling…" : "Poll & Consume"}
      </button>
      {pollError && <ErrorAlert message={pollError} />}

      {received.length > 0 && (
        <div className="sqs-message-list">
          {received.map((m, i) => (
            <div key={m.message_id ?? i} className="sqs-message-item">
              <div className="sqs-message-meta">
                <span className="badge badge-gray">{m.message_id?.slice(0, 8)}…</span>
                {m.sent_timestamp && (
                  <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                    {new Date(Number(m.sent_timestamp)).toLocaleTimeString()}
                  </span>
                )}
              </div>
              <pre className="sqs-message-body">{m.body}</pre>
            </div>
          ))}
        </div>
      )}
      {received.length === 0 && !pollMutation.isPending && (
        <div className="panel-empty">No messages polled yet.</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lambda Panel
// ---------------------------------------------------------------------------
function LambdaPanel({ stackName, logicalId }: { stackName: string; logicalId: string }) {
  const [activeTab, setActiveTab] = useState<"invoke" | "logs">("invoke");
  const [payload, setPayload] = useState("{}");
  const [result, setResult] = useState<LambdaInvokeResponse | null>(null);
  const [invokeError, setInvokeError] = useState("");

  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery({
    queryKey: ["lambda", stackName, logicalId, "logs"],
    queryFn: () => getLambdaLogs(stackName, logicalId),
    enabled: activeTab === "logs",
  });

  const invokeMutation = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = { input: payload };
      }
      return invokeLambda(stackName, logicalId, parsed);
    },
    onSuccess: (d) => {
      setResult(d);
      setInvokeError("");
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (e as Error).message;
      setInvokeError(msg);
    },
  });

  return (
    <div className="panel-content">
      <div className="panel-tabs" style={{ marginBottom: "1rem" }}>
        <button
          className={`panel-tab ${activeTab === "invoke" ? "active" : ""}`}
          onClick={() => setActiveTab("invoke")}
        >
          Invoke Function
        </button>
        <button
          className={`panel-tab ${activeTab === "logs" ? "active" : ""}`}
          onClick={() => setActiveTab("logs")}
        >
          Execution Logs
        </button>
      </div>

      {activeTab === "invoke" && (
        <div className="panel-tab-content">
          <div className="panel-section-title">Invocation payload (JSON)</div>
          <textarea
            className="panel-textarea panel-mono"
            rows={5}
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
            placeholder="{}"
          />
          <button
            className="btn btn-primary btn-sm"
            style={{ marginTop: "0.5rem" }}
            onClick={() => invokeMutation.mutate()}
            disabled={invokeMutation.isPending}
          >
            {invokeMutation.isPending ? "Invoking…" : "Invoke Function"}
          </button>
          
          {invokeError && <ErrorAlert message={invokeError} />}

          {result && (
            <div style={{ marginTop: "1.25rem" }}>
              <div className="panel-section-title">Invocation Result</div>
              {result.function_error && (
                <div className="alert alert-error" style={{ marginTop: "0.5rem", marginBottom: "0.5rem" }}>
                  <strong>Function error:</strong> {result.function_error}
                </div>
              )}
              <pre className="lambda-output" style={{ fontSize: "12px", background: "var(--bg-card)", padding: "0.75rem", borderRadius: 4 }}>
                {JSON.stringify(result.response, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {activeTab === "logs" && (
        <div className="panel-tab-content">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
            <span className="panel-section-title" style={{ margin: 0 }}>CloudWatch Logs</span>
            <button 
              className="btn btn-secondary btn-sm" 
              onClick={() => refetchLogs()}
              disabled={logsLoading}
            >
              {logsLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {logsLoading ? (
            <Skeleton lines={6} />
          ) : (
            <pre
              className="code-block"
              style={{
                maxHeight: "350px",
                overflowY: "auto",
                fontSize: "12px",
                backgroundColor: "#f1f3f5",
                color: "#0f172a",
                padding: "1rem",
                borderRadius: "6px",
                fontFamily: "monospace",
                whiteSpace: "pre-wrap"
              }}
            >
              {logsData?.logs || "No logs available. Trigger or invoke the function to write logs."}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// S3 Panel
// ---------------------------------------------------------------------------
function S3Panel({ stackName, logicalId }: { stackName: string; logicalId: string }) {
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["s3", stackName, logicalId],
    queryFn: () => listS3Objects(stackName, logicalId),
    refetchInterval: 5000,
  });

  const [newKey, setNewKey] = useState("");
  const [newContent, setNewContent] = useState("");
  const [uploadError, setUploadError] = useState("");

  const deleteMutation = useMutation({
    mutationFn: (key: string) => deleteS3Object(stackName, logicalId, key),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["s3", stackName, logicalId] });
    },
  });

  const uploadMutation = useMutation({
    mutationFn: () => uploadS3Object(stackName, logicalId, newKey.trim(), newContent),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["s3", stackName, logicalId] });
      setNewKey("");
      setNewContent("");
      setUploadError("");
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (e as Error).message;
      setUploadError(msg);
    },
  });

  function handleUpload() {
    if (!newKey.trim()) {
      setUploadError("Please provide an object key.");
      return;
    }
    uploadMutation.mutate();
  }

  const objects = data?.objects ?? [];

  return (
    <div className="panel-content">
      <div className="panel-section-title">Objects ({data?.count ?? 0})</div>

      {isLoading && <Skeleton lines={4} />}
      {error && <ErrorAlert message={(error as Error).message} />}

      {!isLoading && objects.length === 0 && (
        <div className="panel-empty">Bucket is empty. Upload one below.</div>
      )}

      {objects.length > 0 && (
        <div className="dynamo-table-wrapper" style={{ marginBottom: "1.25rem" }}>
          <table className="dynamo-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Size</th>
                <th>Last Modified</th>
                <th>Delete</th>
              </tr>
            </thead>
            <tbody>
              {objects.map((obj) => (
                <tr key={obj.key}>
                  <td>
                    <span className="resource-id">{obj.key}</span>
                  </td>
                  <td>{(obj.size / 1024).toFixed(1)} KB</td>
                  <td>
                    {obj.last_modified
                      ? new Date(obj.last_modified).toLocaleTimeString()
                      : "—"}
                  </td>
                  <td>
                    <button
                      className="btn-icon btn-delete"
                      title="Delete object"
                      onClick={() => deleteMutation.mutate(obj.key)}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* S3 Upload Form */}
      <div className="dynamo-add-form" style={{ marginTop: "1rem" }}>
        <div className="panel-section-title" style={{ marginBottom: "0.5rem" }}>
          Upload/Put Object
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <input
            className="kv-input"
            style={{ width: "100%", boxSizing: "border-box" }}
            placeholder="object-key.json"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <textarea
            className="panel-textarea panel-mono"
            style={{ width: "100%", boxSizing: "border-box" }}
            rows={4}
            placeholder="Object content / body here..."
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <button
            className="btn btn-primary btn-sm"
            style={{ alignSelf: "flex-start" }}
            onClick={handleUpload}
            disabled={uploadMutation.isPending}
          >
            {uploadMutation.isPending ? "Uploading…" : "Upload Object"}
          </button>
        </div>
        {uploadError && <ErrorAlert message={uploadError} />}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// EC2 Panel
// ---------------------------------------------------------------------------
function Ec2Panel({ stackName, logicalId }: { stackName: string; logicalId: string }) {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"info" | "console">("info");

  const { data: info, isLoading: infoLoading, error: infoError } = useQuery({
    queryKey: ["ec2", stackName, logicalId, "info"],
    queryFn: () => getEc2Info(stackName, logicalId),
    refetchInterval: 5000,
  });

  const { data: consoleData, isLoading: consoleLoading, refetch: refetchConsole } = useQuery({
    queryKey: ["ec2", stackName, logicalId, "console"],
    queryFn: () => getEc2Console(stackName, logicalId),
    enabled: activeTab === "console",
  });

  const stateMutation = useMutation({
    mutationFn: (action: "start" | "stop" | "reboot") => setEc2State(stackName, logicalId, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ec2", stackName, logicalId, "info"] });
    },
  });

  const isRunning = info?.state === "running";
  const isStopped = info?.state === "stopped";

  return (
    <div className="panel-content">
      <div className="panel-tabs">
        <button
          className={`panel-tab ${activeTab === "info" ? "active" : ""}`}
          onClick={() => setActiveTab("info")}
        >
          Details
        </button>
        <button
          className={`panel-tab ${activeTab === "console" ? "active" : ""}`}
          onClick={() => setActiveTab("console")}
        >
          Console Logs
        </button>
      </div>

      {activeTab === "info" && (
        <div className="panel-tab-content">
          {infoLoading && <Skeleton lines={4} />}
          {infoError && <ErrorAlert message={(infoError as Error).message} />}
          {info && (
            <>
              <div className="panel-section">
                <h3 className="panel-section-title">Status</h3>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1rem" }}>
                  <span className={`badge ${isRunning ? "badge-green" : isStopped ? "badge-red" : ""}`}>
                    {info.state.toUpperCase()}
                  </span>
                  <span>({info.instance_type})</span>
                </div>

                <div className="button-group" style={{ marginBottom: "1.5rem" }}>
                  <button
                    className="btn btn-primary"
                    disabled={isRunning || stateMutation.isPending}
                    onClick={() => stateMutation.mutate("start")}
                  >
                    Start
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={isStopped || stateMutation.isPending}
                    onClick={() => stateMutation.mutate("stop")}
                  >
                    Stop
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={!isRunning || stateMutation.isPending}
                    onClick={() => stateMutation.mutate("reboot")}
                  >
                    Reboot
                  </button>
                </div>
              </div>

              <div className="panel-section">
                <h3 className="panel-section-title">Networking</h3>
                <div className="info-grid" style={{ marginBottom: "1rem" }}>
                  <div className="info-item">
                    <span className="info-label">Public IP</span>
                    <span className="info-value">{info.public_ip || "None"}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Private IP</span>
                    <span className="info-value">{info.private_ip || "None"}</span>
                  </div>
                </div>

                {info.public_ip && isRunning ? (
                  <>
                    <h3 className="panel-section-title">SSH Access</h3>
                    <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: "0.5rem" }}>
                      Run this command in your terminal to connect:
                    </p>
                    <div className="code-block" style={{ padding: "0.5rem", background: "var(--bg-card)", borderRadius: 4, fontFamily: "monospace", fontSize: 13 }}>
                      ssh -i my-ec2-key.pem ec2-user@{info.public_ip}
                    </div>
                  </>
                ) : isRunning ? (
                  <div style={{ marginTop: "1rem" }}>
                    <h3 className="panel-section-title">Local Dev Container</h3>
                    <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: "0.75rem" }}>
                      An ephemeral container has been automatically spun up in the MiniStack network.
                    </p>
                    
                    {info.host_port ? (
                      <div style={{ marginBottom: "1rem" }}>
                        <span className="info-label" style={{ display: "block", marginBottom: "0.25rem" }}>Access Web Server (Host Browser)</span>
                        <a 
                          href={`http://localhost:${info.host_port}`} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="resource-id"
                          style={{ color: "var(--accent)", textDecoration: "underline", fontSize: 13, fontWeight: "bold" }}
                        >
                          http://localhost:{info.host_port}
                        </a>
                      </div>
                    ) : (
                      <p style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: "1rem" }}>
                        Port mapping not available (container starting up...).
                      </p>
                    )}

                    <div>
                      <span className="info-label" style={{ display: "block", marginBottom: "0.25rem" }}>VPC Internal Address (Lambda / SQS / VPC)</span>
                      <div className="code-block" style={{ padding: "0.5rem", background: "var(--bg-card)", borderRadius: 4, fontFamily: "monospace", fontSize: 12 }}>
                        http://{logicalId}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "console" && (
        <div className="panel-tab-content">
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "0.5rem" }}>
            <button className="btn btn-secondary" onClick={() => refetchConsole()}>
              Refresh
            </button>
          </div>
          {consoleLoading ? (
            <Skeleton lines={6} />
          ) : (
            <pre
              className="code-block"
              style={{
                maxHeight: "300px",
                overflowY: "auto",
                fontSize: "12px",
                backgroundColor: "#f1f3f5",
                color: "#0f172a",
                padding: "1rem",
                borderRadius: "6px"
              }}
            >
              {consoleData?.output || "No console output available yet (try refreshing in a minute)."}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RDS Panel
// ---------------------------------------------------------------------------
function RdsPanel({ stackName, logicalId }: { stackName: string; logicalId: string }) {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"info" | "query">("info");
  const [sql, setSql] = useState("SELECT * FROM test_users;");
  const [queryResult, setQueryResult] = useState<{
    records: Record<string, unknown>[];
    numberOfRecordsUpdated: number;
    error?: string;
  } | null>(null);

  const { data: db, isLoading, error } = useQuery({
    queryKey: ["rds", stackName, logicalId],
    queryFn: () => getRdsInfo(stackName, logicalId),
    refetchInterval: 5000,
  });

  const rebootMutation = useMutation({
    mutationFn: () => setRdsAction(stackName, logicalId, "reboot"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["rds", stackName, logicalId] });
    },
  });

  const queryMutation = useMutation({
    mutationFn: (queryText: string) => runRdsQuery(stackName, logicalId, queryText),
    onSuccess: (data) => {
      setQueryResult({
        records: data.records,
        numberOfRecordsUpdated: data.numberOfRecordsUpdated,
      });
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
        ?? (e as Error).message;
      setQueryResult({
        records: [],
        numberOfRecordsUpdated: 0,
        error: msg,
      });
    },
  });

  const isAvailable = db?.status === "available";

  const templates = [
    { label: "Show Tables", sql: "SHOW TABLES;" },
    { label: "Create Table", sql: "CREATE TABLE IF NOT EXISTS test_users (id INT PRIMARY KEY, name VARCHAR(50));" },
    { label: "Insert Row", sql: "INSERT INTO test_users (id, name) VALUES (1, 'Alice');" },
    { label: "Select All", sql: "SELECT * FROM test_users;" },
  ];

  return (
    <div className="panel-content">
      <div className="panel-tabs">
        <button
          className={`panel-tab ${activeTab === "info" ? "active" : ""}`}
          onClick={() => setActiveTab("info")}
        >
          Details
        </button>
        <button
          className={`panel-tab ${activeTab === "query" ? "active" : ""}`}
          onClick={() => setActiveTab("query")}
        >
          Query Runner (CRUD)
        </button>
      </div>

      {activeTab === "info" && (
        <div className="panel-tab-content">
          {isLoading && <Skeleton lines={5} />}
          {error && <ErrorAlert message={(error as Error).message} />}
          {db && (
            <>
              <div className="panel-section">
                <h3 className="panel-section-title">Status</h3>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1rem" }}>
                  <span className={`badge ${isAvailable ? "badge-green" : "badge-orange"}`}>
                    {db.status.toUpperCase()}
                  </span>
                  <span>({db.db_instance_class})</span>
                </div>

                <div className="button-group" style={{ marginBottom: "1.5rem" }}>
                  <button
                    className="btn btn-secondary"
                    disabled={!isAvailable || rebootMutation.isPending}
                    onClick={() => rebootMutation.mutate()}
                  >
                    {rebootMutation.isPending ? "Rebooting..." : "Reboot DB Instance"}
                  </button>
                </div>
              </div>

              <div className="panel-section">
                <h3 className="panel-section-title">Database Details</h3>
                <div className="info-grid" style={{ marginBottom: "1rem" }}>
                  <div className="info-item">
                    <span className="info-label">Engine</span>
                    <span className="info-value">{db.engine} {db.engine_version}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">DB Name</span>
                    <span className="info-value">{db.db_name || "N/A"}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Master Username</span>
                    <span className="info-value">{db.master_username || "N/A"}</span>
                  </div>
                  <div className="info-item">
                    <span className="info-label">Allocated Storage</span>
                    <span className="info-value">{db.allocated_storage} GB</span>
                  </div>
                </div>
              </div>

              {db.address && (
                <div className="panel-section">
                  <h3 className="panel-section-title">Endpoint</h3>
                  <div style={{ marginBottom: "1rem" }}>
                    <span className="info-label" style={{ display: "block", marginBottom: "0.25rem" }}>Connection String</span>
                    <div className="code-block" style={{ padding: "0.5rem", background: "var(--bg-card)", borderRadius: 4, fontFamily: "monospace", fontSize: 12 }}>
                      {db.address}:{db.port}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "query" && (
        <div className="panel-tab-content">
          <div className="panel-section">
            <h3 className="panel-section-title">Common Templates</h3>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
              {templates.map((tpl, idx) => (
                <button
                  key={idx}
                  className="btn btn-secondary btn-sm"
                  style={{ fontSize: 11, padding: "0.25rem 0.5rem" }}
                  onClick={() => setSql(tpl.sql)}
                >
                  {tpl.label}
                </button>
              ))}
            </div>

            <h3 className="panel-section-title">SQL Query</h3>
            <textarea
              className="yaml-pre"
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              style={{
                width: "100%",
                height: "100px",
                fontFamily: "monospace",
                fontSize: "12px",
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid var(--border)",
                backgroundColor: "var(--bg-card)",
                color: "var(--text-main)",
                resize: "vertical",
                outline: "none",
                marginBottom: "0.75rem",
              }}
            />

            <button
              className="btn btn-primary"
              disabled={queryMutation.isPending}
              onClick={() => queryMutation.mutate(sql)}
              style={{ width: "100%", marginBottom: "1.25rem" }}
            >
              {queryMutation.isPending ? "Executing SQL..." : "Execute Statement"}
            </button>
          </div>

          <div className="panel-section">
            <h3 className="panel-section-title">Query Results</h3>
            {queryResult ? (
              queryResult.error ? (
                <ErrorAlert message={queryResult.error} />
              ) : queryResult.records.length > 0 ? (
                <div className="dynamo-table-wrapper" style={{ maxHeight: "250px", overflowY: "auto" }}>
                  <table className="dynamo-table">
                    <thead>
                      <tr>
                        {Object.keys(queryResult.records[0]).map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {queryResult.records.map((row, rIdx) => (
                        <tr key={rIdx}>
                          {Object.keys(row).map((col) => (
                            <td key={col}>
                              <span className="resource-id">
                                {row[col] == null ? "NULL" : String(row[col])}
                              </span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="alert alert-success" role="alert" style={{ fontSize: 12 }}>
                  Statement executed successfully. Number of records updated:{" "}
                  <strong>{queryResult.numberOfRecordsUpdated}</strong>.
                </div>
              )
            ) : (
              <p style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                Execute a statement to see the results here.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// IAM / Unknown info panel
// ---------------------------------------------------------------------------
function InfoPanel({ node }: { node: DiagramNode }) {
  return (
    <div className="panel-content">
      <div className="panel-empty" style={{ textAlign: "left" }}>
        <p style={{ fontWeight: 600, marginBottom: "0.25rem" }}>{node.label}</p>
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>{node.type}</p>
        <p style={{ marginTop: "0.75rem", fontSize: 13, color: "var(--text-secondary)" }}>
          This resource type does not have an interactive panel.
          Inspect it in the resources table below.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ResourcePanel (slide-out sheet)
// ---------------------------------------------------------------------------
interface ResourcePanelProps {
  node: DiagramNode | null;
  stackName: string;
  onClose: () => void;
}

export function ResourcePanel({ node, stackName, onClose }: ResourcePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Close on outside click
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    if (node) {
      // slight delay so the opening click doesn't immediately close it
      const t = setTimeout(() => document.addEventListener("mousedown", onClick), 50);
      return () => {
        clearTimeout(t);
        document.removeEventListener("mousedown", onClick);
      };
    }
  }, [node, onClose]);

  if (!node) return null;

  function renderBody() {
    if (!node) return null;
    switch (node.type) {
      case "AWS::DynamoDB::Table":
        return <DynamoPanel stackName={stackName} logicalId={node.id} />;
      case "AWS::SQS::Queue":
        return <SqsPanel stackName={stackName} logicalId={node.id} />;
      case "AWS::Lambda::Function":
        return <LambdaPanel stackName={stackName} logicalId={node.id} />;
      case "AWS::S3::Bucket":
        return <S3Panel stackName={stackName} logicalId={node.id} />;
      case "AWS::EC2::Instance":
        return <Ec2Panel stackName={stackName} logicalId={node.id} />;
      case "AWS::RDS::DBInstance":
        return <RdsPanel stackName={stackName} logicalId={node.id} />;
      default:
        return <InfoPanel node={node} />;
    }
  }

  const interactive = isInteractive(node.type);

  return (
    <>
      <div className="panel-overlay" onClick={onClose} />
      <aside className="resource-panel open" ref={panelRef}>
        <div className="panel-header">
          <div className="panel-header-info">
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <h2 className="panel-title">{node.label}</h2>
              {interactive && (
                <span className="badge badge-blue" style={{ fontSize: 10 }}>Interactive</span>
              )}
            </div>
            <p className="panel-subtitle">{node.type}</p>
          </div>
          <button className="panel-close" onClick={onClose} aria-label="Close panel">
            ✕
          </button>
        </div>
        <div className="panel-body">{renderBody()}</div>
      </aside>
    </>
  );
}
