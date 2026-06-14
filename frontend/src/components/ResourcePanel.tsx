import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getDynamoItems,
  putDynamoItem,
  deleteDynamoItem,
  sendSqsMessage,
  receiveSqsMessages,
  invokeLambda,
} from "../lib/api";
import type { DiagramNode, DynamoItem, SqsMessage, LambdaInvokeResponse } from "../lib/types";

// ---------------------------------------------------------------------------
// Interactive resource types
// ---------------------------------------------------------------------------
const INTERACTIVE_TYPES = new Set([
  "AWS::DynamoDB::Table",
  "AWS::SQS::Queue",
  "AWS::Lambda::Function",
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

  const putMutation = useMutation({
    mutationFn: (item: Record<string, unknown>) =>
      putDynamoItem(stackName, logicalId, item),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dynamo", stackName, logicalId] });
      setNewItem([{ key: "", value: "" }]);
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
      setSendStatus(`✓ Sent! Message ID: ${d.message_id}`);
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
        {sendMutation.isPending ? "Sending…" : "Send Message ➤"}
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
        {pollMutation.isPending ? "Polling…" : "↻ Poll & Consume"}
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
  const [payload, setPayload] = useState("{}");
  const [tab, setTab] = useState<"response" | "logs">("response");
  const [result, setResult] = useState<LambdaInvokeResponse | null>(null);
  const [invokeError, setInvokeError] = useState("");

  const invokeMutation = useMutation({
    mutationFn: () => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(payload);
      } catch {
        // pass raw string wrapped in a key
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
        {invokeMutation.isPending ? "Invoking…" : "⚡ Invoke Function"}
      </button>
      {invokeError && <ErrorAlert message={invokeError} />}

      {result && (
        <>
          <div className="panel-tabs" style={{ marginTop: "1.25rem" }}>
            <button
              className={`panel-tab ${tab === "response" ? "active" : ""}`}
              onClick={() => setTab("response")}
            >
              Response
            </button>
            <button
              className={`panel-tab ${tab === "logs" ? "active" : ""}`}
              onClick={() => setTab("logs")}
            >
              Logs
            </button>
          </div>

          {result.function_error && (
            <div className="alert alert-error" style={{ marginTop: "0.5rem" }}>
              <strong>Function error:</strong> {result.function_error}
            </div>
          )}

          {tab === "response" && (
            <pre className="lambda-output">
              {JSON.stringify(result.response, null, 2)}
            </pre>
          )}
          {tab === "logs" && (
            <pre className="lambda-output lambda-logs">
              {result.logs || "(No logs returned)"}
            </pre>
          )}
        </>
      )}

      {!result && !invokeMutation.isPending && (
        <div className="panel-empty">Invoke the function to see the response.</div>
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
        <div style={{ fontSize: 32, marginBottom: "0.75rem" }}>🔒</div>
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
                <span className="badge badge-blue" style={{ fontSize: 10 }}>⚡ Interactive</span>
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
