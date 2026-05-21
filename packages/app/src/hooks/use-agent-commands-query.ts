import { useQuery } from "@tanstack/react-query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";

const COMMANDS_STALE_TIME = 60_000; // Commands rarely change, cache for 1 minute

export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  argumentOptions?: Array<{
    id: string;
    label: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface DraftCommandConfig {
  provider: AgentProvider;
  cwd: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export function agentCommandsQueryRoot(serverId: string, agentId: string) {
  return ["agentCommands", serverId, agentId] as const;
}

function commandsQueryKey(serverId: string, agentId: string, draftConfig?: DraftCommandConfig) {
  return [
    ...agentCommandsQueryRoot(serverId, agentId),
    draftConfig?.provider ?? null,
    draftConfig?.cwd ?? null,
    draftConfig?.modeId ?? null,
    draftConfig?.model ?? null,
    draftConfig?.thinkingOptionId ?? null,
    draftConfig?.featureValues ?? null,
  ] as const;
}

interface UseAgentCommandsQueryOptions {
  serverId: string;
  agentId: string;
  enabled?: boolean;
  draftConfig?: DraftCommandConfig;
  staleTime?: number;
}

export function useAgentCommandsQuery({
  serverId,
  agentId,
  enabled = true,
  draftConfig,
  staleTime = COMMANDS_STALE_TIME,
}: UseAgentCommandsQueryOptions) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: commandsQueryKey(serverId, agentId, draftConfig),
    queryFn: async () => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const response = await client.listCommands(agentId, { draftConfig });
      return response.commands as AgentSlashCommand[];
    },
    enabled: enabled && !!client && isConnected && (!!agentId || !!draftConfig),
    staleTime,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });

  // isPending is true when the query has never run yet (no cached data and not fetching)
  // isLoading is true when fetching and no data yet
  const isLoading = query.isPending || query.isLoading;

  return {
    commands: query.data ?? [],
    isLoading,
    isError: query.isError,
    error: query.error,
  };
}
