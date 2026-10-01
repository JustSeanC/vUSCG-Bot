module.exports = {
  myactivity: { category: 'Personal Activity', description: 'Show your 90-day activity and accepted-flight statistics. Staff may target another pilot.', usage: '/myactivity', access: 'member' },
  myairports: { category: 'Personal Activity', description: 'List airports visited by accepted PIREP arrival. Staff may target another pilot.', usage: '/myairports', access: 'member' },
  mycgas: { category: 'Personal Activity', description: 'Show progress through the current Coast Guard air-station tour. Staff may target another pilot.', usage: '/mycgas', access: 'member' },
  help: { category: 'Personal Activity', description: 'Show commands available to you.', usage: '/help', access: 'member' },
  location: { category: 'Flight Operations', description: 'Find aircraft by registration, type, or airport.', usage: '/location search:C6052', access: 'member' },
  mission: { category: 'Flight Operations', description: 'Generate a mission and available aircraft.', usage: '/mission type:SAR aircraft:H60', access: 'member' },
  jumpseat: { category: 'Flight Operations', description: 'Move your current pilot location to an airport.', usage: '/jumpseat airport:KPIE', access: 'member' },
  manualpirep: { category: 'Flight Operations', description: 'File a manual PIREP for your own account.', usage: '/manualpirep registration:C6052 dep:KPIE arr:KEYW time:1:30', access: 'member' },
  activate: { category: 'Staff Tools', description: 'Activate a member and open a training thread.', usage: '/activate pilot_id:1234 user:@member', access: 'command' },
  promote: { category: 'Staff Tools', description: 'Promote a trainee and assign their track.', usage: '/promote pilot_id:1234 user:@member track:rotary', access: 'staffOrInstructor' },
  moveaircraft: { category: 'Staff Tools', description: 'Administratively move an aircraft.', usage: '/moveaircraft registration:C6052 airport:KPIE reason:Ferry', access: 'staffOrInstructor' },
  activity90: { category: 'Staff Tools', description: 'Force-run the submitted-PIREP 90-day report.', usage: '/activity90', access: 'command' },
  forceranksync: { category: 'Staff Tools', description: 'Force recalculation of pilot ranks.', usage: '/forceranksync', access: 'command' },
};

function canView(access, hasRole, roles) {
  if (access === 'member') return true;
  const command = hasRole(roles.COMMAND_STAFF_ROLE_ID);
  const instructor = hasRole(roles.INSTRUCTOR_PILOT_ROLE_ID);
  return access === 'command' ? command : command || instructor;
}

function accessLabel(access) {
  return access === 'command' ? ' — *Command Staff only*' : access === 'staffOrInstructor' ? ' — *Command Staff / Instructor Pilots*' : '';
}

module.exports.canView = canView;
module.exports.accessLabel = accessLabel;
