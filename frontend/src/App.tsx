import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PromptInput } from "./components/PromptInput";
import { YamlPreview } from "./components/YamlPreview";
import { ArchitectureDiagram } from "./components/ArchitectureDiagram";
import { ChangeSetPreview } from "./components/ChangeSetPreview";
import { StackStatus } from "./components/StackStatus";
import { ResourcePanel } from "./components/ResourcePanel";
import { useDiagram } from "./hooks/useDiagram";
import { useExecuteChangeset } from "./hooks/useExecuteChangeset";
import { listStacks, deleteStack, getStackScript } from "./lib/api";
import { PREDEFINED_TEMPLATES } from "./lib/templates";
import type {
  ChangeSetChange,
  ChangeSetResponse,
  DiagramNode,
} from "./lib/types";

type Stage = "idle" | "generated" | "changeset" | "deployed";

interface ChangesetState {
  stackName: string;
  changeset: ChangeSetResponse;
}

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
      <div className="diagram-card diagram-loading" style={{ border: "1px solid var(--border)", borderRadius: 0 }}>
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

export default function App() {
  const queryClient = useQueryClient();

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

  // Query deployed stacks from the state manager
  const { data: deployedStacks = [] } = useQuery({
    queryKey: ["deployedStacks"],
    queryFn: listStacks,
    refetchInterval: 5000,
  });

  // Teardown mutation
  const deleteMutation = useMutation({
    mutationFn: deleteStack,
    onSuccess: (_, stackName) => {
      queryClient.invalidateQueries({ queryKey: ["deployedStacks"] });
      if (deployedStack === stackName) {
        handleReset();
      }
    },
  });

  const handleSelectTemplate = (tmpl: typeof PREDEFINED_TEMPLATES[0]) => {
    localStorage.setItem("AWS_AI_Resources_Provisioner_template", tmpl.script);
    localStorage.setItem("AWS_AI_Resources_Provisioner_stage", "generated");
    localStorage.removeItem("AWS_AI_Resources_Provisioner_deployed_stack");

    setTemplate(tmpl.script);
    setStage("generated");
    setDeployedStack(null);
    setChangesetState(null);
    setSelectedNode(null);
  };

  const handleSelectDeployedStack = async (stackName: string) => {
    try {
      const res = await getStackScript(stackName);
      localStorage.setItem("AWS_AI_Resources_Provisioner_template", res.python_script);
      localStorage.setItem("AWS_AI_Resources_Provisioner_deployed_stack", stackName);
      localStorage.setItem("AWS_AI_Resources_Provisioner_stage", "deployed");

      setTemplate(res.python_script);
      setDeployedStack(stackName);
      setStage("deployed");
      setChangesetState(null);
      setSelectedNode(null);
    } catch (e) {
      console.error("Failed to load stack script:", e);
    }
  };

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
    queryClient.invalidateQueries({ queryKey: ["deployedStacks"] });
  };

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
          queryClient.invalidateQueries({ queryKey: ["deployedStacks"] });
        },
      },
    );
  };

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

  const handleNodeClick = (node: DiagramNode) => {
    if (deployedStack) setSelectedNode(node);
  };

  const deployErrorMsg = deployError
    ? ((deployError as { response?: { data?: { detail?: string } } })?.response
        ?.data?.detail ?? (deployError as Error).message)
    : null;

  return (
    <div className="app-root" style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      {/* Header */}
      <header className="app-header" style={{ flexShrink: 0, borderBottom: "2px solid var(--border)", padding: "1rem 2rem" }}>
        <div
          className="header-inner"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            width: "100%",
            maxWidth: "none",
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
                border: "1px solid var(--border)",
                color: "var(--text-secondary)",
                borderRadius: 0,
                background: "transparent",
              }}
            >
              Start Fresh
            </button>
          )}
        </div>
      </header>

      {/* Main Body */}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Sidebar */}
        <aside
          style={{
            width: "340px",
            borderRight: "2px solid var(--border)",
            padding: "1.5rem",
            display: "flex",
            flexDirection: "column",
            gap: "1.5rem",
            overflowY: "auto",
            flexShrink: 0,
            background: "#ffffff",
          }}
        >
          {/* Deployed Stacks */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <h3 style={{ fontSize: "0.75rem", fontWeight: "900", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-secondary)" }}>
              Deployed Stacks
            </h3>
            {deployedStacks.length === 0 ? (
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", border: "1px dashed var(--border)", padding: "0.75rem", textAlign: "center" }}>
                No active deployments
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                {deployedStacks.map((s: any) => (
                  <div
                    key={s.StackName}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0.5rem",
                      border: s.StackName === deployedStack ? "2px solid var(--border)" : "1px solid var(--border)",
                      background: s.StackName === deployedStack ? "#f0f0f0" : "transparent",
                    }}
                  >
                    <button
                      onClick={() => handleSelectDeployedStack(s.StackName)}
                      style={{
                        flex: 1,
                        textAlign: "left",
                        background: "none",
                        border: "none",
                        fontSize: "0.8rem",
                        fontFamily: "var(--font-mono)",
                        fontWeight: "600",
                        cursor: "pointer",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        padding: 0,
                      }}
                    >
                      {s.StackName}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Are you sure you want to delete ${s.StackName}?`)) {
                          deleteMutation.mutate(s.StackName);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        fontSize: "0.75rem",
                        fontWeight: "bold",
                        padding: "2px 6px",
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Predefined Templates */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <h3 style={{ fontSize: "0.75rem", fontWeight: "900", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-secondary)" }}>
              Templates
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
              {PREDEFINED_TEMPLATES.map((tmpl) => (
                <button
                  key={tmpl.id}
                  onClick={() => handleSelectTemplate(tmpl)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: "0.25rem",
                    padding: "0.5rem",
                    border: "1px solid var(--border)",
                    background: "transparent",
                    textAlign: "left",
                    cursor: "pointer",
                    width: "100%",
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.background = "#f0f0f0")}
                  onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <span style={{ fontSize: "0.8rem", fontWeight: "bold" }}>{tmpl.name}</span>
                  <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{tmpl.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Create Stack (AI Generator) */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <h3 style={{ fontSize: "0.75rem", fontWeight: "900", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-secondary)" }}>
              Create Custom Stack (AI)
            </h3>
            <PromptInput onTemplate={handleNewTemplate} />
          </div>
        </aside>

        {/* Content Area */}
        <main
          style={{
            flex: 1,
            padding: "2rem",
            display: "flex",
            flexDirection: "column",
            gap: "2rem",
            overflowY: "auto",
            background: "#fafafa",
          }}
        >
          {template ? (
            <>
              {/* YAML / Script Preview & Diagram */}
              <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <h2 className="step-title">Template & Architecture</h2>
                <div className="preview-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
                  <YamlPreview
                    yaml={template}
                    onChange={(newYaml) => {
                      setTemplate(newYaml);
                      localStorage.setItem("AWS_AI_Resources_Provisioner_template", newYaml);
                    }}
                    onPreviewChanges={handlePreviewChanges}
                  />
                  <DiagramPanel
                    template={template}
                    onNodeClick={stage === "deployed" ? handleNodeClick : undefined}
                  />
                </div>
              </section>

              {/* Change Set / Deployment steps */}
              {changesetState && (
                <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  <h2 className="step-title">Deployment Plan</h2>
                  <ChangeSetPreview
                    changeset={changesetState.changeset}
                    stackName={changesetState.stackName}
                    onApprove={handleApprove}
                    isDeploying={isDeploying}
                    deployError={deployErrorMsg}
                  />
                </section>
              )}

              {deployedStack && stage === "deployed" && (
                <section style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  <h2 className="step-title">Deployment Status & Resources</h2>
                  <StackStatus
                    stackName={deployedStack}
                    onDeleteComplete={handleReset}
                  />
                </section>
              )}
            </>
          ) : (
            <div
              style={{
                display: "flex",
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                flexDirection: "column",
                border: "2px dashed var(--border)",
                minHeight: "300px",
                background: "#ffffff",
              }}
            >
              <p style={{ fontSize: "1rem", fontWeight: "bold", marginBottom: "0.5rem" }}>No Stack Selected</p>
              <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                Select a template from the sidebar or generate one using AI to preview it.
              </p>
            </div>
          )}
        </main>
      </div>

      {/* Resource Panel Drawer */}
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
