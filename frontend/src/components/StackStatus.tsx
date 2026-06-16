import { useStackStatus } from "../hooks/useStackStatus";
import { StackResources } from "./StackResources";

interface Props {
  stackName: string;
}

const STATUS_CONFIG: Record<
  string,
  { label: string; className: string; }
> = {
  CREATE_IN_PROGRESS: { label: "Deploying…",    className: "badge badge-yellow" },
  CREATE_COMPLETE:    { label: "Deployed",       className: "badge badge-green" },
  CREATE_FAILED:      { label: "Failed",         className: "badge badge-red" },
  ROLLBACK_IN_PROGRESS: { label: "Rolling back…", className: "badge badge-orange" },
  ROLLBACK_COMPLETE:  { label: "Rolled back",    className: "badge badge-red" },
};

export function StackStatus({ stackName }: Props) {
  const { data, isLoading, error } = useStackStatus(stackName);

  if (isLoading) {
    return (
      <div className="status-card">
        <span className="spinner" /> Fetching stack status…
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-error" role="alert">
        <strong>Status error:</strong>{" "}
        {(error as { message?: string })?.message ?? "Unknown error"}
      </div>
    );
  }

  if (!data) return null;

  const cfg = STATUS_CONFIG[data.status] ?? {
    label: data.status,
    className: "badge badge-gray",
  };

  const isFailed =
    data.status === "CREATE_FAILED" ||
    data.status === "ROLLBACK_COMPLETE" ||
    data.status === "ROLLBACK_IN_PROGRESS";

  return (
    <>
      <div className="status-card">
        <div className="status-header">
          <h3 className="status-title">Stack Status</h3>
          <span className={cfg.className}>
            {cfg.label}
          </span>
        </div>

        <div className="status-detail">
          <span className="status-label">Stack Name</span>
          <code className="status-value">{data.stack_name}</code>
        </div>

        {/* Top-level status reason (e.g. "Resource creation cancelled") */}
        {data.reason && !isFailed && data.status !== "CREATE_COMPLETE" && (
          <div className="alert alert-info mt-2">{data.reason}</div>
        )}

        {/* Success message */}
        {data.status === "CREATE_COMPLETE" && (
          <div className="alert alert-success mt-2" role="status">
            Stack deployed successfully! Resources are live on MiniStack.
            {data.outputs && data.outputs.length > 0 && (
              <ul className="output-list">
                {data.outputs.map((o) => (
                  <li key={o.key}>
                    <strong>{o.key}:</strong> {o.value}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Detailed failure breakdown from stack events */}
        {isFailed && data.failed_events && data.failed_events.length > 0 && (
          <div className="alert alert-error mt-2" role="alert">
            <strong>Deployment failed. Failed resources:</strong>
            <ul className="failed-events-list">
              {data.failed_events.map((e, i) => (
                <li key={i}>
                  <span className="fe-resource">
                    {e.logical_id} <span className="fe-type">({e.resource_type})</span>
                  </span>
                  <span className="fe-reason">{e.reason || e.status}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Fallback reason when no events */}
        {isFailed && (!data.failed_events || data.failed_events.length === 0) && data.reason && (
          <div className="alert alert-error mt-2" role="alert">
            <strong>Reason:</strong> {data.reason}
          </div>
        )}
      </div>

      {/* Resource table — shown once CREATE_COMPLETE */}
      {data.status === "CREATE_COMPLETE" && (
        <StackResources stackName={stackName} />
      )}
    </>
  );
}
