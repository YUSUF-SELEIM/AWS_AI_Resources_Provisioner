import { useState } from "react";
import { useChangeset } from "../hooks/useChangeset";

interface Props {
  yaml: string;
  onChange: (newYaml: string) => void;
  onPreviewChanges: (stackName: string, changesetName: string, changes: import("../lib/types").ChangeSetChange[]) => void;
}

// Derive a stack name from the Python script description or variable assignments
function deriveStackName(script: string): string {
  const bucket = script.match(/(?:bucket_name|Bucket)\s*=\s*['"]([a-z0-9-]+)['"]/i);
  if (bucket) return `stack-${bucket[1]}`;
  const fn = script.match(/(?:FunctionName|function_name)\s*=\s*['"]([a-z0-9-]+)['"]/i);
  if (fn) return `stack-${fn[1]}`;
  const table = script.match(/(?:TableName|table_name)\s*=\s*['"]([a-z0-9-]+)['"]/i);
  if (table) return `stack-${table[1]}`;
  const queue = script.match(/(?:QueueName|queue_name)\s*=\s*['"]([a-z0-9-]+)['"]/i);
  if (queue) return `stack-${queue[1]}`;
  return `stack-${Date.now()}`;
}

export function YamlPreview({ yaml, onChange, onPreviewChanges }: Props) {
  const { mutate, isPending, error } = useChangeset();
  const [stackName] = useState(() => deriveStackName(yaml));

  const handlePreview = () => {
    mutate(
      { stackName, template: yaml },
      {
        onSuccess: (data) =>
          onPreviewChanges(stackName, data.changeset_name, data.changes),
      }
    );
  };

  return (
    <div className="yaml-card">
      <div className="yaml-card-header">
        <h2 className="yaml-title">Generated Python Script</h2>
        <span className="badge">PYTHON</span>
      </div>
      <textarea
        className="yaml-pre"
        style={{ width: "100%", height: "380px", resize: "vertical", outline: "none", border: "1px solid var(--border)" }}
        value={yaml}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="yaml-footer">
        <span className="stack-name-label">Stack: <code>{stackName}</code></span>
        <button
          id="preview-changes-btn"
          className="btn btn-primary"
          onClick={handlePreview}
          disabled={isPending}
        >
          {isPending ? (
            <span className="btn-loading">
              <span className="spinner" /> Analysing…
            </span>
          ) : (
            "Preview Changes →"
          )}
        </button>
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          <strong>Preview failed:</strong>{" "}
          {(error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
            (error as Error).message}
        </div>
      )}
    </div>
  );
}

