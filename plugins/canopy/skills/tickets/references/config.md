# `tickets.config.md` — per-team defaults for the `tickets` skill

Optional. The `tickets` skill looks for `tickets.config.md` at the repo root, then `.claude/`. If
neither exists, every default below applies and the skill works fine.

## What this file is — and what it is NOT

This config expresses a **team's taste** about writes that are already permitted. It is read by the
skill, so it binds an agent that *honours* the skill.

**It is not a permission system.** A bearer token can call the MCP tools directly without ever loading
this file. Everything that actually has to hold is enforced by the Worker, where no config can reach:

| Enforced by the Worker (binding on every bearer) | Expressed here (advisory) |
|---|---|
| You may write only to tickets **already assigned to you** | Which category/priority to default to |
| After filing, only an admin, the requester or an assignee may (re)assign (`assign_ticket`) | Whether to self-assign at filing |
| Deleting or completing a sprint needs the person's confirmation | Which sprint a new ticket lands in |
| The status machine (`submitted → in_progress → testing → done`…) | Which of those moves the skill will *offer* |
| Nesting is exactly one level | A prefix on agent-written comments |
| Handles must resolve to a real person | Whether to confirm before writing |

So: setting `offer_transitions: start-only` stops the *skill* proposing `done`. It does not stop the
tool accepting it. If your team needs a rule that actually binds, it belongs in the Worker — open an
issue rather than writing it here.

## Keys

All optional. Unknown keys are ignored.

| Key | Default | Meaning |
|---|---|---|
| `default_category` | `other` | Category for tickets the agent files when the person didn't say. One of `bug` / `request` / `question` / `access` / `other`. |
| `default_priority` | `normal` | Same, for priority: `low` / `normal` / `high`. |
| `landing_sprint` | `backlog` | Where a filed ticket lands: `backlog` (no sprint), `active` (the one sprint currently in progress — if two are, ask), or a sprint id. |
| `self_assign_on_create` | `true` | Whether the agent puts its own principal on tickets it files. **This is the lever on the one escalation the design has**: a self-assigned ticket is in the agent's lane, so it can later resolve it. Set `false` on a team that wants a person to pick up everything, including what an agent filed. (As the ticket's requester the agent could still add itself later with `assign_ticket` — the skill never does that unasked.) |
| `offer_transitions` | `all` | Which moves the skill proposes. `all`, or `start-only` (`submitted → in_progress` and nothing else — a team that wants people to close things). Advisory. |
| `comment_prefix` | *(none)* | Prepended to every comment the agent posts, e.g. `[via claude]`. Canopy stores **no** provenance on a write, so this is the only thing that makes an agent's comment recognizable in the ticket history. |
| `require_confirmation` | `true` | Show the one-line diff and wait before any write. `done` / `declined` and `complete_sprint` are **always** confirmed regardless of this setting — they resolve work for the whole org. |
| `link_repo` | `SaplingLearn/sapling` | The repo a bare `#214` resolves against. Must match `DEFAULT_TICKET_REPO` in `shared/tickets.ts` — the server parses the link, not the skill, so a mismatch here just makes the skill's preview wrong. |

## Example

````markdown
# tickets.config.md

```yaml
default_category: request
default_priority: normal
landing_sprint: active
self_assign_on_create: false
offer_transitions: start-only
comment_prefix: "[via claude] "
require_confirmation: true
```
````
