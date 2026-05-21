/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agentCommandsQueryRoot, useAgentCommandsQuery } from "./use-agent-commands-query";

const { mockClient, mockRuntime } = vi.hoisted(() => {
  const hoistedClient = {
    listCommands: vi.fn(),
  };
  return {
    mockClient: hoistedClient,
    mockRuntime: {
      client: hoistedClient,
      isConnected: true,
    },
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mockRuntime.client,
  useHostRuntimeIsConnected: () => mockRuntime.isConnected,
}));

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderCommandsHook(input: Parameters<typeof useAgentCommandsQuery>[0]) {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);

  return {
    ...renderHook(() => useAgentCommandsQuery(input), { wrapper }),
    queryClient,
  };
}

describe("useAgentCommandsQuery", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockRuntime.client = mockClient;
    mockRuntime.isConnected = true;
  });

  it("loads commands for a draft composer without an agent id", async () => {
    mockClient.listCommands.mockResolvedValue({
      commands: [{ name: "compact", description: "Compact context", argumentHint: "" }],
    });

    const draftConfig = {
      provider: "opencode" as const,
      cwd: "/repo",
      modeId: "build",
    };

    const { result } = renderCommandsHook({
      serverId: "server-1",
      agentId: "",
      draftConfig,
    });

    await waitFor(() => {
      expect(result.current.commands).toEqual([
        { name: "compact", description: "Compact context", argumentHint: "" },
      ]);
    });

    expect(mockClient.listCommands).toHaveBeenCalledWith("", { draftConfig });
  });

  it("refreshes active command queries when the agent command root is invalidated", async () => {
    const initialCommands = [
      { name: "tree", description: "Pick a Pi tree entry", argumentHint: "<entryId>" },
    ];
    const refreshedCommands = [
      { name: "tree", description: "Pick the current Pi tree entry", argumentHint: "<entryId>" },
    ];
    mockClient.listCommands
      .mockResolvedValueOnce({ commands: initialCommands })
      .mockResolvedValueOnce({ commands: refreshedCommands });

    const { result, queryClient } = renderCommandsHook({
      serverId: "server-1",
      agentId: "agent-1",
    });

    await waitFor(() => {
      expect(result.current.commands).toEqual(initialCommands);
    });

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: agentCommandsQueryRoot("server-1", "agent-1"),
      });
    });

    await waitFor(() => {
      expect(result.current.commands).toEqual(refreshedCommands);
    });
    expect(mockClient.listCommands).toHaveBeenCalledTimes(2);
  });
});
