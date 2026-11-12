# Changelog

## [0.1.1] - 2026-11-12

### Added

- An English, description-backed peer mode picker in place of the input editor. Open it with `/grove peers` or `o` in the Peers tab; move with `j`/`k` or arrow keys, apply with Enter, and cancel with Escape.
- Command argument completion for peer modes and the `global` scope, with behavioral descriptions.

### Changed

- The Peers tab's `o` key now opens the mode picker instead of immediately cycling the mode.

## [0.1.0] - 2026-11-12

### Added

- `/grove` (`alt+g`): the session tree as a lazygit-style graph with Tree, History and Peers tabs, a preview pane, search, labels, jump, jump with summary, and fork.
- Related sessions in one graph: forks, parent sessions and peer sessions are drawn together with the current session.
- Merge edges for branch summaries and peer messages.
- History: a per-session journal of every move within the tree, with a way back to each position.
- Peers: equal pi agents that each own a session branch, a git worktree and a git branch, with the tools `grove_peers`, `grove_spawn`, `grove_send` and `grove_board`.
- Peer modes `auto`, `manual` and `off`, set with `/grove peers <mode>` for one repository, `/grove peers <mode> global` for every repository, or `--grove-peers <mode>` for one run.
- Settings `mode` and `maxPeers` in `~/.pi/agent/pi-grove/config.json` and `<repository>/.git/pi-grove/config.json`.
- `/grove spawn`, `/grove send` and `/grove stop`.
- Peer activity in the conversation is drawn as an exchange: `+` for a new peer, `→` and `←` for messages, `▪` for board notes.
