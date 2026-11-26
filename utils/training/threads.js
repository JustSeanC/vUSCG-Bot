const { ChannelType } = require('discord.js');

async function findTrainingThread(parent, { pilotId, discordId }) {
  if (!parent?.threads || !/^\d{1,15}$/.test(String(pilotId)) || !discordId) return null;
  const name = `Training Case for C${pilotId}`;
  const matches = new Map();
  const collect = threads => {
    for (const thread of threads.values()) {
      if (thread.parentId === parent.id && thread.type === ChannelType.PrivateThread && thread.name === name) {
        matches.set(thread.id, thread);
      }
    }
  };

  const active = await parent.threads.fetchActive();
  collect(active.threads);
  let before;
  do {
    if (matches.size > 1) return null;
    // Discord orders joined archived private threads by descending snowflake.
    const archived = await parent.threads.fetchArchived({ type: 'private', limit: 100, before });
    collect(archived.threads);
    if (!archived.hasMore) break;
    const next = archived.threads.last();
    if (!next || (before && BigInt(next.id) >= BigInt(before.id))) return null;
    before = next;
  } while (true);

  if (matches.size !== 1) return null;
  const [thread] = matches.values();
  if (thread.locked || !(await thread.members.fetch({ member: discordId, force: true }))) return null;
  return thread;
}

async function postToTrainingThread(parent, trainee, payload) {
  let thread;
  try {
    thread = await findTrainingThread(parent, trainee);
    if (!thread) return null;
    if (thread.archived) await thread.setArchived(false, 'Post an update in the existing trainee thread');
  } catch {
    return null;
  }
  return thread.send({ ...payload, allowedMentions: { parse: [], repliedUser: false } });
}

module.exports = { findTrainingThread, postToTrainingThread };
