# Moderator kit

A discord.js v14 moderation bot. Settings are per server in `config.json`. It filters words and links, records warnings, times out, kicks, bans, purges, writes a mod log, and can enable raid mode (slowmode on configured channels, plus a timeout or role gate for new joins).

Requires Node.js 22.12 or newer (`engines` and `engine-strict=true`). Node.js 20 is outside this kit's supported runtime. The invite does not request Administrator.

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

Commands are disabled in DMs. Every command checks its permission again when it runs. Discord's default visibility is not the check. A member who can see the command but does not hold the permission is refused. Administrator still counts as holding every permission, which is how Discord evaluates it.

The bot refuses to warn, time out, kick, or ban itself, the server owner, or anyone whose highest role is above the bot or the moderator. The owner can act on members below the bot. `/warn` uses that hierarchy too.

Timeout, kick, and ban write `By <moderator id>:` in front of the reason. Discord's audit log shows the bot as the actor, so the id is how you can see who requested it. Filter deletes use the reason `Filter (word)` or `Filter (link)`. `/purge` calls bulk delete. This version of discord.js does not take an audit-log reason for that call. The mod log still records the moderator.

A ban looks up the member first. Error `10007` (unknown member) means they left, so there is no role to compare and the ban continues. Any other lookup error stops the ban. A failed lookup must not skip the hierarchy check.

Each moderator can run 5 moderation commands per 15 seconds. The 6th is refused until the window passes.

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

Warnings are stored in `data/warnings.json`. Raid slowmode snapshots are stored in `data/raid-snapshots.json` so a restart can restore the previous slowmode. Set `DATA_DIR` to move both files. The default is `./data` relative to the working directory. Both paths are gitignored. Writes use a temp file and rename. Copy those two files for a backup, preferably while the process is stopped. This kit does not ship a second backup copy. If a restore to Discord fails, the snapshot is kept and the next sync tries again. The pre-raid slowmode is written before Discord is asked to change it. A lost response does not replace that snapshot with the raid slowmode. The next sync retries the change and, when raid mode is turned off, restores the original value.

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
| `raidMode.joinHold.roleId` | Required when `type` is `role`. See the role rules below. |
| `exemptRoleIds` | Optional. Members with one of these roles are not filtered. |

Bot messages are not filtered. Members with Administrator, Moderate Members, or Manage Messages are not filtered, and neither is anyone in `exemptRoleIds`. If the member cannot be loaded, the message is left in place so a moderator is not deleted by mistake. That also means a message with no resolvable member is not filtered. Deletes are capped at 6 per 10 seconds per server. After that, matching messages stay and one mod-log line is written for the window.

A role hold adds one role. It does not remove other roles, and it does not edit channel overwrites. It is not applied when the bot lacks Manage Roles, when the bot's highest role is not above the target, or when the role is `@everyone`, managed by an integration, or elevated. Elevated here means Administrator, Manage Guild, Manage Roles, Manage Channels, Manage Webhooks, Manage Messages, Ban Members, Kick Members, Moderate Members, Mention Everyone, Mute Members, Deafen Members, Move Members, Manage Nicknames, or Manage Threads. A timeout hold is skipped when Discord says the member is not moderatable. New joins that happen while the bot is offline are not held retroactively.

`/raid on` writes `raidMode.enabled` for the current server, creating a default guild entry when the id is missing. Edit `channelIds` and `joinHold` in `config.json` before or after. Turning raid mode off asks Discord to put back the slowmode from before it was enabled. The snapshot is removed only after that call succeeds.

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

`Dockerfile` uses `node:22-slim`, fails the build if the image is older than Node.js 22.12.0, and runs as the `node` user. `railway.json` sets `restartPolicyType` to `ALWAYS`.

This is a Gateway bot. It is not deployable to Vercel or another serverless host that stops the process between requests. Filters, join hold, and raid sync run only while the process is up. Railway bills the running service; nothing here is guaranteed free.

Point the Railway service root at `kits/moderator`. Set `DISCORD_BOT_TOKEN` and `CLIENT_ID`. Provide `config.json` at `/app/config.json` or `CONFIG_PATH`. The file is gitignored, so a git deploy does not include it. Mount a volume over `data/` (or over `DATA_DIR`) or warnings and raid snapshots disappear when the container is replaced. The image does not contain that data. The `node` user (uid 1000) must be able to write `config.json` for `/raid` and the data directory.

Changing `config.json` is a change on that host. Reloading the file is not a remote API, and there is no management port. A newer image does not overwrite a customer's config or data.

Automated tests mock Discord. They do not prove live permissions, audit-log text, or slowmode on a real server. Before relying on this bot, invite it to a test server and check: a member without the command permission is refused; a warning against the owner is refused; a filtered word from a moderator stays; raid mode restores the old slowmode after a restart; a join-hold role with Administrator is not assigned; an unrelated member is not given that role.

## Tests

These are automated tests with mocked Discord boundaries, not live Discord tests.

```bash
cd kits/moderator && npm ci && npm run lint && npm test
```
