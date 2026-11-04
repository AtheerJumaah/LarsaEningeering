/* One authoritative many-to-many department rule for the organisation chart,
   Approval Flow, and any screen that displays department membership. */
export function departmentMembershipIds(org, user) {
  const departments = Array.isArray(org?.departments) ? org.departments : [];
  const teams = Array.isArray(org?.teams) ? org.teams : [];
  const ids = new Set();

  teams.forEach((team) => {
    if ((team.memberIds || []).includes(user.id) || (team.leadIds || []).includes(user.id)) {
      if (team.departmentId) ids.add(team.departmentId);
    }
  });

  departments.forEach((department) => {
    if ((department.headIds || []).includes(user.id)) ids.add(department.id);
  });

  const managerIds = new Set(org?.reporting?.[user.id] || []);
  if (managerIds.size) {
    departments.forEach((department) => {
      if ((department.headIds || []).some((id) => managerIds.has(id))) ids.add(department.id);
    });
  }

  const legacyName = String(user.department || "").trim().toLowerCase();
  if (legacyName && legacyName !== "unassigned") {
    departments.forEach((department) => {
      if (String(department.name || "").trim().toLowerCase() === legacyName) ids.add(department.id);
    });
  }

  return ids;
}

export function departmentMemberships(org, user) {
  const ids = departmentMembershipIds(org, user);
  return (Array.isArray(org?.departments) ? org.departments : []).filter((department) => ids.has(department.id));
}
