# Requirements: GM "Speak as" picker

Context: a solo player often runs Foundry as both the Gamemaster (for the Familiar link) and the player. Today every line typed or spoken in the GM's window is labelled "GM", so the AI GM treats it as table/GM talk, not the hero. The GM needs to send lines as their character without opening a second, player window.

## REQ-001 GM picks who they speak as
The GM's Table Talk panel must show a "Speak as" dropdown, offering "GM" and each player character.
- Given the GM's window, when the panel renders, then a Speak-as dropdown is visible with "GM" first.
- Given a player's window, when the panel renders, then no Speak-as dropdown appears.

## REQ-002 Choices are players' characters only
The dropdown must list "GM" plus every actor that a non-GM user has assigned as their character or owns (OWNER), type "character", each once, sorted by name.
- Given an NPC actor owned only by the GM, then it is not listed.
- Given an actor assigned to one player and owned by another, then it is listed once.
- Given no player characters, then the dropdown shows only "GM".

## REQ-003 Lines sent as a character are labelled "Character (Gamemaster)"
The GM's typed and spoken lines must carry the picked character's name as `character`, with the GM's user name as `player`.
- Given Speak as = Chaizzik, when the GM types a line, then the queue and the batch Claude receives show `Chaizzik (Gamemaster)`.
- Given Speak as = GM, then lines are labelled "GM" exactly as before.
- Given Speak as = Chaizzik, when the GM says "OK GM, send it", then the queue still sends (the spoken send phrase is not turned into a line).

## REQ-004 The choice is remembered per browser
The pick must persist across reloads in that browser (client-scope setting).
- Given Speak as = Chaizzik, when the GM reloads, then the dropdown still shows Chaizzik.
- Given the saved actor was deleted, or no longer a player character, when the panel renders, then it falls back to "GM".

## Non-goals
- GM posts in Foundry's own chat box (the chat-forwarding path still skips GM posts).
- Speaking as NPCs.
- Any change to the Claude-side server or label format.

## Open questions
None.
