# Reaction roles kit

A discord.js v14 bot that posts a button panel or a select menu and adds or removes the chosen roles. This is not an emoji reaction role. Classic reactions are left out on purpose.

Requires Node.js 22.12 or newer (`engines` and `engine-strict=true`). The invite does not request Administrator.

Automated tests mock Discord. They are not live role changes. Use the checklist below on a test server.

## Intents

| Intent | Privileged |
| --- | --- |
| Guilds | no |

## Permissions

| Permission | Why |
| --- | --- |
| View Channel | See the panel channel |
| Send Messages | Post the panel |
| Read Message History | Edit the panel later |
| Manage Roles | Add and remove the configured roles |

Permission integer: **268504064**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=268504064
```

`/roles` defaults to Manage Roles. The handler checks that permission again, or `managerRoleId` when you set one. A member who can see the command but has neither is refused.

The bot will not assign or remove a role that is `@everyone`, managed by an integration, above the bot, or elevated. Elevated means Administrator, Manage Guild, Manage Roles, Manage Channels, Manage Webhooks, Manage Messages, Ban Members, Kick Members, Moderate Members, Mention Everyone, Mute Members, Deafen Members, Move Members, Manage Nicknames, or Manage Threads. The check runs when the role is added to the panel, when the panel is published, and again on every click.

An exclusive panel keeps one role from that panel. Roles the member has that are not on the panel are not touched. A non-exclusive panel stops at `max_roles`. A deleted role is removed from the saved panel and the click gets a short reply instead of throwing. An old button whose panel was deleted says the panel is no longer active.

## Setup

```bash
cd kits/reaction-roles
npm install
cp .env.example .env
cp config.example.json config.json
npm run register
npm start
```

Secrets are `DISCORD_BOT_TOKEN`, `CLIENT_ID`, and optional `GUILD_ID`. Logs redact the token. There is no HTTP port.

`/roles create` stores a panel. `/roles add` adds a role. `/roles publish` posts it. `/roles delete` forgets the panel and leaves the Discord message where it is; its buttons then do nothing.

`config.json` reloads from disk. A bad write keeps the last good file. That file is not a remote API. A new image does not replace a customer's config or `panels.json`.

## Storage

The image sets `DATA_DIR=/data` and `CONFIG_PATH=/data/config.json`. Mount a volume on `/data`. `panels.json` is the state. The previous good write is kept as `panels.json.bak`. If the main file is corrupt, the process restores the backup. If both are corrupt, it refuses to start. Copy both files to back up. Run one process. A second process on the same directory is blocked while the file lease is valid. That lease is not a distributed lock. Do not run a second replica. Do not put the data directory on network-shared storage. If this process loses the lease, it stops changing roles and stops posting panels.

Clicks are serialized in the process so two clicks cannot both pass an exclusive check. This is a Gateway bot. It is not deployable to Vercel or another host that stops the process. Railway bills the running container. Nothing here is guaranteed free.

## Manual acceptance

- [ ] Invite with integer 268504064 and confirm the permission screen.
- [ ] Publish a button panel with two safe roles and confirm a member receives one.
- [ ] Confirm an exclusive panel removes the previous panel role and not an unrelated role.
- [ ] Try to add an Administrator role and confirm the bot refuses.
- [ ] Delete the Discord role, click the old button, and confirm the bot replies instead of crashing.
- [ ] Restart the process and confirm the same button still works.
- [ ] Confirm a member without Manage Roles cannot publish a panel.

## Tests

```bash
cd kits/reaction-roles && npm ci && npm run lint && npm test
```
