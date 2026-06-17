import { useState } from "react";
import { useGenerateTemplate } from "../hooks/useGenerateTemplate";

interface Props {
  onTemplate: (yaml: string, promptText?: string) => void;
}

export function PromptInput({ onTemplate }: Props) {
  const [prompt, setPrompt] = useState("");
  const { mutate, isPending, error } = useGenerateTemplate();

  const handleGenerate = (text = prompt) => {
    if (!text.trim()) return;
    mutate(text, { onSuccess: (data) => onTemplate(data.template, text) });
  };

  return (
    <div className="prompt-input-card">
      <label htmlFor="prompt" className="prompt-label">
        Describe your infrastructure
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

