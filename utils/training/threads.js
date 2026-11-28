const { ChannelType } = require('discord.js');

async function findPrivateTrainingThreads(parent, pilotId) {
  if (!parent?.threads || !/^\d{1,15}$/.test(String(pilotId))) return [];
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
    if (matches.size > 1) return [...matches.values()];
    // Discord orders joined archived private threads by descending snowflake.
    const archived = await parent.threads.fetchArchived({ type: 'private', limit: 100, before });
    collect(archived.threads);
    if (!archived.hasMore) break;
    const next = archived.threads.last();
    if (!next || (before && BigInt(next.id) >= BigInt(before.id))) throw new Error('Training thread pagination stalled');
    before = next;
  } while (true);

  return [...matches.values()];
}

async function findTrainingThread(parent, { pilotId, discordId }) {
  if (!discordId) return null;
  const matches = await findPrivateTrainingThreads(parent, pilotId);
  if (matches.length !== 1) return null;
  const [thread] = matches;
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

module.exports = { findPrivateTrainingThreads, findTrainingThread, postToTrainingThread };
