/**
 * Hooks configuration manager for Claude Code hooks
 */

import {
  HooksConfiguration,
  HookMatcher,
  HookValidationResult,
  HookValidationError,
  HookValidationWarning,
  HookCommand,
  RawHookEntry,
  HookEventFormat,
  DirectHookEvent,
  NormalizedHooksConfig,
} from "@/types/hooks";

/** Events whose handlers are matched against a tool name pattern */
const MATCHER_EVENTS = ["PreToolUse", "PostToolUse"] as const;
/** Events whose handlers run unconditionally */
const DIRECT_EVENTS: readonly DirectHookEvent[] = ["Notification", "Stop", "SubagentStop"];

/**
 * Converts a single raw handler entry into the editor's canonical shape.
 *
 * Handlers without a string `command` (for example Claude Code's `prompt` and
 * `agent` handlers) are preserved verbatim so that saving the configuration
 * does not silently drop them.
 */
function toHookCommand(entry: RawHookEntry): HookCommand {
  const command = typeof entry.command === "string" ? entry.command : undefined;
  return {
    ...entry,
    type: typeof entry.type === "string" ? entry.type : command === undefined ? "unknown" : "command",
    ...(command === undefined ? {} : { command }),
  } as HookCommand;
}

/** True when an entry carries handler fields directly (legacy flat shape) */
function isFlatHandler(entry: RawHookEntry): boolean {
  return typeof entry.command === "string" || typeof entry.type === "string";
}

/**
 * Hooks configuration manager for Claude Code hooks
 *
 * Provides utilities for managing, validating, and merging hook configurations
 * across different scopes (user, project, local) with proper priority handling.
 */
export class HooksManager {
  /**
   * Normalize a raw `hooks` block read from settings.json into the shape the
   * editor works with.
   *
   * Claude Code changed the on-disk format over time:
   * - legacy (<= 1.0.x): `"Stop": [{ "type": "command", "command": "..." }]`
   * - current (>= 2.x):  `"Stop": [{ "hooks": [{ "type": "command", ... }] }]`
   *
   * Both are accepted, unknown fields are preserved, and malformed entries are
   * skipped instead of throwing. The on-disk shape of each matcher-less event is
   * reported back so that `serializeConfig` can round-trip it.
   *
   * @param raw - The `hooks` value from settings.json (any shape)
   * @returns Normalized configuration plus the detected on-disk format
   */
  static normalizeConfig(raw: unknown): NormalizedHooksConfig {
    const source =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};

    const hooks: HooksConfiguration = {};
    const directEventFormat: Record<DirectHookEvent, HookEventFormat> = {
      Notification: "nested",
      Stop: "nested",
      SubagentStop: "nested",
    };

    // Events with matchers
    for (const event of MATCHER_EVENTS) {
      const entries = source[event];
      if (!Array.isArray(entries)) continue;

      const matchers: HookMatcher[] = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const raw_entry = entry as RawHookEntry;

        let handlers: RawHookEntry[];
        if (Array.isArray(raw_entry.hooks)) {
          handlers = raw_entry.hooks.filter((h): h is RawHookEntry => !!h && typeof h === "object");
        } else if (isFlatHandler(raw_entry)) {
          // Legacy shape: the handler fields sit next to the matcher. Keep the
          // handler fields only, so the matcher is not duplicated into it.
          const { matcher: _matcher, ...handler } = raw_entry;
          handlers = [handler as RawHookEntry];
        } else {
          handlers = [];
        }

        matchers.push({
          ...(typeof raw_entry.matcher === "string" ? { matcher: raw_entry.matcher } : {}),
          hooks: handlers.map(toHookCommand),
        });
      }
      if (matchers.length > 0) {
        hooks[event] = matchers;
      }
    }

    // Events without matchers
    for (const event of DIRECT_EVENTS) {
      const entries = source[event];
      if (!Array.isArray(entries)) continue;

      const commands: HookCommand[] = [];
      let sawNested = false;
      let sawFlat = false;

      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const raw_entry = entry as RawHookEntry;

        if (Array.isArray(raw_entry.hooks)) {
          sawNested = true;
          for (const handler of raw_entry.hooks) {
            if (handler && typeof handler === "object") {
              commands.push(toHookCommand(handler as RawHookEntry));
            }
          }
        } else if (isFlatHandler(raw_entry)) {
          sawFlat = true;
          commands.push(toHookCommand(raw_entry));
        }
      }

      directEventFormat[event] = sawFlat && !sawNested ? "flat" : "nested";
      if (entries.length > 0) {
        hooks[event] = commands;
      }
    }

    return { hooks, directEventFormat };
  }

  /**
   * Convert the editor's canonical configuration back into the on-disk shape.
   *
   * Matcher events are always written in the current nested form. Matcher-less
   * events keep whatever shape they were loaded with (`nested` by default) so
   * that an existing configuration is not rewritten into a format the installed
   * Claude Code version may not understand.
   *
   * @param hooks - Normalized configuration
   * @param directEventFormat - Shape to use for Notification/Stop/SubagentStop
   * @returns A plain object ready to be written to settings.json
   */
  static serializeConfig(
    hooks: HooksConfiguration,
    directEventFormat?: Partial<Record<DirectHookEvent, HookEventFormat>>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    if (!hooks) return result;

    for (const event of MATCHER_EVENTS) {
      const matchers = hooks[event];
      if (!Array.isArray(matchers) || matchers.length === 0) continue;

      result[event] = matchers.map((matcher) => {
        const { id: _id, expanded: _expanded, ...rest } = matcher as HookMatcher & {
          id?: string;
          expanded?: boolean;
        };
        return {
          ...rest,
          matcher: typeof rest.matcher === "string" ? rest.matcher : ".*",
          hooks: (Array.isArray(rest.hooks) ? rest.hooks : []).map((hook) => {
            const { id: _hookId, ...handler } = hook as HookCommand & { id?: string };
            return handler;
          }),
        };
      });
    }

    for (const event of DIRECT_EVENTS) {
      const commands = hooks[event];
      if (!Array.isArray(commands) || commands.length === 0) continue;

      const handlers = commands.map((hook) => {
        const { id: _id, ...handler } = hook as HookCommand & { id?: string };
        return handler;
      });

      const format = directEventFormat?.[event] ?? "nested";
      result[event] = format === "flat" ? handlers : [{ hooks: handlers }];
    }

    return result;
  }

  /**
   * Merge hooks configurations with proper priority
   * Priority: local > project > user
   *
   * @param user - User-level hooks configuration
   * @param project - Project-level hooks configuration
   * @param local - Local-level hooks configuration
   * @returns Merged hooks configuration with proper priority
   *
   * @example
   * ```typescript
   * const merged = HooksManager.mergeConfigs(userHooks, projectHooks, localHooks);
   * ```
   */
  static mergeConfigs(
    user: HooksConfiguration,
    project: HooksConfiguration,
    local: HooksConfiguration
  ): HooksConfiguration {
    const merged: HooksConfiguration = {};

    // Events with matchers (tool-related)
    const matcherEvents: (keyof HooksConfiguration)[] = ["PreToolUse", "PostToolUse"];

    // Events without matchers (non-tool-related)
    const directEvents: (keyof HooksConfiguration)[] = ["Notification", "Stop", "SubagentStop"];

    // Merge events with matchers
    for (const event of matcherEvents) {
      // Start with user hooks
      let matchers = [...((user[event] as HookMatcher[] | undefined) || [])];

      // Add project hooks (may override by matcher pattern)
      if (project[event]) {
        matchers = this.mergeMatchers(matchers, project[event] as HookMatcher[]);
      }

      // Add local hooks (highest priority)
      if (local[event]) {
        matchers = this.mergeMatchers(matchers, local[event] as HookMatcher[]);
      }

      if (matchers.length > 0) {
        (merged as Record<string, unknown>)[event] = matchers;
      }
    }

    // Merge events without matchers
    for (const event of directEvents) {
      // Combine all hooks from all levels (local takes precedence)
      const hooks: HookCommand[] = [];

      // Add user hooks
      if (user[event]) {
        hooks.push(...(user[event] as HookCommand[]));
      }

      // Add project hooks
      if (project[event]) {
        hooks.push(...(project[event] as HookCommand[]));
      }

      // Add local hooks (highest priority)
      if (local[event]) {
        hooks.push(...(local[event] as HookCommand[]));
      }

      if (hooks.length > 0) {
        (merged as Record<string, unknown>)[event] = hooks;
      }
    }

    return merged;
  }

  /**
   * Merge matcher arrays, with later items taking precedence
   *
   * @param base - Base array of hook matchers
   * @param override - Override array of hook matchers that take precedence
   * @returns Merged array with override matchers replacing base matchers by pattern
   */
  private static mergeMatchers(base: HookMatcher[], override: HookMatcher[]): HookMatcher[] {
    const result = [...base];

    for (const overrideMatcher of override) {
      const existingIndex = result.findIndex((m) => m.matcher === overrideMatcher.matcher);

      if (existingIndex >= 0) {
        // Replace existing matcher
        result[existingIndex] = overrideMatcher;
      } else {
        // Add new matcher
        result.push(overrideMatcher);
      }
    }

    return result;
  }

  /**
   * Validate hooks configuration for syntax errors and security issues
   *
   * @param hooks - The hooks configuration to validate
   * @returns Promise resolving to validation result with errors and warnings
   *
   * @example
   * ```typescript
   * const result = await HooksManager.validateConfig(hooksConfig);
   * if (!result.valid) {
   *   console.error('Validation errors:', result.errors);
   * }
   * ```
   */
  static async validateConfig(hooks: HooksConfiguration): Promise<HookValidationResult> {
    const errors: HookValidationError[] = [];
    const warnings: HookValidationWarning[] = [];

    // Guard against undefined or null hooks
    if (!hooks) {
      return { valid: true, errors, warnings };
    }

    // Events with matchers
    const matcherEvents = MATCHER_EVENTS;

    // Events without matchers
    const directEvents = DIRECT_EVENTS;

    // Validate events with matchers
    for (const event of matcherEvents) {
      const matchers = hooks[event];
      if (!matchers || !Array.isArray(matchers)) continue;

      for (const matcher of matchers) {
        // Validate regex pattern if provided
        if (typeof matcher.matcher === "string" && matcher.matcher) {
          // Check for empty or whitespace-only patterns
          if (!matcher.matcher.trim()) {
            errors.push({
              event,
              matcher: matcher.matcher,
              message: "Empty regex pattern - please provide a valid pattern",
            });
          } else {
            try {
              new RegExp(matcher.matcher);
            } catch (regexError) {
              errors.push({
                event,
                matcher: matcher.matcher,
                message: `Invalid regex pattern: ${regexError instanceof Error ? regexError.message : "Unknown error"}`,
              });
            }
          }
        } else {
          errors.push({
            event,
            matcher: matcher.matcher || "(empty)",
            message: "Missing regex pattern - please provide a pattern to match tools",
          });
        }

        // Validate commands
        const matcherHooks = Array.isArray(matcher.hooks) ? matcher.hooks : [];
        if (matcherHooks.length === 0) {
          errors.push({
            event,
            matcher: matcher.matcher,
            message: "No commands defined - please add at least one command",
          });
        } else {
          for (const hook of matcherHooks) {
            const command = typeof hook?.command === "string" ? hook.command : undefined;
            if (command === undefined) {
              // Handlers without a command (e.g. Claude Code "prompt"/"agent"
              // handlers) are preserved as-is; only "command" handlers that lost
              // their command are an error.
              if (hook?.type === undefined || hook.type === "command") {
                errors.push({
                  event,
                  matcher: matcher.matcher,
                  message: "Empty command - please provide a command to execute",
                });
              }
              continue;
            }
            if (!command.trim()) {
              errors.push({
                event,
                matcher: matcher.matcher,
                message: "Empty command - please provide a command to execute",
              });
              continue;
            }
            // Check for dangerous patterns
            const dangers = this.checkDangerousPatterns(command);
            warnings.push(
              ...dangers.map((d) => ({
                event,
                matcher: matcher.matcher,
                command,
                message: d,
              }))
            );
          }
        }
      }
    }

    // Validate events without matchers
    for (const event of directEvents) {
      const directHooks = hooks[event];
      if (!directHooks || !Array.isArray(directHooks)) continue;

      for (const hook of directHooks) {
        const command = typeof hook?.command === "string" ? hook.command : undefined;
        if (command === undefined) {
          // Non-command handler: preserved verbatim, nothing to validate.
          if (hook?.type === undefined || hook.type === "command") {
            errors.push({
              event,
              message: "Empty command - please provide a command to execute",
            });
          }
          continue;
        }
        if (!command.trim()) {
          errors.push({
            event,
            message: "Empty command - please provide a command to execute",
          });
          continue;
        }
        // Check for dangerous patterns
        const dangers = this.checkDangerousPatterns(command);
        warnings.push(
          ...dangers.map((d) => ({
            event,
            command,
            message: d,
          }))
        );
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Check for potentially dangerous command patterns in shell commands
   *
   * @param command - The shell command to analyze for security risks
   * @returns Array of warning messages for detected dangerous patterns
   *
   * @example
   * ```typescript
   * const warnings = HooksManager.checkDangerousPatterns('rm -rf /');
   * // Returns: ['Destructive command on root directory']
   * ```
   */
  public static checkDangerousPatterns(command: string): string[] {
    const warnings: string[] = [];

    // Guard against undefined or null commands
    if (!command || typeof command !== "string") {
      return warnings;
    }

    const patterns = [
      { pattern: /rm\s+-rf\s+\/(?:\s|$)/, message: "Destructive command on root directory" },
      { pattern: /rm\s+-rf\s+~/, message: "Destructive command on home directory" },
      { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;/, message: "Fork bomb pattern detected" },
      { pattern: /curl.*\|\s*(?:bash|sh)/, message: "Downloading and executing remote code" },
      { pattern: /wget.*\|\s*(?:bash|sh)/, message: "Downloading and executing remote code" },
      { pattern: />\/dev\/sda/, message: "Direct disk write operation" },
      { pattern: /sudo\s+/, message: "Elevated privileges required" },
      { pattern: /dd\s+.*of=\/dev\//, message: "Dangerous disk operation" },
      { pattern: /mkfs\./, message: "Filesystem formatting command" },
      { pattern: /:(){ :|:& };:/, message: "Fork bomb detected" },
    ];

    for (const { pattern, message } of patterns) {
      if (pattern.test(command)) {
        warnings.push(message);
      }
    }

    // Check for unescaped variables that could lead to code injection
    if (command.includes("$") && !command.includes('"$')) {
      warnings.push("Unquoted shell variable detected - potential code injection risk");
    }

    return warnings;
  }

  /**
   * Escape a command for safe shell execution
   *
   * @param command - The command string to escape
   * @returns Escaped command string safe for shell execution
   *
   * @example
   * ```typescript
   * const safe = HooksManager.escapeCommand('echo "hello $USER"');
   * // Returns: 'echo "hello \\$USER"'
   * ```
   */
  static escapeCommand(command: string): string {
    // Basic shell escaping - in production, use a proper shell escaping library
    return command
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\$/g, "\\$")
      .replace(/`/g, "\\`");
  }

  /**
   * Generate a unique ID for hooks/matchers/commands
   *
   * @returns Unique identifier string combining timestamp and random characters
   *
   * @example
   * ```typescript
   * const id = HooksManager.generateId();
   * // Returns: '1703123456789-abc123def'
   * ```
   */
  static generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
