/**
 * Interactive menu shown on a bare `oma` invocation in a TTY.
 *
 * A thin launcher: it never talks to the API itself — it just asks the user
 * what they want to do and returns the equivalent argv, which `main()` then
 * runs through the normal command matcher. That keeps a single dispatch path
 * (no duplicated command logic) and means every interactive action is also
 * runnable non-interactively.
 *
 * Returns the argv to execute, or `null` when the user picks Quit / presses
 * Ctrl-C. Only ever invoked when stdout+stdin are a TTY (checked by caller),
 * so the prompt libs always have a real terminal.
 */

import { logo } from "./bridge/lib/style.js";

export async function runInteractive(): Promise<string[] | null> {
  // Lazily imported so the (heavier) prompt libs never load for normal,
  // non-interactive command runs.
  const { default: select, Separator } = await import("@inquirer/select");
  const { default: input } = await import("@inquirer/input");

  process.stderr.write(`\n${logo()}\n\n`);

  let action: string;
  try {
    action = await select<string>({
      message: "What would you like to do?",
      choices: [
        { name: "List agents", value: "agents.list" },
        { name: "Create an agent", value: "agents.create" },
        { name: "List sessions", value: "sessions.list" },
        { name: "Open (tail) a session", value: "sessions.tail" },
        { name: "List environments", value: "envs.list" },
        new Separator(),
        { name: "Bridge status (local runtime)", value: "bridge.status" },
        { name: "Who am I", value: "whoami" },
        { name: "API reference", value: "api" },
        new Separator(),
        { name: "Quit", value: "quit" },
      ],
    });
  } catch {
    // Ctrl-C / non-interactive abort.
    return null;
  }

  try {
    switch (action) {
      case "agents.list":
        return ["agents", "list"];
      case "agents.create": {
        const name = (await input({ message: "Agent name:" })).trim();
        if (!name) return null;
        return ["agents", "create", name];
      }
      case "sessions.list":
        return ["sessions", "list"];
      case "sessions.tail": {
        const id = (await input({ message: "Session id:" })).trim();
        if (!id) return null;
        return ["sessions", "tail", id];
      }
      case "envs.list":
        return ["envs", "list"];
      case "bridge.status":
        return ["bridge", "status"];
      case "whoami":
        return ["whoami"];
      case "api":
        return ["api"];
      case "quit":
      default:
        return null;
    }
  } catch {
    return null;
  }
}
