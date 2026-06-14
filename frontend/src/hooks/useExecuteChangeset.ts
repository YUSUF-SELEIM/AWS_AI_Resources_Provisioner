import { useMutation } from "@tanstack/react-query";
import { executeChangeset } from "../lib/api";

export function useExecuteChangeset() {
  return useMutation({
    mutationFn: ({
      stackName,
      changesetName,
    }: {
      stackName: string;
      changesetName: string;
    }) => executeChangeset(stackName, changesetName),
  });
}
