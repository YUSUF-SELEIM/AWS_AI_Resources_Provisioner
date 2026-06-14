import { useQuery } from "@tanstack/react-query";
import { getStackStatus } from "../lib/api";

const TERMINAL_STATUSES = ["CREATE_COMPLETE", "CREATE_FAILED", "ROLLBACK_COMPLETE"];

export function useStackStatus(stackName: string | null) {
  return useQuery({
    queryKey: ["stack-status", stackName],
    queryFn: () => getStackStatus(stackName!),
    enabled: !!stackName,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (!status || TERMINAL_STATUSES.includes(status)) return false;
      return 2000; // poll every 2s while in progress
    },
  });
}
