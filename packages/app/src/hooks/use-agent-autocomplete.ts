import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { AutocompleteOption } from "@/components/ui/autocomplete";
import {
  useAgentCommandsQuery,
  type AgentSlashCommand,
  type DraftCommandConfig,
} from "./use-agent-commands-query";
import { orderAutocompleteOptions } from "@/components/ui/autocomplete-utils";
import { useAutocomplete } from "./use-autocomplete";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { CLIENT_SLASH_COMMANDS, type ClientSlashCommand } from "@/client-slash-commands";
import {
  applyFileMentionReplacement,
  findActiveFileMention,
  type FileMentionRange,
} from "@/utils/file-mention-autocomplete";

interface UseAgentAutocompleteInput {
  userInput: string;
  cursorIndex: number;
  setUserInput: (nextValue: string) => void;
  serverId: string;
  agentId: string;
  draftConfig?: DraftCommandConfig;
  onAutocompleteApplied?: () => void;
  onClientSlashCommand?: (command: ClientSlashCommand) => void;
  canExecuteClientSlashCommand?: boolean;
}

type AgentAutocompleteOption =
  | (AutocompleteOption & { type: "client_command"; command: ClientSlashCommand })
  | (AutocompleteOption & { type: "provider_command" })
  | (AutocompleteOption & {
      type: "command_argument";
      commandName: string;
      argumentValue: string;
    })
  | (AutocompleteOption & {
      type: "workspace_entry";
      entryPath: string;
      mention: FileMentionRange;
    });

interface AgentAutocompleteResult {
  isVisible: boolean;
  options: AutocompleteOption[];
  selectedIndex: number;
  isLoading: boolean;
  errorMessage?: string;
  loadingText: string;
  emptyText: string;
  onSelectOption: (option: AutocompleteOption) => void;
  onKeyPress: (event: { key: string; preventDefault: () => void }) => boolean;
}

interface DirectorySuggestionEntry {
  path: string;
  kind: "file" | "directory";
}

type AvailableCommand =
  | { source: "client"; command: ClientSlashCommand }
  | { source: "provider"; command: AgentSlashCommand };

type SlashAutocompleteIntent =
  | { mode: "command"; query: string }
  | { mode: "command_argument"; commandName: string; query: string }
  | null;

function normalizeDraftCommandConfig(
  draftConfig?: DraftCommandConfig,
): DraftCommandConfig | undefined {
  if (!draftConfig) {
    return undefined;
  }

  const cwd = draftConfig.cwd.trim();
  if (!cwd) {
    return undefined;
  }

  const modeId = draftConfig.modeId?.trim() ?? "";
  const model = draftConfig.model?.trim() ?? "";
  const thinkingOptionId = draftConfig.thinkingOptionId?.trim() ?? "";
  const featureValues = draftConfig.featureValues;
  return {
    provider: draftConfig.provider,
    cwd,
    ...(modeId ? { modeId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(featureValues && Object.keys(featureValues).length > 0 ? { featureValues } : {}),
  };
}

function mapDirectorySuggestionsToEntries(payload: {
  entries?: Array<{ path: string; kind: string }>;
  directories?: string[];
}): DirectorySuggestionEntry[] {
  if (Array.isArray(payload.entries) && payload.entries.length > 0) {
    return payload.entries.flatMap((entry) => {
      if (
        !entry ||
        typeof entry.path !== "string" ||
        (entry.kind !== "file" && entry.kind !== "directory")
      ) {
        return [];
      }
      return [{ path: entry.path, kind: entry.kind }];
    });
  }

  return (payload.directories ?? []).map((path) => ({
    path,
    kind: "directory" as const,
  }));
}

function mapCommandToOption(entry: AvailableCommand): AgentAutocompleteOption {
  const command = entry.command;
  const base = {
    id: command.name,
    label: `/${command.name}`,
    detail: command.argumentHint || undefined,
    description: command.description,
    kind: "command" as const,
  };
  if (entry.source === "client") {
    return {
      ...base,
      type: "client_command",
      command: entry.command,
    };
  }
  return {
    ...base,
    type: "provider_command",
  };
}

function readStringMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readBooleanMetadata(value: unknown): boolean {
  return value === true;
}

function mapCommandMatchesToOptions(args: {
  commands: AgentSlashCommand[];
  commandFilterQuery: string;
  isDraftContext: boolean;
}): AgentAutocompleteOption[] {
  const filterLower = args.commandFilterQuery.toLowerCase();
  const providerCommands = args.commands.map(
    (command): AvailableCommand => ({ source: "provider", command }),
  );
  const availableCommands: AvailableCommand[] = args.isDraftContext
    ? providerCommands
    : [
        ...CLIENT_SLASH_COMMANDS.map(
          (command): AvailableCommand => ({ source: "client", command }),
        ),
        ...providerCommands,
      ];
  const matches = availableCommands.filter((entry) => {
    if (entry.source === "provider") {
      return entry.command.name.toLowerCase().includes(filterLower);
    }
    const candidates = [entry.command.name, ...entry.command.aliases];
    return candidates.some((candidate) => candidate.toLowerCase().includes(filterLower));
  });
  return orderAutocompleteOptions(matches).map(mapCommandToOption);
}

function mapCommandArgumentMatchesToOptions(args: {
  commands: AgentSlashCommand[];
  slashIntent: Extract<SlashAutocompleteIntent, { mode: "command_argument" }>;
}): AgentAutocompleteOption[] {
  const command = args.commands.find((entry) => entry.name === args.slashIntent.commandName);
  const argumentOptions = command?.argumentOptions ?? [];
  const filterLower = args.slashIntent.query.toLowerCase();
  const matches = argumentOptions.filter(
    (entry) =>
      entry.id.toLowerCase().includes(filterLower) ||
      entry.label.toLowerCase().includes(filterLower) ||
      (entry.description?.toLowerCase().includes(filterLower) ?? false),
  );
  const orderedMatches = matches.some((entry) => readBooleanMetadata(entry.metadata?.preserveOrder))
    ? matches
    : orderAutocompleteOptions(matches);
  return orderedMatches.map((entry) => ({
    type: "command_argument" as const,
    id: `${args.slashIntent.commandName}:${entry.id}`,
    label: entry.label,
    description: entry.description,
    detail: readStringMetadata(entry.metadata?.detail),
    kind: "command" as const,
    layout: "stacked" as const,
    commandName: args.slashIntent.commandName,
    argumentValue: entry.id,
  }));
}

function mapWorkspaceEntriesToOptions(
  entries: DirectorySuggestionEntry[],
  activeFileMention: FileMentionRange,
): AgentAutocompleteOption[] {
  return orderAutocompleteOptions(entries).map((entry) => ({
    type: "workspace_entry" as const,
    id: `${entry.kind}:${entry.path}`,
    label: entry.path,
    kind: entry.kind,
    entryPath: entry.path,
    mention: activeFileMention,
  }));
}

function parseSlashAutocompleteIntent(
  userInput: string,
  cursorIndex: number,
): SlashAutocompleteIntent {
  const beforeCursor = userInput.slice(0, cursorIndex);
  if (!beforeCursor.startsWith("/") || beforeCursor.includes("\n")) {
    return null;
  }
  const firstSpaceIndex = beforeCursor.indexOf(" ");
  if (firstSpaceIndex === -1) {
    return { mode: "command", query: beforeCursor.slice(1) };
  }
  const commandName = beforeCursor.slice(1, firstSpaceIndex).trim();
  if (!commandName) {
    return null;
  }
  return {
    mode: "command_argument",
    commandName,
    query: beforeCursor.slice(firstSpaceIndex + 1).trim(),
  };
}

type AutocompleteMode = "command" | "command_argument" | "file" | null;

function resolveAutocompleteMode(args: {
  showFileAutocomplete: boolean;
  slashIntent: SlashAutocompleteIntent;
}): AutocompleteMode {
  if (args.showFileAutocomplete) {
    return "file";
  }
  if (args.slashIntent) {
    return args.slashIntent.mode;
  }
  return null;
}

function resolveAutocompleteIsVisible(args: {
  mode: AutocompleteMode;
  canLoadCommands: boolean;
  serverId: string;
  autocompleteCwd: string;
}): boolean {
  if (args.mode === "command" || args.mode === "command_argument") {
    return args.canLoadCommands;
  }
  if (args.mode === "file") {
    return Boolean(args.serverId) && args.autocompleteCwd.length > 0;
  }
  return false;
}

function resolveAutocompleteIsLoading(args: {
  mode: AutocompleteMode;
  isCommandsLoading: boolean;
  fileSuggestionsIsPending: boolean;
  fileSuggestionsIsLoading: boolean;
  optionsLength: number;
}): boolean {
  if (args.mode === "command" || args.mode === "command_argument") {
    return args.isCommandsLoading;
  }
  if (args.mode === "file") {
    return (
      args.fileSuggestionsIsPending || (args.fileSuggestionsIsLoading && args.optionsLength === 0)
    );
  }
  return false;
}

function resolveAutocompleteErrorMessage(args: {
  mode: AutocompleteMode;
  isCommandError: boolean;
  commandError: Error | null;
  fileSuggestionsError: unknown;
}): string | undefined {
  if (args.mode === "command" || args.mode === "command_argument") {
    return args.isCommandError ? (args.commandError?.message ?? "Failed to load") : undefined;
  }
  if (args.mode === "file") {
    return args.fileSuggestionsError instanceof Error
      ? args.fileSuggestionsError.message
      : undefined;
  }
  return undefined;
}

function shouldShowAutocomplete(args: {
  baseIsVisible: boolean;
  mode: AutocompleteMode;
  isCommandsLoading: boolean;
  optionsLength: number;
}): boolean {
  if (!args.baseIsVisible) {
    return false;
  }
  return args.mode !== "command_argument" || args.isCommandsLoading || args.optionsLength > 0;
}

function resolveAutocompleteQuery(args: {
  mode: AutocompleteMode;
  commandFilterQuery: string;
  slashIntent: SlashAutocompleteIntent;
  fileFilterQuery: string;
}): string {
  if (args.mode === "command") {
    return args.commandFilterQuery;
  }
  if (args.mode === "command_argument" && args.slashIntent?.mode === "command_argument") {
    return args.slashIntent.query;
  }
  return args.fileFilterQuery;
}

function resolveAutocompleteEmptyText(mode: AutocompleteMode): string {
  if (mode === "file") {
    return "No files or directories found";
  }
  if (mode === "command_argument") {
    return "No matching arguments";
  }
  return "No commands found";
}

export function useAgentAutocomplete(input: UseAgentAutocompleteInput): AgentAutocompleteResult {
  const {
    userInput,
    cursorIndex,
    setUserInput,
    serverId,
    agentId,
    draftConfig,
    onAutocompleteApplied,
    onClientSlashCommand,
    canExecuteClientSlashCommand,
  } = input;

  const slashIntent = useMemo(
    () => parseSlashAutocompleteIntent(userInput, cursorIndex),
    [cursorIndex, userInput],
  );
  const commandFilterQuery = slashIntent?.mode === "command" ? slashIntent.query : "";

  const activeFileMention = useMemo(
    () =>
      findActiveFileMention({
        text: userInput,
        cursorIndex,
      }),
    [cursorIndex, userInput],
  );
  const showFileAutocomplete = activeFileMention !== null;
  const fileFilterQuery = activeFileMention?.query ?? "";
  const [debouncedFileFilterQuery, setDebouncedFileFilterQuery] = useState(fileFilterQuery);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFileFilterQuery(fileFilterQuery), 180);
    return () => clearTimeout(timer);
  }, [fileFilterQuery]);

  const normalizedDraftConfig = useMemo(
    () => normalizeDraftCommandConfig(draftConfig),
    [draftConfig],
  );

  const isDraftContext = normalizedDraftConfig !== undefined;
  const queryDraftConfig = isDraftContext ? normalizedDraftConfig : undefined;
  const canLoadCommands = Boolean(serverId) && (Boolean(agentId) || isDraftContext);

  const agentCwd = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.cwd ?? "",
  );
  const autocompleteCwd = useMemo(() => {
    if (isDraftContext) {
      return queryDraftConfig?.cwd ?? "";
    }
    return agentCwd.trim();
  }, [agentCwd, isDraftContext, queryDraftConfig]);

  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const mode = resolveAutocompleteMode({ showFileAutocomplete, slashIntent });
  const baseIsVisible = resolveAutocompleteIsVisible({
    mode,
    canLoadCommands,
    serverId,
    autocompleteCwd,
  });

  const {
    commands,
    isLoading: isCommandsLoading,
    isError,
    error,
  } = useAgentCommandsQuery({
    serverId,
    agentId,
    enabled: (mode === "command" || mode === "command_argument") && canLoadCommands,
    draftConfig: queryDraftConfig,
    staleTime: mode === "command_argument" ? 0 : undefined,
  });

  const fileSuggestionsQuery = useQuery({
    queryKey: [
      "directorySuggestions",
      serverId,
      autocompleteCwd,
      debouncedFileFilterQuery,
      true,
      true,
    ],
    queryFn: async (): Promise<DirectorySuggestionEntry[]> => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      const response = await client.getDirectorySuggestions({
        cwd: autocompleteCwd,
        query: debouncedFileFilterQuery,
        limit: 50,
        includeFiles: true,
        includeDirectories: true,
      });
      if (response.error) {
        throw new Error(response.error);
      }
      return mapDirectorySuggestionsToEntries(response);
    },
    enabled:
      mode === "file" &&
      Boolean(serverId) &&
      autocompleteCwd.length > 0 &&
      Boolean(client) &&
      isConnected,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const options = useMemo<AgentAutocompleteOption[]>(() => {
    if (!baseIsVisible) {
      return [];
    }

    if (mode === "command") {
      return mapCommandMatchesToOptions({ commands, commandFilterQuery, isDraftContext });
    }

    if (mode === "command_argument" && slashIntent?.mode === "command_argument") {
      return mapCommandArgumentMatchesToOptions({ commands, slashIntent });
    }

    if (mode === "file" && activeFileMention) {
      return mapWorkspaceEntriesToOptions(fileSuggestionsQuery.data ?? [], activeFileMention);
    }

    return [];
  }, [
    activeFileMention,
    commandFilterQuery,
    commands,
    fileSuggestionsQuery.data,
    baseIsVisible,
    isDraftContext,
    mode,
    slashIntent,
  ]);

  const isVisible = shouldShowAutocomplete({
    baseIsVisible,
    mode,
    isCommandsLoading,
    optionsLength: options.length,
  });

  const onSelectOption = useCallback(
    (option: AutocompleteOption) => {
      const selected = option as AgentAutocompleteOption;
      if (
        selected.type === "client_command" &&
        selected.command.execution === "immediate" &&
        canExecuteClientSlashCommand &&
        onClientSlashCommand
      ) {
        onClientSlashCommand(selected.command);
        return;
      }

      if (selected.type === "client_command" || selected.type === "provider_command") {
        setUserInput(`/${selected.id} `);
        onAutocompleteApplied?.();
        return;
      }

      if (selected.type === "command_argument") {
        setUserInput(`/${selected.commandName} ${selected.argumentValue} `);
        onAutocompleteApplied?.();
        return;
      }

      const nextInput = applyFileMentionReplacement({
        text: userInput,
        mention: selected.mention,
        relativePath: selected.entryPath,
      });
      setUserInput(nextInput);
      onAutocompleteApplied?.();
    },
    [
      canExecuteClientSlashCommand,
      onAutocompleteApplied,
      onClientSlashCommand,
      setUserInput,
      userInput,
    ],
  );

  const { selectedIndex, onKeyPress } = useAutocomplete({
    isVisible,
    options,
    query: resolveAutocompleteQuery({
      mode,
      commandFilterQuery,
      slashIntent,
      fileFilterQuery,
    }),
    onSelectOption,
    onEscape: mode === "command" ? () => setUserInput("") : undefined,
  });

  const isLoading = resolveAutocompleteIsLoading({
    mode,
    isCommandsLoading,
    fileSuggestionsIsPending: fileSuggestionsQuery.isPending,
    fileSuggestionsIsLoading: fileSuggestionsQuery.isLoading,
    optionsLength: options.length,
  });
  const errorMessage = resolveAutocompleteErrorMessage({
    mode,
    isCommandError: isError,
    commandError: error,
    fileSuggestionsError: fileSuggestionsQuery.error,
  });

  const loadingText = mode === "file" ? "Searching workspace..." : "Loading commands...";
  const emptyText = resolveAutocompleteEmptyText(mode);

  return {
    isVisible,
    options,
    selectedIndex,
    isLoading,
    errorMessage,
    loadingText,
    emptyText,
    onSelectOption,
    onKeyPress,
  };
}
