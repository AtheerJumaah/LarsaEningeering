/* Synthetic-only fixtures for the future attendance identity-binding gate.
 *
 * These identifiers are deliberately non-production values. Do not replace
 * them with staff IDs, email addresses, Auth UUIDs, credentials, or exported
 * app_state data. The fixture module must remain safe to commit and share.
 */

export const syntheticStaff = Object.freeze({
  self: Object.freeze({
    staff_uid: 'fixture-staff-self-001',
    normalized_email: 'self-001@example.test',
    enabled: true,
    offboarded: false,
    role: 'employee',
  }),
  disabled: Object.freeze({
    staff_uid: 'fixture-staff-disabled-001',
    normalized_email: 'disabled-001@example.test',
    enabled: false,
    offboarded: true,
    role: 'employee',
  }),
  manager: Object.freeze({
    staff_uid: 'fixture-staff-manager-001',
    normalized_email: 'manager-001@example.test',
    enabled: true,
    offboarded: false,
    role: 'manager',
    scope: { team_ids: ['fixture-team-alpha'] },
  }),
  teamMember: Object.freeze({
    staff_uid: 'fixture-staff-team-alpha-001',
    normalized_email: 'team-alpha-001@example.test',
    enabled: true,
    offboarded: false,
    role: 'employee',
    team_id: 'fixture-team-alpha',
  }),
  otherTeam: Object.freeze({
    staff_uid: 'fixture-staff-other-team-001',
    normalized_email: 'other-team-001@example.test',
    enabled: true,
    offboarded: false,
    role: 'employee',
    team_id: 'fixture-team-beta',
  }),
  blankEmail: Object.freeze({
    staff_uid: 'fixture-staff-blank-email-001',
    normalized_email: null,
    enabled: true,
    offboarded: false,
    role: 'employee',
  }),
});

export const syntheticAuth = Object.freeze({
  self: Object.freeze({
    auth_user_id: '00000000-0000-4000-8000-000000000001',
    email: 'self-001@example.test',
    is_anonymous: false,
    deleted_at: null,
  }),
  manager: Object.freeze({
    auth_user_id: '00000000-0000-4000-8000-000000000002',
    email: 'manager-001@example.test',
    is_anonymous: false,
    deleted_at: null,
  }),
  anonymous: Object.freeze({
    auth_user_id: '00000000-0000-4000-8000-000000000003',
    email: null,
    is_anonymous: true,
    deleted_at: null,
  }),
  unmapped: Object.freeze({
    auth_user_id: '00000000-0000-4000-8000-000000000004',
    email: 'unmapped-001@example.test',
    is_anonymous: false,
    deleted_at: null,
  }),
  collision: Object.freeze({
    auth_user_id: '00000000-0000-4000-8000-000000000005',
    email: 'self-001@example.test',
    is_anonymous: false,
    deleted_at: null,
  }),
});

export const syntheticSessions = Object.freeze({
  mappedSelf: Object.freeze({
    auth_uid: syntheticAuth.self.auth_user_id,
    is_anonymous: false,
    mapped_staff_uid: syntheticStaff.self.staff_uid,
  }),
  mappedManager: Object.freeze({
    auth_uid: syntheticAuth.manager.auth_user_id,
    is_anonymous: false,
    mapped_staff_uid: syntheticStaff.manager.staff_uid,
  }),
  anonymous: Object.freeze({
    auth_uid: syntheticAuth.anonymous.auth_user_id,
    is_anonymous: true,
    mapped_staff_uid: null,
  }),
  unmapped: Object.freeze({
    auth_uid: syntheticAuth.unmapped.auth_user_id,
    is_anonymous: false,
    mapped_staff_uid: null,
  }),
});

export const identityBindingCases = Object.freeze([
  Object.freeze({
    id: 'SELF-001',
    name: 'mapped enabled self punch',
    session: syntheticSessions.mappedSelf,
    client_uid: syntheticStaff.self.staff_uid,
    target_uid: syntheticStaff.self.staff_uid,
    expected: { outcome: 'authorized', server_staff_uid: syntheticStaff.self.staff_uid },
  }),
  Object.freeze({
    id: 'DENY-ANON-001',
    name: 'anonymous session cannot write attendance',
    session: syntheticSessions.anonymous,
    client_uid: syntheticStaff.self.staff_uid,
    target_uid: syntheticStaff.self.staff_uid,
    expected: { outcome: 'forbidden', reason: 'anonymous_session' },
  }),
  Object.freeze({
    id: 'DENY-UNMAPPED-001',
    name: 'non-anonymous unmapped session cannot write attendance',
    session: syntheticSessions.unmapped,
    client_uid: syntheticStaff.self.staff_uid,
    target_uid: syntheticStaff.self.staff_uid,
    expected: { outcome: 'forbidden', reason: 'unmapped_identity' },
  }),
  Object.freeze({
    id: 'DENY-MISMATCH-001',
    name: 'mapped self cannot authorize a different client UID',
    session: syntheticSessions.mappedSelf,
    client_uid: syntheticStaff.otherTeam.staff_uid,
    target_uid: syntheticStaff.otherTeam.staff_uid,
    expected: { outcome: 'forbidden', reason: 'client_uid_mismatch' },
  }),
  Object.freeze({
    id: 'DENY-DISABLED-001',
    name: 'disabled staff mapping cannot write attendance',
    session: Object.freeze({
      auth_uid: syntheticAuth.self.auth_user_id,
      is_anonymous: false,
      mapped_staff_uid: syntheticStaff.disabled.staff_uid,
    }),
    client_uid: syntheticStaff.disabled.staff_uid,
    target_uid: syntheticStaff.disabled.staff_uid,
    expected: { outcome: 'forbidden', reason: 'disabled_staff' },
  }),
  Object.freeze({
    id: 'MANAGER-IN-001',
    name: 'manager may target an in-scope employee',
    session: syntheticSessions.mappedManager,
    client_uid: syntheticStaff.teamMember.staff_uid,
    target_uid: syntheticStaff.teamMember.staff_uid,
    target_scope: 'fixture-team-alpha',
    expected: { outcome: 'authorized', server_staff_uid: syntheticStaff.manager.staff_uid },
  }),
  Object.freeze({
    id: 'DENY-MANAGER-SCOPE-001',
    name: 'manager cannot target an out-of-scope employee',
    session: syntheticSessions.mappedManager,
    client_uid: syntheticStaff.otherTeam.staff_uid,
    target_uid: syntheticStaff.otherTeam.staff_uid,
    target_scope: 'fixture-team-beta',
    expected: { outcome: 'forbidden', reason: 'target_out_of_scope' },
  }),
]);
export const enrollmentCases = Object.freeze([
  Object.freeze({ id: 'ENROLL-SELF-001', staff: syntheticStaff.self, auth: syntheticAuth.self, expected: 'eligible' }),
  Object.freeze({ id: 'ENROLL-DISABLED-001', staff: syntheticStaff.disabled, auth: syntheticAuth.unmapped, expected: 'excluded_offboarded' }),
  Object.freeze({ id: 'ENROLL-BLANK-001', staff: syntheticStaff.blankEmail, auth: syntheticAuth.unmapped, expected: 'blocked_blank_email' }),
  Object.freeze({ id: 'ENROLL-COLLISION-001', staff: syntheticStaff.self, auth: syntheticAuth.collision, expected: 'blocked_auth_collision' }),
]);
// End synthetic attendance identity fixtures.
