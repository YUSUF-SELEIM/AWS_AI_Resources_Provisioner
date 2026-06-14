import { useQuery } from "@tanstack/react-query";
import { getDiagram } from "../lib/api";

export function useDiagram(template: string | null) {
  return useQuery({
    queryKey: ["diagram", template],
    queryFn: () => getDiagram(template!),
    enabled: !!template,
    staleTime: Infinity, // diagram is pure derivation — never re-fetch
  });
}
