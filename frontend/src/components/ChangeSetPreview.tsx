import type { ChangeSetChange, ChangeSetResponse } from "../lib/types";

interface Props {
  changeset: ChangeSetResponse;
  stackName: string;
  onApprove: () => void;
  isDeploying: boolean;
  deployError?: string | null;
}

const ACTION_CONFIG: Record<
  string,
  { label: string; className: string; icon: string }
> = {
  Add:    { label: "Add",    className: "badge badge-green",  icon: "+" },
  Modify: { label: "Modify", className: "badge badge-yellow", icon: "~" },
  Remove: { label: "Remove", className: "badge badge-red",    icon: "−" },
};

function ActionBadge({ action }: { action: ChangeSetChange["action"] }) {
  const cfg = ACTION_CONFIG[action] ?? {
    label: action,
    className: "badge badge-gray",
    icon: "?",
  };
  return <span className={cfg.className}>{cfg.icon} {cfg.label}</span>;
}

export function ChangeSetPreview({
  changeset,
  stackName,
  onApprove,
  isDeploying,
  deployError,
}: Props) {
  const hasChanges = changeset.changes.length > 0;

  return (
    <div className="changeset-card">
      <div className="changeset-header">
        <div>
          <h2 className="changeset-title">Planned Changes</h2>
          <p className="changeset-subtitle">
            Stack: <code>{stackName}</code> · Change set:{" "}
            <code>{changeset.changeset_name}</code>
          </p>
        </div>
        <span className={`badge ${hasChanges ? "badge-yellow" : "badge-gray"}`}>
          {changeset.changes.length} change{changeset.changes.length !== 1 ? "s" : ""}
        </span>
      </div>

      {hasChanges ? (
        <div className="changeset-table-wrapper">
          <table className="changeset-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Resource Type</th>
                <th>Logical ID</th>
                <th>Replacement</th>
              </tr>
            </thead>
            <tbody>
              {changeset.changes.map((c, i) => (
                <tr key={i}>
                  <td><ActionBadge action={c.action} /></td>
                  <td>
                    <span className="resource-type-badge">{c.resource_type}</span>
                  </td>
                  <td>
                    <span className="resource-id">{c.logical_id}</span>
                  </td>
                  <td>
                    {c.replacement && (
                      <span className="badge badge-orange">⚠ Replace</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="alert alert-info changeset-empty">
          <span>ℹ No resource changes detected. The stack will be created/updated as-is.</span>
        </div>
      )}

      <div className="changeset-footer">
        <button
          id="approve-deploy-btn"
          className="btn btn-success"
          onClick={onApprove}
          disabled={isDeploying}
        >
          {isDeploying ? (
            <span className="btn-loading">
              <span className="spinner" /> Deploying…
            </span>
          ) : (
            "✓ Approve & Deploy"
          )}
        </button>
      </div>

      {deployError && (
        <div className="alert alert-error" role="alert">
          <strong>Deploy failed:</strong> {deployError}
        </div>
      )}
    </div>
  );
}
