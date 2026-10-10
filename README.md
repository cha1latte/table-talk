# Table Talk

**Talk to your Claude Code game master instead of typing for everyone.** Players hold **G** in Foundry VTT and speak. Their own browser writes down what they said, word for word, and labels it with their character. The lines wait in a queue on the GM's screen. When the GM presses **Send** (or says *"OK GM, send it"*), the whole table's turn goes to the Claude Code session that's running your game through [Familiar](https://foundryvtt.com/packages/familiar).

```
Shlo holds G: "I want to just fucking bash the lock in."
Techie holds G: "While he does that, I keep watch on the hallway."
GM presses Send  →  Claude Code receives:

  Spoken at the table (voice transcripts, 2 lines):
  Big Elf (Shlo): "I want to just fucking bash the lock in."
  Gizmo (Techie): "While he does that, I keep watch on the hallway."
```

Players install nothing. Discord (or whatever you talk on) stays exactly as it is; Table Talk only listens while someone holds the key.

## Set it up (GM, about five minutes, once)

You need Foundry VTT 13 or 14, Claude Code with Familiar already working, and Node.js (you already have it if Familiar runs through `npx`).

1. **Foundry:** *Add-on Modules → Install Module*, paste this manifest URL, install, then enable **Table Talk** in your world:
   ```
   https://github.com/cha1latte/table-talk/releases/latest/download/module.json
   ```
2. **Claude Code:** run these two commands inside Claude Code:
   ```
   /plugin marketplace add cha1latte/table-talk
   /plugin install table-talk@table-talk
   ```
3. **Every game:** start Claude Code the way you normally do for Familiar, adding the Table Talk flag:
   ```
   claude --dangerously-load-development-channels plugin:table-talk@table-talk
   ```
   Claude Code shows a warning screen. Choose **"I am using this for local development"** (more on that below).

When the dot next to *Hold G to talk* on the GM's screen turns **green**, you're ready.

## Playing

- **Players:** hold **G** (or hold the microphone button) and talk. Let go when you're done. You'll see your words, then *"Waiting for the GM to send"*.
- **GM:** lines pile up in the *Waiting to send* list with each character's name. Remove anything you don't want with the ✕. Press **Send to the AI GM**, press **Shift+G**, or hold G and say *"OK GM, send it."* The AI GM answers the whole table at once.
- Lines spoken while the AI GM is still answering simply wait for the next Send.
- The keys can be changed in *Configure Controls*.

## Things to know

- **Remote players need https.** Browsers only allow the microphone on secure pages. The Forge and tunnels such as Cloudflare Tunnel are https; a self-hosted Foundry reached at `http://<ip>:30000` is not, and the button will say so. The GM's own browser on `localhost` is fine.
- **The GM's browser must be on the same computer as Claude Code.** That browser hands the lines to Claude Code on `127.0.0.1`.
- **Foundry on The Forge (or any address that isn't localhost):** the first Send tells you to allow it. Ask Claude Code: *"Allow Table Talk for https://yourgame.forge-vtt.com"* (or run `/table-talk:allow https://yourgame.forge-vtt.com`).
- **Speech-to-text runs in each player's browser.**
  - Chrome, Edge and Safari use the browser's own recognition: instant, nothing to download. It sends the audio to the browser maker's speech service (Google for Chrome) to turn it into text.
  - Firefox, the Foundry desktop app and anything else without it switch automatically to **Whisper running inside the browser**: a one-time download (about 80 MB), after which audio never leaves the player's computer. Anyone can choose Whisper in *Configure Settings → Table Talk*.
- **Nobody shares a Claude login.** The GM's Claude Code uses the GM's own account. Players need no Anthropic account at all.
- **About the warning screen.** Custom Claude Code channels are a research preview, and only channels Anthropic has approved start without `--dangerously-load-development-channels`. Until Table Talk is approved, that flag and one click each launch are the price. The warning also says not to run downloaded channels: only do this with code you trust. The whole channel is one small file with no dependencies, [claude-plugin/server.mjs](claude-plugin/server.mjs), so you can read it first. It only accepts lines from Foundry pages on your own computer or addresses you've allowed, and it tells Claude to treat them as player speech, never as instructions to run commands or edit files.
- **Settings** (*Configure Settings → Table Talk*): speech engine, spoken language, the GM's Claude Code address, and whether "OK GM, send it" works.

## Troubleshooting

| What you see | Fix |
| --- | --- |
| Grey or red dot, *"Claude Code isn't listening"* | Start Claude Code with the flag in step 3 and pick "I am using this for local development". |
| *"Claude Code refused this page"* | Ask Claude Code: *Allow Table Talk for* the address in your browser bar. |
| *"Voice needs a secure page"* | Serve Foundry over https (The Forge, a tunnel, or a certificate). |
| *"Your browser blocked the microphone"* | Click the microphone icon in the address bar and allow it. |
| *"Didn't catch anything"* | Hold the key a moment before you start talking, and keep holding until you finish. |

## Without the plugin

If you'd rather not install a plugin, download this repository and add the channel for one session only:

```
claude --mcp-config '{"mcpServers":{"table-talk":{"command":"node","args":["/path/to/table-talk/claude-plugin/server.mjs"]}}}' --dangerously-load-development-channels server:table-talk
```

## Development

`npm test` runs the channel checks; `npm run e2e` drives real Chrome against a throwaway Foundry (see `qa/`); `npm run package` builds `dist/module.json` and `dist/table-talk.zip` for a release.

MIT licence. Not made or endorsed by Anthropic or by Familiar's developer.
