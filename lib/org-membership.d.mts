export type MembershipDepartment = {
  id: string;
  name?: string;
  headIds?: string[];
};

export type MembershipTeam = {
  departmentId?: string;
  leadIds?: string[];
  memberIds?: string[];
};

export type MembershipOrg = {
  departments?: MembershipDepartment[];
  teams?: MembershipTeam[];
  reporting?: Record<string, string[]>;
};

export type MembershipUser = {
  id: string;
  department?: string;
};

export function departmentMembershipIds(
  org: MembershipOrg | null | undefined,
  user: MembershipUser,
): Set<string>;

export function departmentMemberships(
  org: MembershipOrg | null | undefined,
  user: MembershipUser,
): MembershipDepartment[];
