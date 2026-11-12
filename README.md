# session-panel

A side panel for the Claude Code CLI that brings the desktop app's session panel to the terminal. It shows:

- **Environment**: machine, project and folder, git branch, model, and whether a Remote Control client is attached
- **Context**: % used, used/total tokens, a coloured bar by category, and the `/context` rows (Messages, System tools, MCP tools, System prompt, Memory files, Skills, Autocompact buffer, Free space, deferred tools), with an expandable Memory files list
- **Usage**: your 5-hour and weekly limits, each with a bar and when it resets, and the session's cost (shown when your plan reports them)
- **MCP in context**: the MCP servers whose tools are loaded in context, with their tokens and tool counts (servers whose tools are all deferred are not listed)
- **Outputs**: files written and artifacts published this session, newest first; files that existed before are marked updated
- **Changes**: lines added and removed against the main branch (untracked files included), commits ahead and behind, uncommitted files, and the branch's pull request: **View PR** when one is open, **Create PR** when there is work to send

The panel docks beside the chat when the terminal is at least 144 columns wide; `/session-panel` opens it at any width. Context and usage refresh whenever Claude Code measures the session (after each reply, a compaction, or a limit moving); git refreshes after each file edit or shell command. The PR is looked up with `gh` at the start, on a new branch, after a command that runs `gh` or `git push`, and on Refresh.

<p align="center">
  <img src="docs/demo.gif" alt="The session panel updating live in a Claude Code terminal session, showing the Environment, Context, Connectors and Outputs sections" width="308">
</p>

## Install

At the prompt of a terminal session:

```
/plugin install session-panel --marketplace danbaez/session-panel
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install session-panel --marketplace danbaez/session-panel
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `danbaez/session-panel`, then Add plugin.

## Uninstall

```
/plugin uninstall session-panel
```

## Contributing

Issues and pull requests are welcome. The panel is a single module, `hooks/register.tsx`, with its data types in `types/index.d.ts` and a render test in `hooks/pane.test.tsx`.

## License

[MIT](LICENSE)
