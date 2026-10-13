# Claude Mod Pack

[![Support me on Ko-fi](https://img.shields.io/badge/Ko--fi-buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/finalpantasy)

**Small Claude Code mods: a status band for your usage limits, a switchboard for your mods, a button that hides them all, a guard that keeps your name out of public pushes, and OpenAI Codex as native subagents.**

Each mod installs on its own. Pick the ones you want.

![Claude Status Band above the Claude Code prompt: week and 5-hour limit rings, context, spend and token rows, with Compact now and Handoff buttons, and the Claude Mod Hider arrow (boxed) in the corner](docs/band.png)

*A real screenshot from the Claude desktop app. The dollar and token figures are pixelated.*

## Install

```
/plugin marketplace add finalpantasy/claude-mod-pack
/plugin install status-band@claude-mod-pack
/plugin install claude-mod-hider@claude-mod-pack
/plugin install push-guard@claude-mod-pack
/plugin install codex-bridge@claude-mod-pack
```

Restart Claude Code after installing. Mods need Claude Code with mod support (function hooks).

## The mods

### Claude Status Band (`status-band`)

One tidy band above the prompt, each row labelled:

- **Week** and **5-hour**: your plan's limits as rings, with a pace for the week that learns when you actually work. Nights and weekends you are away are not counted as burn, and it gets more accurate the longer you use it.
- **Context**: how full the chat is and when it will need compacting (red from 75%).
- **Spend** and **Tokens**: this chat, today, 7 days and all time, across every open chat.
- **Last turn**: how long it took, files edited with lines added and removed, commands run, failures, reads and agents.
- **Tasks**: your open to-do list, from TodoWrite or claude-mem's work state.
- **Compact now** and **Handoff** buttons, always there. Handoff has Claude write a handoff packet and move the work to a fresh chat.

![Claude Status Band with sample data: week, 5-hour and context rings, spend and token tiles for this chat, today, 7 days and all time, Compact now and Handoff buttons, the last turn and an open task list](docs/band-sample.png)

`/mods` opens a panel listing every installed mod with its full description and an on/off switch, plus a switch for each band row. `/band` hides or shows the band.

![The /mods panel: Compact now and Handoff, a switch for each band row, and every installed mod with an on/off switch and its full description](docs/mods-panel.png)

*These two pictures are drawn from status-band's own output with sample data: its screenshot test records exactly what the mod draws, and [tools/shots.py](tools/shots.py) lays that out in the desktop app's dark style and photographs it. The mods named focus-timer and pixel-pet are made-up examples.*

### Claude Mod Hider (`claude-mod-hider`)

One small arrow in the corner of the band. Click it and every mod above the prompt folds down to a single **▸ mods** button; click again and they are back. It remembers your choice across sessions. [More, including how other mods can opt in](claude-mod-hider/README.md).

### Claude Push Guard (`push-guard`)

Stops a `git push` Claude runs when the commits about to leave would publish something about you, and tells Claude exactly where it is so it can fix the files and the history first. It checks only what is new in the push: added lines, file names, commit messages and author names.

What it looks for is yours, never anyone else's:

- **Your words**: your real name, personal email, company, anything you list in the plugin's settings (`/plugin configure push-guard@claude-mod-pack`). Empty until you fill it in.
- **Your home folder path**, read from your own machine, in any spelling (`C:\Users\you`, `/c/Users/you`, escaped JSON, `/home/you`).
- **Your everyday git name and email**, but only when the commits are made under a different identity, the way a real name slips into a repo you publish under a handle.
- **Em dashes**, if you turn that on.

What Claude reads when a push is stopped (from the mod's tests, with a made-up name):

```
Push Guard stopped this push: one place in the commits would publish something private.
- README.md:13: "Alex Rivera"
Remove it from the files and from the commit history (amend or rebase the commits, and fix author names with the repo's own git identity), then push again.
If it is meant to be public, the person can run /push-guard off to push without the check for this session.
```

Private GitHub repos are skipped when the GitHub CLI can see they are private; any other host is checked. `/push-guard` says what it checks, and `/push-guard off` lets a push through for the rest of the session.

### Claude Codex Bridge (`codex-bridge`)

Runs OpenAI Codex models as real Claude Code subagents. Each model becomes an agent type (`codex-bridge:sol`, `codex-bridge:sol-ro` for read-only, and so on) that the Agent tool can start like any other. You get the same task row, timer, token count, tool rows, background notice and SendMessage follow-ups as a native agent, which is handy for a second opinion from a different model family.

- Needs the [Codex CLI](https://github.com/openai/codex) installed and signed in.
- Set which models you get in the plugin's settings (`models`, as `name=model` pairs).

## Support

These are free hobby projects. If one saves you time, you can [buy me a coffee on Ko-fi](https://ko-fi.com/finalpantasy).

## License

MIT
