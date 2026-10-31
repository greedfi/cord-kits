export function moderationBlock({
  actorId,
  targetId,
  ownerId,
  botId,
  actorHighest = 0,
  targetHighest = 0,
  botHighest = 0,
}) {
  if (targetId === actorId) return 'self'
  if (targetId === botId) return 'bot'
  if (targetId === ownerId) return 'owner'
  if (targetHighest >= botHighest) return 'bot_hierarchy'
  if (actorId !== ownerId && targetHighest >= actorHighest) return 'actor_hierarchy'
  return null
}

export const MODERATION_BLOCK_REASON = {
  self: 'You cannot use that command on yourself.',
  bot: 'You cannot use that command on this bot.',
  owner: 'You cannot moderate the server owner.',
  bot_hierarchy: 'My highest role needs to be above that member.',
  actor_hierarchy: 'That member’s highest role is above yours.',
}
