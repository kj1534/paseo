import type { Logger } from "pino";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { SessionOutboundMessage } from "./messages.js";
import { archivePaseoWorktree, killTerminalsUnderPath } from "./paseo-worktree-archive-service.js";
import { isSameOrDescendantPath } from "./path-utils.js";
import type { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import type { GitHubService } from "../services/github-service.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { isPaseoOwnedWorktreeCwd } from "../utils/worktree.js";

export interface AutoArchiveOnMergeOptions {
  paseoHome: string;
  daemonConfigStore: DaemonConfigStore;
  workspaceGitService: WorkspaceGitServiceImpl;
  github: GitHubService;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  logger: Logger;
  archiveWorkspaceRecord: (workspaceId: string) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
  emitSessionMessage: (message: SessionOutboundMessage) => void;
}

export function setupAutoArchiveOnMerge(options: AutoArchiveOnMergeOptions): void {
  const log = options.logger.child({ module: "auto-archive-on-merge" });
  const inFlight = new Set<string>();

  options.workspaceGitService.setPullRequestStatusListener(({ cwd, status }) => {
    if (!status?.isMerged) {
      return;
    }
    if (options.daemonConfigStore.get().autoArchiveAfterMerge !== true) {
      return;
    }
    if (inFlight.has(cwd)) {
      return;
    }
    inFlight.add(cwd);
    void archiveIfSafe(cwd, options, log).finally(() => {
      inFlight.delete(cwd);
    });
  });
}

async function archiveIfSafe(
  cwd: string,
  options: AutoArchiveOnMergeOptions,
  log: Logger,
): Promise<void> {
  let snapshot: Awaited<ReturnType<typeof options.workspaceGitService.getSnapshot>>;
  try {
    snapshot = await options.workspaceGitService.getSnapshot(cwd, {
      reason: "auto-archive-on-merge",
    });
  } catch (error) {
    log.warn({ err: error, cwd }, "Failed to read snapshot for auto-archive; skipping");
    return;
  }
  if (!snapshot) {
    return;
  }

  if (snapshot.git.isDirty === true || (snapshot.git.aheadOfOrigin ?? 0) > 0) {
    return;
  }

  const ownership = await isPaseoOwnedWorktreeCwd(cwd, { paseoHome: options.paseoHome });
  if (!ownership.allowed) {
    return;
  }

  try {
    await archivePaseoWorktree(
      {
        paseoHome: options.paseoHome,
        github: options.github,
        workspaceGitService: options.workspaceGitService,
        agentManager: options.agentManager,
        agentStorage: options.agentStorage,
        archiveWorkspaceRecord: options.archiveWorkspaceRecord,
        emit: options.emitSessionMessage,
        emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
        markWorkspaceArchiving: options.markWorkspaceArchiving,
        clearWorkspaceArchiving: options.clearWorkspaceArchiving,
        isPathWithinRoot: isSameOrDescendantPath,
        killTerminalsUnderPath: (rootPath) =>
          killTerminalsUnderPath(
            {
              terminalManager: options.terminalManager,
              isPathWithinRoot: isSameOrDescendantPath,
              killTrackedTerminal: () => {},
              sessionLogger: log,
            },
            rootPath,
          ),
        sessionLogger: log,
      },
      {
        targetPath: cwd,
        repoRoot: ownership.repoRoot ?? null,
        worktreesRoot: ownership.worktreeRoot,
        requestId: "auto-archive-on-merge",
      },
    );
    log.info({ cwd }, "Auto-archived worktree after PR merge");
  } catch (error) {
    log.warn({ err: error, cwd }, "Auto-archive after merge failed");
  }
}
