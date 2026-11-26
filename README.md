# model-picker

A Claude Code mod that suggests a model and effort level for each task. Before it suggests a cheaper model, it estimates whether switching pays off, because a switch can mean building a new prompt cache.

**Early test version.** The mod API is early access, so a Claude Code update can break it. It was built with Claude Code 2.1.331. The automated tests use a simulated engine.

**Checked by hand in the desktop app's Code tab** (a few single tests):

- A switch from Opus 5.5 to Haiku 5.5, with Haiku 5.5 answering.
- A follow-up message that stayed on Haiku 5.5.
- A switch back from Haiku 5.5 to Opus 5.5 for a harder task.
- The orange footer label after the switch to Haiku 5.5.

**Not yet checked in the live app:** the effort level actually used for an answer, the grey footer label, upgrades above your own model, subagents, longer tasks that use tools, auto mode, and the terminal.

It works in Claude Code (terminal and the desktop app's Code tab). It does not work in normal Claude chats.

## Install

In a Claude Code terminal session:

```
/plugin install model-picker --marketplace LKaliszan/model-picker
```

In the desktop app's Code tab: click **+** next to the prompt box, then **Plugins**, add the marketplace `LKaliszan/model-picker`, then add **model-picker**.

If you use another mod that sets effort or model automatically, turn it off first.

## What it does

- **Judge:** Haiku 5.5 rates your prompts: which model, which effort, whether a mistake would be costly, and how many requests the task may take. So that desktop app messages are not missed, it also rates prompts sent through the SDK (including `claude -p`) and prompts of unknown origin. Slash commands, notifications and scheduled prompts are not rated.
- **Asks first:** it asks before changing your main model.
- **Cost check:** it offers a cheaper model only if the estimate saves at least 20% and half a cent.
- **Risky tasks:** it does not go below your own model.
- **Subagents:** without asking, it can start `general-purpose` and `claude` subagents on a cheaper model, and shows a notice.
- **Footer:** shows the model and effort of the latest request, as `Picker:` when the mod changed something and `Running:` when it did not. In the desktop app, `Picker:` is orange. The app's own model menu keeps showing your setting.
- It does not change your saved model or effort settings.

An accepted change can carry into later prompts.

## Commands

| Command | Effect |
|---|---|
| `/model-picker` | Show the status and the last request |
| `/model-picker ask` | Ask before changing model or effort (default) |
| `/model-picker auto` | Set effort without asking; still ask before changing the main model |
| `/model-picker off` | Change nothing |
| `/model-picker reset` | Return to your own model and effort |

## Usage, privacy and cost

- The judge calls run on **your** Claude account and add some usage.
- The judge receives up to 4,000 characters of your prompt and 600 of Claude's last reply. For a subagent, it receives up to 4,000 characters of its task.
- A local log, `~/.claude/mods-logs/model-picker.log`, records where each prompt came from (not its text), decisions, model names, cache token counts and subagent task descriptions. A decision can include model and effort names and cost estimates. The mod does not upload the log.
- Cost figures are rough estimates. They use API list prices fixed in the code (reference dated 2026-11-03), assume 1,000 output tokens per request, and leave out judge calls and the cost of switching back. They are not your bill. On a subscription, usage is not billed this way.
- In a new chat, the estimate uses the saved size of an earlier chat's first request, or 100,000 tokens if none is saved, and assumes nothing is cached yet.
- **Estimates can be far off.** In one live test, the switch back to Opus was estimated at $0.95 on the assumption that Opus had to rebuild its cache. The request in fact read almost the whole chat from cache. Do not treat the figures as actual costs or guaranteed savings. Switching back to your own model does not depend on the estimate.
- It switches among Haiku 5.5, Sonnet 5.5 and Opus 5.5, so your account needs access to them.

## License

You may install and use unmodified copies, including for work. You may not change or redistribute the code without written permission. This is not an open source license. See [LICENSE](LICENSE) for the full terms.

## Credit

The idea of picking an effort level for each prompt, and the general approach to effort levels, come from Ben AI's effort-optimizer mod. This mod was written separately and includes none of its files.
