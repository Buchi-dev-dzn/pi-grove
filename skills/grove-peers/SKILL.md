---
name: grove-peers
description: How to split work across pi-grove peers (grove_spawn, grove_send, grove_board, grove_peers) and integrate their branches. Use before starting a peer, when deciding between a peer and a subagent, when writing a peer's task, when a peer reports back, or when reviewing and integrating a grove/<name> branch.
---

# Working with grove peers

The system prompt already says what the grove tools do. This skill covers the decisions and procedures around them.

## 1. Peer or not?

| Situation | Use |
|---|---|
| Independent code changes in separate files/modules that each need commits | Peer (`grove_spawn`) |
| Two competing approaches to compare on real code | Two peers, e.g. `try-sqlite` and `try-json` |
| A long check (full test matrix, benchmark, bisect) while you keep editing | Peer |
| Read-only search or a question about the codebase | Subagent / direct tools, not a peer |
| Small change (< ~15 min) or tightly coupled to the file you are editing | Do it yourself |

Before spawning, run `grove_peers`: reuse an idle peer that already has the right context (send it a follow-up) instead of starting a new one. Respect `maxPeers`.

## 2. Prepare the starting point

- The peer's worktree starts at your **current commit**. Commit (or ask the user to allow committing) anything the peer needs; uncommitted changes are not copied.
- If peers must agree on an interface (types, API shape, file layout), post it on the board **before** spawning, so every peer reads the same contract.

## 3. Write the task

Use this template for the `task` argument:

```
Goal: <one sentence outcome>
Owns: <files/dirs this peer may edit>
Do not touch: <areas owned by you or other peers>
Context: <decisions, contracts (or "see board"), relevant files>
Verify: <exact command(s), e.g. npm run check && npm test>
Report: send me the branch, what changed, verification output, open questions
```

- `name`: describe the outcome (`parser-errors`, `docs-peers`), not the agent.
- `context: "fresh"` when the task is self-contained: cheaper and less biased. Keep the default `fork` only when the conversation holds decisions the peer needs that would be long to restate.
- `model`: leave unset unless the user asked or the task is clearly mechanical.

## 4. While peers work

- Continue your own part; reports arrive as messages. Do not poll `grove_peers` in a loop.
- Board: decisions, contracts, ownership changes. Not progress updates.
- `grove_send`: questions, answers, blockers, changed requirements. Include everything the receiver needs: it cannot see your conversation. No acknowledgements.
- If you need to change a contract, post it on the board and message affected peers in one `grove_send` to `all`.

## 5. When a peer reports

Treat the report as a claim, then verify:

1. `git log --oneline main..grove/<name>` and `git diff main...grove/<name>` (use your base branch instead of `main`). Check the diff stays within the peer's owned area.
2. Run the verification command yourself, in the peer's worktree (`<repo>.grove/<name>`) or after integrating.
3. If something is wrong, send the peer a concrete follow-up (file, failure, expected behavior); it keeps its context.
4. Do **not** merge, rebase, push or delete branches unless the user asked. Otherwise tell the user which branches are verified and ready, with the commands you would run.

## 6. Cleanup

- When the user approves integration and it is done, stop the peer (`/grove stop <name>`) and forget it from the Peers tab (`d`); the branch is kept, and deleting it is the user's call.
- Never remove a worktree with uncommitted changes or a peer that still has an unanswered question.
