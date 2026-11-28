const { createHash, randomUUID } = require('node:crypto');
const { first, transaction } = require('./service');
const { TrainingError, code, text, recordId, snowflake, pilotNumber } = require('./validation');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function httpsUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 1000 || /[\s<>\\\u0000-\u001f\u007f]/.test(value) ||
        !/^https:\/\//i.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.href.length > 1000) throw new Error();
    return url.href;
  } catch {
    throw new TrainingError('Enter a valid HTTPS URL without credentials or spaces.');
  }
}

function label(value, name, max) {
  const result = text(value, name, true);
  if (result.length > max || /[\r\n]/.test(result)) throw new TrainingError(`${name} must fit on one line (up to ${max} characters).`);
  return result;
}

async function category(db, value, lock = false) {
  const id = code(value, 'resource category');
  const item = await first(db, `SELECT category_id, name, active FROM vuscg_training_resource_categories
    WHERE category_id = ?${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!item?.active) throw new TrainingError('This training resource category is unavailable.');
  return item;
}

function resource(db, id, lock = false) {
  return first(db, `SELECT resource_id, category_id, title, url, description, display_order, active
    FROM vuscg_training_resources WHERE resource_id = ?${lock ? ' FOR UPDATE' : ''}`, [recordId(id)]);
}

async function listResources(db, categoryId, { includeInactive = false, limit = 25, offset = 0 } = {}) {
  const [rows] = await db.query(`SELECT resource_id, category_id, title, url, description, display_order, active
    FROM vuscg_training_resources WHERE category_id = ? AND (? OR active)
    ORDER BY display_order, resource_id LIMIT ? OFFSET ?`, [categoryId, includeInactive, limit, offset]);
  return rows;
}

async function snapshot(db, categoryId) {
  // A configured category can contain any number of links; snapshot this immutable ordered set.
  const [rows] = await db.execute(`SELECT resource_id, title, url, description FROM vuscg_training_resources
    WHERE category_id = ? AND active ORDER BY display_order, resource_id`, [categoryId]);
  return rows;
}

function order(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new TrainingError('Display order must be between 0 and 65535.');
  return value;
}

function prepareResource(action, input) {
  if (action === 'add_category') return { categoryId: code(input.categoryId, 'category'), name: label(input.title, 'Name', 80) };
  if (!['add_link', 'edit_link', 'deactivate_link'].includes(action)) throw new TrainingError('Unknown material change.');
  if (action === 'deactivate_link') return { resourceId: recordId(input.resourceId) };
  const changes = {};
  if (input.title != null || action === 'add_link') changes.title = label(input.title, 'Title', 100);
  if (input.url != null || action === 'add_link') changes.url = httpsUrl(input.url);
  if (input.description != null || action === 'add_link') changes.description = text(input.description, 'Description');
  if (input.order != null || action === 'add_link') changes.display_order = order(input.order ?? 0);
  if (input.active != null || action === 'add_link') changes.active = input.active ?? true;
  if (action === 'edit_link' && !Object.keys(changes).length) throw new TrainingError('Provide at least one change.');
  return { changes, ...(action === 'add_link'
    ? { categoryId: code(input.categoryId, 'category') } : { resourceId: recordId(input.resourceId) }) };
}

async function changeResource(db, { action, prepared, actor, interactionId }) {
  const discordId = snowflake(actor.discordId);
  const pilotId = pilotNumber(actor.pilotId);
  const request = snowflake(interactionId);
  const intent = digest([action, prepared, discordId, pilotId]);
  const receipt = async connection => {
    const prior = await first(connection, 'SELECT resource_id, category_id, intent_hash FROM vuscg_training_resource_audit WHERE interaction_id=?', [request]);
    if (prior && prior.intent_hash !== intent) throw new TrainingError('This interaction already saved a different resource change.');
    return prior;
  };
  try {
    return await transaction(db, async connection => {
      const cached = await receipt(connection);
      if (cached) return cached;
      let before = null;
      let after;
      if (action === 'add_category') {
        after = { category_id: prepared.categoryId, name: prepared.name, active: true };
        await connection.execute('INSERT INTO vuscg_training_resource_categories (category_id,name) VALUES (?,?)', [after.category_id, after.name]);
      } else {
        if (prepared.resourceId) {
          const current = await resource(connection, prepared.resourceId);
          if (!current) throw new TrainingError('Training resource not found.');
          await category(connection, current.category_id, true);
          before = await resource(connection, prepared.resourceId, true);
        } else {
          await category(connection, prepared.categoryId, true);
        }
        const retry = await receipt(connection);
        if (retry) return retry;
        after = { ...(before ?? { resource_id: randomUUID(), category_id: prepared.categoryId }),
          ...(action === 'deactivate_link' ? { active: false } : prepared.changes) };
        const values = [after.title, after.url, after.description, after.display_order, Boolean(after.active), discordId, pilotId];
        if (before) {
          await connection.execute(`UPDATE vuscg_training_resources SET title=?, url=?, description=?, display_order=?, active=?,
            edited_by_discord_id=?, edited_by_pilot_id=?, updated_at=UTC_TIMESTAMP(6) WHERE resource_id=?`, [...values, after.resource_id]);
        } else {
          await connection.execute(`INSERT INTO vuscg_training_resources (title,url,description,display_order,active,
            edited_by_discord_id,edited_by_pilot_id,resource_id,category_id,created_by_discord_id,created_by_pilot_id,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6))`,
          [...values, after.resource_id, after.category_id, discordId, pilotId]);
        }
      }
      await connection.execute(`INSERT INTO vuscg_training_resource_audit (interaction_id,category_id,resource_id,action,
        actor_discord_id,actor_pilot_id,before_snapshot,after_snapshot,intent_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))`, [request, after.category_id, after.resource_id ?? null, action,
        discordId, pilotId, before && JSON.stringify(before), JSON.stringify(after), intent]);
      return after;
    });
  } catch (error) {
    if (error instanceof TrainingError) throw error;
    const existing = await receipt(db);
    if (existing) return existing;
    if (error.code === 'ER_DUP_ENTRY') throw new TrainingError('This training category already exists.');
    throw error;
  }
}

module.exports = { digest, httpsUrl, category, listResources, snapshot, prepareResource, changeResource };
