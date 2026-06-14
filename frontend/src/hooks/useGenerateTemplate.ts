import { useMutation } from "@tanstack/react-query";
import { generateTemplate } from "../lib/api";

export function useGenerateTemplate() {
  return useMutation({
    mutationFn: (prompt: string) => generateTemplate(prompt),
  });
}
