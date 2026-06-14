import { useStackResources } from "../hooks/useStackResources";

interface Props {
  stackName: string;
}

const RESOURCE_STATUS_CLASS: Record<string, string> = {
  CREATE_COMPLETE: "badge badge-green",
  CREATE_IN_PROGRESS: "badge badge-yellow",
  CREATE_FAILED: "badge badge-red",
  DELETE_COMPLETE: "badge badge-gray",
};

// Map AWS resource types to readable short labels
const TYPE_LABELS: Record<string, string> = {
  "AWS::S3::Bucket": "S3 Bucket",
  "AWS::DynamoDB::Table": "DynamoDB Table",
  "AWS::SQS::Queue": "SQS Queue",
  "AWS::Lambda::Function": "Lambda Function",
  "AWS::Lambda::EventSourceMapping": "Event Source Mapping",
  "AWS::IAM::Role": "IAM Role",
};

export function StackResources({ stackName }: Props) {
  const { data, isLoading, error } = useStackResources(stackName, true);

  if (isLoading) {
    return (
      <div className="resources-card">
        <span className="spinner" /> Loading resources…
      </div>
    );
  }

  if (error || !data) return null;

  return (
    <div className="resources-card">
      <h3 className="resources-title">Deployed Resources</h3>
      <div className="resources-table-wrapper">
        <table className="resources-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Logical ID</th>
              <th>Physical ID</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.logical_id}>
                <td>
                  <span className="resource-type-badge">
                    {TYPE_LABELS[r.resource_type] ?? r.resource_type}
                  </span>
                </td>
                <td><code className="resource-id">{r.logical_id}</code></td>
                <td>
                  <code className="resource-id resource-physical">
                    {r.physical_id ?? "—"}
                  </code>
                </td>
                <td>
                  <span className={RESOURCE_STATUS_CLASS[r.status] ?? "badge badge-gray"}>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
