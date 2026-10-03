import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { HooksEditor } from "../HooksEditor";
import { I18nProvider } from "../I18nProvider";

/**
 * Regression test for issue #28 ("无法使用hooks" / "Cannot read properties of
 * undefined").
 *
 * The component used to crash while loading any hooks configuration written by
 * Claude Code >= 2.x, because those versions nest the handlers in
 * `hooks: [...]` for matcher-less events (Stop / Notification / SubagentStop)
 * as well. The editor read `entry.command`, got undefined, and the auto-fix
 * pass then threw on `undefined.trim()`.
 */

const getHooksConfig = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    getHooksConfig: (...args: unknown[]) => getHooksConfig(...args),
    updateHooksConfig: vi.fn().mockResolvedValue(undefined),
  },
}));

// framer-motion is not needed for these assertions
vi.mock("framer-motion", () => ({
  motion: { div: "div" },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const claudeCode2xConfig = {
  PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
  Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
  Notification: [
    { matcher: "permission_prompt", hooks: [{ type: "command", command: "notify-send hi" }] },
  ],
};

describe("HooksEditor with a Claude Code 2.x configuration (issue #28)", () => {
  beforeEach(() => {
    getHooksConfig.mockReset();
    getHooksConfig.mockResolvedValue(claudeCode2xConfig);
  });

  const renderEditor = () =>
    render(
      <I18nProvider>
        <HooksEditor scope="user" />
      </I18nProvider>
    );

  it("loads and renders the configuration instead of crashing", async () => {
    renderEditor();

    await waitFor(() => expect(getHooksConfig).toHaveBeenCalledWith("user", undefined));

    // The tool event is loaded and shown with its matcher pattern
    await waitFor(() => expect(screen.getByDisplayValue("Bash")).toBeInTheDocument());

    // No error banner from the load path
    expect(screen.queryByText(/Failed to load hooks configuration/i)).not.toBeInTheDocument();
  });

  it("shows the command of a nested Stop handler", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByDisplayValue("Bash")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: /^stop/i }));

    await waitFor(() => expect(screen.getByDisplayValue("echo done")).toBeInTheDocument());
  });

  it("shows the command of a nested Notification handler", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByDisplayValue("Bash")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: /notification/i }));

    await waitFor(() => expect(screen.getByDisplayValue("notify-send hi")).toBeInTheDocument());
  });

  it("keeps non-command handlers visible instead of dropping them", async () => {
    getHooksConfig.mockResolvedValue({
      Stop: [{ hooks: [{ type: "prompt", prompt: "did you finish?" }] }],
    });

    renderEditor();

    fireEvent.click(await screen.findByRole("tab", { name: /^stop/i }));

    await waitFor(() =>
      expect(screen.getByText(/"type":"prompt"/)).toBeInTheDocument()
    );
  });
});
