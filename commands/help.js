const { EmbedBuilder } = require('discord.js');
const metadata = require('./metadata');
const { canView, accessLabel } = metadata;

module.exports = { name: 'help', async execute({ interaction, hasRole, roles }) {
  await interaction.deferReply({ ephemeral: true });
  const groups = {};
  for (const [name, item] of Object.entries(metadata)) {
    if (typeof item !== 'object' || !item.category || !canView(item.access, hasRole, roles)) continue;
    let examples = `Example: \`${item.usage}\``;
    const staff = hasRole(roles.COMMAND_STAFF_ROLE_ID) || hasRole(roles.INSTRUCTOR_PILOT_ROLE_ID);
    if (staff && ['myactivity', 'myairports', 'mycgas'].includes(name)) {
      const example = name === 'myairports' ? '/myairports pilot_id:3015' : `/${name} user:@Pilot`;
      examples += `\nStaff lookup: \`${example}\``;
    }
    (groups[item.category] ||= []).push(`**/${name}**${accessLabel(item.access)}\n${item.description}\n${examples}`);
  }
  const embed = new EmbedBuilder().setTitle('vUSCG Bot Help').setColor(0x3498db)
    .setDescription('Commands shown below match your current roles. Permission checks are still enforced when commands run.');
  for (const [category, entries] of Object.entries(groups)) embed.addFields({ name: category, value: entries.join('\n\n').slice(0, 1024) });
  return interaction.editReply({ embeds: [embed] });
}};
