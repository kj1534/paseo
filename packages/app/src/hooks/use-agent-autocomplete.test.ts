/**
 * @vitest-environment jsdom
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSlashCommand, DraftCommandConfig } from "./use-agent-commands-query";
import { useAgentAutocomplete } from "./use-agent-autocomplete";

const { mockClient, mockRuntime } = vi.hoisted(() => {
  const hoistedClient = {
    listCommands: vi.fn(),
    getDirectorySuggestions: vi.fn(),
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

const DRAFT_CONFIG: DraftCommandConfig = {
  provider: "pi",
  cwd: "/repo",
};

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderAutocompleteHook(args: {
  userInput: string;
  setUserInput?: (nextValue: string) => void;
  onAutocompleteApplied?: () => void;
}) {
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  const setUserInput = args.setUserInput ?? vi.fn();
  const onAutocompleteApplied = args.onAutocompleteApplied ?? vi.fn();

  return renderHook(
    ({ userInput }: { userInput: string }) =>
      useAgentAutocomplete({
        userInput,
        cursorIndex: userInput.length,
        setUserInput,
        serverId: "server-1",
        agentId: "",
        draftConfig: DRAFT_CONFIG,
        onAutocompleteApplied,
      }),
    {
      initialProps: { userInput: args.userInput },
      wrapper,
    },
  );
}

function treeCommand(argumentOptions: AgentSlashCommand["argumentOptions"]): AgentSlashCommand {
  return {
    name: "tree",
    description: "Pick a Pi tree entry",
    argumentHint: "<entryId>",
    argumentOptions,
  };
}

function optionLabels(options: Array<{ label: string }>): string[] {
  const labels: string[] = [];
  for (const option of options) {
    labels.push(option.label);
  }
  return labels;
}

function optionDetails(options: Array<{ detail?: string }>): Array<string | undefined> {
  const details: Array<string | undefined> = [];
  for (const option of options) {
    details.push(option.detail);
  }
  return details;
}

function optionIds(options: Array<{ id: string }>): string[] {
  const ids: string[] = [];
  for (const option of options) {
    ids.push(option.id);
  }
  return ids;
}

function allOptionsStacked(options: Array<{ layout?: string }>): boolean {
  for (const option of options) {
    if (option.layout !== "stacked") {
      return false;
    }
  }
  return true;
}

describe("useAgentAutocomplete", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockRuntime.client = mockClient;
    mockRuntime.isConnected = true;
  });

  it("filters /tree argument candidates locally, preserves provider order, and writes selected ids", async () => {
    mockClient.listCommands.mockResolvedValue({
      commands: [
        treeCommand([
          {
            id: "entry-b",
            label: "↳ user",
            description: "Branch question",
            metadata: {
              detail: "entry-b · d3 · from root",
              preserveOrder: true,
            },
          },
          {
            id: "entry-a",
            label: "● assistant",
            description: "Branch answer",
            metadata: {
              detail: "entry-a · d4 · current",
              preserveOrder: true,
            },
          },
          {
            id: "entry-c",
            label: "○ assistant",
            description: "Unrelated answer",
            metadata: {
              detail: "entry-c · d2",
              preserveOrder: true,
            },
          },
        ]),
      ],
    });
    const setUserInput = vi.fn();
    const onAutocompleteApplied = vi.fn();

    const { result, rerender } = renderAutocompleteHook({
      userInput: "/tree ",
      setUserInput,
      onAutocompleteApplied,
    });

    await waitFor(() => {
      expect(optionLabels(result.current.options)).toEqual([
        "↳ user",
        "● assistant",
        "○ assistant",
      ]);
    });

    rerender({ userInput: "/tree branch" });

    expect(optionLabels(result.current.options)).toEqual(["↳ user", "● assistant"]);
    expect(optionDetails(result.current.options)).toEqual([
      "entry-b · d3 · from root",
      "entry-a · d4 · current",
    ]);
    expect(allOptionsStacked(result.current.options)).toBe(true);

    act(() => {
      result.current.onSelectOption(result.current.options[0]!);
    });

    expect(setUserInput).toHaveBeenCalledWith("/tree entry-b");
    expect(onAutocompleteApplied).toHaveBeenCalledTimes(1);
  });

  it("does not refetch command lists while typing /tree argument filters", async () => {
    mockClient.listCommands.mockResolvedValue({
      commands: [
        treeCommand([
          {
            id: "answer-1",
            label: "● assistant",
            description: "First answer",
            metadata: { preserveOrder: true },
          },
          {
            id: "answer-2",
            label: "↳ user",
            description: "Second answer",
            metadata: { preserveOrder: true },
          },
        ]),
      ],
    });

    const { result, rerender } = renderAutocompleteHook({ userInput: "/tree " });

    await waitFor(() => {
      expect(result.current.options).toHaveLength(2);
    });
    expect(mockClient.listCommands).toHaveBeenCalledTimes(1);

    rerender({ userInput: "/tree a" });
    rerender({ userInput: "/tree an" });
    rerender({ userInput: "/tree ans" });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(optionIds(result.current.options)).toEqual(["tree:answer-1", "tree:answer-2"]);
    expect(mockClient.listCommands).toHaveBeenCalledTimes(1);
  });
});
