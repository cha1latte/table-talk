---
description: Let a Foundry server's address send spoken lines to this session (needed when Foundry isn't on localhost, e.g. The Forge or a tunnel)
argument-hint: <foundry address, e.g. https://mygame.forge-vtt.com>
---

The user wants Table Talk to accept spoken lines from the Foundry VTT page at: `$ARGUMENTS`

1. Reduce it to an origin: scheme + host + port only, no path and no trailing slash (for example `https://mygame.forge-vtt.com/game` becomes `https://mygame.forge-vtt.com`). If it isn't an http or https address, stop and ask for the address shown in their browser's address bar while Foundry is open.
2. Read `~/.claude/channels/table-talk/config.json` (it may not exist yet; treat that as `{}`), add the origin to its `allowedOrigins` array if it isn't already there, keep every other key as it was, and write the file back as JSON.
3. Tell the user in one line that the address is allowed and takes effect immediately; in Foundry, the Table Talk panel's status dot turns green within a few seconds.
