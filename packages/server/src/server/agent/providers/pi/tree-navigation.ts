import { readFileSync } from "node:fs";

import type {
  AgentPromptInput,
  AgentSlashCommand,
  AgentSlashCommandArgumentOption,
} from "../../agent-sdk-types.js";

export const PI_TREE_COMMAND_NAME = "tree";
export const PI_TREED_COMMAND_NAME = "treed";

const PI_TREE_COMMAND_LIST_LIMIT = 80;
const PI_TREE_COMMAND_ARGUMENT_LIMIT = 500;
const MAX_PI_TREE_LABEL_DEPTH = 6;
const PI_TREE_PREVIEW_LIMIT = 180;

interface PiTreeEntry {
  id: string;
  parentId: string | null;
  timestampMs: number | null;
  record: Record<string, unknown>;
}

interface PiTreeDisplayEntry {
  id: string;
  role: "user" | "assistant";
  preview: string;
  isCurrent: boolean;
  isOnCurrentBranch: boolean;
  isNonCurrentBranchEntry: boolean;
  depth: number;
  labelDepth: number;
  visibleParentId: string | null;
  timestampMs: number | null;
}

export interface PiTreeParsedCommand {
  targetId: string | null;
  trailingText: string | null;
}

export interface PiTreeNavigationFeedbackInput {
  targetId: string;
  beforeLeafId: string | null;
  afterLeafId: string | null;
  result: unknown;
  trailingText: string | null;
  target: PiTreeNavigationTarget | null;
}

export interface PiTreeNavigationTarget {
  role: "user" | "assistant";
  text: string | null;
  parentId: string | null;
}

const PI_TREE_SLASH_COMMAND: AgentSlashCommand = {
  name: PI_TREE_COMMAND_NAME,
  description:
    "Pick a Pi tree entry. Send /tree <entryId> to move the branch point; selecting an existing user prompt makes the next normal message a sibling branch.",
  argumentHint: "<entryId>",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringMember(record: unknown, keys: readonly string[]): string | null {
  if (!isRecord(record)) return null;
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) return value;
  }
  return null;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseDateMs(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

function getPiEntryId(entry: unknown): string | null {
  return readStringMember(entry, ["id", "entryId", "messageId", "nodeId"]);
}

function getPiEntryParentId(entry: unknown): string | null {
  return readStringMember(entry, ["parentId", "parent", "parentEntryId", "previousId", "prevId"]);
}

function readPiTreeEntries(sessionFile: string | undefined): PiTreeEntry[] {
  if (!sessionFile) return [];
  let content: string;
  try {
    content = readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }

  const entries: PiTreeEntry[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const record = parseJsonRecord(rawLine.trim());
    if (!record || record.type === "session") continue;
    const id = getPiEntryId(record);
    if (!id) continue;
    entries.push({
      id,
      parentId: getPiEntryParentId(record),
      timestampMs: parseDateMs(record.timestamp),
      record,
    });
  }
  return entries;
}

function getPiMessage(entry: PiTreeEntry): Record<string, unknown> | null {
  if (isRecord(entry.record.message)) {
    return entry.record.message;
  }
  return entry.record;
}

function getPiMessageRole(message: Record<string, unknown> | null): "user" | "assistant" | null {
  const role = readString(message?.role);
  return role === "user" || role === "assistant" ? role : null;
}

function extractPiUserText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n\n")
    .trim();
}

function extractPiAssistantVisibleText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      if (!isRecord(part)) return [];
      return part.type === "text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n\n")
    .trim();
}

function truncatePiPreview(text: string, limit: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function truncatePiFeedbackText(text: string): string {
  const normalized = text.trim();
  return normalized.length <= 2000 ? normalized : `${normalized.slice(0, 1999)}…`;
}

function formatPiFeedbackCodeBlock(text: string): string[] {
  const matches = text.match(/`+/gu) ?? [];
  const longestBacktickRun = matches.reduce((longest, match) => Math.max(longest, match.length), 0);
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [fence, text, fence];
}

function formatPiTreeMoveLine(input: PiTreeNavigationFeedbackInput): string | null {
  if (!input.beforeLeafId && !input.afterLeafId) {
    return null;
  }

  let moveLabel = "Pi moved";
  if (input.target?.role === "user") {
    moveLabel = "Pi moved to the selected user message's parent";
  } else if (input.target?.role === "assistant") {
    moveLabel = "Pi moved to the selected assistant entry";
  }

  const before = input.beforeLeafId ? `\`${input.beforeLeafId}\`` : "root";
  const after = input.afterLeafId ? `\`${input.afterLeafId}\`` : "root";
  return `${moveLabel}: ${before} → ${after}`;
}

function formatPiTreeNextMessageLine(input: PiTreeNavigationFeedbackInput): string {
  if (input.target?.role === "user") {
    const branchPoint = input.afterLeafId ? `\`${input.afterLeafId}\`` : "the root";
    return `Next message starts after parent ${branchPoint}, so Pi creates a new sibling branch next to the selected user message \`${input.targetId}\`. The selected message and its existing replies are unchanged.`;
  }
  if (input.target?.role === "assistant") {
    return "Next message will continue after this assistant response as a new child message.";
  }
  return "Tree navigation only changes the selected Pi branch point. The next normal message you send in Paseo continues from that branch point.";
}

function formatPiTreePendingSelectionLine(): string {
  return "Send the next normal message before reloading this agent; reload may resume Pi's persisted leaf and clear this pending tree selection.";
}

function extractPiTreeDisplayPreview(
  message: Record<string, unknown>,
  role: "user" | "assistant",
): string | null {
  const text =
    role === "assistant"
      ? extractPiAssistantVisibleText(message)
      : extractPiUserText(message.content);
  return text.length > 0 ? truncatePiPreview(text, PI_TREE_PREVIEW_LIMIT) : null;
}

function getDefaultLeafId(entries: readonly PiTreeEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry && entry.record.type !== "session_info") {
      return entry.id;
    }
  }
  return null;
}

export function getPiCurrentLeafId(
  sessionFile: string | undefined,
  currentLeafOverrideId?: string | null,
): string | null {
  return currentLeafOverrideId !== undefined
    ? currentLeafOverrideId
    : getDefaultLeafId(readPiTreeEntries(sessionFile));
}

function getCurrentBranchEntryIds(
  entries: readonly PiTreeEntry[],
  currentLeafId: string | null,
): Set<string> {
  const parentById = new Map(entries.map((entry) => [entry.id, entry.parentId] as const));
  const branchIds = new Set<string>();
  let current = currentLeafId;
  for (let guard = 0; current && guard < entries.length + 1; guard += 1) {
    branchIds.add(current);
    current = parentById.get(current) ?? null;
  }
  return branchIds;
}

function mapPiTreeDisplayEntry(
  entry: PiTreeEntry,
  currentLeafId: string | null,
  currentBranchIds: ReadonlySet<string>,
): PiTreeDisplayEntry | null {
  const message = getPiMessage(entry);
  const role = getPiMessageRole(message);
  if (!message || !role) return null;
  const preview = extractPiTreeDisplayPreview(message, role);
  if (!preview) return null;
  return {
    id: entry.id,
    role,
    preview,
    isCurrent: entry.id === currentLeafId,
    isOnCurrentBranch: currentBranchIds.has(entry.id),
    isNonCurrentBranchEntry: false,
    depth: 0,
    labelDepth: 0,
    visibleParentId: null,
    timestampMs: entry.timestampMs,
  };
}

function findPiVisibleParentId(
  id: string,
  parentById: ReadonlyMap<string, string | null>,
  displayById: ReadonlyMap<string, PiTreeDisplayEntry>,
): string | null {
  let parentId = parentById.get(id) ?? null;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    if (displayById.has(parentId)) {
      return parentId;
    }
    seen.add(parentId);
    parentId = parentById.get(parentId) ?? null;
  }
  return null;
}

function orderPiTreeChildIds(ids: readonly string[], currentBranchIds: ReadonlySet<string>) {
  return [...ids].sort((left, right) => {
    const leftCurrent = currentBranchIds.has(left);
    const rightCurrent = currentBranchIds.has(right);
    if (leftCurrent === rightCurrent) return 0;
    return leftCurrent ? -1 : 1;
  });
}

function isPiNonCurrentBranchEntry(args: {
  id: string;
  visibleParentId: string | null;
  displayById: ReadonlyMap<string, PiTreeDisplayEntry>;
  childrenByVisibleParent: ReadonlyMap<string | null, readonly string[]>;
}): boolean {
  const entry = args.displayById.get(args.id);
  if (!entry || entry.isOnCurrentBranch) {
    return false;
  }
  if (args.visibleParentId === null) {
    return true;
  }
  const parent = args.displayById.get(args.visibleParentId);
  if (parent?.isOnCurrentBranch) {
    return true;
  }
  const siblings = args.childrenByVisibleParent.get(args.visibleParentId) ?? [];
  return siblings.length > 1;
}

function listPiTreeDisplayEntries(
  sessionFile: string | undefined,
  currentLeafOverrideId?: string | null,
): PiTreeDisplayEntry[] {
  const entries = readPiTreeEntries(sessionFile);
  const leafId =
    currentLeafOverrideId !== undefined ? currentLeafOverrideId : getDefaultLeafId(entries);
  const currentBranchIds = getCurrentBranchEntryIds(entries, leafId);
  const parentById = new Map(entries.map((entry) => [entry.id, entry.parentId] as const));
  const displayById = new Map<string, PiTreeDisplayEntry>();

  for (const entry of entries) {
    const display = mapPiTreeDisplayEntry(entry, leafId, currentBranchIds);
    if (display) {
      displayById.set(entry.id, display);
    }
  }

  const childrenByVisibleParent = new Map<string | null, string[]>();
  for (const id of displayById.keys()) {
    const normalizedParentId = findPiVisibleParentId(id, parentById, displayById);
    const siblings = childrenByVisibleParent.get(normalizedParentId) ?? [];
    siblings.push(id);
    childrenByVisibleParent.set(normalizedParentId, siblings);
  }

  for (const [parentId, childIds] of childrenByVisibleParent) {
    childrenByVisibleParent.set(parentId, orderPiTreeChildIds(childIds, currentBranchIds));
  }

  const displayEntries: PiTreeDisplayEntry[] = [];
  const visit = (
    id: string,
    depth: number,
    labelDepth: number,
    visibleParentId: string | null,
    seen: Set<string>,
  ): void => {
    if (seen.has(id)) return;
    seen.add(id);

    const baseDisplay = displayById.get(id);
    if (!baseDisplay) return;
    const display = {
      ...baseDisplay,
      depth,
      labelDepth,
      visibleParentId,
      isNonCurrentBranchEntry: isPiNonCurrentBranchEntry({
        id,
        visibleParentId,
        displayById,
        childrenByVisibleParent,
      }),
    };
    displayEntries.push(display);

    const childIds = childrenByVisibleParent.get(id) ?? [];
    const childLabelDepth = childIds.length > 1 ? labelDepth + 1 : labelDepth;
    for (const childId of childIds) {
      visit(childId, depth + 1, childLabelDepth, id, seen);
    }
  };

  const seen = new Set<string>();
  for (const rootId of childrenByVisibleParent.get(null) ?? []) {
    visit(rootId, 0, 0, null, seen);
  }
  for (const id of displayById.keys()) {
    visit(id, 0, 0, null, seen);
  }

  return displayEntries;
}

function formatPiTreeShortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatPiTreeShortTime(timestampMs: number | null): string | null {
  if (timestampMs === null) {
    return null;
  }
  const date = new Date(timestampMs);
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  const hoursMinutes = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === now.toDateString()
    ? hoursMinutes
    : `${date.getMonth() + 1}-${date.getDate()} ${hoursMinutes}`;
}

function formatPiTreeArgumentDetail(entry: PiTreeDisplayEntry): string {
  const parts = [formatPiTreeShortId(entry.id), `d${entry.depth}`];
  const shortTime = formatPiTreeShortTime(entry.timestampMs);
  if (shortTime) {
    parts.push(shortTime);
  }
  if (entry.isNonCurrentBranchEntry && entry.visibleParentId) {
    parts.push(`from ${formatPiTreeShortId(entry.visibleParentId)}`);
  }
  if (entry.isCurrent) {
    parts.push("current");
  } else if (entry.isOnCurrentBranch) {
    parts.push("current path");
  }
  return parts.join(" · ");
}

function formatPiTreeEntryLabel(entry: PiTreeDisplayEntry): string {
  const depthTrack = "┊".repeat(Math.min(entry.labelDepth, MAX_PI_TREE_LABEL_DEPTH));
  let marker = "○";
  if (entry.isCurrent) {
    marker = "●";
  } else if (entry.isOnCurrentBranch) {
    marker = "•";
  } else if (entry.isNonCurrentBranchEntry) {
    marker = "↳";
  }
  return `${depthTrack}${marker} ${entry.role}`;
}

function mapPiTreeEntryToArgumentOption(
  entry: PiTreeDisplayEntry,
): AgentSlashCommandArgumentOption {
  return {
    id: entry.id,
    label: formatPiTreeEntryLabel(entry),
    description: entry.preview,
    metadata: {
      detail: formatPiTreeArgumentDetail(entry),
      role: entry.role,
      current: entry.isCurrent,
      currentBranch: entry.isOnCurrentBranch,
      branchEntry: entry.isNonCurrentBranchEntry,
      preserveOrder: true,
    },
  };
}

function formatPiTreeEntryPreview(entry: PiTreeDisplayEntry): string {
  return `${formatPiTreeEntryLabel(entry)}: ${entry.preview} (\`${entry.id}\`)`;
}

export function buildPiTreeSlashCommand(
  sessionFile: string | undefined,
  currentLeafOverrideId?: string | null,
): AgentSlashCommand {
  return {
    ...PI_TREE_SLASH_COMMAND,
    argumentOptions: listPiTreeDisplayEntries(sessionFile, currentLeafOverrideId)
      .slice(0, PI_TREE_COMMAND_ARGUMENT_LIMIT)
      .map(mapPiTreeEntryToArgumentOption),
  };
}

export function formatPiTreeListing(
  sessionFile: string | undefined,
  currentLeafOverrideId?: string | null,
): string {
  const leafId = getPiCurrentLeafId(sessionFile, currentLeafOverrideId);
  const rows = listPiTreeDisplayEntries(sessionFile, currentLeafOverrideId)
    .map((entry) => formatPiTreeEntryPreview(entry))
    .slice(0, PI_TREE_COMMAND_LIST_LIMIT);
  if (rows.length === 0) {
    return "Pi session tree has no selectable entries yet.";
  }
  return [
    "Pi session tree entries:",
    leafId ? `Current leaf: \`${leafId}\`` : null,
    "Use `/tree <entryId>` to navigate. The next message you send in Paseo continues from the selected Pi branch point.",
    "",
    ...rows,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function resolvePiNavigationLeafId(
  sessionFile: string | undefined,
  targetId: string,
): string | null {
  const entries = readPiTreeEntries(sessionFile);
  const entry = entries.find((candidate) => candidate.id === targetId);
  if (!entry) {
    return targetId;
  }
  const message = getPiMessage(entry);
  const role = getPiMessageRole(message);
  return role === "user" ? entry.parentId : targetId;
}

export function getPiNavigationTarget(
  sessionFile: string | undefined,
  targetId: string,
): PiTreeNavigationTarget | null {
  const entry = readPiTreeEntries(sessionFile).find((candidate) => candidate.id === targetId);
  if (!entry) {
    return null;
  }
  const message = getPiMessage(entry);
  const role = getPiMessageRole(message);
  if (!message || !role) {
    return null;
  }
  const text =
    role === "user" ? extractPiUserText(message.content) : extractPiAssistantVisibleText(message);
  return {
    role,
    text: text.length > 0 ? truncatePiFeedbackText(text) : null,
    parentId: entry.parentId,
  };
}

function parsePiSlashCommand(prompt: AgentPromptInput): { name: string; args: string } | null {
  const text = typeof prompt === "string" ? prompt : null;
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIndex = trimmed.search(/\s/u);
  const name = spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
  if (!name) return null;
  return {
    name,
    args: spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim(),
  };
}

export function parsePiTreeCommand(prompt: AgentPromptInput): PiTreeParsedCommand | null {
  const parsed = parsePiSlashCommand(prompt);
  if (!parsed || parsed.name !== PI_TREE_COMMAND_NAME) return null;
  const args = parsed.args.trim();
  if (!args) return { targetId: null, trailingText: null };
  const separatorIndex = args.search(/\s/u);
  if (separatorIndex === -1) {
    return { targetId: args, trailingText: null };
  }
  return {
    targetId: args.slice(0, separatorIndex),
    trailingText: args.slice(separatorIndex + 1).trim() || null,
  };
}

export function parsePiTreedCommand(prompt: AgentPromptInput): boolean {
  return parsePiSlashCommand(prompt)?.name === PI_TREED_COMMAND_NAME;
}

function extractPiNavigationText(result: unknown): string | null {
  if (typeof result === "string") return readString(result);
  if (!isRecord(result)) return null;
  return readStringMember(result, ["editorText", "prompt", "text", "input", "userMessage"]);
}

function extractPiNavigationSummary(result: unknown): string | null {
  if (!isRecord(result)) return null;
  return (
    readStringMember(result, ["summary", "branchSummary", "message"]) ??
    readStringMember(result.summaryEntry, ["summary"])
  );
}

export function formatPiTreeNavigationFeedback(input: PiTreeNavigationFeedbackInput): string {
  const roleSuffix = input.target?.role ? ` (${input.target.role})` : "";
  const lines = ["", "", `Selected Pi tree entry \`${input.targetId}\`${roleSuffix}.`];
  const moveLine = formatPiTreeMoveLine(input);
  if (moveLine) {
    lines.push(moveLine);
  }
  const summary = extractPiNavigationSummary(input.result);
  if (summary) {
    lines.push("", summary);
  }
  if (input.target?.role === "user" && input.target.text) {
    lines.push("", "Selected user message:", ...formatPiFeedbackCodeBlock(input.target.text));
  }
  const editorText = extractPiNavigationText(input.result);
  if (editorText && editorText !== input.target?.text) {
    lines.push("", "Editor draft returned by Pi:", ...formatPiFeedbackCodeBlock(editorText));
  }
  if (input.trailingText) {
    lines.push(
      "",
      "Extra text after the entry id was not sent:",
      ...formatPiFeedbackCodeBlock(input.trailingText),
    );
  }
  lines.push("", formatPiTreeNextMessageLine(input));
  lines.push(formatPiTreePendingSelectionLine());
  lines.push("", "This notice is local to Paseo and is not written into the Pi session.");
  return lines.join("\n");
}
