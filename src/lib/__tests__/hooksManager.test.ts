import { describe, it, expect } from "vitest";
import { HooksManager } from "../hooksManager";
import type { HooksConfiguration } from "@/types/hooks";

/**
 * Regression tests for issue #28: the hooks editor crashed with
 * "Cannot read properties of undefined (reading 'trim')" for every
 * configuration written by Claude Code >= 2.x, because those versions nest the
 * handlers in `hooks: [...]` for matcher-less events too.
 */
describe("HooksManager", () => {
  describe("normalizeConfig", () => {
    it("normalizes the Claude Code >= 2.x nested shape for Stop/Notification", () => {
      const raw = {
        Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
        Notification: [
          { matcher: "permission_prompt", hooks: [{ type: "command", command: "notify-send hi" }] },
        ],
      };

      const { hooks, directEventFormat } = HooksManager.normalizeConfig(raw);

      expect(hooks.Stop).toEqual([{ type: "command", command: "echo done" }]);
      expect(hooks.Notification).toEqual([{ type: "command", command: "notify-send hi" }]);
      expect(directEventFormat.Stop).toBe("nested");
      expect(directEventFormat.Notification).toBe("nested");
    });

    it("normalizes the legacy flat shape and remembers it", () => {
      const raw = {
        Stop: [{ type: "command", command: "echo legacy", timeout: 30 }],
      };

      const { hooks, directEventFormat } = HooksManager.normalizeConfig(raw);

      expect(hooks.Stop).toEqual([{ type: "command", command: "echo legacy", timeout: 30 }]);
      expect(directEventFormat.Stop).toBe("flat");
    });

    it("normalizes legacy flat matcher entries for tool events", () => {
      const raw = {
        PreToolUse: [{ matcher: "Bash", command: "echo flat" }],
      };

      const { hooks } = HooksManager.normalizeConfig(raw);

      expect(hooks.PreToolUse).toEqual([
        { matcher: "Bash", hooks: [{ type: "command", command: "echo flat" }] },
      ]);
    });

    it("keeps nested tool event handlers intact", () => {
      const raw = {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo nested", timeout: 5 }] },
        ],
      };

      const { hooks } = HooksManager.normalizeConfig(raw);

      expect(hooks.PreToolUse).toEqual([
        { matcher: "Bash", hooks: [{ type: "command", command: "echo nested", timeout: 5 }] },
      ]);
    });

    it("preserves handler types the editor cannot edit", () => {
      const raw = {
        Stop: [{ hooks: [{ type: "prompt", prompt: "did you finish?" }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "agent", prompt: "verify" }] }],
      };

      const { hooks } = HooksManager.normalizeConfig(raw);

      expect(hooks.Stop).toEqual([{ type: "prompt", prompt: "did you finish?" }]);
      expect(hooks.PreToolUse?.[0].hooks).toEqual([{ type: "agent", prompt: "verify" }]);
    });

    it("never throws on malformed input", () => {
      for (const raw of [null, undefined, 42, "nope", [], { Stop: "nope" }, { Stop: [null, 1] }]) {
        expect(() => HooksManager.normalizeConfig(raw)).not.toThrow();
      }
    });
  });

  describe("validateConfig on Claude Code 2.x configurations", () => {
    it("reports no errors for a normalized nested Stop hook", async () => {
      const raw = { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] };
      const { hooks } = HooksManager.normalizeConfig(raw);

      const result = await HooksManager.validateConfig(hooks);

      // Before the fix this returned an "Empty command" error, which then drove
      // the editor's auto-fix into `undefined.trim()` and crashed the app.
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it("does not flag non-command handlers as empty commands", async () => {
      const raw = { Stop: [{ hooks: [{ type: "prompt", prompt: "keep going?" }] }] };
      const { hooks } = HooksManager.normalizeConfig(raw);

      const result = await HooksManager.validateConfig(hooks);

      expect(result.errors).toEqual([]);
    });

    it("still reports genuinely empty commands", async () => {
      const hooks: HooksConfiguration = {
        Stop: [{ type: "command", command: "   " }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "" }] }],
      };

      const result = await HooksManager.validateConfig(hooks);

      expect(result.errors).toHaveLength(2);
      expect(result.valid).toBe(false);
    });

    it("does not throw when a handler has no command field at all", async () => {
      const hooks = {
        Stop: [{ type: "command" }],
        PreToolUse: [{ matcher: "Bash", hooks: [{}] }],
      } as unknown as HooksConfiguration;

      await expect(HooksManager.validateConfig(hooks)).resolves.toBeDefined();
    });
  });

  describe("serializeConfig", () => {
    it("writes matcher events in the nested form", () => {
      const hooks: HooksConfiguration = {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      };

      expect(HooksManager.serializeConfig(hooks)).toEqual({
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
      });
    });

    it("round-trips a nested matcher-less event without changing its shape", () => {
      const raw = { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] };
      const { hooks, directEventFormat } = HooksManager.normalizeConfig(raw);

      expect(HooksManager.serializeConfig(hooks, directEventFormat)).toEqual(raw);
    });

    it("round-trips a legacy flat matcher-less event without changing its shape", () => {
      const raw = { Stop: [{ type: "command", command: "echo legacy" }] };
      const { hooks, directEventFormat } = HooksManager.normalizeConfig(raw);

      expect(HooksManager.serializeConfig(hooks, directEventFormat)).toEqual(raw);
    });

    it("drops editor-only fields (id/expanded) when serializing", () => {
      const hooks = {
        PreToolUse: [
          {
            id: "matcher-1",
            expanded: true,
            matcher: "Bash",
            hooks: [{ id: "hook-1", type: "command", command: "echo hi" }],
          },
        ],
        Stop: [{ id: "hook-2", type: "command", command: "echo done" }],
      } as unknown as HooksConfiguration;

      expect(HooksManager.serializeConfig(hooks)).toEqual({
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
      });
    });

    it("preserves non-command handlers verbatim", () => {
      const raw = { Stop: [{ hooks: [{ type: "prompt", prompt: "keep going?" }] }] };
      const { hooks, directEventFormat } = HooksManager.normalizeConfig(raw);

      expect(HooksManager.serializeConfig(hooks, directEventFormat)).toEqual(raw);
    });

    it("defaults an empty matcher pattern to .* so Claude Code still matches", () => {
      const hooks = {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      } as HooksConfiguration;

      const serialized = HooksManager.serializeConfig(hooks) as {
        PreToolUse: Array<{ matcher: string }>;
      };

      expect(serialized.PreToolUse[0].matcher).toBe(".*");
    });
  });
});
