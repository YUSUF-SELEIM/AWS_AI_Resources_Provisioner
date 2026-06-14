import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
  useNodesState,
  useEdgesState,
  MarkerType,
  Position,
} from "reactflow";
import dagre from "@dagrejs/dagre";
import "reactflow/dist/style.css";
import type { DiagramNode, DiagramEdge } from "../lib/types";
import { isInteractive } from "./ResourcePanel";

// ---------------------------------------------------------------------------
// Node category colours
// ---------------------------------------------------------------------------

const RESOURCE_COLORS: Record<string, { bg: string; border: string; icon: string }> = {
  "AWS::Lambda::Function":        { bg: "#1d3a5f", border: "#3b82f6", icon: "λ" },
  "AWS::Lambda::EventSourceMapping": { bg: "#1d3a5f", border: "#60a5fa", icon: "↔" },
  "AWS::S3::Bucket":              { bg: "#14422a", border: "#22c55e", icon: "🪣" },
  "AWS::DynamoDB::Table":         { bg: "#14422a", border: "#4ade80", icon: "🗄" },
  "AWS::SQS::Queue":              { bg: "#422d14", border: "#f59e0b", icon: "📨" },
  "AWS::SNS::Topic":              { bg: "#422d14", border: "#fbbf24", icon: "📢" },
  "AWS::IAM::Role":               { bg: "#2a2a35", border: "#94a3b8", icon: "🔑" },
  "AWS::IAM::Policy":             { bg: "#2a2a35", border: "#94a3b8", icon: "📄" },
};

function getColor(resourceType: string) {
  return (
    RESOURCE_COLORS[resourceType] ?? { bg: "#1a1e2d", border: "#6366f1", icon: "☁" }
  );
}

function shortType(resourceType: string): string {
  const parts = resourceType.split("::");
  return parts[parts.length - 1] ?? resourceType;
}

// ---------------------------------------------------------------------------
// Custom node renderer
// ---------------------------------------------------------------------------

function ResourceNode({ data }: { data: { label: string; resourceType: string } }) {
  const color = getColor(data.resourceType);
  const interactive = isInteractive(data.resourceType);
  return (
    <div
      style={{
        background: color.bg,
        border: `1.5px solid ${color.border}`,
        borderRadius: 10,
        padding: "10px 14px",
        minWidth: 140,
        maxWidth: 200,
        textAlign: "center",
        boxShadow: `0 0 12px ${color.border}30`,
        cursor: interactive ? "pointer" : "default",
        position: "relative",
      }}
    >
      {interactive && (
        <span
          style={{
            position: "absolute",
            top: 4,
            right: 6,
            fontSize: 9,
            fontWeight: 700,
            color: "#818cf8",
            background: "rgba(99,102,241,0.15)",
            border: "1px solid rgba(99,102,241,0.3)",
            borderRadius: 4,
            padding: "1px 4px",
            lineHeight: 1.5,
          }}
        >
          ⚡
        </span>
      )}
      <div style={{ fontSize: 22, lineHeight: 1.2 }}>{color.icon}</div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: "#f1f5f9",
          marginTop: 4,
          wordBreak: "break-word",
        }}
      >
        {data.label}
      </div>
      <div
        style={{
          fontSize: 10,
          color: color.border,
          marginTop: 3,
          fontFamily: "monospace",
        }}
      >
        {shortType(data.resourceType)}
      </div>
    </div>
  );
}

const nodeTypes = { resource: ResourceNode };

// ---------------------------------------------------------------------------
// Dagre layout
// ---------------------------------------------------------------------------

const DAGRE_GRAPH = new dagre.graphlib.Graph();
DAGRE_GRAPH.setDefaultEdgeLabel(() => ({}));

function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: "LR" | "TB" = "LR"
): { nodes: Node[]; edges: Edge[] } {
  DAGRE_GRAPH.setGraph({ rankdir: direction, nodesep: 60, ranksep: 100 });

  nodes.forEach((n) => {
    DAGRE_GRAPH.setNode(n.id, { width: 160, height: 90 });
  });
  edges.forEach((e) => {
    DAGRE_GRAPH.setEdge(e.source, e.target);
  });

  dagre.layout(DAGRE_GRAPH);

  const laid = nodes.map((n) => {
    const pos = DAGRE_GRAPH.node(n.id);
    return {
      ...n,
      position: { x: pos.x - 80, y: pos.y - 45 },
      targetPosition: direction === "LR" ? Position.Left : Position.Top,
      sourcePosition: direction === "LR" ? Position.Right : Position.Bottom,
    };
  });
  return { nodes: laid, edges };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  onNodeClick?: (node: DiagramNode) => void;
}

export function ArchitectureDiagram({ nodes: rawNodes, edges: rawEdges, onNodeClick }: Props) {
  const initialNodes: Node[] = useMemo(
    () =>
      rawNodes.map((n) => ({
        id: n.id,
        type: "resource",
        position: { x: 0, y: 0 },
        data: { label: n.label, resourceType: n.type },
      })),
    [rawNodes]
  );

  const initialEdges: Edge[] = useMemo(
    () =>
      rawEdges.map((e, i) => ({
        id: `edge-${i}`,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: "#6366f1" },
        style: { stroke: "#6366f1", strokeWidth: 1.5 },
        labelStyle: { fill: "#94a3b8", fontSize: 10 },
        labelBgStyle: { fill: "#141720" },
      })),
    [rawEdges]
  );

  const { nodes: laidNodes, edges: laidEdges } = useMemo(
    () => applyDagreLayout(initialNodes, initialEdges, "LR"),
    [initialNodes, initialEdges]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(laidNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(laidEdges);

  useEffect(() => {
    setNodes(laidNodes);
    setEdges(laidEdges);
  }, [laidNodes, laidEdges, setNodes, setEdges]);

  const onInit = useCallback((instance: { fitView: () => void }) => {
    instance.fitView();
  }, []);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, rfNode: Node) => {
      if (!onNodeClick) return;
      const dn = rawNodes.find((n) => n.id === rfNode.id);
      if (dn) onNodeClick(dn);
    },
    [onNodeClick, rawNodes]
  );

  if (rawNodes.length === 0) {
    return (
      <div className="diagram-card diagram-empty">
        <span>No resources found</span>
      </div>
    );
  }

  return (
    <div className="diagram-card">
      <div className="diagram-header">
        <h2 className="diagram-title">Architecture Diagram</h2>
        <span className="badge badge-blue">{rawNodes.length} resources</span>
      </div>
      <div className="diagram-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          onInit={onInit}
          onNodeClick={handleNodeClick}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#252a3a" gap={20} size={1} />
          <Controls
            style={{
              background: "#141720",
              border: "1px solid #252a3a",
              borderRadius: 8,
            }}
          />
        </ReactFlow>
      </div>
    </div>
  );
}
