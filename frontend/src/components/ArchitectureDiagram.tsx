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
  "AWS::Lambda::Function":        { bg: "#dbeafe", border: "#3b82f6", icon: "λ" },
  "AWS::Lambda::EventSourceMapping": { bg: "#dbeafe", border: "#60a5fa", icon: "↔" },
  "AWS::S3::Bucket":              { bg: "#dcfce7", border: "#22c55e", icon: "S3" },
  "AWS::DynamoDB::Table":         { bg: "#dcfce7", border: "#4ade80", icon: "DB" },
  "AWS::SQS::Queue":              { bg: "#fef3c7", border: "#f59e0b", icon: "Q" },
  "AWS::SNS::Topic":              { bg: "#fef3c7", border: "#fbbf24", icon: "SNS" },
  "AWS::IAM::Role":               { bg: "#f1f3f5", border: "#94a3b8", icon: "R" },
  "AWS::IAM::Policy":             { bg: "#f1f3f5", border: "#94a3b8", icon: "P" },
};

function getColor(resourceType: string) {
  return (
    RESOURCE_COLORS[resourceType] ?? { bg: "#f1f3f5", border: "#2563eb", icon: "?" }
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
            color: "#3b82f6",
            background: "rgba(37,99,235,0.1)",
            border: "1px solid rgba(37,99,235,0.3)",
            borderRadius: 4,
            padding: "1px 4px",
            lineHeight: 1.5,
          }}
        >
          i
        </span>
      )}
      <div style={{ fontSize: 22, lineHeight: 1.2 }}>{color.icon}</div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 700,
          color: "#0f172a",
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
        markerEnd: { type: MarkerType.ArrowClosed, color: "#2563eb" },
        style: { stroke: "#2563eb", strokeWidth: 1.5 },
        labelStyle: { fill: "#475569", fontSize: 10 },
        labelBgStyle: { fill: "#ffffff" },
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
          <Background color="#e2e8f0" gap={20} size={1} />
          <Controls
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
            }}
          />
        </ReactFlow>
      </div>
    </div>
  );
}
