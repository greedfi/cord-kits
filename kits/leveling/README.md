# Leveling kit

A discord.js v14 bot that awards flat XP for messages and can add a safe role when a level is crossed.

Requires Node.js 22.12 or newer. The invite does not request Administrator. Automated tests mock Discord. They do not prove XP on a live server.

The level formula is exact: the XP required to **be** level `n` is `50 * n * (n + 1)`. Level 1 is 100 XP, level 2 is 300, level 100 is 505000. The cap is level 200.

## Intents

| Intent | Privileged |
| --- | --- |
| Guilds | no |
| Guild Messages | no |

**Message Content is not enabled.** The bot does not read message text. It counts a guild message that is not from a bot, a system message, or a webhook. A throwing `content` getter is part of the automated test. This needs a running Gateway connection. An interactions-only host will not see messages and will not award XP.

XP is per server. The same user in another server has a separate total. The default is 15 XP per counted message, at most once per 60 seconds for that member. A server can set 1–50 XP and a cooldown of 0–3600 seconds. Excluded channel ids and role ids award nothing. A server is also limited to 20 counted messages per 10 seconds so a flood does not write the disk for every message.

## Role rewards

`rewards` lists `{ level, roleId }`. The role is added only when the member crosses that level. It is refused when the bot lacks Manage Roles, or the role is missing, managed, `@everyone`, above the bot, or elevated (Administrator and the moderation permissions used by the other kits). A refused role is remembered as skipped and is not retried. A Discord error leaves the role pending. Startup and the next successful path retry pending roles. Rewards are not removed when someone is later excluded.

## Permissions

| Permission | Why |
| --- | --- |
| View Channel | See channels the bot is counting |
| Send Messages | Reply to `/rank` and `/leaderboard` |
| Manage Roles | Add a configured safe reward role |

Permission integer: **268438528**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=268438528
```

If you will not use rewards, you can remove Manage Roles from the invite. The bot then skips every reward.

`/rank` and `/leaderboard` are available to members of the server. The leaderboard mentions users with mentions disabled, so it should not ping them. Ties sort by user id.

## Storage

`levels.json` is in `DATA_DIR` (the image uses `/data`). Mount a volume. Writes are serialized in the process, so concurrent messages do not lose XP. `levels.json.bak` is the previous good write. A corrupt main file is restored from the backup. If both are corrupt, the process refuses to start. Copy both files to back up. Run one replica. Two replicas that do not share the directory will each award XP.

`config.json` reloads from disk. A bad write keeps the last good file. There is no HTTP API. A new image does not replace a customer's files.

This is not deployable to Vercel or another host that suspends the process. While the process is down, messages are not counted and are not backfilled. Railway bills the running container. Nothing here is guaranteed free.

## Manual acceptance

- [ ] Invite with integer 268438528 and enable no privileged intents.
- [ ] Send two messages inside the cooldown and confirm only one award.
- [ ] Restart and confirm `/rank` shows the same XP.
- [ ] Confirm an Administrator reward role is not added.
- [ ] Confirm a channel in `excludedChannelIds` does not award XP.
- [ ] Confirm another server does not show this server's XP.

## Tests

```bash
cd kits/leveling && npm ci && npm run lint && npm test
```
