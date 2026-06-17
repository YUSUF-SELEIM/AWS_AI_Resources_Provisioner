import { useState } from "react";
import { PromptInput } from "./components/PromptInput";
import { YamlPreview } from "./components/YamlPreview";
import { ArchitectureDiagram } from "./components/ArchitectureDiagram";
import { ChangeSetPreview } from "./components/ChangeSetPreview";
import { StackStatus } from "./components/StackStatus";
import { ResourcePanel } from "./components/ResourcePanel";
import { useDiagram } from "./hooks/useDiagram";
import { useExecuteChangeset } from "./hooks/useExecuteChangeset";
import type {
  ChangeSetChange,
  ChangeSetResponse,
  DiagramNode,
} from "./lib/types";

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
  const [template, setTemplate] = useState<string | null>(() =>
    localStorage.getItem("AWS_AI_Resources_Provisioner_template"),
  );
  const [stage, setStage] = useState<Stage>(
    () =>
      (localStorage.getItem("AWS_AI_Resources_Provisioner_stage") as Stage) ||
      "idle",
  );
  const [deployedStack, setDeployedStack] = useState<string | null>(() =>
    localStorage.getItem("AWS_AI_Resources_Provisioner_deployed_stack"),
  );
  const [changesetState, setChangesetState] = useState<ChangesetState | null>(
    null,
  );
  const [selectedNode, setSelectedNode] = useState<DiagramNode | null>(null);

  const {
    mutate: execChangeset,
    isPending: isDeploying,
    error: deployError,
  } = useExecuteChangeset();

  // Step 1 → 2: new template generated / loaded from history
  const handleNewTemplate = (yaml: string, promptText?: string) => {
    localStorage.setItem("AWS_AI_Resources_Provisioner_template", yaml);
    localStorage.setItem("AWS_AI_Resources_Provisioner_stage", "generated");
    localStorage.removeItem("AWS_AI_Resources_Provisioner_deployed_stack");

    // Save template to history
    const history = JSON.parse(
      localStorage.getItem("AWS_AI_Resources_Provisioner_history") || "[]",
    );
    const exists = history.some((h: any) => h.template === yaml);
    if (!exists) {
      const newHistory = [
        {
          timestamp: Date.now(),
          prompt: promptText || "Custom Configuration",
          template: yaml,
        },
        ...history,
      ].slice(0, 10);
      localStorage.setItem(
        "AWS_AI_Resources_Provisioner_history",
        JSON.stringify(newHistory),
      );
    }

    setTemplate(yaml);
    setChangesetState(null);
    setDeployedStack(null);
    setStage("generated");
  };

  // Step 2 → 3: changeset preview ready
  const handlePreviewChanges = (
    stackName: string,
    changesetName: string,
    changes: ChangeSetChange[],
  ) => {
    setChangesetState({
      stackName,
      changeset: { changeset_name: changesetName, changes },
    });
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
          localStorage.setItem(
            "AWS_AI_Resources_Provisioner_deployed_stack",
            changesetState.stackName,
          );
          localStorage.setItem(
            "AWS_AI_Resources_Provisioner_stage",
            "deployed",
          );
          setDeployedStack(changesetState.stackName);
          setStage("deployed");
        },
      },
    );
  };

  // Reset all active states
  const handleReset = () => {
    localStorage.removeItem("AWS_AI_Resources_Provisioner_template");
    localStorage.removeItem("AWS_AI_Resources_Provisioner_stage");
    localStorage.removeItem("AWS_AI_Resources_Provisioner_deployed_stack");
    setTemplate(null);
    setStage("idle");
    setChangesetState(null);
    setDeployedStack(null);
    setSelectedNode(null);
  };

  // Node click from diagram (only opens panel if stack is deployed)
  const handleNodeClick = (node: DiagramNode) => {
    if (deployedStack) setSelectedNode(node);
  };

  const deployErrorMsg = deployError
    ? ((deployError as { response?: { data?: { detail?: string } } })?.response
        ?.data?.detail ?? (deployError as Error).message)
    : null;

  return (
    <div className="app-root">
      {/* Header */}
      <header className="app-header">
        <div
          className="header-inner"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            width: "100%",
          }}
        >
          <div>
            <div className="logo">
              <span className="logo-text">AWS AI PROVISIONEER</span>
            </div>
      
          </div>
          {template && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={handleReset}
              style={{
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              Start Fresh
            </button>
          )}
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
        {(stage === "generated" ||
          stage === "changeset" ||
          stage === "deployed") &&
          template && (
            <section className="step-section">
              <div className="step-number">2</div>
              <div className="step-content">
                <h2 className="step-title">Review your template</h2>
                <div className="preview-grid">
                  <YamlPreview
                    yaml={template}
                    onChange={(newYaml) => {
                      setTemplate(newYaml);
                      localStorage.setItem(
                        "AWS_AI_Resources_Provisioner_template",
                        newYaml,
                      );
                    }}
                    onPreviewChanges={handlePreviewChanges}
                  />
                  <DiagramPanel
                    template={template}
                    onNodeClick={
                      stage === "deployed" ? handleNodeClick : undefined
                    }
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
              <StackStatus stackName={deployedStack} onDeleteComplete={handleReset} />
            </div>
          </section>
        )}
      </main>

      <footer className="app-footer">
        <p>
          AWS_AI_Resources_Provisioner Phase 3B · MiniStack endpoint:{" "}
          <code>http://localhost:4566</code>
          {deployedStack && (
            <span style={{ marginLeft: "0.75rem" }}>
              · Stack: <code>{deployedStack}</code>
              {" — "}
              <span style={{ color: "var(--accent)" }}>
                click any interactive node to inspect
              </span>
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
