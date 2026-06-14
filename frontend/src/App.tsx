import { useState } from "react";
import { PromptInput } from "./components/PromptInput";
import { YamlPreview } from "./components/YamlPreview";
import { ArchitectureDiagram } from "./components/ArchitectureDiagram";
import { ChangeSetPreview } from "./components/ChangeSetPreview";
import { StackStatus } from "./components/StackStatus";
import { ResourcePanel } from "./components/ResourcePanel";
import { useDiagram } from "./hooks/useDiagram";
import { useExecuteChangeset } from "./hooks/useExecuteChangeset";
import type { ChangeSetChange, ChangeSetResponse, DiagramNode } from "./lib/types";

// ---------------------------------------------------------------------------
// Stage machine types
// ---------------------------------------------------------------------------
type Stage = "idle" | "generated" | "changeset" | "deployed";

interface ChangesetState {
  stackName: string;
  changeset: ChangeSetResponse;
}

// ---------------------------------------------------------------------------
// Diagram panel (fetches automatically when template is set)
// ---------------------------------------------------------------------------
function DiagramPanel({
  template,
  onNodeClick,
}: {
  template: string | null;
  onNodeClick?: (node: DiagramNode) => void;
}) {
  const { data, isLoading } = useDiagram(template);

  if (isLoading) {
    return (
      <div className="diagram-card diagram-loading">
        <span className="spinner" />
        <span>Building diagram…</span>
      </div>
    );
  }

  if (!data) return null;

  return (
    <ArchitectureDiagram
      nodes={data.nodes}
      edges={data.edges}
      onNodeClick={onNodeClick}
    />
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
export default function App() {
  const [stage, setStage] = useState<Stage>("idle");
  const [template, setTemplate] = useState<string | null>(null);
  const [changesetState, setChangesetState] = useState<ChangesetState | null>(null);
  const [deployedStack, setDeployedStack] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<DiagramNode | null>(null);

  const { mutate: execChangeset, isPending: isDeploying, error: deployError } =
    useExecuteChangeset();

  // Step 1 → 2: new template generated
  const handleNewTemplate = (yaml: string) => {
    setTemplate(yaml);
    setChangesetState(null);
    setDeployedStack(null);
    setStage("generated");
  };

  // Step 2 → 3: changeset preview ready
  const handlePreviewChanges = (
    stackName: string,
    changesetName: string,
    changes: ChangeSetChange[]
  ) => {
    setChangesetState({ stackName, changeset: { changeset_name: changesetName, changes } });
    setStage("changeset");
  };

  // Step 3 → 4: execute change set and wait for deploy
  const handleApprove = () => {
    if (!changesetState) return;
    execChangeset(
      {
        stackName: changesetState.stackName,
        changesetName: changesetState.changeset.changeset_name,
      },
      {
        onSuccess: () => {
          setDeployedStack(changesetState.stackName);
          setStage("deployed");
        },
      }
    );
  };

  // Node click from diagram (only opens panel if stack is deployed)
  const handleNodeClick = (node: DiagramNode) => {
    if (deployedStack) setSelectedNode(node);
  };

  const deployErrorMsg = deployError
    ? ((deployError as { response?: { data?: { detail?: string } } })?.response?.data
        ?.detail ?? (deployError as Error).message)
    : null;

  return (
    <div className="app-root">
      {/* Header */}
      <header className="app-header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">⚡</span>
            <span className="logo-text">Stackmind</span>
          </div>
          <p className="header-tagline">
            Natural language → CloudFormation → Local AWS sandbox
          </p>
        </div>
      </header>

      {/* Main */}
      <main className="app-main">
        {/* Step 1 — Prompt */}
        <section className="step-section">
          <div className="step-number">1</div>
          <div className="step-content">
            <h2 className="step-title">Describe your infrastructure</h2>
            <PromptInput onTemplate={handleNewTemplate} />
          </div>
        </section>

        {/* Step 2 — YAML Preview + Architecture Diagram */}
        {(stage === "generated" || stage === "changeset" || stage === "deployed") &&
          template && (
            <section className="step-section">
              <div className="step-number">2</div>
              <div className="step-content">
                <h2 className="step-title">Review your template</h2>
                <div className="preview-grid">
                  <YamlPreview
                    yaml={template}
                    onPreviewChanges={handlePreviewChanges}
                  />
                  <DiagramPanel
                    template={template}
                    onNodeClick={stage === "deployed" ? handleNodeClick : undefined}
                  />
                </div>
              </div>
            </section>
          )}

        {/* Step 3 — Change Set Preview */}
        {(stage === "changeset" || stage === "deployed") && changesetState && (
          <section className="step-section">
            <div className="step-number">3</div>
            <div className="step-content">
              <h2 className="step-title">Plan before apply</h2>
              <ChangeSetPreview
                changeset={changesetState.changeset}
                stackName={changesetState.stackName}
                onApprove={handleApprove}
                isDeploying={isDeploying}
                deployError={deployErrorMsg}
              />
            </div>
          </section>
        )}

        {/* Step 4 — Deployment Status */}
        {stage === "deployed" && deployedStack && (
          <section className="step-section">
            <div className="step-number">4</div>
            <div className="step-content">
              <h2 className="step-title">Deployment status</h2>
              <StackStatus stackName={deployedStack} />
            </div>
          </section>
        )}
      </main>

      <footer className="app-footer">
        <p>
          Stackmind Phase 3B · MiniStack endpoint:{" "}
          <code>http://localhost:4566</code>
          {deployedStack && (
            <span style={{ marginLeft: "0.75rem" }}>
              · Stack: <code>{deployedStack}</code>
              {" — "}<span style={{ color: "var(--success)" }}>click any ⚡ node to inspect</span>
            </span>
          )}
        </p>
      </footer>

      {/* Resource Panel (slide-out drawer) */}
      {deployedStack && (
        <ResourcePanel
          node={selectedNode}
          stackName={deployedStack}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}

