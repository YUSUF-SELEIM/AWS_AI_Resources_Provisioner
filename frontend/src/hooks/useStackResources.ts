import { useQuery } from "@tanstack/react-query";
import { getStackResources } from "../lib/api";

export function useStackResources(stackName: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["stack-resources", stackName],
    queryFn: () => getStackResources(stackName!),
    enabled: !!stackName && enabled,
    staleTime: 30_000,
  });
}
