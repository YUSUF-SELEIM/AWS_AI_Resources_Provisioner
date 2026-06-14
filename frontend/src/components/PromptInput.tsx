import { useState } from "react";
import { useGenerateTemplate } from "../hooks/useGenerateTemplate";

interface Props {
  onTemplate: (yaml: string) => void;
}

const EXAMPLE_PROMPTS = [
  "Create a DynamoDB table for storing user profiles",
  "Create an SQS queue for order processing",
  "Create a Lambda function triggered by an SQS queue, with the necessary IAM role",
  "Create an S3 bucket called my-photos",
];

export function PromptInput({ onTemplate }: Props) {
  const [prompt, setPrompt] = useState("");
  const { mutate, isPending, error } = useGenerateTemplate();

  const handleGenerate = (text = prompt) => {
    if (!text.trim()) return;
    mutate(text, { onSuccess: (data) => onTemplate(data.template) });
  };

  const handleChip = (chip: string) => {
    setPrompt(chip);
    handleGenerate(chip);
  };

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
            "Generate Template"
          )}
        </button>
      </div>
      {error && (
        <div className="alert alert-error" role="alert">
          <strong>Generation failed:</strong>{" "}
          {(error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
            error.message}
        </div>
      )}
    </div>
  );
}
