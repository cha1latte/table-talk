# Design: GM "Speak as" picker

## Decisions
- DEC-001 Store the pick as a client-scope setting `speakAs` (actor id, "" = GM), registered with `config: false`. Options: client setting / localStorage / world setting. Client setting chosen: Foundry-native, per browser, survives reload (REQ-004). World setting lost: it would be shared by every GM.
- DEC-002 Label in `makeLine`: when the user is GM and `speakAs` resolves to a listed character, `character` = actor name; `player` stays the GM's user name. The server already prints `Character (Player)` when they differ (REQ-003). No server change.
- DEC-003 Candidate list is a pure function `speakAsChoices(actors, users)` so it can be checked without the UI; the dropdown is re-rendered on actor/user create/update/delete hooks (REQ-002, REQ-004 fallback).

## Components
- `foundry-module/scripts/table-talk.mjs`: setting, `speakAsChoices`, `makeLine`, panel `<select class="tt-speak-as">` in the GM box area, hooks.
- `foundry-module/lang/en.json`: "SpeakAs" string.
- `foundry-module/styles/table-talk.css`: dropdown style.
- `qa/test-speak-as.mjs`: live Playwright test on the throwaway QA Foundry (:30005).

## Test strategy
Live test in the throwaway Foundry (qa/foundry.ps1, :30005, never :30000): GM sees the dropdown, player doesn't; list content; typed line as character reaches the queue labelled; GM default unchanged; reload keeps the pick; deleted-actor fallback. Plus the existing `npm test` and `qa/test-type.mjs`.

## Commands
- `npm test`
- `powershell -File qa\foundry.ps1` then `node qa/test-speak-as.mjs` and `node qa/test-type.mjs`
- `npm run package`
