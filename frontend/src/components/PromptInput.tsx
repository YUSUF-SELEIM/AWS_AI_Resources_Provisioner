import { useState } from "react";
import { useGenerateTemplate } from "../hooks/useGenerateTemplate";

interface Props {
  onTemplate: (yaml: string, promptText?: string) => void;
}

const EXAMPLE_PROMPTS = [
  "Create an S3 bucket and an S3 object inside it containing dummy config JSON data",
  "Create an EC2 Web Server inside a Security Group with an attached Elastic IP and UserData",
  "Create a Lambda function triggered by an SQS queue with an execution IAM Role",
  "Create a DynamoDB table and a Lambda function that receives environment variables to query it",
];

export function PromptInput({ onTemplate }: Props) {
  const [prompt, setPrompt] = useState("");
  const { mutate, isPending, error } = useGenerateTemplate();

  const handleGenerate = (text = prompt) => {
    if (!text.trim()) return;
    mutate(text, { onSuccess: (data) => onTemplate(data.template, text) });
  };

  const handleChip = (chip: string) => {
    setPrompt(chip);
    handleGenerate(chip);
  };

  const history: { timestamp: number; prompt: string; template: string }[] =
    JSON.parse(
      localStorage.getItem("AWS_AI_Resources_Provisioner_history") || "[]",
    );

  return (
    <div className="prompt-input-card">
      {/* Example chips */}
      <div className="prompt-chips">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p}
            className="chip"
            onClick={() => handleChip(p)}
            disabled={isPending}
            type="button"
          >
            {p}
          </button>
        ))}
      </div>

      {history.length > 0 && (
        <div
          style={{
            marginTop: "1rem",
            borderTop: "1px dashed var(--border)",
            paddingTop: "0.75rem",
          }}
        >
          <label
            className="prompt-label"
            style={{
              fontSize: "11px",
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              display: "block",
              marginBottom: "0.5rem",
            }}
          >
            Recent Templates (Load without API call)
          </label>
          <div className="prompt-chips">
            {history.map((h, idx) => (
              <button
                key={idx}
                className="chip"
                style={{
                  borderColor: "var(--border)",
                  opacity: 0.85,
                  fontSize: "12px",
                }}
                onClick={() => onTemplate(h.template, h.prompt)}
                disabled={isPending}
                type="button"
              >
                {h.prompt.slice(0, 50)}
                {h.prompt.length > 50 ? "..." : ""}
              </button>
            ))}
          </div>
        </div>
      )}

      <label htmlFor="prompt" className="prompt-label">
        Or describe your own infrastructure
      </label>
      <textarea
        id="prompt"
        className="prompt-textarea"
        rows={4}
        placeholder='e.g. "Create an S3 bucket called my-photos"'
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && e.ctrlKey && handleGenerate()}
      />
      <div className="prompt-footer">
        <span className="prompt-hint">Ctrl+Enter to generate</span>
        <button
          id="generate-btn"
          className="btn btn-primary"
          onClick={() => handleGenerate()}
          disabled={isPending || !prompt.trim()}
        >
          {isPending ? (
            <span className="btn-loading">
              <span className="spinner" /> Generating…
            </span>
          ) : (
            "Generate Script"
          )}
        </button>
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          <strong>Generation failed:</strong>{" "}
          {(error as { response?: { data?: { detail?: string } } })?.response
            ?.data?.detail ?? error.message}
        </div>
      )}
    </div>
  );
}
