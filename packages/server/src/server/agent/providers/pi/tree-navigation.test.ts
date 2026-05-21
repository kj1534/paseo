import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  buildPiTreeSlashCommand,
  formatPiTreeListing,
  formatPiTreeNavigationFeedback,
  parsePiTreeCommand,
  resolvePiNavigationLeafId,
} from "./tree-navigation.js";

function writeSession(entries: unknown[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-pi-tree-"));
  const sessionFile = path.join(root, "session.jsonl");
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8",
  );
  return sessionFile;
}

function session(): unknown {
  return {
    type: "session",
    id: "session-1",
    cwd: "/repo",
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function message(input: {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  timestamp: string;
}): unknown {
  return {
    type: "message",
    id: input.id,
    parentId: input.parentId,
    timestamp: input.timestamp,
    message: {
      role: input.role,
      content: input.content,
    },
  };
}

describe("Pi tree navigation display", () => {
  test("uses branch-track labels, current markers, side branch markers, and provider order", () => {
    const sessionFile = writeSession([
      session(),
      message({
        id: "u0",
        parentId: null,
        role: "user",
        content: "Start",
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
      message({
        id: "a1",
        parentId: "u0",
        role: "assistant",
        content: [{ type: "text", text: "Ready" }],
        timestamp: "2026-01-01T00:00:02.000Z",
      }),
      message({
        id: "old-user",
        parentId: "a1",
        role: "user",
        content: "Old side question",
        timestamp: "2026-01-01T00:00:03.000Z",
      }),
      message({
        id: "old-assistant",
        parentId: "old-user",
        role: "assistant",
        content: [{ type: "text", text: "Old side answer" }],
        timestamp: "2026-01-01T00:00:04.000Z",
      }),
      message({
        id: "hidden-tool",
        parentId: "old-assistant",
        role: "toolResult",
        content: "tool output",
        timestamp: "2026-01-01T00:00:04.100Z",
      }),
      message({
        id: "thinking-only",
        parentId: "old-assistant",
        role: "assistant",
        content: [{ type: "thinking", thinking: "private" }],
        timestamp: "2026-01-01T00:00:04.200Z",
      }),
      message({
        id: "tool-call-only",
        parentId: "old-assistant",
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        timestamp: "2026-01-01T00:00:04.300Z",
      }),
      message({
        id: "cur-user",
        parentId: "a1",
        role: "user",
        content: "Current question",
        timestamp: "2026-01-01T00:00:05.000Z",
      }),
      message({
        id: "cur-assistant",
        parentId: "cur-user",
        role: "assistant",
        content: [{ type: "text", text: "Current answer" }],
        timestamp: "2026-01-01T00:00:06.000Z",
      }),
    ]);

    const command = buildPiTreeSlashCommand(sessionFile);

    expect(command.argumentOptions?.map((option) => option.id)).toEqual([
      "u0",
      "a1",
      "cur-user",
      "cur-assistant",
      "old-user",
      "old-assistant",
    ]);
    expect(command.argumentOptions?.map((option) => option.label)).toEqual([
      "• user",
      "• assistant",
      "┊• user",
      "┊● assistant",
      "┊↳ user",
      "┊○ assistant",
    ]);
    expect(command.argumentOptions?.find((option) => option.id === "old-user")?.metadata).toEqual(
      expect.objectContaining({
        detail: expect.stringContaining("from a1"),
        preserveOrder: true,
      }),
    );
    expect(command.argumentOptions?.some((option) => option.id === "hidden-tool")).toBe(false);
    expect(command.argumentOptions?.some((option) => option.id === "thinking-only")).toBe(false);
    expect(command.argumentOptions?.some((option) => option.id === "tool-call-only")).toBe(false);
  });

  test("caps visual label depth while keeping real depth in detail", () => {
    const entries: unknown[] = [session()];
    let parentId: string | null = null;
    for (let index = 0; index <= 8; index += 1) {
      const id = `main-${index}`;
      entries.push(
        message({
          id,
          parentId,
          role: index % 2 === 0 ? "user" : "assistant",
          content: index % 2 === 0 ? `Main ${index}` : [{ type: "text", text: `Main ${index}` }],
          timestamp: `2026-01-01T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
        }),
      );
      entries.push(
        message({
          id: `side-${index}`,
          parentId,
          role: "user",
          content: `Side ${index}`,
          timestamp: `2026-01-01T00:01:${String(index + 1).padStart(2, "0")}.000Z`,
        }),
      );
      parentId = id;
    }
    const sessionFile = writeSession(entries);

    const option = buildPiTreeSlashCommand(sessionFile, "main-8").argumentOptions?.find(
      (entry) => entry.id === "main-8",
    );

    expect(option?.label).toBe("┊┊┊┊┊┊● user");
    expect(option?.metadata?.detail).toEqual(expect.stringContaining("d8"));
  });

  test("formats listing and navigation feedback with branch-point semantics", () => {
    const sessionFile = writeSession([
      session(),
      message({
        id: "first",
        parentId: null,
        role: "user",
        content: "First prompt",
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
      message({
        id: "answer",
        parentId: "first",
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
        timestamp: "2026-01-01T00:00:02.000Z",
      }),
    ]);

    expect(formatPiTreeListing(sessionFile)).toContain("Use `/tree <entryId>` to navigate");
    expect(resolvePiNavigationLeafId(sessionFile, "first")).toBeNull();
    expect(resolvePiNavigationLeafId(sessionFile, "answer")).toBe("answer");
    expect(parsePiTreeCommand("/tree first extra words")).toEqual({
      targetId: "first",
      trailingText: "extra words",
    });
    expect(
      formatPiTreeNavigationFeedback({
        targetId: "first",
        beforeLeafId: "answer",
        afterLeafId: null,
        result: { editorText: "First prompt" },
        trailingText: "extra words",
        target: { role: "user", text: "First prompt", parentId: null },
      }),
    ).toContain("creates a new sibling branch next to the selected user message");
  });

  test("explains user prompt navigation and shows local prompt text when Pi omits editor text", () => {
    const sessionFile = writeSession([
      message({
        id: "first",
        parentId: null,
        role: "user",
        content: "First prompt",
      }),
      message({
        id: "answer",
        parentId: "first",
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      }),
      message({
        id: "branch",
        parentId: "answer",
        role: "user",
        content: "Try another branch\n\n```ts\nconsole.log('x')\n```",
      }),
    ]);

    const feedback = formatPiTreeNavigationFeedback({
      targetId: "branch",
      beforeLeafId: "answer",
      afterLeafId: "answer",
      result: {},
      trailingText: null,
      target: {
        role: "user",
        text: "Try another branch\n\n```ts\nconsole.log('x')\n```",
        parentId: "answer",
      },
    });

    expect(resolvePiNavigationLeafId(sessionFile, "branch")).toBe("answer");
    expect(feedback).toContain("Selected Pi tree entry `branch` (user)");
    expect(feedback).toContain(
      "Pi moved to the selected user message's parent: `answer` → `answer`",
    );
    expect(feedback).toContain("Selected user message:");
    expect(feedback).toContain("````\nTry another branch\n\n```ts\nconsole.log('x')\n```\n````");
    expect(feedback).toContain("creates a new sibling branch next to the selected user message");
    expect(feedback).toContain("The selected message and its existing replies are unchanged");
    expect(feedback).toContain("reload may resume Pi's persisted leaf");
  });

  test("explains assistant entry navigation", () => {
    const feedback = formatPiTreeNavigationFeedback({
      targetId: "answer",
      beforeLeafId: "branch",
      afterLeafId: "answer",
      result: {},
      trailingText: null,
      target: { role: "assistant", text: "Answer text", parentId: "first" },
    });

    expect(feedback.startsWith("\n\nSelected Pi tree entry `answer` (assistant).")).toBe(true);
    expect(feedback).toContain("Pi moved to the selected assistant entry: `branch` → `answer`");
    expect(feedback).not.toContain("Selected assistant message:");
    expect(feedback).not.toContain("Answer text");
    expect(feedback).toContain("continue after this assistant response as a new child message");
    expect(feedback).toContain("not written into the Pi session");
  });
});
