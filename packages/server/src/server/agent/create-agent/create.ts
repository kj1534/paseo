import type { Logger } from "pino";

import { PARENT_AGENT_ID_LABEL } from "../../../shared/agent-labels.js";
import type { TerminalManager } from "../../../terminal/terminal-manager.js";
import type { CreatePaseoWorktreeInput } from "../../paseo-worktree-service.js";
import { expandUserPath, resolvePathFromBase } from "../../path-utils.js";
import { toWorktreeRequestError } from "../../worktree-errors.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type {
  AgentWorktreeSetupContinuation,
  CreatePaseoWorktreeSetupContinuationInput,
  CreatePaseoWorktreeWorkflowFn,
  CreatePaseoWorktreeWorkflowResult,
} from "../../worktree-session.js";
import type { AgentAttachment, FirstAgentContext, GitSetupOptions } from "../../messages.js";
import type { AgentManager, ManagedAgent } from "../agent-manager.js";
import { scheduleAgentMetadataGeneration } from "../agent-metadata-generator.js";
import type {
  AgentProvider,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentRunOptions,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import type { AgentStorage } from "../agent-storage.js";
import { getAgentProviderDefinition } from "../provider-manifest.js";
import type { ProviderDefinition } from "../provider-registry.js";
import { sendPromptToAgent, setupFinishNotification } from "../agent-prompt.js";
import { resolveAndValidateCreateAgentMode } from "../create-agent-mode.js";
import { resolveCreateAgentTitles } from "../create-agent-title.js";
import { resolveRequiredProviderModel } from "../mcp-shared.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "../timeline-append.js";

export interface CreateAgentWorkspace {
  workspaceId: string;
}

export interface CreateAgentSessionWorktreeResult {
  sessionConfig: AgentSessionConfig;
  setupContinuation?: AgentWorktreeSetupContinuation;
}

interface CreateAgentCommandDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  paseoHome?: string;
  workspaceGitService?: Pick<
    WorkspaceGitService,
    "getSnapshot" | "listWorktrees" | "resolveRepoRoot"
  >;
  terminalManager?: TerminalManager | null;
  providerRegistry?: Record<AgentProvider, ProviderDefinition> | null;
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
}

export interface CreateAgentFromSessionInput {
  kind: "session";
  config: AgentSessionConfig;
  workspaceId?: string;
  worktreeName?: string;
  initialPrompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
  git?: GitSetupOptions;
  labels: Record<string, string>;
  buildSessionConfig: (
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    firstAgentContext?: FirstAgentContext,
  ) => Promise<CreateAgentSessionWorktreeResult>;
  resolveWorkspace: (input: { cwd: string; workspaceId?: string }) => Promise<CreateAgentWorkspace>;
}

export interface CreateAgentFromMcpInput {
  kind: "mcp";
  provider: string;
  title: string;
  initialPrompt: string;
  cwd?: string;
  thinking?: string;
  labels?: Record<string, string>;
  mode?: string;
  background: boolean;
  notifyOnFinish: boolean;
  callerAgentId?: string;
  callerContext?: {
    lockedCwd?: string;
    allowCustomCwd?: boolean;
    childAgentDefaultLabels?: Record<string, string>;
  } | null;
  worktree?: {
    worktreeName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

export type CreateAgentCommandInput = CreateAgentFromSessionInput | CreateAgentFromMcpInput;

export interface CreateAgentCommandResult {
  snapshot: ManagedAgent;
  background: boolean;
  initialPromptStarted: boolean;
}

interface ResolvedCreateAgent {
  config: AgentSessionConfig;
  createOptions?: AgentCreateOptions;
  metadataInitialPrompt?: string;
  initialPromptText?: string;
  prompt?: AgentPromptInput;
  messageId?: string;
  runOptions?: AgentRunOptions;
  explicitTitle: string | null;
  setupContinuation?: AgentWorktreeSetupContinuation;
  background: boolean;
  promptFailure: "throw" | "log";
}

interface AgentCreateOptions {
  labels?: Record<string, string>;
  workspaceId?: string;
  initialPrompt?: string;
}

export async function createAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
): Promise<CreateAgentCommandResult> {
  const resolved =
    input.kind === "session"
      ? await resolveSessionCreateAgent(dependencies, input)
      : await resolveMcpCreateAgent(dependencies, input);

  const snapshot = await dependencies.agentManager.createAgent(
    resolved.config,
    undefined,
    resolved.createOptions,
  );

  resolved.setupContinuation?.startAfterAgentCreate({
    agentId: snapshot.id,
  });

  let initialPromptStarted = false;
  if (resolved.prompt && resolved.initialPromptText !== undefined) {
    initialPromptStarted = await sendInitialPrompt(dependencies, resolved, snapshot);
  }

  if (input.kind === "mcp" && input.notifyOnFinish && input.callerAgentId && initialPromptStarted) {
    setupFinishNotification({
      agentManager: dependencies.agentManager,
      agentStorage: dependencies.agentStorage,
      childAgentId: snapshot.id,
      callerAgentId: input.callerAgentId,
      logger: dependencies.logger,
    });
  }

  return {
    snapshot,
    background: resolved.background,
    initialPromptStarted,
  };
}

async function resolveSessionCreateAgent(
  _dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
): Promise<ResolvedCreateAgent> {
  const trimmedPrompt = input.initialPrompt?.trim();
  const { explicitTitle, provisionalTitle } = resolveCreateAgentTitles({
    configTitle: input.config.title,
    initialPrompt: trimmedPrompt,
  });
  const resolvedConfig: AgentSessionConfig = {
    ...input.config,
    ...(provisionalTitle ? { title: provisionalTitle } : {}),
  };
  const firstAgentContext: FirstAgentContext = {
    ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
  };
  const { sessionConfig, setupContinuation } = await input.buildSessionConfig(
    resolvedConfig,
    input.git,
    input.worktreeName,
    firstAgentContext,
  );
  const workspace = await input.resolveWorkspace({
    cwd: sessionConfig.cwd,
    workspaceId: input.workspaceId,
  });
  const prompt = buildAgentPrompt(trimmedPrompt ?? "", input.images, input.attachments);
  const hasPromptContent = Array.isArray(prompt) ? prompt.length > 0 : prompt.length > 0;

  return {
    config: sessionConfig,
    createOptions: {
      labels: input.labels,
      workspaceId: workspace.workspaceId,
      initialPrompt: trimmedPrompt,
    },
    metadataInitialPrompt: trimmedPrompt,
    initialPromptText: hasPromptContent ? (trimmedPrompt ?? "") : undefined,
    prompt: hasPromptContent ? prompt : undefined,
    messageId: input.clientMessageId,
    runOptions: input.outputSchema ? { outputSchema: input.outputSchema } : undefined,
    explicitTitle,
    setupContinuation,
    background: true,
    promptFailure: "throw",
  };
}

async function resolveMcpCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
): Promise<ResolvedCreateAgent> {
  const resolvedProviderModel = resolveRequiredProviderModel(input.provider);
  const provider = resolvedProviderModel.provider;
  const parentAgent = input.callerAgentId
    ? requireParentAgent(dependencies.agentManager, input.callerAgentId)
    : null;
  const cwd = parentAgent
    ? resolveChildAgentCwd({
        parentCwd: parentAgent.cwd,
        requestedCwd: input.cwd,
        lockedCwd: input.callerContext?.lockedCwd,
        allowCustomCwd: input.callerContext?.allowCustomCwd ?? true,
      })
    : expandUserPath(input.cwd ?? process.cwd());
  const { resolvedCwd, setupContinuation } = await resolveMcpCwd({
    dependencies,
    cwd,
    worktree: input.worktree,
    initialPrompt: input.initialPrompt,
  });
  const resolvedMode = resolveAndValidateCreateAgentMode({
    requestedMode: input.mode,
    targetProvider: provider,
    parent: parentAgent
      ? {
          provider: parentAgent.provider,
          modeId: parentAgent.currentModeId,
          isUnattended: isParentInUnattendedMode(
            dependencies,
            parentAgent.provider,
            parentAgent.currentModeId,
          ),
        }
      : null,
    availableModes: getAvailableModeIds(dependencies, provider),
    targetUnattendedMode: getUnattendedModeId(dependencies, provider),
  });
  const labels = mergeLabels(
    input.callerAgentId,
    input.callerContext?.childAgentDefaultLabels,
    input.labels,
  );

  return {
    config: {
      provider,
      cwd: resolvedCwd,
      modeId: resolvedMode,
      title: input.title.trim(),
      model: resolvedProviderModel.model,
      thinkingOptionId: input.thinking,
    },
    createOptions: labels ? { labels } : undefined,
    metadataInitialPrompt: input.initialPrompt.trim(),
    initialPromptText: input.initialPrompt.trim(),
    prompt: input.initialPrompt.trim(),
    explicitTitle: input.title.trim(),
    setupContinuation,
    background: input.background,
    promptFailure: "log",
  };
}

async function sendInitialPrompt(
  dependencies: CreateAgentCommandDependencies,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
): Promise<boolean> {
  scheduleAgentMetadataGeneration({
    agentManager: dependencies.agentManager,
    agentId: snapshot.id,
    cwd: snapshot.cwd,
    workspaceGitService: dependencies.workspaceGitService,
    initialPrompt: resolved.metadataInitialPrompt,
    explicitTitle: resolved.explicitTitle,
    paseoHome: dependencies.paseoHome,
    logger: dependencies.logger,
  });

  try {
    const prompt = resolved.prompt;
    if (!prompt) {
      return false;
    }
    await sendPromptToAgent({
      agentManager: dependencies.agentManager,
      agentStorage: dependencies.agentStorage,
      agentId: snapshot.id,
      userMessageText: resolved.initialPromptText,
      prompt,
      messageId: resolved.messageId,
      runOptions: resolved.runOptions,
      logger: dependencies.logger,
    });
    return true;
  } catch (error) {
    if (resolved.promptFailure === "throw") {
      throw error;
    }
    dependencies.logger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
    return false;
  }
}

function buildAgentPrompt(
  text: string,
  images?: Array<{ data: string; mimeType: string }>,
  attachments?: AgentAttachment[],
): AgentPromptInput {
  const normalized = text.trim();
  const hasImages = (images?.length ?? 0) > 0;
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!hasImages && !hasAttachments) {
    return normalized;
  }
  const blocks: AgentPromptContentBlock[] = [];
  if (normalized.length > 0) {
    blocks.push({ type: "text", text: normalized });
  }
  for (const image of images ?? []) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  for (const attachment of attachments ?? []) {
    blocks.push(attachment);
  }
  return blocks;
}

function requireParentAgent(agentManager: AgentManager, parentAgentId: string): ManagedAgent {
  const parentAgent = agentManager.getAgent(parentAgentId);
  if (!parentAgent) {
    throw new Error(`Parent agent ${parentAgentId} not found`);
  }
  return parentAgent;
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

async function resolveMcpCwd(params: {
  dependencies: CreateAgentCommandDependencies;
  cwd: string;
  initialPrompt: string;
  worktree: CreateAgentFromMcpInput["worktree"];
}): Promise<{ resolvedCwd: string; setupContinuation?: AgentWorktreeSetupContinuation }> {
  const { dependencies, worktree } = params;
  if (!worktree) {
    return { resolvedCwd: params.cwd };
  }
  const shouldCreateWorktree = Boolean(
    worktree.worktreeName || worktree.refName || worktree.action || worktree.githubPrNumber,
  );
  if (!shouldCreateWorktree) {
    return { resolvedCwd: params.cwd };
  }
  if (
    worktree.worktreeName &&
    !worktree.baseBranch &&
    !worktree.refName &&
    !worktree.action &&
    worktree.githubPrNumber === undefined
  ) {
    throw new Error("baseBranch is required when creating a worktree");
  }
  const baseBranch = worktree.baseBranch;
  const createdWorktree = await createMcpWorktree({
    input: {
      cwd: params.cwd,
      worktreeSlug: worktree.worktreeName,
      refName: worktree.refName,
      action: worktree.action,
      githubPrNumber: worktree.githubPrNumber,
      ...(params.initialPrompt ? { firstAgentContext: { prompt: params.initialPrompt } } : {}),
      runSetup: false,
      paseoHome: dependencies.paseoHome,
    },
    createPaseoWorktree: dependencies.createPaseoWorktree,
    resolveDefaultBranch: baseBranch ? async () => baseBranch : undefined,
    setupContinuation: {
      kind: "agent",
      terminalManager: dependencies.terminalManager ?? null,
      appendTimelineItem: ({ agentId, item }) =>
        appendTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      emitLiveTimelineItem: ({ agentId, item }) =>
        emitLiveTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      logger: dependencies.logger,
    },
  });
  return {
    resolvedCwd: createdWorktree.worktree.worktreePath,
    setupContinuation: createdWorktree.setupContinuation,
  };
}

interface CreateMcpWorktreeOptions {
  input: CreatePaseoWorktreeInput;
  createPaseoWorktree: CreatePaseoWorktreeWorkflowFn | undefined;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  setupContinuation?: CreatePaseoWorktreeSetupContinuationInput;
}

async function createMcpWorktree(
  options: CreateMcpWorktreeOptions,
): Promise<CreatePaseoWorktreeWorkflowResult> {
  try {
    if (!options.createPaseoWorktree) {
      throw new Error("Paseo worktree service is not configured");
    }
    return await options.createPaseoWorktree(options.input, {
      ...(options.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      ...(options.setupContinuation ? { setupContinuation: options.setupContinuation } : {}),
    });
  } catch (error) {
    throw toWorktreeRequestError(error);
  }
}

function mergeLabels(
  callerAgentId: string | undefined,
  childAgentDefaultLabels: Record<string, string> | undefined,
  labels: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const mergedLabels = {
    ...(callerAgentId ? { [PARENT_AGENT_ID_LABEL]: callerAgentId } : {}),
    ...childAgentDefaultLabels,
    ...labels,
  };
  return Object.keys(mergedLabels).length > 0 ? mergedLabels : undefined;
}

function getProviderModes(
  dependencies: CreateAgentCommandDependencies,
  provider: AgentProvider,
): ProviderDefinition["modes"] | undefined {
  const fromRegistry = dependencies.providerRegistry?.[provider];
  if (fromRegistry) {
    return fromRegistry.modes;
  }
  try {
    return getAgentProviderDefinition(provider).modes;
  } catch {
    return undefined;
  }
}

function getAvailableModeIds(
  dependencies: CreateAgentCommandDependencies,
  provider: AgentProvider,
): string[] | undefined {
  return getProviderModes(dependencies, provider)?.map((mode) => mode.id);
}

function getUnattendedModeId(
  dependencies: CreateAgentCommandDependencies,
  provider: AgentProvider,
): string | undefined {
  return getProviderModes(dependencies, provider)?.find((mode) => mode.isUnattended)?.id;
}

function isParentInUnattendedMode(
  dependencies: CreateAgentCommandDependencies,
  provider: AgentProvider,
  modeId: string | null,
): boolean {
  if (modeId === null) {
    return false;
  }
  const modes = getProviderModes(dependencies, provider);
  if (!modes) {
    return false;
  }
  return modes.some((mode) => mode.id === modeId && mode.isUnattended === true);
}
