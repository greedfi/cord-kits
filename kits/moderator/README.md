# Moderator kit

A discord.js v14 moderation bot. Settings are per server in `config.json`. It filters words and links, records warnings, times out, kicks, bans, purges, writes a mod log, and can enable raid mode (slowmode on configured channels, plus a timeout or role gate for new joins).

Requires Node.js 20 or newer. The invite does not request Administrator.

## Intents

| Intent | Enum | Privileged |
| --- | --- | --- |
| Guilds | `Guilds` | no |
| Guild Messages | `GuildMessages` | no |
| Message Content | `MessageContent` | yes |
| Server Members | `GuildMembers` | yes |

Turn on **Message Content Intent** and **Server Members Intent** in the Developer Portal or the filters and join hold will not see message text or new members.

## Permissions

| Permission | Why |
| --- | --- |
| View Channel | Read channels and reply |
| Send Messages | Replies and the mod log |
| Read Message History | `/purge` |
| Manage Messages | Delete filtered messages and `/purge` |
| Moderate Members | `/warn`, `/timeout`, `/raid`, join-hold timeouts |
| Kick Members | `/kick` |
| Ban Members | `/ban` |
| Manage Channels | Raid-mode slowmode |
| Manage Roles | Raid-mode role gate |

Permission integer: **1099780140054**

Invite URL template:

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=1099780140054
```

Command defaults (Server Settings → Integrations can override these):

| Command | Default permission |
| --- | --- |
| `/warn`, `/timeout`, `/raid` | Moderate Members |
| `/kick` | Kick Members |
| `/ban` | Ban Members |
| `/purge` | Manage Messages |

Commands are disabled in DMs. The bot still refuses to act on itself, the server owner, or anyone whose highest role is above the bot or the moderator (the owner can act on members below the bot).

## Setup

```bash
cd kits/moderator
npm install
cp .env.example .env
cp config.example.json config.json
```

`.env`:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `CLIENT_ID` | yes for `npm run register` | Application id |
| `GUILD_ID` | no | Register commands to one server. Omit for global commands. |

`config.json` is gitignored. `guilds` is keyed by server id. Copy `config.example.json`, replace the sample ids, and set `enabled` on the filters you want. The process watches the config directory. A bad write keeps the last good config and logs an error. Validate the file against `config.schema.json` (the process does this on every load).

```bash
npm run register
npm start
```

Global commands can take up to an hour to appear. Use either guild or global registration, not both, or delete the old set in the Developer Portal.

Warnings are stored in `data/warnings.json`. Raid slowmode snapshots are stored in `data/raid-snapshots.json` so a restart can restore the previous slowmode. Both paths are gitignored.

## Config fields

`guilds.<guild id>`:

| Field | Meaning |
| --- | --- |
| `modLogChannelId` | Channel for plain-text mod logs, or `null`. |
| `wordFilter.enabled` | Delete messages that match. |
| `wordFilter.match` | `word` (whole word) or `contains`. |
| `wordFilter.words` | Case-insensitive list. |
| `linkFilter.enabled` | Delete messages with a disallowed link. |
| `linkFilter.mode` | `off`, `allowlist`, or `blocklist`. |
| `linkFilter.domains` | Hostnames such as `example.com`, lowercase or mixed case. |
| `linkFilter.allowSubdomains` | `www.example.com` matches `example.com` when true. |
| `raidMode.enabled` | Also toggled with `/raid`. |
| `raidMode.slowmodeSeconds` | Slowmode applied while raid mode is on (0–21600). |
| `raidMode.channelIds` | Channels that receive that slowmode. |
| `raidMode.joinHold.type` | `off`, `timeout`, or `role`. |
| `raidMode.joinHold.timeoutMinutes` | 1–40320 (28 days). |
| `raidMode.joinHold.roleId` | Required when `type` is `role`. The bot's role must be above it. |

Bot messages are not filtered. A role gate adds the role; it does not remove other roles. Set that role's channel overwrites so held members cannot speak. New joins that happen while the bot is offline are not held retroactively.

`/raid on` writes `raidMode.enabled` for the current server, creating a default guild entry when the id is missing. Edit `channelIds` and `joinHold` in `config.json` before or after. Turning raid mode off restores the slowmode values from before it was enabled.

## Commands

| Command | Behavior |
| --- | --- |
| `/warn` | Stores a warning, tries to DM the member, logs the count. |
| `/timeout` | Discord timeout, 1–40320 minutes. |
| `/kick` | Kicks with a reason. |
| `/ban` | Bans, with optional `delete_days` from 0 to 7. |
| `/purge` | Deletes up to 100 messages younger than 14 days. Optional user filter scans the last 100. |
| `/raid` | `on` or `off`. |

## Hosting

`Dockerfile` uses `node:20-slim` and runs as the `node` user. `railway.json` sets `restartPolicyType` to `ALWAYS`.

Point the Railway service root at `kits/moderator`. Set `DISCORD_BOT_TOKEN` and `CLIENT_ID`. Provide `config.json` at `/app/config.json` or `CONFIG_PATH`. The file is gitignored, so a git deploy does not include it. The `node` user must be able to write `config.json` for `/raid`, and write `data/` for warnings and raid snapshots.
