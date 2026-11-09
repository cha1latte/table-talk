Workflow: project-workflow

| Slice | Title | REQs | Status | Rounds |
|---|---|---|---|---|
| S-01 | GM Speak-as dropdown | REQ-001..004 | Built, tests pass; adversary + Bunny skipped (Chai, 2026-10-29) | 1 |
| S-02 | Players can send | REQ-101..103 | Built, 15/15 live checks pass; agent gates + Bunny skipped (quick ask mid-session, 2026-10-29) | 1 |

## S-01 GM Speak-as dropdown
Goal: the GM can type/speak lines as a player character.
Done when: all REQ acceptance checks pass live in the QA Foundry; existing tests still pass.
Out of scope: Foundry chat-box posts, NPCs, server changes, release.

## S-02 Players can send
Goal: a player (e.g. on a laptop) can send the table's turn when the GM allows it.
Done when: qa/test-players-send.mjs passes on the QA Foundry; existing tests still pass.
Out of scope: sending without the GM window, per-player permissions, release.
