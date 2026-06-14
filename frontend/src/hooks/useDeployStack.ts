import { useMutation } from "@tanstack/react-query";
import { deployStack } from "../lib/api";

export function useDeployStack() {
  return useMutation({
    mutationFn: ({ stackName, template }: { stackName: string; template: string }) =>
      deployStack(stackName, template),
  });
}
