import { useMutation } from "@tanstack/react-query";
import { previewChangeset } from "../lib/api";

export function useChangeset() {
  return useMutation({
    mutationFn: ({ stackName, template }: { stackName: string; template: string }) =>
      previewChangeset(stackName, template),
  });
}
