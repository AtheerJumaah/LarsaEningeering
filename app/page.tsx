"use client";

import Image from "next/image";
import { createPortal } from "react-dom";
import { initLarsaSync, serverNowIso, serverNowMs, pushSyncedKeyNow, SYNCED_KEYS } from "../lib/supabase/sync";
import { mergeStoreText } from "../lib/supabase/merge";
import { initAttendanceLedger, reconcileStoreFromLedger, markLogsRemoved } from "../lib/ledger";
import { initAccountLedger, reconcileAccountsFromLedger, markAccountsRemoved, tombstoneAccount } from "../lib/accounts-ledger";
import { formatHours, formatMinutes } from "../lib/duration.mjs";
import { findPunchSession, planTrim } from "../lib/attendance.mjs";
import { getSupabaseClient, supabaseConfigured } from "../lib/supabase/client";
import { subscribeToPush, unsubscribeFromPush, adoptPushSubscription, thisDeviceSubscribed, pushSupported, pushNeedsHomeScreen, setAppBadge, describeThisDevice, canDisplayNotifications } from "../lib/supabase/push";
import {
  raiseNotifications, fetchFeed, fetchCounts, markNotifications, markAllRead,
  fetchSetup, setCategoryPref, setNotifySettings, updateDevice, removeDevice,
  importLegacy, watchNotifications, notifyConfigured,
  EMPTY_COUNTS,
} from "../lib/supabase/notify";
import type { NotifyRow, NotifyCounts, NotifySetup } from "../lib/supabase/notify";
import { sendMail } from "../lib/supabase/mail"; import { AccountAccess } from "./AccountAccess"; import { OrgStructure } from "./OrgStructure"; import { HierarchyDashboard } from "./HierarchyDashboard"; import { TeamCharts } from "./TeamCharts";import { PlatformSettings } from "./PlatformSettings";
import { SmartCardGrid, type CardSize } from "./SmartCards"; import { canSeeOrgPortal, effectiveOrg, isResponsibleForOthers, staffIdsVisibleTo } from "../lib/org"; import { verifyPassword, hashPassword, hashPin, findByPin, needsUpgrade, isHashed, pinTakenByOther } from "../lib/password"; import { getDeviceId, describeDevice, deviceNeedsVerification, accountingNeedsVerification, verificationRemainingMs, verificationWindowHours, withDeviceRecorded, withDeviceRemoved, describeWhen, findDevice } from "../lib/devices"; import type { TrustedDevice } from "../lib/devices";import { checkVerification, loadPolicy } from "../lib/verification"; import { useDialog } from "./Dialog"; import { popBackCloser } from "./backstack";
import {
  ArrowLeft,
  ArrowRight,
  Archive,
  Award,
  BadgeDollarSign,
  Bell,
  BellOff,
  BookOpen,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  Circle,
  ChevronLeft,
  ChevronRight,
  Clock,
  CircleDollarSign,
  ClipboardCheck,
  ClipboardList,
  Coffee,
  Scissors,
  Database,
  Eye,
  EyeOff,
  FileBarChart,
  FileClock,
  FileSpreadsheet,
  FileText,
  FolderLock,
  FolderKanban,
  Gauge,
  HardHat,
  History,
  IdCard,
  ImagePlus,
  Image as ImageIcon,
  Import,
  KeyRound,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Lock,
  LockKeyhole,
  LockOpen,
  LogOut,
  MessagesSquare,
  Monitor,
  Moon,
  Network,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Plus,
  Presentation,
  Radio,
  ReceiptText,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  Mail,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Smartphone,
  Sun,
  Target,
  Timer,
  Trash2,
  TrendingUp,
  UserCog,
  UserRoundSearch,
  UsersRound,
  Video,
  Wallet,
  WalletCards,
  X,
  type LucideIcon,
} from "lucide-react";
import { ChangeEvent, CSSProperties, FormEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

/* The three embedded engines keep their state in top-level `const` and `let`
   bindings, which never become window properties, so the only way in from the
   parent frame is eval. It exists on every Window at runtime; lib.dom simply
   does not declare it, and a build with type checking on rejects the file
   without this. */
declare global {
  interface Window {
    eval(code: string): unknown;
  }
}

type Engine = "staff" | "hr" | "accounting";
type NativeView =
  | "salesCommissions"
  | "overview"
  | "admin"
  | "access"
  | "corrections"
  | "approvalFlow"
  | "data"
  | "myPoints"
  | "quickClock"
  | "weekSchedule"
  | "accountingHub"
  | "settings"
  | "requests"
  | "presence"
  | "performance"
  | "development"
  | "performanceHistory"
  | "projects"
  | "notifications"
  | "constructionFinancials" | "orgStructure" | "platformSettings"
  | "myPay"
  | "payrollPortal";
type SignInMethod = "email" | "pin";
type NavChannel = "home" | "time" | "performance" | "hr" | "accounting" | "engineering" | "admin";
type BackupScope = "all" | "staff" | "hr" | "accounting";
type PermissionAction = "view" | "add" | "edit" | "delete" | "approve" | "export" | "manage";
type DataScope = "own" | "team" | "department" | "company";
type ProjectAccessMode = "none" | "assigned" | "all";
type PermissionProfile = {
  version: 1;
  preset: string;
  scope: DataScope;
  grants: Record<string, Partial<Record<PermissionAction, boolean>>>;
};
type ChatAttachment = {
  id: string;
  name: string;
  kind: "image" | "video" | "file";
  type: string;
  size: number;
  data: string;
};
type ChatMessage = {
  id: string;
  projectId: string;
  authorId: string;
  authorName: string;
  authorRole: string;
  body: string;
  at: string;
  attachments: ChatAttachment[];
  /* Reaction emoji -> the ids of the people who chose it. Storing ids rather
     than a count means a second tap can remove your own reaction and the room
     can show exactly who agreed to what. */
  reactions?: Record<string, string[]>;
  /* Locked records are contractual: nobody, including an administrator,
     can redact them until an administrator unlocks them first. */
  locked?: boolean;
  deleted?: boolean;
  deletedBy?: string;
  deletedAt?: string;
};
/* A group exists only once an administrator opens one. Projects are created by
   the accounting side for all sorts of reasons, and most never need a shared
   client channel, so the room is a deliberate act rather than an automatic one. */
type ChatRoom = {
  projectId: string;
  name: string;
  purpose: string;
  createdBy: string;
  createdById: string;
  createdAt: string;
  closed?: boolean;
};
type ChatAudit = {
  id: string;
  projectId: string;
  at: string;
  actorId: string;
  actorName: string;
  action: "created" | "posted" | "removed" | "locked" | "unlocked" | "restored" | "closed" | "reopened";
  detail: string;
};
type ChatStore = { version: 1; rooms: ChatRoom[]; messages: ChatMessage[]; audit: ChatAudit[] };
type NotifyChannel = "inApp" | "email" | "push";
type NotifyPrefs = Record<string, Partial<Record<NotifyChannel, boolean>>>;
type AppNotification = {
  id: string;
  event: string;
  title: string;
  body: string;
  at: string;
  toId: string;
  fromName: string;
  read?: boolean;
  itemId?: string;
};
type StaffUser = {
  id: string;
  name: string;
  username?: string;
  password?: string;
  pin?: string;
  access?: string;
  /* When this record was last DELIBERATELY edited (server time). The sync
     merge and push guard settle conflicts by this stamp, so a stale
     wholesale write-back can never revert a role, name, or lifecycle
     change. See lib/supabase/merge.ts. */
  touchedAt?: string;
  /* When each secret was last changed (server time). The repair_008 database
     trigger refuses to let a hashed password or PIN be replaced by a
     DIFFERENT hash carrying an older or missing stamp — which is exactly how
     "my new password stopped working two days later" used to happen: a stale
     record with a newer wholesale save dragged the old hash back. */
  passwordChangedAt?: string;
  pinChangedAt?: string;
  role?: string;
  department?: string;
  email?: string;
  enabled?: boolean;
  /* Offboarding, not deletion. A removed colleague's account moves to the
     Offboarded tab in Users & Access: sign-in is blocked (enabled false), the
     record and all history stay, and the account can be restored any time. */
  offboarded?: boolean;
  offboardedAt?: string;
  offboardedBy?: string;
  /* The account lifecycle after offboarding. Offboarded RESERVES the email
     (reactivate, or move to the Recycling Bin first). Recycling Bin is a
     soft deletion: the record and every work record stay for admin review
     and restore, but the email becomes free for a new Create Account.
     Permanent deletion is a separate Super-Admin-only act, and even that
     leaves the attendance ledger and audit history intact. */
  recycled?: boolean;
  recycledAt?: string;
  recycledBy?: string;
  /* Employment periods and re-onboarding history modes. Multiple periods
     accumulate as a person leaves and returns; historyMode only shapes what
     current REPORTING shows — no mode ever deletes stored history.
       all      → every session this account ever recorded
       current  → sessions from the newest employment period only
       from     → sessions from historyFrom (a date the admin picked) onward */
  employmentPeriods?: { start: string; end?: string }[];
  historyMode?: "all" | "current" | "from";
  historyFrom?: string;
  /* Controlled email changes: identity history, never silently overwritten. */
  emailHistory?: { from: string; to: string; at: string; by: string }[];
  permissions?: string[];
  permissionProfile?: PermissionProfile;
  /* Accounting is closed unless someone is deliberately let in. A Super Admin
     sets this per person in Users & Access; no role grants it by itself and
     no Admin can set it. See accountingAccessAllowed(). */
  accountingAccess?: boolean;
  accountingAccessAt?: string;
  accountingAccessBy?: string;
  notes?: string;
  phone?: string;
  location?: string;
  manager?: string;
  constraints?: unknown[];
  projectAccessMode?: ProjectAccessMode;
  projectIds?: string[];
  notifyPrefs?: NotifyPrefs;
  phoneAlt?: string;
  /* A square JPEG data URL, small enough to live on the record. Stored here
     rather than in a bucket because this deployment has no file storage at
     all, and because it travels with the person: wherever the app already
     knows who somebody is, it can now show their face without a second
     fetch. Written only by its owner -- see saveOwnProfile. */
  photo?: string;
  emailVerified?: boolean; mustResetPassword?: boolean; pendingApproval?: boolean; devices?: TrustedDevice[]; platformAdmin?: boolean;
};
type Item = {
  id: string;
  label: string;
  /* Only where a label is genuinely used in Arabic. The shell is English;
     the accounting engine is bilingual, and My Pay is reachable from both. */
  labelAr?: string;
  description: string;
  code: string;
  engine?: Engine;
  section?: string;
  native?: NativeView;
};
type Group = { label: string; items: Item[] };
type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
/* Written by the capture script in the document head, which runs before this
   bundle exists — see app/layout.tsx. */
type InstallBridge = { event: InstallEvent | null; installed: boolean };
type WindowWithInstall = Window & { __larsaInstall?: InstallBridge };
type PerformanceDraft = {
  workDate: string;
  // Only asked for when the week is closed: why this is arriving late.
  lateReason: string;
  jobNumber: string;
  clientCode: string;
  workCategory: string;
  discipline: string;
  hoursSpent: string;
  assignedPoints: string;
  submittedPoints: string;
  notes: string;
};
type PerformanceRow = {
  id: string;
  Week?: string;
  Date?: string;
  Engineer?: string;
  Department?: string;
  Project?: string;
  Deliverable?: string;
  Status?: string;
  uid?: string;
  "Submitted Points"?: number | string;
  "Approved Points"?: number | string;
  "Assigned Points"?: number | string;
  // Written by older entries, before the job number replaced the project name
  // and points were reduced to assigned and total. Still read so history shows.
  "Estimated Points"?: number | string;
  "Hours Spent"?: number | string;
  [key: string]: unknown;
};
type ClockLog = {
  id?: string;
  uid?: string;
  type?: string;
  status?: string;
  time?: string;
  note?: string;
  clockedBy?: string;
  lastSeen?: string;
  active?: boolean;
  /* Recency stamp (ISO server time), written at punch time and refreshed by
     every deliberate correction. The merge layer and the repair_008 database
     trigger use it to refuse a stale copy of this record — it is what makes
     a trimmed clock-out stay trimmed when an engine iframe or sleeping tab
     writes back the pre-trim version. */
  touchedAt?: string;
  /* Incident-recovery provenance: the original record id/uid before a
     reconnection, and how the record was recovered ("incident-20260806",
     "backup-restore", "ledger-restore", or "needs-review" for sessions
     whose owner is not yet identified). */
  recovery?: string;
  origUid?: string;
  origId?: string;
};
type ClockSession = {
  uid: string;
  employee: string;
  mode: string;
  clockIn: string;
  clockOut: string;
  /* Three figures, because Larsa targets two different things:
       hours         - net worked time, the clocked span minus breaks. Drives
                       productivity, payroll and points-per-hour.
       presenceHours - the full clocked span including breaks. Drives
                       attendance and time-in-office targets; someone on a
                       lunch break is still at work.
       breakHours    - what was deducted, kept visible so the difference
                       between the two is never a mystery. */
  hours: number;
  presenceHours: number;
  breakHours: number;
  open: boolean;
  /* The LOCAL calendar day these hours belong to. A session that crosses
     midnight becomes one segment per day, so 22:00–02:00 puts two hours on
     each date instead of four on the first — and a punch at 00:30 Baghdad
     time lands on the day the person actually worked, not the UTC date. */
  date: string;
  /* Flagged sessions are shown but never counted: a clock-in left open past
     48 hours (stale) or an open session abandoned before a later clock-in
     (unclosed). They need a correction, and pretending they are 72 hours of
     work in every total until then is how payroll goes wrong. openHours
     keeps the raw span visible so the flag can say how long it has been. */
  stale?: boolean;
  unclosed?: boolean;
  /* A punch of this session carries a correction stamp ("Adjusted by …",
     "Fixed by …", "Manual entry by …") — surfaced so the trim panel can say
     a session has already been corrected before somebody corrects it again. */
  adjusted?: boolean;
  openHours?: number;
};
type DevelopmentStatus = "Assigned" | "In Progress" | "Submitted" | "Approved" | "Returned";
type DevelopmentHistory = {
  at: string;
  byId: string;
  byName: string;
  action: string;
  note?: string;
};
type DevelopmentRecord = {
  id: string;
  employeeId: string;
  employeeName: string;
  title: string;
  activityType: string;
  skill: string;
  month: string;
  dueDate: string;
  targetHours: number;
  targetPresentations: number;
  completedHours: number;
  completedPresentations: number;
  assignedById: string;
  assignedByName: string;
  status: DevelopmentStatus;
  notes: string;
  evidenceUrl: string;
  createdAt: string;
  updatedAt: string;
  history: DevelopmentHistory[];
};
type DevelopmentDraft = {
  employeeId: string;
  title: string;
  activityType: string;
  skill: string;
  month: string;
  dueDate: string;
  targetHours: number;
  targetPresentations: number;
  notes: string;
};
type GrowthStore = {
  version: 1;
  pointTargets: Record<string, number>;
  development: DevelopmentRecord[];
};
type AccountingProject = {
  id: string;
  code: string;
  name: string;
  clientName: string;
  clientEmail: string;
  region: string;
  type: string;
  phase: string;
  status: string;
  priority: string;
  responsibleEngineer: string;
  projectManager: string;
  teamLeader: string;
  startDate: string;
  dueDate: string;
  projectAddress: string;
  progress: number;
  googleDriveLink: string;
  clickUpLink: string;
  contractValue: number;
};
type AccountingDocument = {
  id?: string;
  projectId?: string;
  title?: string;
  type?: string;
  url?: string;
  notes?: string;
};
type CheckRow = {
  id: string;
  label: string;
  area: string;
  state: "ready" | "permission" | "missing" | "loading";
  note: string;
};
/* Commission and payroll rows as the accounting engine stores them. Read-only
   here: the engine remains the system of record, this only reports on it. */
type CommissionRow = {
  id: string; person: string; date: string; description: string;
  base: number; rate: number; due: number; paid: number; status: string; region: string;
};
type PayrollRow = {
  id: string; employee: string; employeeId: string; payDate: string; period: string;
  grossPay: number; totalCompanyCost: number; currency: string; status: string; region: string;
};
/* The cost and income lines the accounting engine keeps per project. Only the
   fields the construction analysis needs are lifted out; the engine stays the
   system of record and nothing here writes back. Materials store a derived
   `amount` (quantity x unit price) and labour a derived `total`
   (quantity x rate), which is what the engine's own totals use. */
type LedgerLine = {
  id: string;
  projectId: string;
  date: string;
  status: string;
  currency: string;
  amount: number;
  /* funding only: Larsa's consultancy fee on that payment, and whether it was
     waived for this particular payment. */
  consultancyFee: number;
  waived: boolean;
  label: string;
  /* The USD rate recorded on this line the day it was entered. 0 for lines
     written before the engine started asking, which fall back to the current
     setting. Storing it per line is what stops a rate change from silently
     re-valuing every closed month. */
  fxRate: number;
};
type AccountingSnapshot = {
  key: string;
  /* IQD per USD, as set in the accounting engine's own settings. Read from the
     store rather than hardcoded: the engine's rate() does the same, and a rate
     baked in here would quietly disagree with every figure it reports. */
  rate: number;
  projects: AccountingProject[];
  documents: AccountingDocument[];
  commissions: CommissionRow[];
  payroll: PayrollRow[];
  funding: LedgerLine[];
  revenue: LedgerLine[];
  materials: LedgerLine[];
  labor: LedgerLine[];
  expenses: LedgerLine[];
};

// Every event that can reach a person, and who it is aimed at by default.
const NOTIFY_EVENTS: { id: string; label: string; description: string; audience: string }[] = [
  { id: "development.assigned", label: "Development assigned", description: "A learning activity is assigned to you", audience: "Employee" },
  { id: "development.reviewed", label: "Development reviewed", description: "Your activity is approved or returned", audience: "Employee" },
  { id: "points.submitted", label: "Points submitted", description: "Someone submits points you need to review", audience: "Reviewer" },
  { id: "points.reviewed", label: "Points reviewed", description: "Your points are approved or returned", audience: "Employee" },
  { id: "leave.requested", label: "Leave requested", description: "A leave or schedule request needs a decision", audience: "Approver" },
  { id: "leave.decided", label: "Leave decided", description: "Your request is approved or rejected", audience: "Employee" },
  { id: "clock.correction", label: "Attendance correction", description: "Someone asks to fix a missed clock, break, or hours", audience: "Approver" },
  { id: "points.week", label: "Performance week closed", description: "A week is locked or reopened for adding points", audience: "Employee" },
  { id: "points.unlock", label: "Locked week access asked", description: "Someone needs to add points to a week you closed", audience: "Approver" },
  { id: "schedule.changed", label: "Schedule changed", description: "Your shifts are edited or the week is rebuilt", audience: "Employee" },
  { id: "accounting.entry", label: "Accounting activity", description: "Funding, expenses, payroll, or invoices are recorded", audience: "Finance" },
  { id: "accounting.flag", label: "Accounting review flag", description: "An entry is flagged for review", audience: "Finance" },
  { id: "project.updated", label: "Project updated", description: "Progress or status changes on a project you can see", audience: "Assigned" },
  { id: "admin.broadcast", label: "Admin announcement", description: "A targeted message sent to you from Notifications", audience: "Everyone" },
  /* Pay events. The body never carries a figure: a notification preview can
     appear on a lock screen, in an email client, or over somebody's shoulder,
     and a salary is not something to leak in a preview. The amount is behind
     the tap, in My Pay, where the record is. */
  { id: "pay.published", label: "Payslip available", description: "A pay period has been published for you", audience: "Everyone" },
  { id: "pay.paid", label: "Payment recorded", description: "A payroll payment has been recorded against your pay", audience: "Everyone" },
  { id: "pay.commission", label: "Commission updated", description: "One of your commissions was approved, scheduled, or paid", audience: "Everyone" },
];
const NOTIFY_STORE_KEY = "larsaNotificationsV1";
// Sign-in convenience. The address and the "stay signed in" session are stored;
// the password never is — the browser's own password manager handles that, so
// it stays encrypted behind the device lock instead of sitting in plain text.
const KEEP_SESSION_KEY = "larsa-control-session-keep";
const REMEMBER_EMAIL_KEY = "larsa-control-remember-email";
// A Viewer is never a StaffUser and never touches larsaStaffV8 — this is a
// separate session, for a separate kind of account, stored under its own
// key. It holds no secret: the real credential is the live Supabase Auth
// session (a cookie-less bearer token Supabase's own client keeps track of);
// this is only the display shell rebuilt from viewer_accounts on reload.
const VIEWER_SESSION_KEY = "larsa-viewer-session";
// Must match VIEWER_DOMAIN in supabase/functions/viewer-admin/index.ts — a
// domain nobody can receive mail at, used only so Supabase Auth's own
// email+password mechanism can back a username+password sign-in.
const VIEWER_EMAIL_DOMAIN = "viewer.larsaeng.internal";
type ViewerSession = {
  id: string;
  username: string;
  displayName: string;
  projectAccessMode: "all" | "assigned" | "none";
  allowedProjectIds: string[];
};
const PROJECT_CHAT_KEY = "larsaProjectRoomsV1";
// Notifications start enabled. Delivery still respects every channel switch:
// when a person clears all three boxes for an event, nothing is sent.
const EMAIL_DEFAULT_EVENTS = new Set([
    "leave.requested", "leave.decided", "clock.correction",
    "development.assigned", "development.reviewed",
    "accounting.entry", "accounting.flag", "admin.broadcast",
  ]);
const DEFAULT_NOTIFY_PREFS: NotifyPrefs = Object.fromEntries(
    NOTIFY_EVENTS.map((event) => [event.id, {
          inApp: true,
          push: true,
          email: EMAIL_DEFAULT_EVENTS.has(event.id),
    }]),
  );

const GROWTH_STORE_KEY = "larsaStaffGrowthV1";

const engineItem = (
  engine: Engine,
  id: string,
  label: string,
  description: string,
  code: string,
  section: string,
): Item => ({ engine, id, label, description, code, section });

const ACCESS_ITEM: Item = {
  id: "access",
  label: "Users & Access",
  description: "People, sign-in, roles, scopes, and permissions",
  code: "UA",
  native: "access",
};
const PERFORMANCE_REVIEW_ITEM: Item = {
  id: "staff-performance-review",
  label: "Performance Review",
  description: "Review, return, approve, and lock submitted points",
  code: "PR",
};
const PERFORMANCE_TARGETS_ITEM: Item = {
  id: "staff-performance-targets",
  label: "Targets & Point Rules",
  description: "Targets, columns, point rules, and performance setup",
  code: "PT",
};
const NOTIFICATIONS_ITEM: Item = {
  id: "admin-notifications",
  label: "Notifications",
  description: "Send, target, and manage staff notifications",
  code: "NT",
  native: "notifications",
};
/* Records go wrong in three ways an ordinary screen cannot fix: a request is
   routed to the wrong approvers, a points entry carries a wrong figure, or a
   clock session has the wrong times. This screen is where somebody GRANTED the
   access puts them right — admins always can; anyone else needs the row ticked
   in Users & Access, which this item's presence in GROUPS provides. */
const CORRECTIONS_ITEM: Item = {
  id: "admin-corrections",
  label: "Corrections",
  description: "Fix request approval flows, points entries, and clock records",
  code: "CX",
  native: "corrections",
};
const PERFORMANCE_CENTER_ITEM: Item = {
  id: "performance-center",
  label: "Points & Weekly Targets",
  description: "Weekly targets, progress, approvals, and team comparison",
  code: "PW",
  native: "performance",
};
const DEVELOPMENT_ITEM: Item = {
  id: "staff-development",
  label: "Development Portal",
  description: "Monthly learning activities, hours, presentations, and history",
  code: "DP",
  native: "development",
};
const PERFORMANCE_HISTORY_ITEM: Item = {
  id: "performance-history",
  /* An employee's formal record: evaluations, feedback, recognition, warnings,
     promotions, training, certifications. Deliberately NOT hours and points.
     Those have their own homes — attendance owns hours, Points & Weekly
     Targets owns points — and repeating them here made this page a third copy
     of figures that already existed twice, which is what made it useless as
     the place you look up somebody's actual history. The id is kept so
     existing links and saved views still resolve. */
  label: "Performance History",
  description: "Evaluations, recognition, warnings, promotions, training, and certifications",
  code: "PH",
  native: "performanceHistory",
};

/* The kinds of thing an employee file actually holds. Ordered roughly from
   routine to serious, which is also the order the filter offers them. */
const FORMAL_RECORD_KINDS = [
  "Evaluation", "Feedback", "Achievement", "Recognition", "Training",
  "Certification", "Skill change", "Promotion", "Role change",
  "Department change", "Improvement plan", "Corrective action", "Warning",
] as const;
type FormalRecordKind = (typeof FORMAL_RECORD_KINDS)[number];
/* Which kinds read as a concern rather than a credit. Only used for the
   colour of a chip — nothing behaves differently because of it. */
const FORMAL_CONCERN_KINDS: string[] = ["Warning", "Corrective action", "Improvement plan"];
type FormalRecord = {
  id: string;
  uid: string;
  kind: FormalRecordKind | string;
  title: string;
  detail?: string;
  date: string;
  outcome?: string;
  recordedBy?: string;
  recordedAt?: string;
};
function formalRecords(store: Record<string, unknown> | null): FormalRecord[] {
  return Array.isArray(store?.formalRecords) ? store.formalRecords as FormalRecord[] : [];
}
const SALES_ITEM: Item = {
  id: "sales-commissions",
  label: "Sales & Commissions",
  description: "Commission and salary per person for any period",
  code: "SC",
  native: "salesCommissions",
};
const PROJECT_PORTAL_ITEM: Item = {
  id: "project-portal",
  label: "Assigned Projects",
  description: "Construction projects available to this account",
  code: "AP",
  native: "projects",
};
const CONSTRUCTION_FINANCIALS_ITEM: Item = {
  id: "construction-financials",
  label: "Construction Financials",
  description: "Company, Iraq, USA, and per-project cost and profit",
  code: "CX",
  native: "constructionFinancials",
};
const EXTRA_PERMISSION_ITEMS = [PERFORMANCE_REVIEW_ITEM, PERFORMANCE_TARGETS_ITEM, NOTIFICATIONS_ITEM];

const GROUPS: Group[] = [
  {
    label: "Home",
    items: [
      {
        id: "overview",
        label: "Home",
        description: "Choose a work area",
        code: "OV",
        native: "overview",
      },
    ],
  },
  {
    /* Engineering Management is one screen with four sections behind tabs, and
       for a long time only the screen itself was in the sidebar — so from the
       outside it looked like a single page and the other three were invisible
       until you were already inside. Each section is listed now.

       They all open the same native screen and differ only in which tab it
       lands on. org-structure keeps its id and stays the entry that opens the
       Dashboard, because the Home card, the recent list and its permission all
       point at it; only its label changed. */
    label: "Engineering Management",
    items: [
      { id: "org-structure", label: "Engineering Dashboard", description: "Headcount, hours, and points across the structure", code: "EM", native: "orgStructure" },
      { id: "org-chart", label: "Structure", description: "Departments, teams, and access", code: "ES", native: "orgStructure" },
      { id: "org-team-time", label: "Team Timesheets", description: "Hours for everyone you are responsible for", code: "ET", native: "orgStructure" },
      { id: "org-team-points", label: "Team Performance", description: "Points and targets across your teams", code: "EP", native: "orgStructure" },
    ],
  },
  {
    label: "Timeclock & Performance",
    items: [
      engineItem("staff", "staff-dashboard", "Performance Dashboard", "Workboard summaries, alerts, and KPIs", "DB", "dashboard"),
      PERFORMANCE_CENTER_ITEM,
      /* Development Portal used to sit here. It is learning and growth — the
         same subject as the skills matrix — so it lives under HR & Skills now.
         Only its home moved: the id, its permissions and every handler that
         checks them are untouched. */
      engineItem("staff", "staff-clock", "Clock In / Out", "Daily clocking and attendance", "TC", "clock"),
      engineItem("staff", "staff-live", "Live Presence", "Office, remote, site, and out status", "LP", "live"),
      engineItem("staff", "staff-schedule", "Weekly Schedule", "Shift builder and attendance planning", "WS", "schedule"),
      engineItem("staff", "staff-performance", "Performance Workboard", "Weekly points, targets, and analytics", "PF", "performance"),
      engineItem("staff", "staff-timesheet", "Timesheet", "Sessions, hours, and timezone views", "TS", "timesheet"),
      engineItem("staff", "staff-approvals", "Leave & Requests", "Leave and schedule requests, approvals, and workflows", "LR", "approvals"),
      engineItem("staff", "staff-rules", "Rules & Constraints", "Rules, constraints, and enforcement", "RC", "rules"),
      PERFORMANCE_HISTORY_ITEM,
      engineItem("staff", "staff-reports", "Performance Reports", "Employee, department, hours, and points", "SR", "reports"),
      engineItem("staff", "staff-backup", "Staff Data Tools", "Staff CSV import, export, and print tools", "DT", "backup"),
    ],
  },
  {
    label: "HR & Skills",
    items: [
      engineItem("hr", "hr-dashboard", "HR Dashboard", "Visual HR counts and distributions", "HD", "dashboard"),
      engineItem("hr", "hr-people", "People & Skills", "Employee classifications and skill files", "PS", "people"),
      engineItem("hr", "hr-matrix", "Skills Matrix", "Editable categories and yes/no coverage", "SM", "matrix"),
      DEVELOPMENT_ITEM,
      /* The approval-chain editor itself lives on the Timeclock engine's Leave
         & Requests page, where it always has — this entry is the same screen
         reachable from the people side of the app, because "who approves my
         requests" is an HR question and nobody could find it before. Same id
         rules as staff-development: a staff-engine screen listed under HR,
         with its channel pinned to "hr" in channelForItem. */
      /* The approval chain, edited where people already are. It was reachable
         only through the Timeclock engine's Leave & Requests page, which is
         why nobody could find it; this is a native screen over the very same
         flowConfig, so both views always agree. */
      { id: "hr-approval-flow", label: "Approval Flow", description: "Who approves each person's leave, schedule, and performance requests, and in what order", code: "AF", native: "approvalFlow" },
      engineItem("hr", "hr-reports", "HR Reports", "Compact HR report and exports", "HR", "reports"),
    ],
  },
  {
    label: "Accounting",
    items: [
      engineItem("accounting", "acc-dashboard", "Accounting Dashboard", "Financial overview and alerts", "AD", "dashboard"),
      CONSTRUCTION_FINANCIALS_ITEM,
      PROJECT_PORTAL_ITEM,
      engineItem("accounting", "acc-master", "Profit & Loss", "Company master P&L view", "PL", "master"),
      engineItem("accounting", "acc-funding", "Construction Funding", "Funding and consultancy balances", "CF", "funding"),
      engineItem("accounting", "acc-iq-revenue", "Iraq Revenue", "Iraq engineering revenue", "IR", "iqRevenue"),
      engineItem("accounting", "acc-iq-operating", "Iraq Operating Costs", "Iraq operating expenses", "IO", "iqOperating"),
      engineItem("accounting", "acc-us-revenue", "USA Revenue", "USA engineering revenue", "UR", "usRevenue"),
      engineItem("accounting", "acc-us-operating", "USA Operating Costs", "USA operating expenses", "UO", "usOperating"),
      engineItem("accounting", "acc-usa-ledger", "USA Accounting", "Regional accounting workspace", "UA", "usaAccounting"),
      engineItem("accounting", "acc-iraq-ledger", "Iraq Accounting", "Regional accounting workspace", "IA", "iraqAccounting"),
      engineItem("accounting", "acc-expenses", "Project Expenses", "Project cost and expense ledger", "PE", "expenses"),
      engineItem("accounting", "acc-materials", "Project Materials", "Materials, quantities, and supply costs", "PM", "materials"),
      engineItem("accounting", "acc-labor", "Project Labor", "Labor and workforce costs", "LB", "labor"),
      engineItem("accounting", "acc-payroll", "Payroll & Paystubs", "Payroll, taxes, approvals, and paystubs", "PY", "payroll"),
      engineItem("accounting", "acc-commissions", "Commissions", "Sales commissions and balances", "CM", "commissions"),
      engineItem("accounting", "acc-clients", "Client Statements", "Client accounts and statements", "CS", "clients"),
      engineItem("accounting", "acc-projects", "Projects", "Project sheets, documents, and audit", "PJ", "projects"),
      engineItem("accounting", "acc-boq", "BOQ / Pricing", "Quantities, pricing, and variance", "BQ", "boq"),
      engineItem("accounting", "acc-refs", "Suppliers & Workforce", "Supplier and workforce references", "SW", "refs"),
      engineItem("accounting", "acc-employees", "Payroll Employees", "Employee payroll records", "EM", "employees"),
      engineItem("accounting", "acc-reports", "Accounting Reports", "Financial reports and exports", "AR", "reports"),
      engineItem("accounting", "acc-review", "Review Queue", "Flags, severity, and resolutions", "RQ", "review"),
      engineItem("accounting", "acc-notifications", "Notifications", "Targeted and in-app notifications", "NT", "notifications"),
      engineItem("accounting", "acc-settings", "Accounting Settings", "Preferences, payroll tax, clients, connections, and audit", "AS", "settings"),
    ],
  },
  {
    label: "Administration",
    items: [
      ACCESS_ITEM,
      {
        id: "admin",
        label: "Admin Center",
        description: "Users, access, rules, and protected data",
        code: "AM",
        native: "admin",
      },
      CORRECTIONS_ITEM,
      {
        id: "platform-settings", label: "Platform Settings", description: "Signup, verification policy, and platform owners", code: "PS", native: "platformSettings" },
      { id: "data", label: "Data Center",
        description: "Scoped backup, restore, and staff sync",
        code: "DC",
        native: "data",
      },
    ],
  },
];

const QUICK_CLOCK_ITEM: Item = {
  id: "quick-clock",
  label: "Clock In / Out",
  description: "Record your attendance in one tap",
  code: "QC",
  native: "quickClock",
};
const ACCOUNTING_HUB_ITEM: Item = {
  id: "accounting-hub",
  label: "Accounting",
  description: "Choose an accounting area",
  code: "AC",
  native: "accountingHub",
};
const REQUESTS_ITEM: Item = {
  id: "my-requests",
  label: "Leave & Requests",
  description: "Submit leave or a schedule change, and track decisions",
  code: "LR",
  native: "requests",
};
const PRESENCE_ITEM: Item = {
  id: "live-presence",
  label: "Live Presence",
  description: "Who is in the office, online, or on site right now",
  code: "LP",
  native: "presence",
};
/* Home is reachable from the bar as well as the sidebar, so it needs a name
   outside the GROUPS literal. Read from GROUPS rather than restated, so the
   two can never describe different things. */
const OVERVIEW_ITEM: Item = GROUPS[0].items[0];
const SETTINGS_ITEM: Item = {
  id: "my-settings",
  label: "My Settings",
  description: "Profile, sign-in, appearance, and notifications",
  code: "ST",
  native: "settings",
};
const WEEK_SCHEDULE_ITEM: Item = {
  id: "week-schedule",
  label: "Weekly Schedule",
  description: "Your shifts for the week and who else is in",
  code: "WS",
  native: "weekSchedule",
};
const MY_POINTS_ITEM: Item = {
  id: "my-points",
  label: "Add My Points",
  description: "Record and submit your own performance points",
  code: "MP",
  native: "myPoints",
};
/* An employee's own pay. Personal, like My Settings — it is not a seventh
   work area, and it never shows anybody else's figures. The Arabic label is
   carried on the item so the areas that do speak Arabic can use it. */
const MY_PAY_ITEM: Item = {
  id: "my-pay",
  label: "My Pay",
  description: "Salary, commissions, and payment history",
  labelAr: "رواتبي ومستحقاتي",
  code: "MY",
  native: "myPay",
};
/* One portal for the whole payroll cycle, replacing four scattered screens.
   It is the accountant's lens on exactly the records My Pay shows the
   employee — one payroll truth, two views of it. */
const PAYROLL_PORTAL_ITEM: Item = {
  id: "payroll-portal",
  label: "Payroll & People",
  description: "Employees, pay runs, commissions, and payslips",
  labelAr: "الرواتب والموظفون",
  code: "PP",
  native: "payrollPortal",
};
const ITEMS = [...GROUPS.flatMap((group) => group.items), SALES_ITEM, MY_POINTS_ITEM, QUICK_CLOCK_ITEM, WEEK_SCHEDULE_ITEM, ACCOUNTING_HUB_ITEM, SETTINGS_ITEM, REQUESTS_ITEM, PRESENCE_ITEM, MY_PAY_ITEM, PAYROLL_PORTAL_ITEM];

/* Which tab of the Engineering Management screen each sidebar entry opens.
   One place, so the nav channel, the permission check and the screen itself
   cannot disagree about what these ids mean. */
type EngineeringTab = "dashboard" | "structure" | "time" | "performance";
const ENGINEERING_ITEM_TABS: Record<string, EngineeringTab> = {
  "org-structure": "dashboard",
  "org-chart": "structure",
  "org-team-time": "time",
  "org-team-points": "performance",
};
/* The two that only mean anything to somebody responsible for other people.
   They are hidden rather than shown-and-empty, and the screen falls back to
   the Dashboard if one is reached any other way. */
const ENGINEERING_MANAGER_ITEMS = new Set(["org-team-time", "org-team-points"]);
const DEFAULT_ITEM = ITEMS.find((item) => item.id === "overview")!;
const PIN_ALLOWED_ITEMS = new Set(["overview", "quick-clock", "week-schedule", "staff-clock", "my-points", "staff-development", "my-settings", "my-requests", "live-presence", "my-pay"]);
const PERMISSION_ACTIONS: { id: PermissionAction; label: string }[] = [
  { id: "view", label: "View" },
  { id: "add", label: "Add" },
  { id: "edit", label: "Edit" },
  { id: "delete", label: "Delete" },
  { id: "approve", label: "Approve" },
  { id: "export", label: "Export" },
  { id: "manage", label: "Manage" },
];
const DATA_SCOPES: { id: DataScope; label: string; description: string }[] = [
  { id: "own", label: "Own records", description: "Only records connected to this user" },
  { id: "team", label: "Team", description: "The user and assigned team records" },
  { id: "department", label: "Department", description: "Records for the same department" },
  { id: "company", label: "All company", description: "Company-wide records" },
];
const ROLE_PRESETS = [
  "Super Admin",
  "Admin",
  "Manager",
  "Accountant",
  "Admin HR",
  "Team Leader",
  "Construction Engineer",
  "Engineer",
  "Client",
  "Trainee",
  "Intern",
  "Viewer",
];
/* Accounts an admin creates with just a username and password — no email
 * address, so no email-verification gate ever applies to them. Clients see
 * their own projects (including the financial summary); trainees and interns
 * get the self-service staff basics with no money screens. */
const USERNAME_ONLY_PRESETS = ["Client", "Trainee", "Intern"];
/* The two names a read-only client account used to be given while it still
   lived in the staff directory. Those accounts belong to the Viewer Accounts
   tab now, where they get a real auth identity and database-enforced project
   scoping, so neither name may be assigned to a staff record any more. Kept as
   a list rather than deleted from ROLE_PRESETS because accounts created before
   the split still carry one, and their role has to keep displaying correctly. */
const LEGACY_CLIENT_PRESETS = ["Client", "Viewer"];
const VIEW_ONLY: PermissionAction[] = ["view"];
const VIEW_EXPORT: PermissionAction[] = ["view", "export"];
const BASIC_EDIT: PermissionAction[] = ["view", "add", "edit"];
const FULL_EDIT: PermissionAction[] = ["view", "add", "edit", "delete", "export", "manage"];
const ACCESS_ACTIONS: Record<string, PermissionAction[]> = {
  "staff-dashboard": VIEW_ONLY,
  "staff-clock": BASIC_EDIT,
  "staff-live": VIEW_ONLY,
  "staff-schedule": ["view", "add", "edit", "delete", "approve", "manage"],
  "staff-performance": ["view", "add", "edit", "approve", "export", "manage"],
  "performance-center": ["view", "export", "manage"],
  "staff-performance-review": ["view", "edit", "approve", "export", "manage"],
  "staff-performance-targets": ["view", "add", "edit", "delete", "manage"],
  "staff-development": ["view", "add", "edit", "delete", "approve", "export", "manage"],
  /* It used to be a read-only report over other modules' figures, so viewing
     and exporting was all it could offer. Now that it holds records of its
     own, somebody has to be able to write one — and deleting is deliberately
     absent: an employee file is appended to, not edited away. */
  "performance-history": ["view", "add", "edit", "export"],
  "staff-timesheet": VIEW_EXPORT,
  "staff-approvals": ["view", "add", "edit", "delete", "approve", "manage"],
  /* Same screen as staff-approvals, reached from HR & Skills; its own row here
     so access to it can be customised independently. */
  "hr-approval-flow": ["view", "add", "edit", "delete", "approve", "manage"],
  /* view = see everything; edit = change flows, points, and clock times;
     delete = remove a clock session outright. Closed to everyone but admins
     until the row is explicitly ticked in Users & Access. */
  "admin-corrections": ["view", "edit", "delete"],
  "staff-reports": VIEW_EXPORT,
  "staff-rules": FULL_EDIT,
  "staff-backup": ["view", "add", "export", "manage"],
  "hr-dashboard": VIEW_EXPORT,
  "hr-people": FULL_EDIT,
  "hr-matrix": FULL_EDIT,
  "hr-reports": VIEW_EXPORT,
  "project-portal": ["view", "edit", "export"],
  "construction-financials": ["view", "export"],
  access: ["view", "add", "edit", "delete", "manage"],
  "admin-notifications": ["view", "add", "edit", "delete", "manage"],
  data: ["view", "export", "manage"],
};
const ACCOUNTING_ACTIONS: PermissionAction[] = ["view", "add", "edit", "delete", "approve", "export", "manage"];
const ACCESS_GROUPS: { label: string; items: Item[] }[] = [
  {
    label: "Time & Attendance",
    items: [
      ITEMS.find((item) => item.id === "staff-clock")!,
      ITEMS.find((item) => item.id === "staff-timesheet")!,
      {
        ...ITEMS.find((item) => item.id === "staff-approvals")!,
        label: "Leave & Requests",
        description: "Submit, review, approve, or manage leave and change requests",
      },
      ITEMS.find((item) => item.id === "staff-schedule")!,
      ITEMS.find((item) => item.id === "staff-live")!,
    ],
  },
  {
    label: "Performance & Workboard",
    /* Same order as the sidebar, so an admin granting access reads the tree in
       the shape the person will see. Development Portal is not missing — it
       moved to HR & Skills below and is listed there, with every one of its
       actions intact. Nothing in this tree was dropped. */
    items: [
      ITEMS.find((item) => item.id === "staff-dashboard")!,
      PERFORMANCE_CENTER_ITEM,
      ITEMS.find((item) => item.id === "staff-performance")!,
      PERFORMANCE_REVIEW_ITEM,
      PERFORMANCE_TARGETS_ITEM,
      PERFORMANCE_HISTORY_ITEM,
      ITEMS.find((item) => item.id === "staff-reports")!,
    ],
  },
  {
    label: "HR & Skills",
    items: GROUPS.find((group) => group.label === "HR & Skills")!.items,    },    {      label: "Engineering Management",      items: GROUPS.find((group) => group.label === "Engineering Management")!.items,
  },
  {
    label: "Accounting",
    items: GROUPS.find((group) => group.label === "Accounting")!.items,
  },
  {
    label: "Administration",
    items: [
      ACCESS_ITEM,
      ITEMS.find((item) => item.id === "staff-rules")!,
      {
        ...ITEMS.find((item) => item.id === "staff-backup")!,
        label: "Staff CSV & Import Tools",
        description: "Import staff CSV files and use staff-specific export or print tools",
      },
      NOTIFICATIONS_ITEM, ITEMS.find((item) => item.id === "platform-settings")!,
      ITEMS.find((item) => item.id === "data")!,
    ],
  },
];
const STAFF_PERMISSION: Record<string, string> = {
  dashboard: "Dashboard",
  clock: "Clock In / Out",
  live: "Live Presence",
  schedule: "Schedule View",
  performance: "Submit Performance",
  timesheet: "Reports View",
  approvals: "Approve Leave",
  people: "People Manage",
  rules: "Rules Manage",
  reports: "Reports View",
  backup: "Backup Manage",
};
const STAFF_PERMISSION_LIST = [
  "Dashboard",
  "Clock In / Out",
  "Live Presence",
  "Schedule View",
  "Schedule Edit",
  "Shift Builder",
  "Auto Schedule",
  "Approve Schedule",
  "Submit Leave",
  "Approve Leave",
  "Schedule Change Request",
  "Submit Performance",
  "Approve Performance",
  "People Manage",
  "Rules Manage",
  "Approval Flow Manage",
  "Reports View",
  "Backup Manage",
  "Send Notifications",
];
const ACCOUNTING_SECTIONS: Record<string, Set<string>> = {
  "Super Admin": new Set(GROUPS.find((group) => group.label === "Accounting")!.items.map((item) => item.section!)),
  // Full parity with Super Admin -- see accountingRole() and presetPermissionProfile's "Admin" branch.
  Admin: new Set(GROUPS.find((group) => group.label === "Accounting")!.items.map((item) => item.section!)),
  Manager: new Set(GROUPS.find((group) => group.label === "Accounting")!.items.map((item) => item.section!)),
  "Owner / Super Admin": new Set(GROUPS.find((group) => group.label === "Accounting")!.items.map((item) => item.section!)),
  Management: new Set(GROUPS.find((group) => group.label === "Accounting")!.items.map((item) => item.section!)),
  "Admin HR": new Set(["dashboard", "employees", "payroll", "reports", "review"]),
  "Team Leader": new Set(["dashboard", "funding", "expenses", "materials", "labor", "clients", "projects", "boq", "refs", "reports", "review"]),
  "Construction Engineer": new Set(["dashboard", "expenses", "materials", "labor", "projects", "boq", "review"]),
  Engineer: new Set(["dashboard", "projects", "materials", "labor", "boq", "review"]),
  Client: new Set(["projects"]),
  // Trainees and interns get the engineer-style staff basics only — no
  // accounting engine sections at all (explicit empty set so the Engineer
  // fallback never applies to them). They still see assigned projects in the
  // Project Portal, without the financial summary.
  Trainee: new Set<string>([]),
  Intern: new Set<string>([]),
};
// Accounting is organised into a few clear portals with sub-portals underneath.
// Every existing item is still present — this only groups them.
const ACCOUNTING_TREE: { id: string; label: string; description: string; icon: string; tone: string; items: string[] }[] = [
  {
    id: "acc-grp-overview", tone: "slate", label: "Overview & Company", icon: "acc-dashboard",
    description: "Dashboard, profit and loss, and company-wide reports",
    items: ["acc-dashboard", "acc-master", "acc-reports", "acc-review"],
  },
  {
    id: "acc-grp-usa", tone: "blue", label: "USA Accounting", icon: "acc-usa-ledger",
    description: "Revenue, operating costs, and commissions for the USA side",
    items: ["acc-usa-ledger", "acc-us-revenue", "acc-us-operating", "acc-commissions"],
  },
  {
    id: "acc-grp-iraq", tone: "green", label: "Iraq Accounting", icon: "acc-iraq-ledger",
    description: "Revenue, operating costs, funding, and client statements for Iraq",
    items: ["acc-iraq-ledger", "acc-iq-revenue", "acc-iq-operating", "acc-funding", "acc-clients"],
  },
  {
    id: "acc-grp-construction", tone: "amber", label: "Construction Projects", icon: "acc-projects",
    description: "Project delivery costs: expenses, materials, labour, and pricing",
    items: ["acc-projects", "construction-financials", "project-portal", "acc-expenses", "acc-materials", "acc-labor", "acc-boq"],
  },
  {
    id: "acc-grp-people", tone: "violet", label: "Payroll & People", icon: "acc-payroll",
    description: "One place for people, pay runs, commissions and payslips",
    /* The portal leads: it is the whole cycle in one screen. The older
       single-purpose entries stay underneath it rather than being removed,
       because they are still the way to reach the engine's own ledgers and
       people who know them should not have to relearn where things are. */
    items: ["payroll-portal", "my-pay", "acc-payroll", "sales-commissions", "acc-employees", "acc-refs"],
  },
  {
    id: "acc-grp-settings", tone: "rose", label: "Settings & Notices", icon: "acc-settings",
    description: "Accounting preferences, tax setup, and notifications",
    items: ["acc-settings", "acc-notifications"],
  },
];

const ICONS: Record<string, LucideIcon> = {
  overview: Gauge,
  "my-pay": Wallet,
  "payroll-portal": BadgeDollarSign,
  "staff-dashboard": LayoutDashboard,
  "staff-clock": Timer,
  "staff-live": Radio,
  "staff-schedule": CalendarDays,
  "staff-performance": TrendingUp,
  "performance-center": Target,
  "staff-development": BookOpen,
  "performance-history": History,
  "my-points": TrendingUp,
  "org-chart": Network,
  "org-team-time": FileClock,
  "org-team-points": TrendingUp,
  "staff-timesheet": FileClock,
  "staff-approvals": CheckCircle2,
  "hr-approval-flow": CheckCircle2,
  "staff-rules": SlidersHorizontal,
  "admin-corrections": SlidersHorizontal,
  "staff-reports": FileBarChart,
  "staff-backup": Import,
  "hr-dashboard": Gauge,
  "hr-people": UserRoundSearch,
  "hr-matrix": Network,
  "hr-reports": IdCard,
  "acc-dashboard": LayoutDashboard,
  "project-portal": FolderLock,
  "construction-financials": FileBarChart,
  "acc-master": CircleDollarSign,
  "acc-funding": WalletCards,
  "acc-iq-revenue": Landmark,
  "acc-iq-operating": ReceiptText,
  "acc-us-revenue": Landmark,
  "acc-us-operating": ReceiptText,
  "acc-usa-ledger": FileSpreadsheet,
  "acc-iraq-ledger": FileSpreadsheet,
  "acc-expenses": ReceiptText,
  "acc-materials": Package,
  "acc-labor": HardHat,
  "acc-payroll": BadgeDollarSign,
  "acc-commissions": CircleDollarSign,
  "acc-clients": BriefcaseBusiness,
  "acc-projects": FolderKanban,
  "acc-boq": ClipboardList,
  "acc-refs": UsersRound,
  "acc-employees": IdCard,
  "acc-reports": FileBarChart,
  "acc-review": ClipboardCheck,
  "acc-notifications": Bell,
  "acc-settings": Settings,
  access: UserCog,
  admin: ShieldCheck,
  data: Database,
};
const URLS: Record<Engine, string> = {
  staff: "/engines/timeclock.html",
  hr: "/engines/hr.html",
  accounting: "/engines/accounting.html",
};

/* Injected into each engine iframe the moment it is ready (same origin, so
 * the parent may wrap the frame's own localStorage).
 *
 * WHY: the engines keep the whole shared store in MEMORY and their save()
 * writes that memory back wholesale. A save made an hour after the iframe
 * loaded therefore used to overwrite every punch, account and edit the rest
 * of the company had made in between — the single biggest source of "old
 * information keeps coming back" and of clock-outs vanishing (two thirds of
 * the production clock log carried a ledger-restore recovery mark from
 * exactly this cycle). The wrapper rebases every engine save onto the text
 * that is CURRENTLY stored, with the same three-way merge the sync layer
 * uses (exposed by the parent as __larsaEngineRebase): base is the text the
 * engine's memory was loaded from, local is the engine's save, remote is
 * what storage holds now. getItem is hooked too, so whenever engine code
 * re-reads the store (state=JSON.parse(localStorage.getItem(...))) the base
 * moves forward with its memory.
 *
 * The engines themselves stay byte-for-byte unchanged — this wraps around
 * them from outside, which is what keeps the legacy modules safe to leave
 * alone. */
const ENGINE_REBASE_SRC = `(function () {
  if (window.__larsaRebaseInstalled) return;
  window.__larsaRebaseInstalled = true;
  var KEYS = ${JSON.stringify([...SYNCED_KEYS])};
  var origin = {};
  KEYS.forEach(function (key) {
    try { origin[key] = window.localStorage.getItem(key); } catch (e) { origin[key] = null; }
  });
  var storage = window.localStorage;
  var originalSet = storage.setItem.bind(storage);
  var originalGet = storage.getItem.bind(storage);
  window.localStorage.getItem = function (key) {
    var value = originalGet(key);
    if (KEYS.indexOf(key) >= 0) origin[key] = value;
    return value;
  };
  window.localStorage.setItem = function (key, value) {
    if (KEYS.indexOf(key) >= 0) {
      try {
        var current = originalGet(key);
        var rebase = window.parent && window.parent.__larsaEngineRebase;
        if (typeof rebase === "function" && current !== null && current !== value && current !== origin[key]) {
          value = rebase(origin[key], String(value), current) || value;
        }
      } catch (e) { /* the engine's own copy still saves */ }
      originalSet(key, value);
      return;
    }
    originalSet(key, value);
  };
})();`;

const EMBED_CSS: Record<Engine, string> = {
  staff: `
    html,body{min-height:100%;height:auto!important;overflow:auto!important}
    body{padding-bottom:env(safe-area-inset-bottom)}
    #login{display:none!important}
    .sidebar,.mobileBar{display:none!important}
    .v25-timebar{display:none!important}
    .app:not(.hidden){display:block!important;min-height:100vh}
    .main{min-height:100vh!important;width:100%!important}
    .topbar{top:0!important}.content{max-width:none!important;padding:18px!important}
    button,.btn,input:not([type=checkbox]):not([type=radio]),select,textarea{min-height:44px}
    .tableWrap,.scheduleGrid{-webkit-overflow-scrolling:touch;overscroll-behavior-inline:contain}
    .larsa-employee-table{min-width:980px!important;table-layout:auto!important}
    .larsa-employee-table th,.larsa-employee-table td{overflow-wrap:normal!important;word-break:normal!important}
    .larsa-employee-table th:nth-child(1),.larsa-employee-table td:nth-child(1){min-width:90px}
    .larsa-employee-table th:nth-child(2),.larsa-employee-table td:nth-child(2){min-width:180px}
    .larsa-employee-table th:nth-child(3),.larsa-employee-table td:nth-child(3){min-width:120px}
    .larsa-employee-table th:nth-child(4),.larsa-employee-table td:nth-child(4){min-width:180px}
    .larsa-employee-table th:nth-child(7),.larsa-employee-table td:nth-child(7){min-width:300px}
    .larsa-employee-table th:nth-child(9),.larsa-employee-table td:nth-child(9){min-width:96px;white-space:nowrap}
    .larsa-employee-table td:nth-child(9) .btn{min-width:82px;white-space:nowrap}
    @media(max-width:760px){.topbar{padding:10px 12px!important}.pageTitle h1{font-size:21px!important}
    .content{padding:12px!important}.v25-timebar{display:none!important}.modalLayer{padding:8px!important}
    .modal{max-height:94dvh!important;border-radius:18px!important}}
  `,
  hr: `
    html,body{min-height:100%;height:auto!important;overflow:auto!important}
    body{padding-bottom:env(safe-area-inset-bottom)}
    .sidebar,.mobileBar{display:none!important}.app{display:block!important;min-height:100vh}
    .main{min-height:100vh!important;width:100%!important}
    .topbar{top:0!important}.content{max-width:none!important;padding:18px!important}
    button,.btn,input:not([type=checkbox]):not([type=radio]),select,textarea{min-height:44px}
    .tableWrap{-webkit-overflow-scrolling:touch;overscroll-behavior-inline:contain}
    @media(max-width:760px){.topbar{padding:10px 12px!important}.pageTitle h1{font-size:21px!important}
    .content{padding:12px!important}.modalLayer{padding:8px!important}.modal{max-height:94dvh!important}}
  `,
  accounting: `
    html,body{min-height:100%;height:100%!important;overflow:hidden!important}
    body{padding-bottom:env(safe-area-inset-bottom)}
    #loginScreen,#publicScreen{display:none!important}
    #app[style*="display: flex"],#app[style*="display:flex"]{display:block!important;height:100%!important}
    #app>.sidebar{display:none!important}#app>.main{height:100%!important;width:100%!important}
    #navToggle{display:none!important}.view-scroll{padding:18px!important;-webkit-overflow-scrolling:touch}
    button,.btn,.mini,input:not([type=checkbox]):not([type=radio]),select,textarea{min-height:42px}
    .table-wrap{-webkit-overflow-scrolling:touch;overscroll-behavior-inline:contain}
    @media(max-width:760px){.topbar{padding:9px 10px!important}.tb-right{gap:5px!important}
    #appTitle,.user-chip{display:none!important}.view-scroll{padding:12px!important}
    .modal-layer{padding:7px!important}.modal{max-height:94dvh!important}.page-head{align-items:flex-start!important}}
  `,
};

function ensureEmbeddedStyle(doc: Document, engine: Engine) {
  if (!doc.head || doc.getElementById("larsa-control-embed-style")) return;
  const style = doc.createElement("style");
  style.id = "larsa-control-embed-style";
  style.textContent = EMBED_CSS[engine];
  doc.head.appendChild(style);
}

function normalizeName(value: unknown) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function parseStore(key: string) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveDownload(name: string, body: string, type = "application/json") {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([body], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

const BACKUP_SCOPES: Record<BackupScope, { label: string; file: string; description: string }> = {
  all: {
    label: "Everything",
    file: "everything",
    description: "All operational records and application preferences",
  },
  staff: {
    label: "Time, Attendance & Performance",
    file: "time-attendance-performance",
    description: "Clocking, timesheets, leave, schedules, points, and staff records",
  },
  hr: {
    label: "HR & Skills",
    file: "hr-skills",
    description: "People files, skills, categories, credentials, and HR reports",
  },
  accounting: {
    label: "Accounting",
    file: "accounting",
    description: "Finance, payroll, projects, ledgers, clients, and accounting settings",
  },
};

function backupAreaForKey(key: string): Exclude<BackupScope, "all"> | null {
  const normalized = key.toLowerCase();
  if (normalized.startsWith("larsastaff")) return "staff";
  if (normalized.startsWith("larsa_hr")) return "hr";
  if (
    normalized.includes("enterprise")
    || normalized.includes("structured_accounting")
    || normalized.includes("accounting")
  ) return "accounting";
  return null;
}

function permissionActionsFor(item: Item) {
  if (item.engine === "accounting") return ACCOUNTING_ACTIONS;
  return ACCESS_ACTIONS[item.id] || VIEW_ONLY;
}

function defaultScopeForPreset(preset: string): DataScope {
  if (["Super Admin", "Admin", "Manager"].includes(preset)) return "company";
  if (["Accountant", "Admin HR"].includes(preset)) return "department";
  if (preset === "Team Leader") return "team";
  return "own";
}

function blankPermissionGrants() {
  const grants: PermissionProfile["grants"] = {};
  ACCESS_GROUPS.forEach((group) => {
    group.items.forEach((item) => {
      grants[item.id] = {};
      permissionActionsFor(item).forEach((action) => {
        grants[item.id][action] = false;
      });
    });
  });
  return grants;
}

function permissionItemById(itemId: string) {
  return ITEMS.find((item) => item.id === itemId)
    || EXTRA_PERMISSION_ITEMS.find((item) => item.id === itemId);
}

function presetPermissionProfile(preset: string): PermissionProfile {
  const grants = blankPermissionGrants();
  const allow = (itemId: string, actions?: PermissionAction[]) => {
    const item = permissionItemById(itemId);
    if (!item) return;
    (actions || permissionActionsFor(item)).forEach((action) => {
      grants[itemId] ||= {};
      grants[itemId][action] = true;
    });
    grants[itemId].view = true;
  };
  const allowGroup = (label: string, actions?: PermissionAction[]) => {
    ACCESS_GROUPS.find((group) => group.label === label)?.items.forEach((item) => allow(item.id, actions));
  };

  if (preset === "Super Admin") {
    ACCESS_GROUPS.forEach((group) => allowGroup(group.label));
  } else if (preset === "Admin") {
    allow("access");
    allow("staff-rules");
    allow("staff-backup");
    allow("admin-notifications");
    allow("data");
    allow("staff-dashboard");
    allow("staff-approvals", ["view", "approve", "manage"]);
    allow("performance-center", VIEW_EXPORT);
    allow("staff-development");
    allow("performance-history", VIEW_EXPORT);
    allow("hr-dashboard", VIEW_EXPORT);
    allow("hr-people");
    allow("hr-matrix");
    allow("hr-reports", VIEW_EXPORT);
    /* Full Accounting capability, at the same ceiling Super Admin's own
       profile would compute (allowGroup with no restricted-actions argument
       grants every action permissionActionsFor(item) allows for that item --
       the same call Super Admin's own branch above makes per group). This is
       the client half of Admin's accounting parity; the other half is the
       Postgres migration that recognizes "Admin" alongside "Owner / Super
       Admin" in the functions that actually gate writes at the database. */
    allowGroup("Accounting");
  } else if (preset === "Manager") {
    allowGroup("Time & Attendance");
    allowGroup("Performance & Workboard");
    allowGroup("HR & Skills", VIEW_EXPORT);
    allowGroup("Accounting", ["view", "approve", "export"]);
  } else if (preset === "Accountant") {
    allowGroup("Accounting", ["view", "add", "edit", "approve", "export"]);
    ["staff-clock", "staff-live", "staff-schedule", "staff-performance", "staff-timesheet"].forEach((id) =>
      allow(id, id === "staff-timesheet" ? VIEW_EXPORT : BASIC_EDIT),
    );
  } else if (preset === "Admin HR") {
    allowGroup("HR & Skills");
    allow("access");
    allow("staff-rules");
    allow("admin-notifications");
    allow("staff-approvals", ["view", "approve", "manage"]);
    allow("staff-dashboard");
    allow("staff-clock", BASIC_EDIT);
    allow("staff-live");
    allow("staff-schedule", ["view", "add", "edit", "approve"]);
    allow("staff-performance", ["view", "approve", "export"]);
    allow("performance-center", VIEW_EXPORT);
    allow("staff-development");
    allow("performance-history", VIEW_EXPORT);
    allow("staff-timesheet", VIEW_EXPORT);
    allow("staff-reports", VIEW_EXPORT);
    ["acc-dashboard", "acc-payroll", "acc-employees", "acc-reports", "acc-review"].forEach((id) =>
      allow(id, ["view", "add", "edit", "approve", "export"]),
    );
  } else if (preset === "Team Leader") {
    ["staff-dashboard", "staff-clock", "staff-live", "staff-schedule", "staff-performance", "performance-center", "staff-development", "performance-history", "staff-timesheet", "staff-approvals", "staff-reports"].forEach((id) =>
      allow(id),
    );
    ["hr-dashboard", "hr-reports"].forEach((id) => allow(id, VIEW_EXPORT));
    ["acc-dashboard", "acc-funding", "acc-expenses", "acc-materials", "acc-labor", "acc-clients", "acc-projects", "acc-boq", "acc-refs", "acc-reports", "acc-review"].forEach((id) =>
      allow(id, ["view", "add", "edit", "approve", "export"]),
    );
    allow("construction-financials", VIEW_EXPORT);
  } else if (preset === "Construction Engineer") {
    ["staff-clock", "staff-live", "staff-schedule", "staff-performance"].forEach((id) =>
      allow(id, id === "staff-live" ? VIEW_ONLY : BASIC_EDIT),
    );
    allow("performance-center", VIEW_EXPORT);
    allow("staff-development", ["view", "edit"]);
    allow("performance-history", VIEW_ONLY);
    allow("staff-timesheet", VIEW_EXPORT);
    allow("project-portal", ["view", "edit", "export"]);
    allow("construction-financials", VIEW_EXPORT);
    ["acc-expenses", "acc-materials", "acc-labor", "acc-projects", "acc-boq", "acc-review"].forEach((id) =>
      allow(id, BASIC_EDIT),
    );
  } else if (preset === "Engineer") {
    allow("staff-clock", BASIC_EDIT);
    allow("staff-live");
    allow("staff-schedule", ["view", "add"]);
    allow("staff-performance", ["view", "add", "edit"]);
    allow("performance-center", VIEW_EXPORT);
    allow("staff-development", ["view", "edit"]);
    allow("performance-history", VIEW_ONLY);
    allow("staff-timesheet", VIEW_EXPORT);
    ["acc-dashboard", "acc-projects", "acc-materials", "acc-labor", "acc-boq", "acc-review"].forEach((id) =>
      allow(id, BASIC_EDIT),
    );
  } else if (preset === "Client") {
    allow("project-portal", VIEW_ONLY);
  } else if (preset === "Trainee" || preset === "Intern") {
    // Training staff set up by an admin (username + password): clock in, see
    // their own schedule, points and development, view assigned projects.
    // No accounting or money screens by default; an admin can widen access
    // per person through the same custom-permission editor as everyone else.
    allow("staff-clock", BASIC_EDIT);
    allow("staff-live");
    allow("staff-schedule", ["view", "add"]);
    allow("staff-performance", ["view", "add"]);
    allow("performance-center", VIEW_ONLY);
    allow("staff-development", ["view", "edit"]);
    allow("performance-history", VIEW_ONLY);
    allow("staff-timesheet", VIEW_ONLY);
    allow("project-portal", VIEW_ONLY);
  } else {
    ["staff-dashboard", "staff-live", "staff-schedule", "performance-center", "staff-development", "performance-history", "staff-timesheet", "staff-reports", "hr-dashboard", "hr-reports", "acc-dashboard", "acc-reports"].forEach((id) =>
      allow(id, VIEW_EXPORT),
    );
  }

  return {
    version: 1,
    preset,
    scope: defaultScopeForPreset(preset),
    grants,
  };
}

function isAdmin(user: StaffUser) {
  return user.access === "Super Admin";
}

// Maps detailed area/action grants onto the capability names the Timeclock
// engine understands. Shared so the live check and the preset fallback agree.
function mapStaffPermissions(can: (itemId: string, action: PermissionAction) => boolean) {
  const permissions = new Set<string>();
  if (can("staff-dashboard", "view")) permissions.add("Dashboard");
  if (can("staff-clock", "view")) permissions.add("Clock In / Out");
  if (can("staff-live", "view")) permissions.add("Live Presence");
  if (can("staff-schedule", "view")) permissions.add("Schedule View");
  if (can("staff-schedule", "edit")) permissions.add("Schedule Edit");
  if (can("staff-schedule", "manage")) { permissions.add("Shift Builder"); permissions.add("Auto Schedule"); }
  if (can("staff-schedule", "approve")) permissions.add("Approve Schedule");
  if (can("staff-approvals", "add")) permissions.add("Submit Leave");
  if (can("staff-approvals", "approve")) permissions.add("Approve Leave");
  if (can("staff-approvals", "add") || can("staff-schedule", "add")) permissions.add("Schedule Change Request");
  if (can("staff-performance", "view")) permissions.add("Submit Performance");
  if (can("staff-performance", "approve") || can("staff-performance-review", "approve")) permissions.add("Approve Performance");
  if (can("access", "view")) permissions.add("People Manage");
  if (can("staff-rules", "view")) permissions.add("Rules Manage");
  if (can("staff-approvals", "manage")) permissions.add("Approval Flow Manage");
  if (can("staff-timesheet", "view") || can("staff-reports", "view")) permissions.add("Reports View");
  if (can("data", "view") || can("staff-backup", "view")) permissions.add("Backup Manage");
  if (can("staff-dashboard", "manage") || can("admin-notifications", "manage")) permissions.add("Send Notifications");
  return [...permissions];
}

const PRESET_STAFF_PERMISSIONS = new Map<string, string[]>();
function presetStaffPermissions(preset: string) {
  const cached = PRESET_STAFF_PERMISSIONS.get(preset);
  if (cached) return cached;
  const profile = presetPermissionProfile(preset);
  const list = mapStaffPermissions((itemId, action) => Boolean(profile.grants[itemId]?.[action]));
  PRESET_STAFF_PERMISSIONS.set(preset, list);
  return list;
}

function hasStaffPermission(user: StaffUser, permission: string) {
  if (isAdmin(user)) return true;
  if (Array.isArray(user.permissions) && user.permissions.length) {
    return user.permissions.includes(permission);
  }
  if (user.permissionProfile) return false;
  // Neither a detailed profile nor a stored capability list: derive the role's
  // defaults so a record created outside the Access Center still works.
  return presetStaffPermissions(user.access || "Engineer").includes(permission);
}

function accountingRole(user: StaffUser) {
  if (user.access === "Super Admin") return "Owner / Super Admin";
  /* Admin is deliberately its own distinct engine-facing role rather than a
     reuse of "Owner / Super Admin" -- see the Postgres migration that grants
     it identical permissions. Keeping the string distinct (and not merely a
     superstring of "Super Admin") matters because a couple of legacy client
     checks elsewhere test for that substring; a clean name avoids ever
     tripping one by accident in either direction. */
  if (user.access === "Admin") return "Admin";
  if (user.access === "Manager") return "Management";
  if (user.access === "Accountant") return "Accountant";
  if (user.access === "Admin HR") return "Payroll Accountant";
  if (user.access === "Team Leader") return "Project Manager";
  if (user.access === "Construction Engineer") return "Construction Engineer";
  if (user.access === "Client") return "Client Viewer";
  if (user.access === "Trainee" || user.access === "Intern") return "Viewer";
  if (user.access === "Viewer") return "Viewer";
  return "Engineer";
}

/* ---- Accounting is closed unless somebody is deliberately let in --------
   The company rule: nobody sees the Accounting area except the Developer, a
   Super Admin, an Accountant, and any individual one of those has explicitly
   given access to. Every other role — Admin, Manager, Team Leader, Admin HR,
   Construction Engineer, Engineer, Trainee, Client — sees no financial screen
   at all: not the hub, not the dashboard, not P&L, revenue, operating costs,
   funding, expenses, materials, labour, payroll, commissions, client
   statements, BOQ, suppliers, reports, the review queue, or the settings.

   Two screens stay open on purpose, because neither shows the company's
   money to somebody it does not belong to:

     My Pay — the employee's own salary record, personal the way My Settings
       is, and scoped to the signed-in person by the server, not by this file.
     Assigned Projects — the project workspace engineers actually work in. It
       is filed under Accounting in the navigation, but it carries no
       financial figures of its own; the money view of a project is
       Construction Financials, which IS closed.

   This is a hard gate rather than a default, and it is checked BEFORE any
   stored permission. That matters: the older role presets baked accounting
   grants into people's saved profiles when their accounts were made, and
   fifteen accounts have no profile at all and fall back to role defaults.
   Checking first means every one of those routes is closed by this single
   rule, and not one stored record had to be edited to close it. */
const ACCOUNTING_ALWAYS_OPEN = new Set(["my-pay", "project-portal"]);

function isAccountingItem(item: Item) {
  if (ACCOUNTING_ALWAYS_OPEN.has(item.id)) return false;
  return item.engine === "accounting"
    || item.id === "accounting-hub"
    || item.id === "payroll-portal"
    || item.id === "sales-commissions"
    || item.id === "construction-financials";
}

function accountingAccessAllowed(user: StaffUser) {
  // The Developer, resolved server-side from platform_admins by email.
  if (user.platformAdmin === true) return true;
  if (user.access === "Super Admin") return true;
  // The people whose job this is.
  if (user.access === "Accountant") return true;
  // Anyone a Super Admin has deliberately let in, one person at a time.
  return user.accountingAccess === true;
}

function legacyCanOpen(user: StaffUser, item: Item) {
  if (item.id === "overview") return true;
  if (item.id === "performance-center") return hasStaffPermission(user, "Submit Performance") || hasStaffPermission(user, "Reports View");
  if (item.id === "staff-development") return hasStaffPermission(user, "Submit Performance") || hasStaffPermission(user, "People Manage");
  if (item.id === "performance-history") return hasStaffPermission(user, "Reports View");
  if (item.id === "project-portal") {
    const accessKey = user.access || "Engineer";
    return (ACCOUNTING_SECTIONS[accessKey] || ACCOUNTING_SECTIONS.Engineer).has("projects");
  }
  if (item.id === "access") return hasStaffPermission(user, "People Manage");
  if (item.id === "staff-performance-review") return hasStaffPermission(user, "Approve Performance");
  if (item.id === "staff-performance-targets") return hasStaffPermission(user, "Approve Performance") || hasStaffPermission(user, "Rules Manage");
  if (item.id === "admin-notifications") return hasStaffPermission(user, "Send Notifications");
  if (item.id === "my-points") return hasStaffPermission(user, "Submit Performance");
  if (item.id === "data") return hasStaffPermission(user, "Backup Manage");
  if (item.engine === "staff") {
    return isAdmin(user) || hasStaffPermission(user, STAFF_PERMISSION[item.section || ""] || "");
  }
  if (item.engine === "hr") {
    if (isAdmin(user) || user.access === "Admin HR" || hasStaffPermission(user, "People Manage")) return true;
    return ["dashboard", "reports"].includes(item.section || "") && hasStaffPermission(user, "Reports View");
  }
  if (item.engine === "accounting") {
    const accessKey = user.access || "Engineer";
    return (ACCOUNTING_SECTIONS[accessKey] || ACCOUNTING_SECTIONS.Engineer).has(item.section || "");
  }
  return false;
}

function legacyCanAct(user: StaffUser, item: Item, action: PermissionAction) {
  if (action === "view") return legacyCanOpen(user, item);
  if (isAdmin(user)) return true;
  if (item.id === "performance-center") {
    return action === "export"
      ? hasStaffPermission(user, "Reports View")
      : action === "manage" && hasStaffPermission(user, "Approve Performance");
  }
  if (item.id === "staff-development") {
    if (action === "approve" || action === "manage" || action === "delete") return hasStaffPermission(user, "People Manage");
    if (action === "export") return hasStaffPermission(user, "Reports View");
    return ["add", "edit"].includes(action) && hasStaffPermission(user, "Submit Performance");
  }
  if (item.id === "performance-history") return action === "export" && hasStaffPermission(user, "Reports View");
  if (item.id === "project-portal") {
    const canView = legacyCanOpen(user, item);
    if (!canView) return false;
    if (action === "edit") return ["Manager", "Team Leader", "Construction Engineer"].includes(user.access || "");
    return action === "export";
  }
  if (item.id === "access") return hasStaffPermission(user, "People Manage");
  if (item.id === "staff-performance-review") {
    return ["edit", "approve", "export", "manage"].includes(action) && hasStaffPermission(user, "Approve Performance");
  }
  if (item.id === "staff-performance-targets") {
    return ["add", "edit", "delete", "manage"].includes(action) &&
      (hasStaffPermission(user, "Approve Performance") || hasStaffPermission(user, "Rules Manage"));
  }
  if (item.id === "admin-notifications") return hasStaffPermission(user, "Send Notifications");
  if (item.id === "data" || item.id === "staff-backup") return hasStaffPermission(user, "Backup Manage");
  if (item.id === "staff-rules") return hasStaffPermission(user, "Rules Manage");
  if (item.id === "staff-dashboard") return action === "manage" && hasStaffPermission(user, "Send Notifications");
  if (item.id === "staff-clock") {
    return ["add", "edit"].includes(action) && hasStaffPermission(user, "Clock In / Out");
  }
  if (item.id === "staff-schedule") {
    if (action === "approve") return hasStaffPermission(user, "Approve Schedule");
    if (action === "manage") return hasStaffPermission(user, "Shift Builder") || hasStaffPermission(user, "Auto Schedule");
    return ["add", "edit"].includes(action) && hasStaffPermission(user, "Schedule Edit");
  }
  if (item.id === "staff-performance" || item.id === "my-points") {
    if (action === "approve" || action === "manage") return hasStaffPermission(user, "Approve Performance");
    if (action === "export") return hasStaffPermission(user, "Reports View");
    return ["add", "edit"].includes(action) && hasStaffPermission(user, "Submit Performance");
  }
  if (item.id === "staff-approvals") {
    if (action === "manage") return hasStaffPermission(user, "Approval Flow Manage");
    return action === "approve" && (
      hasStaffPermission(user, "Approve Leave") ||
      hasStaffPermission(user, "Approve Schedule") ||
      hasStaffPermission(user, "Approve Performance")
    );
  }
  if (["staff-timesheet", "staff-reports"].includes(item.id)) {
    return action === "export" && hasStaffPermission(user, "Reports View");
  }
  if (item.engine === "hr") {
    if (user.access === "Admin HR" || hasStaffPermission(user, "People Manage")) return true;
    return action === "export" && hasStaffPermission(user, "Reports View");
  }
  if (item.engine === "accounting") {
    const allowedView = legacyCanOpen(user, item);
    if (!allowedView) return false;
    if (user.access === "Manager") return true;
    if (user.access === "Admin HR" || user.access === "Team Leader") {
      return ["add", "edit", "approve", "export"].includes(action);
    }
    if (user.access === "Engineer") return ["add", "edit"].includes(action);
    return action === "export";
  }
  return false;
}

function hasItemPermission(user: StaffUser, item: Item, action: PermissionAction = "view"): boolean {
  if (isAdmin(user)) return true;
  /* Before anything else, including any stored grant: an account that has not
     been let into Accounting cannot view, add, edit, approve, export or manage
     a single accounting screen. Placed here so the sidebar, the work-area
     tiles, the hub, quick actions, the landing page and the accounting engine
     itself all inherit the one rule — they every one of them ask this
     function, so there is no second place for it to be got wrong. */
  if (isAccountingItem(item) && !accountingAccessAllowed(user)) return false;
  if (item.id === "overview") return true;
  // Everyone manages their own account and notification preferences.
  if (item.id === "my-settings") return true;
  /* Requesting leave is personal, so opening and submitting are unconditional.
     They used to inherit from the approver's page, which meant an engineer was
     allowed to submit a request and given nowhere to do it. Acting on other
     people's requests is a separate capability and stays gated below. */
  if (item.id === "my-requests") {
    if (action === "view" || action === "add") return true;
    const approvals = ITEMS.find((row) => row.id === "staff-approvals");
    return approvals ? hasItemPermission(user, approvals, action) : false;
  }
  /* All four entries are the one portal, which is open to everybody — an
     ordinary engineer opens it to see which team they are in and who they
     report to. What differs is how much of it they can see, and that is
     decided inside the screen, not here. */
  if (ENGINEERING_ITEM_TABS[item.id]) return canSeeOrgPortal();
  /* Platform Super Admins always reach platform settings; everyone else falls
     through to the ordinary grant check for this same item. That fall-through
     has to be the grant lookup itself — asking hasItemPermission again with
     the same item recursed forever and blew the stack for every account that
     is not a Super Admin. */
  if (item.id === "platform-settings") {
    if (user.platformAdmin) return true;
    const settingsGrant = user.permissionProfile?.grants[item.id]?.[action];
    return settingsGrant === undefined ? legacyCanAct(user, item, action) : settingsGrant;
  }
  if (item.id === "live-presence") {
    const live = ITEMS.find((row) => row.id === "staff-live");
    return live ? hasItemPermission(user, live, "view") : true;
  }
  // The native quick clock is the same capability as the engine clock page.
  if (item.id === "quick-clock") {
    const clock = ITEMS.find((row) => row.id === "staff-clock");
    return clock ? hasItemPermission(user, clock, action === "view" ? "view" : "add") : false;
  }
  if (item.id === "week-schedule") {
    const schedule = ITEMS.find((row) => row.id === "staff-schedule");
    return schedule ? hasItemPermission(user, schedule, "view") : false;
  }
  /* Commission and salary together expose everyone's pay, so this follows the
     payroll permission rather than being open to anyone who can see revenue. */
  if (item.id === "sales-commissions") {
    const payrollItem = ITEMS.find((row) => row.id === "acc-payroll");
    return payrollItem ? hasItemPermission(user, payrollItem, action === "export" ? "export" : "view") : isAdmin(user);
  }
  // The hub opens if any accounting area is allowed.
  if (item.id === "accounting-hub") {
    return GROUPS.find((group) => group.label === "Accounting")!.items
      .some((row) => hasItemPermission(user, row, "view"));
  }
  /* Your own pay is yours, the way your own settings are. There is nothing
     to grant: the record is scoped to the signed-in person on the server, and
     seeing somebody ELSE's pay is a separate backend permission that no
     screen here can hand out. */
  if (item.id === "my-pay") return true;
  /* The portal shows everybody's pay, so it follows the same permission the
     accounting payroll area does — and the server independently demands the
     confidential payroll permission before it returns a single row. */
  if (item.id === "payroll-portal") {
    const payrollItem = ITEMS.find((row) => row.id === "acc-payroll");
    return payrollItem ? hasItemPermission(user, payrollItem, action) : isAdmin(user);
  }
  if (item.id === "my-points") {
    const personalGrant = user.permissionProfile?.grants["staff-performance"]?.add;
    return personalGrant === undefined
      ? legacyCanAct(user, item, action)
      : action === "view" || action === "add" || action === "edit"
        ? personalGrant
        : false;
  }
  const explicit = user.permissionProfile?.grants[item.id]?.[action];
  return explicit === undefined ? legacyCanAct(user, item, action) : explicit;
}

function isAdministrationUser(user: StaffUser) {
  if (isAdmin(user)) return true;
  const administrativeIds = [
    "access",
    "staff-rules",
    "admin-notifications",
    "staff-backup",
    "data",
  ];
  return administrativeIds.some((id) => {
    const item = ITEMS.find((row) => row.id === id);
    return item && hasItemPermission(user, item, "view");
  });
}

function canOpen(user: StaffUser | null, item: Item) {
  if (!user) return false;
  if (item.id === "admin") return isAdministrationUser(user);
  return hasItemPermission(user, item, "view");
}

function staffPermissionsForUser(user: StaffUser) {
  if (isAdmin(user)) return STAFF_PERMISSION_LIST;
  if (!user.permissionProfile) return user.permissions || [];
  return mapStaffPermissions((itemId, action) => {
    const item = permissionItemById(itemId);
    return Boolean(item && hasItemPermission(user, item, action));
  });
}

const ACCOUNTING_MODULE_FOR_ITEM: Record<string, string> = {
  "acc-dashboard": "dashboard",
  "acc-master": "reports",
  "acc-funding": "funding",
  "acc-iq-revenue": "revenue",
  "acc-us-revenue": "revenue",
  "acc-iq-operating": "operating",
  "acc-us-operating": "operating",
  "acc-usa-ledger": "reports",
  "acc-iraq-ledger": "reports",
  "acc-expenses": "expenses",
  "acc-materials": "materials",
  "acc-labor": "labor",
  "acc-payroll": "payroll",
  "acc-commissions": "commissions",
  "acc-clients": "clients",
  "acc-projects": "projects",
  "acc-boq": "boq",
  "acc-refs": "suppliers",
  "acc-employees": "employees",
  "acc-reports": "reports",
  "acc-review": "review",
  "acc-notifications": "settings",
  "acc-settings": "settings",
};

function accountingPermissionsForUser(user: StaffUser) {
  if (isAdmin(user)) return {};
  /* An account with no accounting access is handed a fully closed matrix
     rather than the empty object, because an empty object means "no override"
     and lets the engine fall back to its own role defaults. Falling through to
     the loop below produces exactly that closed matrix, since every lookup in
     it goes through hasItemPermission, which now refuses. */
  const denied = !accountingAccessAllowed(user);
  if (!denied && !user.permissionProfile) return {};
  const modules = [
    "dashboard", "funding", "revenue", "operating", "expenses", "materials", "labor", "payroll",
    "commissions", "clients", "reports", "review", "projects", "suppliers", "employees", "boq", "settings",
  ];
  const actions = ["view", "create", "edit", "delete", "approve", "export", "manageUsers", "manageSettings"];
  const result: Record<string, Record<string, boolean>> = {};
  modules.forEach((moduleKey) => {
    result[moduleKey] = {};
    actions.forEach((action) => {
      result[moduleKey][action] = false;
    });
  });
  GROUPS.find((group) => group.label === "Accounting")!.items.forEach((item) => {
    const moduleKey = ACCOUNTING_MODULE_FOR_ITEM[item.id];
    if (!moduleKey) return;
    result[moduleKey].view ||= hasItemPermission(user, item, "view");
    result[moduleKey].create ||= hasItemPermission(user, item, "add");
    result[moduleKey].edit ||= hasItemPermission(user, item, "edit");
    result[moduleKey].delete ||= hasItemPermission(user, item, "delete");
    result[moduleKey].approve ||= hasItemPermission(user, item, "approve");
    result[moduleKey].export ||= hasItemPermission(user, item, "export");
    result[moduleKey].manageSettings ||= hasItemPermission(user, item, "manage");
  });
  /* Managing users is an Administration capability, not an accounting one, so
     it has to be forced shut here too — otherwise an admin with no accounting
     access would still be handed the engine's user-management switch. */
  result.settings.manageUsers = !denied && hasItemPermission(user, ACCESS_ITEM, "manage");
  return result;
}

function enginePermissionSnapshot(user: StaffUser, engine: Engine) {
  const result: Record<string, Partial<Record<PermissionAction, boolean>>> = {};
  GROUPS.flatMap((group) => group.items)
    .filter((item) => item.engine === engine && item.section)
    .forEach((item) => {
      /* Two sidebar entries can point at the same engine page (staff-approvals
         and hr-approval-flow both open "approvals"). The FIRST one listed is
         the canonical permission source; a later alias must not overwrite what
         the engine is told this person may do. */
      if (result[item.section!]) return;
      result[item.section!] = {};
      permissionActionsFor(item).forEach((action) => {
        result[item.section!]![action] = hasItemPermission(user, item, action);
      });
    });
  return result;
}

function canOpenInSession(user: StaffUser | null, item: Item, method: SignInMethod | null) {
  return canOpen(user, item) && (method !== "pin" || PIN_ALLOWED_ITEMS.has(item.id));
}

function channelForItem(item: Item): NavChannel {
  if (item.id === "overview") return "home";
  /* Engineering Management used to resolve to "home", which meant the sidebar
     fell back to the Home group the moment you opened it — so the only way
     back was through a Home card. It owns a channel now, exactly like
     Accounting and HR, and keeps its own sidebar entry while you are in it. */
  if (ENGINEERING_ITEM_TABS[item.id]) return "engineering";
  if (
    item.id === "admin"
    || item.id === "access"
    || item.id === "data"
    || item.id === "admin-corrections"
    || ["staff-rules", "staff-backup"].includes(item.id)
  ) return "admin";
  // Sits with payroll, because that is the permission it follows.
  if (item.id === "sales-commissions" || item.id === "payroll-portal") return "accounting";
  if (item.id === "my-settings" || item.id === "my-pay") return "home";
  if (item.id === "my-requests" || item.id === "live-presence") return "time";
  if (item.id === "quick-clock" || item.id === "week-schedule") return "time";
  /* Learning and growth belong with skills, not with points. The portal keeps
     its own permissions; this only decides which sidebar it opens beside. */
  if (item.id === "staff-development") return "hr";
  if (item.id === "hr-approval-flow") return "hr";
  if (
    item.id === "my-points"
    || item.id === "performance-center"
    || item.id === "performance-history"
    || item.id === "staff-performance"
    || item.id === "staff-dashboard"
    || item.id === "staff-reports"
  ) {
    return "performance";
  }
  if (item.id === "project-portal" || item.id === "accounting-hub"
    || item.id === "construction-financials") return "accounting";
  if (item.engine === "staff") return "time";
  if (item.engine === "hr") return "hr";
  if (item.engine === "accounting") return "accounting";
  return "home";
}

function normalizeIdentity(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
// Matches an identity against a stored free-text field without the substring
// bleed that let "Ali" match "Alia Hassan" or user id "u1" match "u12".
function identityMatches(fieldValue: unknown, identity: string, exactOnly = false) {
  const field = normalizeIdentity(fieldValue);
  const target = normalizeIdentity(identity);
  if (!field || !target) return false;
  if (field === target) return true;
  if (exactOnly || target.length < 3) return false;
  const words = new RegExp(`(^|[^a-z0-9])${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  return words.test(field);
}

// Larsa work modes. Office is green, anything online is blue, site work is black.
const WORK_MODES: { id: string; label: string; tone: "office" | "online" | "site" }[] = [
  { id: "Office", label: "Office", tone: "office" },
  { id: "Online", label: "Online", tone: "online" },
  { id: "Site", label: "Site", tone: "site" },
];
function modeTone(value: unknown): "office" | "online" | "site" | "other" {
  const text = String(value ?? "").toLowerCase();
  if (/site|field|execution|\u0645\u0648\u0642\u0639/.test(text)) return "site";
  if (/online|remote|home|wfh|usa|\u0623\u0648\u0646\u0644\u0627\u064a\u0646/.test(text)) return "online";
  if (/office|onsite|\u0645\u0643\u062a\u0628/.test(text)) return "office";
  return "other";
}
// Shift codes from the Larsa scheduling standard.
const SHIFT_CODES: Record<string, { label: string; time: string; tone: "office" | "online" | "site" | "other" }> = {
  M: { label: "Morning", time: "09:00 – 15:00", tone: "office" },
  MID: { label: "Mid", time: "12:00 – 18:00", tone: "office" },
  E: { label: "Evening", time: "14:30 – 20:00", tone: "office" },
  /* The default hours only. The day and the time are both chosen in Auto
     Build, which writes the choice back here so the legend agrees. */
  MON: { label: "Team meeting", time: "16:00 – 18:00", tone: "office" },
  USA: { label: "USA online", time: "16:00 – 00:00", tone: "online" },
  WFH: { label: "From home", time: "Flexible", tone: "online" },
  SITE: { label: "Site / execution", time: "Field", tone: "site" },
  GOV: { label: "Government duty", time: "Daytime", tone: "other" },
  STB: { label: "Standby", time: "On call", tone: "other" },
  OFF: { label: "Rest day", time: "—", tone: "other" },
};
const TONE_COLOURS: Record<string, string> = {
  office: "#159b56", online: "#2563eb", site: "#17181b", other: "#7a8190",
};

/* Every office shift stays in the same green so the grid still reads
   "green = in the office, blue = online" at a glance. Only the lightness
   steps with the time of day, getting deeper as the day runs later. That
   keeps hue meaning *where* someone works and shade meaning *when*, instead
   of spending a second hue on it and making a dense week look noisy.
   Lightness is also the one dimension every form of colour blindness still
   preserves, so this ramp survives where four separate hues would not.
   A colour set by hand in the schedule's own picker still wins over these. */
const SHIFT_TINTS: Record<string, string> = {
  M: "#3cb873",    // morning, 09:00 — lightest
  MID: "#159b56",  // midday, 12:00 — the existing office green
  E: "#14804a",    // evening, 14:30 — deeper
  MON: "#0b5a34",  // Team meeting, latest by default, so darkest
};
type ShiftMeta = { label: string; time: string; tone: "office" | "online" | "site" | "other" };
type ShiftType = ShiftMeta & { code: string; start: string; end: string; custom?: boolean };
const SHIFT_TYPES_KEY = "shiftTypes";

/* The ten codes above are the ones Larsa started with. Anything the office adds
   or changes afterwards lives in the shared store and is merged over the top by
   code, so a built-in can have its hours corrected without losing the schedules
   already written against it. */
function shiftCatalogue(store: Record<string, unknown> | null): Record<string, ShiftMeta> {
  const merged: Record<string, ShiftMeta> = { ...SHIFT_CODES };
  const saved = Array.isArray(store?.[SHIFT_TYPES_KEY]) ? store[SHIFT_TYPES_KEY] as ShiftType[] : [];
  saved.forEach((row) => {
    const code = String(row?.code || "").toUpperCase().trim();
    if (!code) return;
    merged[code] = {
      label: row.label || code,
      time: row.start && row.end ? `${row.start} – ${row.end}` : row.time || "—",
      tone: row.tone || "other",
    };
  });
  return merged;
}

function shiftTimesFor(code: string, store: Record<string, unknown> | null): [string, string] {
  const key = String(code || "").toUpperCase();
  const saved = Array.isArray(store?.[SHIFT_TYPES_KEY]) ? store[SHIFT_TYPES_KEY] as ShiftType[] : [];
  const custom = saved.find((row) => String(row?.code || "").toUpperCase() === key);
  if (custom && (custom.start || custom.end)) return [custom.start || "", custom.end || ""];
  return SHIFT_TIMES[key] || ["", ""];
}
function shiftColour(code: string, custom: Record<string, string>) {
  const key = String(code || "").toUpperCase();
  if (custom[key]) return custom[key];
  if (SHIFT_TINTS[key]) return SHIFT_TINTS[key];
  const meta = SHIFT_CODES[key];
  return TONE_COLOURS[meta ? meta.tone : modeTone(key)] || TONE_COLOURS.other;
}
function readableInk(hex: string) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return (r * 299 + g * 587 + b * 114) / 1000 > 148 ? "#17181b" : "#ffffff";
}
function shiftHours(entries: { start?: string; end?: string }[]) {
  return entries.reduce((sum, entry) => {
    if (!entry.start || !entry.end) return sum;
    const [sh, sm] = entry.start.split(":").map(Number);
    const [eh, em] = entry.end.split(":").map(Number);
    const minutes = (eh * 60 + (em || 0)) - (sh * 60 + (sm || 0));
    return sum + (minutes > 0 ? minutes / 60 : 0);
  }, 0);
}

const SHIFT_TIMES: Record<string, [string, string]> = {
  M: ["09:00", "15:00"], MID: ["12:00", "18:00"], E: ["14:30", "20:00"],
  MON: ["16:00", "18:00"], USA: ["16:00", "23:59"], WFH: ["10:00", "16:00"],
  SITE: ["08:00", "15:00"], GOV: ["08:00", "14:00"], STB: ["", ""], OFF: ["", ""],
};

const OFFICE_WEEK = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
// Days the office is normally open. Friday stays visible so an individual rest
// day can differ from the company default.
const DEFAULT_OPEN_DAYS = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"];

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type ReminderTone = "due" | "open" | "done";
type HomeReminder = {
  id: string;
  group: "Today" | "This week" | "Development" | "Requests";
  title: string;
  detail: string;
  meta: string;
  tone: ReminderTone;
  itemId?: string;
};
type LeaveRequest = {
  id: string;
  type: string;
  uid: string;
  requestType?: string;
  date?: string;
  from?: string;
  to?: string;
  // Only set on a "Points Unlock" request: the closed week, and the whole
  // performance entry waiting on the decision. Approving one writes the entry.
  week?: string;
  entry?: PerformanceRow;
  reason?: string;
  status: string;
  flow?: string[];
  step?: number;
  history?: { by: string; action: string; at: string; note?: string }[];
  createdAt?: string;
  decidedBy?: string;
  decidedAt?: string;
};
const LEAVE_TYPES = ["Annual", "Sick", "Unpaid", "Emergency", "Study", "Bereavement"];

/* Who a request is waiting on right now, and which step of how many.
   `holder` is null when the request carries no chain -- older records, and
   anything created before flows existed -- and that case deliberately keeps
   the old behaviour: whoever may approve, may approve. Turning enforcement on
   must not strand requests that are already in flight.

   One function, read by both the decision handler and the queue that draws the
   buttons, so the screen cannot offer an action the handler will refuse. */
function requestStage(record: LeaveRequest): { holder: string | null; step: number; total: number } {
  const flow = Array.isArray(record.flow) ? record.flow.filter(Boolean) : [];
  if (!flow.length) return { holder: null, step: 0, total: 0 };
  const step = Math.max(0, Math.min(Number(record.step) || 0, flow.length - 1));
  return { holder: flow[step] || null, step, total: flow.length };
}

/* The full decision trail a person can follow: every approver in their chain,
   in order, and where each one stands — approved, rejected, with-them-now, or
   still waiting. Derived from the request's own flow/step/status (the same
   fields the enforced decision writes), enriched with the actual actor and time
   from history where a step has already been decided. Read-only: this reports
   what happened, it never changes who may act. Legacy requests with no chain
   return nothing, so the display simply falls back to the plain status. */
type ChainStep = { id: string; name: string; state: "approved" | "rejected" | "pending" | "waiting" | "skipped"; at?: string; note?: string };
function approvalSteps(record: LeaveRequest, nameOf: (id: string) => string): ChainStep[] {
  const flow = Array.isArray(record.flow) ? record.flow.filter(Boolean) : [];
  if (!flow.length) return [];
  const step = Math.max(0, Math.min(Number(record.step) || 0, flow.length - 1));
  const status = String(record.status || "Pending");
  const decisions = (Array.isArray(record.history) ? record.history : [])
    .filter((h) => /approv|reject|declin/i.test(String(h?.action || "")));
  let d = 0;
  return flow.map((id, i) => {
    let state: ChainStep["state"];
    if (i < step) state = "approved";
    else if (i === step) state = status === "Approved" ? "approved" : status === "Rejected" ? "rejected" : "pending";
    else state = status === "Rejected" ? "skipped" : "waiting";
    const out: ChainStep = { id, name: nameOf(id), state };
    if (state === "approved" || state === "rejected") {
      const h = decisions[d++];
      if (h) { out.at = h.at; out.note = h.note; }
    }
    return out;
  });
}

// Whole days a request covers, inclusive of both ends.
function requestDays(request: { from?: string; to?: string; date?: string }) {
  const from = request.from || request.date;
  const to = request.to || request.from || request.date;
  if (!from || !to) return 0;
  const start = new Date(`${from}T00:00:00`).getTime();
  const end = new Date(`${to}T00:00:00`).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

/* What a request is worth, shown to the person and the approver. Attendance
   corrections carry TIMES in from/to ("09:00"–"12:00" on one date), which
   requestDays cannot read — it built an Invalid Date from "09:00" and every
   correction displayed as a zero. A three-hour correction is three hours. */
function requestQuantity(request: { from?: string; to?: string; date?: string; type?: string }) {
  const looksLikeTime = (value?: string) => Boolean(value && /^\d{1,2}:\d{2}$/.test(value));
  if (looksLikeTime(request.from) && looksLikeTime(request.to)) {
    const [fh, fm] = String(request.from).split(":").map(Number);
    const [th, tm] = String(request.to).split(":").map(Number);
    const minutes = (th * 60 + tm) - (fh * 60 + fm);
    if (minutes > 0) return formatMinutes(minutes);
    return "—";
  }
  const days = requestDays(request);
  return `${days} day${days === 1 ? "" : "s"}`;
}

type BuildSettings = {
  officeDaysPerPerson: number;
  minInOffice: number;
  targetInOffice: number;
  officeHoursTarget: number;
  onlineHoursTarget: number;
  respectConstraints: boolean;
  /* Which day of OFFICE_WEEK gets the mandatory team meeting, or "" for
     none. Used to default to Monday specifically; kept as a day-of-week
     choice so any office day works, not just Monday. */
  teamMeetingDay: string;
  /* The hours that meeting runs. Empty means "leave whatever the office
     already runs alone" — the MON shift's own hours in the catalogue, which
     start at the built-in 16:00–18:00. Set them here and Auto Build writes
     them back to the catalogue, so the roster, the legend, and the palette
     chip all quote the same time instead of drifting apart. */
  teamMeetingStart: string;
  teamMeetingEnd: string;
};
const DEFAULT_BUILD: BuildSettings = {
  officeDaysPerPerson: 3,
  minInOffice: 5,
  targetInOffice: 6,
  officeHoursTarget: 18,
  onlineHoursTarget: 6,
  respectConstraints: true,
  teamMeetingDay: "Monday",
  teamMeetingStart: "",
  teamMeetingEnd: "",
};

type RoleCard = {
  id: string;
  label: string;
  value: string;
  note: string;
  tone: "plain" | "due" | "good";
  itemId?: string;
};
type HomeSummary = {
  reminders: HomeReminder[];
  openClock: ClockSession | null;
  weekApproved: number;
  weekSubmitted: number;
  weekTarget: number;
  shiftToday: string;
  dueCount: number;
  roleTitle: string;
  roleBlurb: string;
  roleCards: RoleCard[];
};

function shiftLabel(entries: { start?: string; end?: string; name?: string }[]) {
  return entries
    .map((entry) => `${entry.start || "--"}–${entry.end || "--"}`)
    .join(", ");
}

function buildHomeSummary(
  viewer: StaffUser | null,
  store: Record<string, unknown> | null,
  growth: GrowthStore,
  rows: PerformanceRow[],
  sessions: ClockSession[],
  users: StaffUser[],
  projectCount = 0,
): HomeSummary {
  const empty: HomeSummary = {
    reminders: [], openClock: null, weekApproved: 0, weekSubmitted: 0,
    weekTarget: 0, shiftToday: "", dueCount: 0,
    roleTitle: "", roleBlurb: "", roleCards: [],
  };
  if (!viewer) return empty;
  const today = dateInputValue(new Date());
  const todayName = WEEKDAY_NAMES[new Date().getDay()];
  const reminders: HomeReminder[] = [];

  // --- attendance -------------------------------------------------------
  const openClock = sessions.find((session) => session.uid === viewer.id && session.open) || null;
  const schedule = (store?.schedule as Record<string, Record<string, { start?: string; end?: string; name?: string }[]>> | undefined)?.[viewer.id];
  const todayEntries = Array.isArray(schedule?.[todayName]) ? schedule![todayName] : [];
  const shiftToday = shiftLabel(todayEntries);
  if (todayEntries.length) {
    reminders.push({
      id: "shift-today",
      group: "Today",
      title: `${todayName} shift`,
      detail: shiftToday,
      meta: openClock ? "You are clocked in" : "Not clocked in yet",
      tone: openClock ? "done" : "due",
      itemId: "quick-clock",
    });
  } else if (openClock) {
    reminders.push({
      id: "shift-open",
      group: "Today",
      title: "Clocked in",
      detail: `${openClock.mode} · started ${new Date(openClock.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      meta: `${formatHours(openClock.hours)} so far`,
      tone: "done",
      itemId: "quick-clock",
    });
  } else {
    reminders.push({
      id: "shift-none",
      group: "Today",
      title: "No shift recorded",
      detail: "Open Clock In / Out to record your attendance.",
      meta: todayName,
      tone: "open",
      itemId: "quick-clock",
    });
  }

  // --- weekly points ----------------------------------------------------
  const week = isoWeekLabel();
  const mine = rows.filter((row) => {
    if (rowUserId(row, users) !== viewer.id) return false;
    const date = rowDate(row);
    const rowWeek = String(row.Week || (date ? isoWeekLabel(new Date(`${date}T12:00:00`)) : ""));
    return rowWeek === week;
  });
  const weekSubmitted = mine.reduce((sum, row) => sum + finiteNumber(row["Submitted Points"]), 0);
  const weekApproved = mine.reduce((sum, row) => sum + finiteNumber(row["Approved Points"]), 0);
  const weekTarget = Math.max(1, finiteNumber(growth.pointTargets[viewer.id]) || 50);
  const awaiting = mine.filter((row) => !["Approved", "Returned"].includes(String(row.Status || ""))).length;
  reminders.push({
    id: "points-week",
    group: "This week",
    title: "Weekly points",
    detail: `${weekApproved} approved of ${weekTarget} target`,
    meta: awaiting ? `${awaiting} awaiting review` : weekApproved >= weekTarget ? "Target reached" : `${Math.max(0, weekTarget - weekApproved)} to go`,
    /* Progress towards a weekly target is something to get on with, not a
       fault. Red is kept for genuinely overdue work, so an ordinary Monday
       morning no longer reports the week as a problem. */
    tone: weekApproved >= weekTarget ? "done" : "open",
    itemId: "performance-center",
  });

  // --- development ------------------------------------------------------
  growth.development
    .filter((record) => record.employeeId === viewer.id && record.status !== "Approved")
    .sort((left, right) => String(left.dueDate).localeCompare(String(right.dueDate)))
    .slice(0, 4)
    .forEach((record) => {
      const overdue = Boolean(record.dueDate && record.dueDate < today);
      reminders.push({
        id: `dev-${record.id}`,
        group: "Development",
        title: record.title,
        detail: `${formatHours(record.completedHours)} of ${formatHours(record.targetHours)} · ${record.completedPresentations}/${record.targetPresentations} presentations`,
        meta: record.dueDate ? (overdue ? `Overdue ${record.dueDate}` : `Due ${record.dueDate}`) : record.status,
        tone: overdue ? "due" : "open",
        itemId: "staff-development",
      });
    });

  // --- leave and schedule requests -------------------------------------
  const approvals = Array.isArray(store?.approvals)
    ? store.approvals as { id?: string; uid?: string; type?: string; status?: string; from?: string; to?: string; date?: string; reason?: string; flow?: string[]; step?: number }[]
    : [];
  approvals
    .filter((request) => request.uid === viewer.id && request.status === "Pending")
    .slice(0, 3)
    .forEach((request) => {
      reminders.push({
        id: `req-${request.id || Math.random()}`,
        group: "Requests",
        title: `${request.type || "Request"} awaiting approval`,
        detail: request.reason || "Submitted for review",
        meta: [request.from, request.to].filter(Boolean).join(" to ") || request.date || "",
        tone: "open",
        itemId: "staff-approvals",
      });
    });
  /* What is genuinely waiting on THIS person, counted the same way the
     decision handler decides who may act. Being named somewhere in a chain is
     not the same as it being your turn: approvers two and three used to be
     told a request needed them while it still sat with approver one, who was
     the only person the handler would accept. And a chainless request — late
     points, a clock correction — belongs to whoever holds the approve grant,
     so it is only counted for them. */
  const approvalsGate = ITEMS.find((item) => item.id === "staff-approvals");
  const mayApprove = Boolean(approvalsGate && hasItemPermission(viewer, approvalsGate, "approve"));
  const queue = !mayApprove ? 0 : approvals.filter((request) => {
    if (request.status !== "Pending" || request.uid === viewer.id) return false;
    const chain = Array.isArray(request.flow) ? request.flow.filter(Boolean) : [];
    if (!chain.length) return true;
    const at = Math.max(0, Math.min(Number(request.step) || 0, chain.length - 1));
    return chain[at] === viewer.id;
  }).length;
  if (queue) {
    reminders.push({
      id: "req-queue",
      group: "Requests",
      title: "Waiting for your approval",
      detail: `${queue} request${queue === 1 ? "" : "s"} need a decision from you.`,
      meta: "Approval queue",
      tone: "due",
      itemId: "staff-approvals",
    });
  }

  // --- role-specific panel -------------------------------------------------
  const team = scopedUsers(viewer, users);
  const teamIds = new Set(team.map((user) => user.id));
  const activeStaff = users.filter((user) => user.enabled !== false);
  const weekRows = rows.filter((row) => {
    const date = rowDate(row);
    const rowWeek = String(row.Week || (date ? isoWeekLabel(new Date(`${date}T12:00:00`)) : ""));
    return rowWeek === week;
  });
  const teamRows = weekRows.filter((row) => teamIds.has(rowUserId(row, users)));
  const teamApproved = teamRows.reduce((sum, row) => sum + finiteNumber(row["Approved Points"]), 0);
  const teamTarget = team.reduce((sum, user) => sum + (finiteNumber(growth.pointTargets[user.id]) || 50), 0);
  const awaitingReview = teamRows.filter((row) => !["Approved", "Returned"].includes(String(row.Status || ""))).length;
  const pendingAll = approvals.filter((request) => request.status === "Pending").length;
  const inToday = activeStaff.filter((user) => {
    const entries = (store?.schedule as Record<string, Record<string, unknown[]>> | undefined)?.[user.id]?.[todayName];
    return Array.isArray(entries) && entries.length;
  }).length;
  const devOpen = growth.development.filter((record) => teamIds.has(record.employeeId) && record.status !== "Approved").length;
  const devMine = growth.development.filter((record) => record.employeeId === viewer.id && record.status !== "Approved").length;
  const myHoursWeek = sessions
    .filter((session) => session.uid === viewer.id && isoWeekLabel(new Date(`${session.date}T12:00:00`)) === week)
    .reduce((sum, session) => sum + session.hours, 0);

  const access = viewer.access || "Engineer";
  const card = (id: string, label: string, value: string, note: string,
    tone: RoleCard["tone"] = "plain", itemId?: string): RoleCard => ({ id, label, value, note, tone, itemId });

  let roleTitle = "Your work";
  let roleBlurb = "Your attendance, points, and development in one place.";
  let roleCards: RoleCard[] = [];

  if (["Super Admin", "Manager"].includes(access)) {
    roleTitle = "Company overview";
    roleBlurb = "Attendance, delivery, and approvals across the whole company.";
    roleCards = [
      card("in", "In the office today", `${inToday} / ${activeStaff.length}`, inToday < 5 ? "Below the 5 person minimum" : "Coverage is healthy", inToday < 5 ? "due" : "good", "week-schedule"),
      card("points", "Company points this week", `${teamApproved} / ${teamTarget}`, `${teamTarget ? Math.round((teamApproved / teamTarget) * 100) : 0}% of target`, "plain", "performance-center"),
      card("review", "Waiting for review", String(awaitingReview), awaitingReview ? "Point entries need a decision" : "Nothing pending", awaitingReview ? "due" : "good", "performance-center"),
      card("requests", "Open requests", String(pendingAll), pendingAll ? "Leave and schedule requests" : "All clear", pendingAll ? "due" : "good", "staff-approvals"),
    ];
  } else if (access === "Team Leader") {
    roleTitle = "Your team";
    roleBlurb = "Where your team stands this week and what needs your decision.";
    roleCards = [
      card("team", "Team members", String(team.length), "In your data scope", "plain", "week-schedule"),
      card("points", "Team points", `${teamApproved} / ${teamTarget}`, `${teamTarget ? Math.round((teamApproved / teamTarget) * 100) : 0}% of target`, "plain", "performance-center"),
      card("review", "Awaiting your review", String(awaitingReview), awaitingReview ? "Approve or return entries" : "Nothing pending", awaitingReview ? "due" : "good", "performance-center"),
      card("dev", "Open development", String(devOpen), "Activities in progress", devOpen ? "plain" : "good", "staff-development"),
    ];
  } else if (["Accountant"].includes(access)) {
    roleTitle = "Finance overview";
    roleBlurb = "Projects, payroll inputs, and the hours behind them.";
    roleCards = [
      card("projects", "Projects visible", String(projectCount), "Assigned to your account", "plain", "project-portal"),
      card("hours", "Your hours this week", `${formatHours(myHoursWeek)}`, "Recorded attendance", "plain", "quick-clock"),
      card("requests", "Open requests", String(pendingAll), pendingAll ? "Leave and schedule requests" : "All clear", pendingAll ? "due" : "good", "staff-approvals"),
      card("ledger", "Accounting", "Open", "Ledgers, payroll, and reports", "plain", "acc-dashboard"),
    ];
  } else if (access === "Admin HR") {
    roleTitle = "People overview";
    roleBlurb = "Attendance, leave, and development across the office.";
    roleCards = [
      card("in", "In the office today", `${inToday} / ${activeStaff.length}`, inToday < 5 ? "Below the 5 person minimum" : "Coverage is healthy", inToday < 5 ? "due" : "good", "week-schedule"),
      card("requests", "Leave to review", String(pendingAll), pendingAll ? "Waiting for a decision" : "All clear", pendingAll ? "due" : "good", "staff-approvals"),
      card("dev", "Open development", String(devOpen), "Across your scope", "plain", "staff-development"),
      card("people", "Active staff", String(activeStaff.length), "On the roster", "plain", "access"),
    ];
  } else if (access === "Construction Engineer") {
    roleTitle = "Site work";
    roleBlurb = "Your attendance, assigned projects, and learning targets.";
    roleCards = [
      card("hours", "Your hours this week", `${formatHours(myHoursWeek)}`, "Recorded attendance", "plain", "quick-clock"),
      card("points", "Your points", `${weekApproved} / ${weekTarget}`, weekApproved >= weekTarget ? "Target reached" : `${Math.max(0, weekTarget - weekApproved)} to go`, weekApproved >= weekTarget ? "good" : "plain", "performance-center"),
      card("projects", "Assigned projects", String(projectCount), "Available to you", "plain", "project-portal"),
      card("dev", "Your development", String(devMine), devMine ? "Activities open" : "All complete", devMine ? "plain" : "good", "staff-development"),
    ];
  } else if (access === "Client") {
    roleTitle = "Your projects";
    roleBlurb = "Progress on the projects shared with you.";
    roleCards = [card("projects", "Projects", String(projectCount), "Shared with your account", "plain", "project-portal")];
  } else {
    roleTitle = "Your work";
    roleBlurb = "Your attendance, points, and development in one place.";
    roleCards = [
      card("hours", "Your hours this week", `${formatHours(myHoursWeek)}`, "Recorded attendance", "plain", "quick-clock"),
      card("points", "Your points", `${weekApproved} / ${weekTarget}`, weekApproved >= weekTarget ? "Target reached" : `${Math.max(0, weekTarget - weekApproved)} to go`, weekApproved >= weekTarget ? "good" : "plain", "performance-center"),
      card("dev", "Your development", String(devMine), devMine ? "Activities open" : "All complete", devMine ? "plain" : "good", "staff-development"),
      card("shift", "In today", shiftToday || "No shift", todayName, "plain", "week-schedule"),
    ];
  }

  return {
    reminders,
    openClock,
    weekApproved,
    weekSubmitted,
    weekTarget,
    shiftToday,
    dueCount: reminders.filter((reminder) => reminder.tone === "due").length,
    roleTitle,
    roleBlurb,
    roleCards,
  };
}

function greeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function Ring({
  value, target, tone = "blue", caption, size = 132,
}: { value: number; target: number; tone?: "blue" | "green"; caption: string; size?: number }) {
  const safeTarget = Math.max(1, target);
  const percent = Math.max(0, Math.min(100, (value / safeTarget) * 100));
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className={`ring ring-${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`${caption}: ${value} of ${safeTarget}`}>
        <circle cx={size / 2} cy={size / 2} r={radius} className="ring-track" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={radius} className="ring-value" strokeWidth={stroke} fill="none"
          strokeLinecap="round" strokeDasharray={circumference}
          strokeDashoffset={circumference - (percent / 100) * circumference}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-label">
        <b>{Number.isInteger(value) ? value : value.toFixed(1)}</b>
        <small>{caption}</small>
        <em>{Math.round(percent)}%</em>
      </div>
    </div>
  );
}

/* Horizontal bars, one per row.
 *
 * This was a column chart. With a handful of people that reads well; with the
 * whole company it does not — twenty-eight columns in a fixed-width card left
 * every name clipped to "Mary…" and pushed the bars clean outside the card.
 * Rows solve both: the bar length is a share of the row, so it can never
 * overflow however many people there are, and the name gets a real column.
 * Sorted by value, because the question a chart like this answers is "who is
 * ahead", not "what order is the roster in".
 */
function MiniBars({ data, ariaLabel }: { data: { label: string; value: number }[]; ariaLabel: string }) {
  const peak = Math.max(1, ...data.map((row) => row.value));
  const rows = [...data].sort((left, right) => right.value - left.value);
  return (
    <div className="bar-rows" role="img" aria-label={ariaLabel}>
      {rows.map((row, index) => (
        <div className="bar-row" key={`${row.label}-${index}`} title={`${row.label}: ${row.value}`}>
          <small>{row.label}</small>
          <span className="bar-track">
            <i style={{ width: `${row.value > 0 ? Math.max(2, (row.value / peak) * 100) : 0}%` }} />
          </span>
          <b>{row.value.toLocaleString()}</b>
        </div>
      ))}
      {!rows.length && <div className="empty compact">Nothing recorded for this period.</div>}
    </div>
  );
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

/* ==================================================================
   Profile photographs
   ==================================================================
   There is no file storage in this deployment -- no buckets, no objects --
   and the sign-in model is a self-asserted actor on an anonymous Supabase
   session, which means a bucket could not be scoped to its owner by RLS
   anyway. So a photo is kept on the person's own record, as a data URL, the
   same way project chat already keeps its images.

   That only works if the pictures are genuinely small. A photograph off a
   phone is 3-8 MB; the staff record is synced in full to every device, so
   storing one unaltered would make signing in slower for everybody in the
   company. These are cropped square and re-encoded to a 192px JPEG, which
   lands around 10-18 KB -- under a megabyte for a company of forty, and
   sharp enough for a 96px avatar on a retina screen. Measured rather than
   guessed: a 2400x1600 noise field of 311 KB comes out at 17 KB, and a real
   photograph -- which compresses far better than noise -- lands nearer 10. */
const AVATAR_EDGE = 192;
/* The ceiling is per person and generous: a busy photograph at quality .8 is
   about 14 KB, so anything approaching this has failed to compress and is
   worth another pass rather than storing. */
const AVATAR_MAX_BYTES = 48 * 1024;
const AVATAR_QUALITY_LADDER = [0.8, 0.68, 0.55, 0.42];

/* Centre-cropped rather than squashed. Everything that shows a person is a
   circle or a rounded square, so a portrait letterboxed into one would sit in
   bars; cropping to the middle is what a face actually wants. */
function prepareAvatar(file: File): Promise<string> {
  if (!String(file.type || "").startsWith("image/")) {
    return Promise.reject(new Error("not-an-image"));
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read-failed"));
    reader.onload = () => {
      const image = new window.Image();
      image.onerror = () => reject(new Error("read-failed"));
      image.onload = () => {
        try {
          const width = image.width || 1;
          const height = image.height || 1;
          const edge = Math.min(width, height);
          const canvas = document.createElement("canvas");
          canvas.width = AVATAR_EDGE;
          canvas.height = AVATAR_EDGE;
          const context = canvas.getContext("2d");
          if (!context) { reject(new Error("no-canvas")); return; }
          context.drawImage(
            image,
            Math.round((width - edge) / 2), Math.round((height - edge) / 2), edge, edge,
            0, 0, AVATAR_EDGE, AVATAR_EDGE,
          );
          /* Step the quality down until it fits rather than refusing outright.
             Being told "too large" about a photo you cannot resize is a dead
             end; the app is the thing holding the encoder. */
          for (const quality of AVATAR_QUALITY_LADDER) {
            const encoded = canvas.toDataURL("image/jpeg", quality);
            if (encoded.length <= AVATAR_MAX_BYTES) { resolve(encoded); return; }
          }
          reject(new Error("too-large"));
        } catch {
          reject(new Error("read-failed"));
        }
      };
      image.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

/* One element, two states, so every place that already shows initials can show
   a face without its own layout. The span keeps whatever class the surrounding
   CSS sizes and rounds it with; the picture is laid over the top and clipped
   to that same shape. */
function PersonAvatar({ person, className }: {
  person: { name?: string | null; photo?: string | null } | null | undefined;
  className?: string;
}) {
  const name = person?.name || "";
  const photo = person?.photo;
  if (!photo) return <span className={className}>{initials(name)}</span>;
  return (
    <span className={className ? `${className} person-photo` : "person-photo"}>
      {/* Decorative: the name is always written next to it, so announcing the
          picture as well would just say everything twice. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo} alt="" aria-hidden="true" />
    </span>
  );
}

function isoWeekLabel(date = new Date()) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/* Performance weeks are closed by hand -- somebody with the right permission
   locks a week once the work in it is final. A locked week stops the people who
   report their own points from writing into it directly; it deliberately does
   NOT stop review, because closing the week is exactly when approvals happen.

   There is no standing exception list. Every entry into a closed week is its
   own request carrying the whole entry, approved on its own merits, so the
   record always shows exactly what was let in and by whom. */
type WeekLock = {
  week: string;
  lockedBy: string;
  lockedAt: string;
  note?: string;
};

function weekLocks(store: Record<string, unknown> | null | undefined): Record<string, WeekLock> {
  const locks = store?.weekLocks;
  return locks && typeof locks === "object" ? locks as Record<string, WeekLock> : {};
}

/* The one question every caller asks: is this week closed to direct entry? */
function weekLockFor(
  store: Record<string, unknown> | null | undefined,
  week: string,
): WeekLock | null {
  return weekLocks(store)[week] || null;
}

/* One description of a performance entry, so the approver reads the same thing
   in the requests queue, the notification, and the week panel. */
function entryLine(entry: PerformanceRow | undefined) {
  if (!entry) return "";
  return [
    // Project and Deliverable are only present on entries made before the form
    // was cut back to the job number.
    entry["Job Number"] || entry.Project,
    entry["Work Category"],
    entry.Deliverable,
    `${finiteNumber(entry["Submitted Points"])} pts`,
    finiteNumber(entry["Hours Spent"]) ? `${finiteNumber(entry["Hours Spent"])} h` : "",
  ].filter(Boolean).join(" · ");
}

function weekOfDate(value: string) {
  if (!value) return isoWeekLabel();
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? isoWeekLabel() : isoWeekLabel(date);
}

/* Monday and Sunday of an ISO week label, so an unlock request can be stored
   and displayed with real dates like every other request. ISO week 1 is the one
   containing 4 January, which is what makes this arithmetic work at year ends. */
function weekBounds(week: string) {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(week || "");
  if (!match) return { from: "", to: "" };
  const jan4 = new Date(Date.UTC(Number(match[1]), 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (Number(match[2]) - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

/* Moves a week label forward or backward by whole weeks, via its Monday --
   the only way to walk weeks that is immune to month and year-end drift. */
function shiftWeek(week: string, byWeeks: number) {
  const bounds = weekBounds(week);
  if (!bounds.from) return isoWeekLabel();
  const monday = new Date(`${bounds.from}T12:00:00`);
  monday.setDate(monday.getDate() + byWeeks * 7);
  return isoWeekLabel(monday);
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function currentMonthKey(date = new Date()) {
  return dateInputValue(date).slice(0, 7);
}

function monthEnd(month: string) {
  const [year, number] = month.split("-").map(Number);
  if (!year || !number) return "";
  return dateInputValue(new Date(year, number, 0));
}

function projectAccessForPreset(preset: string): ProjectAccessMode {
  if (["Super Admin", "Admin", "Manager", "Accountant", "Admin HR"].includes(preset)) return "all";
  return "assigned";
}

function normalizeGrowthStore(raw: unknown, users: StaffUser[]): GrowthStore {
  const source = raw && typeof raw === "object" ? raw as Partial<GrowthStore> : {};
  const targets = source.pointTargets && typeof source.pointTargets === "object"
    ? { ...source.pointTargets }
    : {};
  users.filter((user) => user.enabled !== false).forEach((user) => {
    if (!Number.isFinite(Number(targets[user.id])) || Number(targets[user.id]) <= 0) targets[user.id] = 50;
  });
  const development = Array.isArray(source.development)
    ? source.development.filter((record): record is DevelopmentRecord =>
        Boolean(record && typeof record === "object" && "id" in record && "employeeId" in record))
      .map((record) => ({
        ...record,
        targetHours: finiteNumber(record.targetHours),
        targetPresentations: finiteNumber(record.targetPresentations),
        completedHours: finiteNumber(record.completedHours),
        completedPresentations: finiteNumber(record.completedPresentations),
        history: Array.isArray(record.history) ? record.history : [],
      }))
    : [];
  return { version: 1, pointTargets: targets, development };
}

/* ==================================================================
   PAGE SCOPE
   Every page answers a question about one of four populations. Which
   one used to be implied by an "Employee" and a "Department" dropdown
   that, for most people, contained exactly one entry each. The switch
   below states the scope instead, and only offers the levels the
   viewer actually has — so an engineer sees no switch at all.
   ================================================================== */
const SCOPE_ORDER: DataScope[] = ["own", "team", "department", "company"];
const SCOPE_LABEL: Record<DataScope, string> = {
  own: "Mine", team: "Team", department: "Department", company: "Company",
};

function maxScopeOf(viewer: StaffUser | null): DataScope {
  if (!viewer) return "own";
  if (isAdmin(viewer)) return "company";
  return viewer.permissionProfile?.scope || defaultScopeForPreset(viewer.access || "Engineer");
}

/* The ladder stops at the viewer's own ceiling, and a rung is dropped only when
   it shows exactly the same people as the rung before it — a team leader with
   no reports gains nothing from a "Team" button listing the same one person.
   Comparison is by membership, not by count: a department that merely happens
   to be smaller than a team is still a different question worth asking. */
function scopesAvailableTo(viewer: StaffUser | null, users: StaffUser[]): DataScope[] {
  if (!viewer) return ["own"];
  const ceiling = SCOPE_ORDER.indexOf(maxScopeOf(viewer));
  const rungs = SCOPE_ORDER.slice(0, Math.max(0, ceiling) + 1);
  const kept: DataScope[] = [];
  let previous = "";
  rungs.forEach((scope) => {
    const signature = usersInScope(viewer, users, scope)
      .map((user) => user.id).sort().join(",");
    if (!kept.length || signature !== previous) { kept.push(scope); previous = signature; }
  });
  return kept;
}

function usersInScope(viewer: StaffUser | null, users: StaffUser[], scope: DataScope): StaffUser[] {
  if (!viewer) return [];
  const active = users.filter((user) => user.enabled !== false);
  if (scope === "own") return active.filter((user) => user.id === viewer.id);
  if (scope === "company") return active;
  if (scope === "department") {
    return active.filter((user) => user.id === viewer.id
      || Boolean(viewer.department && user.department?.toLowerCase() === viewer.department.toLowerCase()));
  }
  return active.filter((user) => {
    if (user.id === viewer.id) return true;
    if (!user.manager) return false;
    return identityMatches(user.manager, viewer.id, true)
      || identityMatches(user.manager, viewer.name)
      || identityMatches(user.manager, viewer.email || "", true);
  });
}

function ScopeSwitch({
  scopes, value, onChange, label = "Showing",
}: {
  scopes: DataScope[];
  value: DataScope;
  onChange: (scope: DataScope) => void;
  label?: string;
}) {
  // One rung is not a choice; rendering it would be the very clutter this replaces.
  if (scopes.length < 2) return null;
  return (
    <div className="scope-switch" role="group" aria-label={`${label} scope`}>
      <span className="scope-switch-label">{label}</span>
      <div className="scope-switch-track">
        {scopes.map((scope) => (
          <button
            key={scope}
            type="button"
            className={scope === value ? "active" : ""}
            aria-pressed={scope === value}
            onClick={() => onChange(scope)}
          >{SCOPE_LABEL[scope]}</button>
        ))}
      </div>
    </div>
  );
}

function scopedUsers(viewer: StaffUser | null, users: StaffUser[]) {
  if (!viewer) return [];
  const activeUsers = users.filter((user) => user.enabled !== false);
  if (isAdmin(viewer)) return activeUsers;
  const scope = viewer.permissionProfile?.scope || defaultScopeForPreset(viewer.access || "Engineer");
  if (scope === "company") return activeUsers;
  if (scope === "department") {
    return activeUsers.filter((user) =>
      user.id === viewer.id
      || Boolean(viewer.department && user.department?.toLowerCase() === viewer.department.toLowerCase()));
  }
  if (scope === "team") {
    return activeUsers.filter((user) => {
      if (user.id === viewer.id) return true;
      if (!user.manager) return false;
      return identityMatches(user.manager, viewer.id, true)
        || identityMatches(user.manager, viewer.name)
        || identityMatches(user.manager, viewer.email || "", true);
    });
  }
  return activeUsers.filter((user) => user.id === viewer.id);
}

/* Where a user's CURRENT reporting starts, per their History Mode. A display
   rule only: logs before this moment stay permanently stored (and appear
   again the moment the mode is set back to "all"), they are just not shown
   in current reports. */
function historyStartFor(user: StaffUser | undefined): number {
  if (!user) return 0;
  const mode = user.historyMode || "all";
  if (mode === "from" && user.historyFrom) {
    const ms = new Date(user.historyFrom).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (mode === "current") {
    const periods = Array.isArray(user.employmentPeriods) ? user.employmentPeriods : [];
    const last = periods[periods.length - 1];
    const ms = last?.start ? new Date(last.start).getTime() : NaN;
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

function buildClockSessions(store: Record<string, unknown> | null, users: StaffUser[]): ClockSession[] {
  const logs = Array.isArray(store?.logs) ? (store.logs as ClockLog[]) : [];
  const names = new Map(users.map((user) => [user.id, user.name]));
  const historyStarts = new Map(users.map((user) => [user.id, historyStartFor(user)]));
  const grouped = new Map<string, ClockLog[]>();
  logs.forEach((log) => {
    if (!log.uid || !log.time) return;
    const start = historyStarts.get(log.uid) || 0;
    if (start && new Date(log.time).getTime() < start) return;
    const group = grouped.get(log.uid) || [];
    group.push(log);
    grouped.set(log.uid, group);
  });
  const sessions: ClockSession[] = [];
  grouped.forEach((rows, uid) => {
    let open: ClockLog | null = null;
    rows.sort((left, right) =>
      new Date(left.time || 0).getTime() - new Date(right.time || 0).getTime());

    /* Break spans for this person, merged so two overlapping breaks can never
       be deducted twice. A break that was started but never ended is left open
       and clamped to the session end below, so forgetting to end one costs the
       rest of that shift rather than being ignored outright. */
    const breaks: { start: number; end: number }[] = [];
    let breakStart: number | null = null;
    rows.forEach((row) => {
      if (!row.time) return;
      if (row.status === "Break Start") { breakStart ??= new Date(row.time).getTime(); return; }
      if (row.status === "Break End" && breakStart !== null) {
        breaks.push({ start: breakStart, end: new Date(row.time).getTime() });
        breakStart = null;
      }
    });
    if (breakStart !== null) breaks.push({ start: breakStart, end: Number.POSITIVE_INFINITY });
    breaks.sort((left, right) => left.start - right.start);
    const merged: { start: number; end: number }[] = [];
    breaks.forEach((span) => {
      const last = merged[merged.length - 1];
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    });
    /* Milliseconds of break that fall inside the given window. Clamping each
       span to the window is what stops a lunch bleeding across a clock-out
       into the next shift. */
    const breakMsWithin = (from: number, to: number) => merged.reduce((total, span) => {
      const overlap = Math.min(to, span.end) - Math.max(from, span.start);
      return total + Math.max(0, overlap);
    }, 0);

    /* A session shown to nobody by its raw id is a bug report waiting to
       happen; a removed account still worked those hours as a person. */
    /* Never show a bare account id where a person's name belongs. A uid with
       no matching account is either a recovered session awaiting
       identification (flagged needs-review by the incident repair) or a
       genuinely departed account whose history is retained. Both get an
       honest human label — "u12" must never read like an employee. */
    const needsReview = rows.some((row) => row.recovery === "needs-review");
    const label = names.get(uid)
      || (needsReview ? `Needs identification (recovered session, was ${uid})` : `Former staff (${uid})`);

    /* A correction stamp on either punch marks the whole session as already
       adjusted, so the trim panel can say so instead of leaving the next
       corrector to guess. */
    const adjustedMark = (...notes: (string | undefined)[]) => notes.some((note) =>
      Boolean(note && (note.includes("Adjusted by") || note.includes("Fixed by") || note.includes("Manual entry by"))));

    /* One ClockSession per LOCAL calendar day. clockIn/clockOut always carry
       the original punches (they are the session's identity for trim and
       reset); the segment's own hours carry only what fell on `date`. */
    const record = (start: string, end: string, mode: string, isOpen: boolean, flag?: "stale" | "unclosed", adjusted?: boolean) => {
      const from = new Date(start).getTime();
      const to = Math.max(new Date(end).getTime(), from);
      const flagged = flag === "stale" || flag === "unclosed";
      let cursor = from;
      while (cursor < to || cursor === from) {
        const day = new Date(cursor);
        const nextMidnight = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0).getTime();
        const segEnd = Math.min(to, nextMidnight);
        const grossMs = Math.max(0, segEnd - cursor);
        const breakMs = Math.min(grossMs, breakMsWithin(cursor, segEnd));
        sessions.push({
          uid,
          employee: label,
          mode,
          clockIn: start,
          clockOut: end,
          date: dateInputValue(day),
          /* A flagged session is listed but contributes nothing until it is
             corrected — never silently into totals, exports, or payroll. */
          hours: flagged ? 0 : Math.max(0, (grossMs - breakMs) / 3600000),
          presenceHours: flagged ? 0 : grossMs / 3600000,
          breakHours: flagged ? 0 : breakMs / 3600000,
          open: isOpen && segEnd === to,
          ...(flag ? { [flag]: true, openHours: (to - from) / 3600000 } : {}),
          ...(adjusted ? { adjusted: true } : {}),
        });
        if (segEnd >= to) break;
        cursor = segEnd;
      }
    };

    rows.forEach((row) => {
        if (row.status === "In") {
          if (open?.time && row.time) {
            const gapHours = (new Date(row.time).getTime() - new Date(open.time).getTime()) / 3600000;
            if (gapHours < 12) {
              /* Same shift, pressed twice: the first press is the punch. The
                 old behaviour silently replaced it, which threw away worked
                 minutes with no trace. */
              return;
            }
            /* A new day's clock-in after an open one from long ago: the old
               session was abandoned, so it surfaces flagged for correction
               rather than being silently discarded — or silently merged into
               one enormous shift. */
            record(open.time, row.time, open.type || "Unspecified", false, "unclosed", adjustedMark(open.note));
          }
          open = row;
          return;
        }
        if (row.status !== "Out" || !open?.time || !row.time) return;
        record(open.time, row.time, open.type || row.type || "Unspecified", false, undefined, adjustedMark(open.note, row.note));
        open = null;
      });
    /* Read through a fresh binding. TypeScript narrows `open` to `never` here,
       because it cannot see that the callback above reassigns it, and a build
       with type checking on then refuses the file. */
    const stillOpen = open as ClockLog | null;
    if (stillOpen?.time) {
      const openHours = (Date.now() - new Date(stillOpen.time).getTime()) / 3600000;
      /* Open under 48 h: a live shift, counted normally. Past 48 h: stale.
         Still never auto-closed — the logs are untouched and the person or a
         manager closes or resets it — but flagged and excluded until then. */
      record(stillOpen.time, new Date().toISOString(), stillOpen.type || "Unspecified", true,
        openHours >= 48 ? "stale" : undefined, adjustedMark(stillOpen.note));
    }
  });
  return sessions;
}

function performanceRows(store: Record<string, unknown> | null) {
  return Array.isArray(store?.performance) ? store.performance as PerformanceRow[] : [];
}

function rowUserId(row: PerformanceRow, users: StaffUser[]) {
  if (row.uid) return row.uid;
  const engineer = String(row.Engineer || "").trim().toLowerCase();
  return users.find((user) => user.name.trim().toLowerCase() === engineer)?.id || "";
}

function rowDate(row: PerformanceRow) {
  if (row.Date && !Number.isNaN(new Date(row.Date).getTime())) return String(row.Date);
  const match = String(row.Week || "").match(/^(\d{4})-W(\d{2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const week = Number(match[2]);
  const start = new Date(Date.UTC(year, 0, 4));
  const day = start.getUTCDay() || 7;
  start.setUTCDate(start.getUTCDate() - day + 1 + (week - 1) * 7);
  return start.toISOString().slice(0, 10);
}

function withinDates(value: string, from: string, to: string) {
  if (!value) return false;
  return (!from || value >= from) && (!to || value <= to);
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
}

function downloadRows(name: string, rows: unknown[][]) {
  saveDownload(name, rows.map((row) => row.map(csvCell).join(",")).join("\n"), "text/csv;charset=utf-8");
}

function readNotifications(): AppNotification[] {
  const store = parseStore(NOTIFY_STORE_KEY);
  return Array.isArray(store?.items) ? store.items as AppNotification[] : [];
}
function prefsFor(user: StaffUser | null): NotifyPrefs {
  const merged: NotifyPrefs = {};
  NOTIFY_EVENTS.forEach((event) => {
    merged[event.id] = { ...DEFAULT_NOTIFY_PREFS[event.id], ...(user?.notifyPrefs?.[event.id] || {}) };
  });
  return merged;
}
/* Who is raising notifications right now. raiseNotification() is module-level
   and called from a dozen places that already pass a display name but have no
   reason to know about actors, so the shell keeps this pointed at the signed-in
   user and the call sites stay as they were. */
let notifyActor: { id: string; name: string } | null = null;
function setNotifyActor(user: StaffUser | null) {
  notifyActor = user ? { id: user.id, name: user.name } : null;
}

/* One place that raises a notification.
 *
 * The in-app record is unconditional. It is written to Supabase, where it
 * belongs to its recipient and is readable from every device they sign in on;
 * a copy is kept in localStorage so the bell still has something to show
 * offline, and on a deployment with no backend at all. What preferences can
 * change is only whether it ALSO reaches somebody outside the app — and that
 * decision is made server-side, by the sender, against preferences that live
 * with the account rather than on whichever laptop happened to raise it.
 *
 * There is no path through this function that skips the in-app record. */
function raiseNotification(input: {
  event: string; title: string; body: string; itemId?: string;
  fromName: string; recipients: StaffUser[]; dedupeKey?: string;
}) {
  if (typeof window === "undefined") return;
  const now = new Date().toISOString();
  const stamp = Date.now();

  // The local mirror, written first so the bell updates on this device without
  // waiting for a round trip.
  const store = parseStore(NOTIFY_STORE_KEY) || { version: 1, items: [] };
  const items: AppNotification[] = Array.isArray(store.items) ? store.items : [];
  input.recipients.forEach((person, index) => {
    items.unshift({
      id: `n${stamp}_${index}_${Math.random().toString(36).slice(2, 6)}`,
      event: input.event, title: input.title, body: input.body,
      at: now, toId: person.id, fromName: input.fromName, read: false, itemId: input.itemId,
    });
  });
  try {
    localStorage.setItem(NOTIFY_STORE_KEY, JSON.stringify({ version: 1, items: items.slice(0, 400) }));
  } catch { /* a full quota must not stop the authoritative write below */ }

  if (!notifyConfigured()) return;
  const actor = notifyActor || { id: input.recipients[0]?.id || "system", name: input.fromName };
  void raiseNotifications(actor, input.recipients.map((person) => ({
    userUid: person.id,
    event: input.event,
    title: input.title,
    body: input.body,
    itemId: input.itemId,
    // A stable key per (event, recipient, occurrence) so a double-tapped
    // Approve or a retried save lands once, not twice.
    dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${person.id}` : undefined,
  })));

  input.recipients.forEach((person) => {
    if (person.email && prefsFor(person)[input.event]?.email) {
      // Email stays a client-side fire-and-forget for now; a failed email must
      // never block the notification it rides with.
      sendMail({ to: person.email, subject: input.title, html: `<p>${input.body}</p>` });
    }
  });
}

/* ==================================================================
   PROJECT GROUP ROOMS
   One conversation per construction project, shared by the client,
   the assigned engineers, and the managers. Membership is not a new
   permission system: whoever can already see the project can already
   see its room, so access stays governed by visibleProjectIds().
   Nothing is ever hard-deleted — removal is a redaction that leaves a
   tombstone and an audit entry, and a locked message resists removal
   entirely.
   ================================================================== */
// A short, unambiguous set. Approval and "seen it" carry real weight on a site
// thread, so the like sits first and the rest stay few enough to scan.
const CHAT_REACTIONS = ["👍", "✅", "❤️", "🎉", "👀", "❓"] as const;
const CHAT_MAX_ATTACHMENT = 3 * 1024 * 1024;   // per file, after compression
const CHAT_IMAGE_MAX_EDGE = 1600;               // px, long edge
const CHAT_STORE_SOFT_LIMIT = 4 * 1024 * 1024;  // warn before the browser refuses

/* The stored session is an identity, not a credential. The password and PIN are
   stripped before writing, because the live record is re-read from the staff
   store on restore — so keeping secrets in the browser buys nothing and costs a
   great deal if the device is shared or stolen. */
function persistSession(user: StaffUser, method: SignInMethod, keep: boolean) {
  const safeUser: StaffUser = { ...user };
  delete safeUser.password;
  delete safeUser.pin;
  const payload = JSON.stringify({ user: safeUser, method });
  try {
    sessionStorage.setItem("larsa-control-session", payload);
  } catch {
    // A refused write must never block the person from working.
  }
  try {
    if (keep) localStorage.setItem(KEEP_SESSION_KEY, payload);
    else localStorage.removeItem(KEEP_SESSION_KEY);
  } catch {
    // Private-browsing quota refusals are not sign-in failures.
  }
}

function readChatStore(): ChatStore {
  const raw = parseStore(PROJECT_CHAT_KEY);
  return {
    version: 1,
    rooms: Array.isArray(raw?.rooms) ? raw.rooms as ChatRoom[] : [],
    messages: Array.isArray(raw?.messages) ? raw.messages as ChatMessage[] : [],
    audit: Array.isArray(raw?.audit) ? raw.audit as ChatAudit[] : [],
  };
}

function writeChatStore(store: ChatStore) {
  localStorage.setItem(PROJECT_CHAT_KEY, JSON.stringify({
    version: 1,
    rooms: store.rooms,
    messages: store.messages,
    // The trail is the point of the feature, so it is kept long but bounded.
    audit: store.audit.slice(0, 4000),
  }));
}

function chatAudit(store: ChatStore, entry: Omit<ChatAudit, "id" | "at">): ChatStore {
  return {
    ...store,
    audit: [{ ...entry, id: `ca_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString() }, ...store.audit],
  };
}

function chatStoreBytes() {
  try {
    return (localStorage.getItem(PROJECT_CHAT_KEY) || "").length;
  } catch {
    return 0;
  }
}

function attachmentKind(type: string): ChatAttachment["kind"] {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return "file";
}

/* Photographs straight from a phone are 3-8 MB and would fill the browser's
   storage after a handful of posts, so images are re-encoded to a sane long
   edge before they are stored. Everything else is passed through and simply
   rejected when it is too large to keep. */
function prepareAttachment(file: File): Promise<ChatAttachment> {
  const base: Omit<ChatAttachment, "data"> = {
    id: `at_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "attachment",
    kind: attachmentKind(file.type || ""),
    type: file.type || "application/octet-stream",
    size: file.size,
  };
  const readAsDataUrl = () => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });
  if (base.kind !== "image") {
    return readAsDataUrl().then((data) => {
      if (data.length > CHAT_MAX_ATTACHMENT) throw new Error("too-large");
      return { ...base, data };
    });
  }
  return readAsDataUrl().then((original) => new Promise<ChatAttachment>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      try {
        const scale = Math.min(1, CHAT_IMAGE_MAX_EDGE / Math.max(image.width || 1, image.height || 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((image.width || 1) * scale));
        canvas.height = Math.max(1, Math.round((image.height || 1) * scale));
        const context = canvas.getContext("2d");
        if (!context) { resolve({ ...base, data: original }); return; }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const shrunk = canvas.toDataURL("image/jpeg", 0.82);
        const data = shrunk.length < original.length ? shrunk : original;
        if (data.length > CHAT_MAX_ATTACHMENT) { reject(new Error("too-large")); return; }
        resolve({ ...base, data, type: data === shrunk ? "image/jpeg" : base.type });
      } catch {
        resolve({ ...base, data: original });
      }
    };
    image.onerror = () => reject(new Error("read-failed"));
    image.src = original;
  }));
}

/* Everyone the project is already visible to. The client is included through
   the same clientName / clientEmail match the project grid uses. */
function roomMembers(projectId: string, staff: StaffUser[], projects: AccountingProject[]) {
  return staff.filter((person) => person.enabled !== false
    && visibleProjectIds(person, projects).has(projectId));
}

/* Mirrors usd() in public/engines/accounting.html exactly: an IQD figure is
   divided by the rate captured on that line, or by the current setting when
   the line predates that being recorded. Anything else is already USD. */
const DEFAULT_IQD_RATE = 1310;
function toUsd(amount: unknown, currency: unknown, rate: number, lineRate = 0) {
  const value = finiteNumber(amount);
  if (String(currency || "USD").toUpperCase() !== "IQD") return value;
  return value / Math.max(1, lineRate > 0 ? lineRate : rate);
}
/* A line only counts once it is real money: the engine treats these as
   settled and excludes anything still requested, pending, or rejected. */
const SETTLED = ["Approved", "Paid", "Received"];
function readLedger(rows: unknown, amountKey: string): LedgerLine[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row: Record<string, unknown>) => ({
    id: String(row.id || ""),
    projectId: String(row.projectId || ""),
    date: String(row.date || ""),
    status: String(row.status || ""),
    currency: String(row.currency || "USD"),
    amount: finiteNumber(row[amountKey]),
    consultancyFee: finiteNumber(row.consultancyFee),
    waived: row.waived === true,
    fxRate: finiteNumber(row.fxRate),
    label: String(row.itemName || row.trade || row.description || row.category || ""),
  }));
}

function readAccountingSnapshot(): AccountingSnapshot {
  const empty: AccountingSnapshot = {
    key: "", rate: DEFAULT_IQD_RATE, projects: [], documents: [], commissions: [], payroll: [],
    funding: [], revenue: [], materials: [], labor: [], expenses: [],
  };
  if (typeof window === "undefined") return empty;
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    .filter((key): key is string => Boolean(key?.toLowerCase().startsWith("larsa")));
  const preferred = keys.find((key) => key.endsWith("_v34_clean"))
    || keys.find((key) => key.toLowerCase().includes("accounting"))
    || keys.find((key) => key.toLowerCase().includes("enterprise"))
    || "";
  const ordered = preferred ? [preferred, ...keys.filter((key) => key !== preferred)] : keys;
  /* An *empty* accounting store used to win this search and stop it dead: the
     old loop accepted the first key whose `projects` was an array, and an
     array with nothing in it still passes that test. The accounting engine
     writes its data under "larsa_enterprise_v3_new_account_20260630", while a
     second, always-empty "..._v34_clean" key also exists on the device, so the
     empty one was shadowing every real project and the whole native side of
     accounting — project list, financial charts, portal totals — rendered as
     if the company had no projects at all. Stores that actually hold projects
     are tried first now, and the empty ones only as a last resort so a
     genuinely fresh install still reports "no projects" rather than nothing. */
  const candidates = [
    ...ordered.filter((key) => {
      const store = parseStore(key);
      return Array.isArray(store?.projects) && store.projects.length > 0;
    }),
    ...ordered,
  ];
  for (const key of candidates) {
    const store = parseStore(key);
    if (!Array.isArray(store?.projects)) continue;
    const projects = store.projects.map((row: Record<string, unknown>) => ({
      id: String(row.id || ""),
      code: String(row.code || ""),
      name: String(row.name || ""),
      clientName: String(row.clientName || row.client || ""),
      clientEmail: String(row.clientEmail || ""),
      region: String(row.region || ""),
      type: String(row.type || ""),
      phase: String(row.phase || ""),
      status: String(row.status || ""),
      priority: String(row.priority || ""),
      responsibleEngineer: String(row.responsibleEngineer || ""),
      projectManager: String(row.projectManager || ""),
      teamLeader: String(row.teamLeader || ""),
      startDate: String(row.startDate || ""),
      dueDate: String(row.dueDate || ""),
      projectAddress: String(row.projectAddress || ""),
      progress: Math.max(0, Math.min(100, finiteNumber(row.progress))),
      googleDriveLink: String(row.googleDriveLink || ""),
      clickUpLink: String(row.clickUpLink || ""),
      contractValue: finiteNumber(row.contractValue),
    })).filter((project: AccountingProject) => project.id);
    const documents = Array.isArray(store.documents) ? store.documents as AccountingDocument[] : [];
    const commissions: CommissionRow[] = (Array.isArray(store.commissions) ? store.commissions : [])
      .map((row: Record<string, unknown>) => ({
        id: String(row.id || ""),
        person: String(row.person || ""),
        date: String(row.date || ""),
        description: String(row.description || ""),
        base: finiteNumber(row.base),
        rate: finiteNumber(row.rate),
        due: finiteNumber(row.due),
        paid: finiteNumber(row.paid),
        status: String(row.status || ""),
        region: String(row.region || ""),
      }));
    const payroll: PayrollRow[] = (Array.isArray(store.payroll) ? store.payroll : [])
      .map((row: Record<string, unknown>) => ({
        id: String(row.id || ""),
        employee: String(row.employee || ""),
        employeeId: String(row.employeeId || ""),
        payDate: String(row.payDate || row.date || ""),
        period: String(row.period || ""),
        grossPay: finiteNumber(row.grossPay ?? row.gross),
        // Company cost includes employer contributions; fall back to gross.
        totalCompanyCost: finiteNumber(row.totalCompanyCost) || finiteNumber(row.grossPay ?? row.gross),
        currency: String(row.currency || "USD"),
        status: String(row.status || ""),
        region: String(row.region || ""),
      }));
    const settings = (store.settings || {}) as Record<string, unknown>;
    return {
      key,
      rate: Math.max(1, finiteNumber(settings.rate) || DEFAULT_IQD_RATE),
      projects, documents, commissions, payroll,
      funding: readLedger(store.funding, "amount"),
      revenue: readLedger(store.revenue, "amount"),
      materials: readLedger(store.materials, "amount"),
      labor: readLedger(store.projectLabor, "total"),
      expenses: readLedger(store.expenses, "amount"),
    };
  }
  return empty;
}

/* ============================================================
   Construction financials

   Two separate things, never added together:

   A) Client fund control — money Larsa holds and manages FOR a
      project. Gross client funding, the consultancy fee taken
      from it, the net construction funds that remain, what has
      been spent on materials/labour/other, and the balance still
      held for the client. None of this is Larsa's money.

   B) Larsa company accounting — what the company actually earns.
        larsaRevenue = consultancy fees earned
                     + engineering revenue
                     + other Larsa revenue
        companyNet   = larsaRevenue - Larsa's own expenses
      Client funding is NOT revenue, and materials or labour paid
      out of client-controlled funds are NOT company expenses, so
      company profit is never "funding minus construction spend".

   The authoritative figures come from the backend
   (acct_company_financials). These local sums are the offline
   fallback and the worked example, and follow exactly the same
   rules so the two can never tell different stories.
   ============================================================ */
type ProjectFinancials = {
  /* A) client fund control */
  funding: number; fees: number; netFunding: number;
  materials: number; labor: number; expenses: number;
  cost: number; workingCost: number; pendingCost: number;
  balance: number; workingBalance: number;
  /* B) Larsa company accounting */
  revenue: number; larsaRevenue: number; companyExpenses: number;
  companyNet: number; margin: number;
  /* reliability */
  unapproved: number; status: "green" | "yellow" | "red";
};
const ZERO_FINANCIALS: ProjectFinancials = {
  funding: 0, fees: 0, netFunding: 0,
  materials: 0, labor: 0, expenses: 0,
  cost: 0, workingCost: 0, pendingCost: 0,
  balance: 0, workingBalance: 0,
  revenue: 0, larsaRevenue: 0, companyExpenses: 0,
  companyNet: 0, margin: 0,
  unapproved: 0, status: "green",
};
/* `within` lets the same arithmetic serve a whole-company total, one region,
   one project, or a single month, without a second copy of the rules. */
function sumLedger(
  rows: LedgerLine[], ids: Set<string> | null, rate: number,
  within?: (row: LedgerLine) => boolean,
) {
  return rows.reduce((total, row) => {
    if (ids && !ids.has(row.projectId)) return total;
    if (!SETTLED.includes(row.status)) return total;
    if (within && !within(row)) return total;
    return total + toUsd(row.amount, row.currency, rate, row.fxRate);
  }, 0);
}
/* Every live saved entry, whether or not it has been approved: working
   totals move the moment something is entered. */
const OPEN_STATUSES = ["Draft", "Pending", "Pending Approval", "Expected", "Requested", "Ordered", "Partially Paid"];
function isLive(status: string) {
  return SETTLED.includes(status) || OPEN_STATUSES.includes(status);
}
/* A cost only leaves the client's fund control when it is explicitly
   Larsa's own money — never by default. */
function isLarsaBorne(row: LedgerLine) {
  const src = String((row as { paymentSource?: unknown }).paymentSource || "").toLowerCase();
  return ["larsa", "larsa operating", "larsa funds", "company", "company funds",
    "company account", "larsa account", "operating", "overhead", "larsa overhead"].includes(src);
}
function sumLive(
  rows: LedgerLine[], ids: Set<string> | null, rate: number,
  approvedOnly: boolean, larsaBorne: boolean,
  within?: (row: LedgerLine) => boolean,
) {
  return rows.reduce((total, row) => {
    if (ids && !ids.has(row.projectId)) return total;
    if (!(approvedOnly ? SETTLED.includes(row.status) : isLive(row.status))) return total;
    if (isLarsaBorne(row) !== larsaBorne) return total;
    if (within && !within(row)) return total;
    return total + toUsd(row.amount, row.currency, rate, row.fxRate);
  }, 0);
}
function financialsFor(
  snapshot: AccountingSnapshot, ids: Set<string> | null,
  within?: (row: LedgerLine) => boolean,
): ProjectFinancials {
  const rate = snapshot.rate;
  /* ---- A) client fund control ---- */
  const funding = sumLedger(snapshot.funding, ids, rate, within);
  const fees = snapshot.funding.reduce((total, row) => {
    if (ids && !ids.has(row.projectId)) return total;
    if (!SETTLED.includes(row.status) || row.waived) return total;
    if (within && !within(row)) return total;
    return total + toUsd(row.consultancyFee, row.currency, rate, row.fxRate);
  }, 0);
  const materials = sumLive(snapshot.materials, ids, rate, true, false, within);
  const labor = sumLive(snapshot.labor, ids, rate, true, false, within);
  const expenses = sumLive(snapshot.expenses, ids, rate, true, false, within);
  const cost = materials + labor + expenses;
  const workingCost =
    sumLive(snapshot.materials, ids, rate, false, false, within)
    + sumLive(snapshot.labor, ids, rate, false, false, within)
    + sumLive(snapshot.expenses, ids, rate, false, false, within);
  const netFunding = funding - fees;
  /* ---- B) Larsa company accounting ---- */
  const revenue = sumLedger(snapshot.revenue, ids, rate, within);
  const companyExpenses =
    sumLive(snapshot.materials, ids, rate, true, true, within)
    + sumLive(snapshot.labor, ids, rate, true, true, within)
    + sumLive(snapshot.expenses, ids, rate, true, true, within);
  const larsaRevenue = fees + revenue;
  const companyNet = larsaRevenue - companyExpenses;
  /* ---- reliability ---- */
  const ledgers = [snapshot.funding, snapshot.materials, snapshot.labor, snapshot.expenses, snapshot.revenue];
  let unapproved = 0;
  ledgers.forEach((list) => list.forEach((row) => {
    if (ids && !ids.has(row.projectId)) return;
    if (within && !within(row)) return;
    if (OPEN_STATUSES.includes(row.status)) unapproved += 1;
  }));
  return {
    funding, fees, netFunding,
    materials, labor, expenses,
    cost, workingCost, pendingCost: workingCost - cost,
    balance: netFunding - cost,
    workingBalance: netFunding - workingCost,
    revenue, larsaRevenue, companyExpenses, companyNet,
    margin: larsaRevenue > 0 ? (companyNet / larsaRevenue) * 100 : 0,
    unapproved,
    status: unapproved > 0 ? "yellow" : "green",
  };
}

/* Every month from the first dated line to the last, with no gaps, so a month
   where nothing happened still shows as an empty column rather than being
   skipped and making the run of months read wrong. */
function monthKeysFor(snapshot: AccountingSnapshot, ids: Set<string> | null) {
  const ledgers = [snapshot.funding, snapshot.revenue, snapshot.materials, snapshot.labor, snapshot.expenses];
  const found: string[] = [];
  ledgers.forEach((rows) => rows.forEach((row) => {
    if (ids && !ids.has(row.projectId)) return;
    if (!SETTLED.includes(row.status)) return;
    const key = String(row.date || "").slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(key)) found.push(key);
  }));
  if (!found.length) return [] as string[];
  const sorted = found.sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const keys: string[] = [];
  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7));
  for (let guard = 0; guard < 240; guard += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    keys.push(key);
    if (key === last) break;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return keys;
}
type MonthPoint = { key: string; label: string; figures: ProjectFinancials };
function monthlySeries(snapshot: AccountingSnapshot, ids: Set<string> | null): MonthPoint[] {
  return monthKeysFor(snapshot, ids).map((key) => ({
    key,
    label: new Date(`${key}-01T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
    figures: financialsFor(snapshot, ids, (row) => String(row.date || "").slice(0, 7) === key),
  }));
}

/* Figures are held in USD, matching the engine, and converted only for
   display. IQD is shown whole; USD keeps no cents either, since these are
   project totals rather than invoice lines. */
function formatMoney(usdValue: number, currency: "IQD" | "USD", rate: number) {
  const value = currency === "IQD" ? usdValue * rate : usdValue;
  const text = Math.round(value).toLocaleString("en-US");
  return currency === "IQD" ? `${text} IQD` : `$${text}`;
}
/* Long IQD figures need to stay readable inside a card, so millions and
   billions are abbreviated on the summary tiles only. */
function formatCompact(usdValue: number, currency: "IQD" | "USD", rate: number) {
  const value = currency === "IQD" ? usdValue * rate : usdValue;
  const sign = value < 0 ? "-" : "";
  const size = Math.abs(value);
  const unit = currency === "IQD" ? " IQD" : "";
  const head = currency === "IQD" ? "" : "$";
  if (size >= 1e9) return `${sign}${head}${(size / 1e9).toFixed(2)}b${unit}`;
  if (size >= 1e6) return `${sign}${head}${(size / 1e6).toFixed(2)}m${unit}`;
  if (size >= 1e4) return `${sign}${head}${Math.round(size / 1e3).toLocaleString("en-US")}k${unit}`;
  return `${sign}${head}${Math.round(size).toLocaleString("en-US")}${unit}`;
}

/* A worked example, held in memory and never written to storage or synced, so
   the layout can be read and checked against real arithmetic before the
   company's own figures are in. Four projects across both regions, with a
   deliberately loss-making one and a fee-waived payment, because those are
   the cases worth being able to spot. Toggled off, this view shows the real
   accounting store instead — same columns, same maths. */
function sampleConstructionSnapshot(rate: number): AccountingSnapshot {
  const project = (
    id: string, code: string, name: string, clientName: string,
    region: string, status: string,
  ): AccountingProject => ({
    id, code, name, clientName, clientEmail: "", region,
    type: "Construction", phase: "Execution", status, priority: "Normal",
    responsibleEngineer: "", projectManager: "", teamLeader: "",
    startDate: "", dueDate: "", projectAddress: "", progress: 0,
    googleDriveLink: "", clickUpLink: "", contractValue: 0,
  });
  const line = (
    projectId: string, date: string, amount: number, label: string,
    extra: Partial<LedgerLine> = {},
  ): LedgerLine => ({
    id: `${projectId}-${date}-${label}`, projectId, date, status: "Approved",
    currency: "USD", amount, consultancyFee: 0, waived: false, label, fxRate: 0, ...extra,
  });
  return {
    key: "sample",
    // The example converts at whatever rate the office has set, so switching
    // to IQD here reads the same way the real figures will.
    rate,
    documents: [], commissions: [], payroll: [],
    projects: [
      project("sp1", "IQ-101", "Erbil Residential Tower", "Barzani Holdings", "Iraq", "Active"),
      project("sp2", "IQ-102", "Basra Warehouse Complex", "Gulf Logistics", "Iraq", "Active"),
      project("sp3", "US-201", "Houston Office Fit-Out", "Lone Star Realty", "USA", "Active"),
      project("sp4", "IQ-103", "Mosul Clinic Extension", "Health Ministry", "Iraq", "On Hold"),
    ],
    /* Client money into the construction trust, with Larsa's consultancy fee
       on each payment. sp2's March payment is waived, so its fee is nil. */
    funding: [
      line("sp1", "2026-02-10", 400000, "Advance", { consultancyFee: 20000, status: "Received" }),
      line("sp1", "2026-04-12", 350000, "Stage 2", { consultancyFee: 17500, status: "Received" }),
      line("sp1", "2026-06-15", 250000, "Stage 3", { consultancyFee: 12500, status: "Received" }),
      line("sp2", "2026-03-05", 180000, "Advance", { consultancyFee: 9000, waived: true, status: "Received" }),
      line("sp2", "2026-05-20", 220000, "Stage 2", { consultancyFee: 11000, status: "Received" }),
      line("sp4", "2026-04-01", 90000, "Advance", { consultancyFee: 4500, status: "Received" }),
    ],
    // USA construction is billed as engineering revenue, not trust funding.
    revenue: [
      line("sp3", "2026-03-18", 210000, "Fit-out billing", { status: "Received" }),
      line("sp3", "2026-05-22", 165000, "Fit-out billing 2", { status: "Received" }),
    ],
    materials: [
      line("sp1", "2026-02-20", 190000, "Concrete & rebar"),
      line("sp1", "2026-04-18", 145000, "Cladding"),
      line("sp1", "2026-06-20", 96000, "Finishes"),
      line("sp2", "2026-03-12", 120000, "Steel frame"),
      line("sp2", "2026-05-25", 88000, "Roof sheeting"),
      line("sp3", "2026-03-25", 74000, "Partitions & glazing"),
      line("sp3", "2026-05-28", 51000, "Flooring"),
      line("sp4", "2026-04-10", 68000, "Blockwork"),
    ],
    labor: [
      line("sp1", "2026-02-25", 82000, "Structural crew"),
      line("sp1", "2026-04-22", 64000, "Cladding crew"),
      line("sp1", "2026-06-24", 41000, "Finishing crew"),
      line("sp2", "2026-03-16", 58000, "Erection crew"),
      line("sp2", "2026-05-28", 39000, "Roofing crew"),
      line("sp3", "2026-03-28", 46000, "Fit-out crew"),
      line("sp3", "2026-05-30", 32000, "Finishing crew"),
      line("sp4", "2026-04-15", 43000, "Masonry crew"),
    ],
    expenses: [
      line("sp1", "2026-03-01", 26000, "Site supervision"),
      line("sp1", "2026-05-01", 21000, "Equipment hire"),
      line("sp2", "2026-04-02", 18000, "Site supervision"),
      line("sp3", "2026-04-05", 15000, "Permits & inspection"),
      line("sp4", "2026-05-05", 24000, "Site supervision"),
    ],
  };
}

/* Two stacked columns a month, on one scale shared across every month shown.
   Stacking rather than a bar per figure means each column still reads as the
   month's total income or total cost, while showing what it is made of —
   funding / fee / revenue on the way in, materials / labour / expenses on the
   way out. Income shades of blue, cost shades of red, so the two sides stay
   distinguishable by hue and the parts by lightness, which survives colour
   blindness where six separate hues would not. CSS only, and it prints. */
/* Client funds received, kept apart from what Larsa earned on them. */
const INFLOW_PARTS: { key: keyof ProjectFinancials; label: string; tint: string }[] = [
  { key: "netFunding", label: "Net client funds", tint: "#1e40af" },
  { key: "fees", label: "Larsa fee earned", tint: "#3b82f6" },
  { key: "revenue", label: "Engineering revenue", tint: "#93c5fd" },
];
const COST_PARTS: { key: keyof ProjectFinancials; label: string; tint: string }[] = [
  { key: "materials", label: "Materials", tint: "#991b1b" },
  { key: "labor", label: "Labour", tint: "#dc2626" },
  { key: "expenses", label: "Other expenses", tint: "#fca5a5" },
];

function MonthBars({
  points, currency, rate,
}: {
  points: MonthPoint[];
  currency: "IQD" | "USD";
  rate: number;
}) {
  if (!points.length) return null;
  const peak = Math.max(
    1,
    ...points.map((point) => Math.max(
      point.figures.netFunding + point.figures.fees + point.figures.revenue,
      point.figures.workingCost,
    )),
  );
  const column = (
    figures: ProjectFinancials,
    parts: typeof INFLOW_PARTS,
    total: number,
    heading: string,
  ) => (
    <span className="fin-stack" title={`${heading} ${formatMoney(total, currency, rate)}`}>
      {parts.map((part) => {
        const value = figures[part.key] as number;
        if (value <= 0) return null;
        return (
          <i
            key={part.key}
            style={{ height: `${(value / peak) * 100}%`, background: part.tint }}
            title={`${part.label} ${formatMoney(value, currency, rate)}`}
          />
        );
      })}
    </span>
  );
  return (
    <div className="fin-chart">
      <div className="fin-chart-key">
        {[...INFLOW_PARTS, ...COST_PARTS].map((part) => (
          <span key={part.key}><i style={{ background: part.tint }} /> {part.label}</span>
        ))}
        <span><i style={{ background: "#0f7b45" }} /> Larsa net</span>
      </div>
      <div className="fin-chart-plot" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(46px, 1fr))` }}>
        {points.map((point) => (
          <div className="fin-month" key={point.key}>
            <span className="fin-month-bars">
              {column(point.figures, INFLOW_PARTS,
                point.figures.netFunding + point.figures.fees + point.figures.revenue, "Received")}
              {column(point.figures, COST_PARTS, point.figures.workingCost, "Spent")}
            </span>
            <b className={point.figures.companyNet < 0 ? "fin-month-net down" : "fin-month-net"}>
              {point.figures.companyNet === 0 ? "\u2014" : formatCompact(point.figures.companyNet, currency, rate)}
            </b>
            <small>{point.label}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

/* Why "Install" can look broken on an iPhone.
   Only Safari can add a real standalone web app on iOS. Chrome, Edge, Firefox
   and the rest all render with WebKit there, so the page looks identical and
   the Install button appears to do nothing useful — by far the commonest cause
   of "it will not install on iPhone". Every iOS browser reports "Safari"
   somewhere in its user agent, so the dependable test is the presence of
   another browser's own token rather than looking for Safari itself. */
type InstallOs = "ios" | "android" | "mac" | "windows" | "";
function installPlatform(): { ios: boolean; wrongBrowser: string; standalone: boolean; os: InstallOs } {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return { ios: false, wrongBrowser: "", standalone: false, os: "" };
  }
  const ua = navigator.userAgent || "";
  const ios = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const wrongBrowser = /CriOS/.test(ua) ? "Chrome"
    : /FxiOS/.test(ua) ? "Firefox"
    : /EdgiOS/.test(ua) ? "Edge"
    : /OPiOS|OPT\//.test(ua) ? "Opera"
    : /DuckDuckGo/.test(ua) ? "DuckDuckGo"
    : /YaBrowser/.test(ua) ? "Yandex"
    : "";
  let standalone = false;
  try {
    standalone = window.matchMedia("(display-mode: standalone)").matches
      || (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch { /* matchMedia missing on very old browsers */ }
  const os: InstallOs = ios ? "ios"
    : /Android/.test(ua) ? "android"
    : /Mac/.test(ua) ? "mac"
    : /Win/.test(ua) ? "windows"
    : "";
  return { ios, wrongBrowser: ios ? wrongBrowser : "", standalone, os };
}

/* The authoritative backend figures, mapped into the same shape the page
   already renders. USD equivalents are per-entry historical snapshots, so
   nothing here ever re-converts history at today's rate. */
type ServerFinancialRow = Record<string, unknown>;
function num(source: unknown, path: string[]): number {
  let node: unknown = source;
  for (const key of path) {
    if (!node || typeof node !== "object") return 0;
    node = (node as Record<string, unknown>)[key];
  }
  const value = Number(node);
  return Number.isFinite(value) ? value : 0;
}
function fromServerRow(row: ServerFinancialRow): ProjectFinancials {
  const ap = ["client_funds", "approved"];
  const wk = ["client_funds", "working"];
  const pn = ["client_funds", "pending"];
  const co = ["company"];
  const larsaRevenue = num(row, [...co, "larsa_revenue_usd"]);
  const companyNet = num(row, [...co, "company_net_profit_usd"]);
  const status = String(num(row, ["review", "needs_correction_entries"]) > 0
    ? "red" : num(row, ["review", "unapproved_entries"]) > 0 ? "yellow" : "green") as ProjectFinancials["status"];
  return {
    funding: num(row, [...ap, "gross_funding_usd"]),
    fees: num(row, [...ap, "initial_fee_usd"]),
    netFunding: num(row, [...ap, "net_construction_funding_usd"]),
    materials: num(row, [...ap, "materials_usd"]),
    labor: num(row, [...ap, "labor_usd"]),
    expenses: num(row, [...ap, "other_costs_usd"]),
    cost: num(row, [...ap, "construction_cost_usd"]),
    workingCost: num(row, [...wk, "construction_cost_usd"]),
    pendingCost: num(row, [...pn, "construction_cost_usd"]),
    balance: num(row, [...ap, "remaining_balance_usd"]),
    workingBalance: num(row, [...wk, "remaining_balance_usd"]),
    revenue: num(row, [...co, "engineering_revenue_usd"]),
    larsaRevenue,
    companyExpenses: num(row, [...co, "company_expenses_usd"]),
    companyNet,
    margin: larsaRevenue > 0 ? (companyNet / larsaRevenue) * 100 : 0,
    unapproved: num(row, ["review", "unapproved_entries"]),
    status,
  };
}
function addFinancials(a: ProjectFinancials, b: ProjectFinancials): ProjectFinancials {
  const larsaRevenue = a.larsaRevenue + b.larsaRevenue;
  const companyNet = a.companyNet + b.companyNet;
  return {
    funding: a.funding + b.funding, fees: a.fees + b.fees, netFunding: a.netFunding + b.netFunding,
    materials: a.materials + b.materials, labor: a.labor + b.labor, expenses: a.expenses + b.expenses,
    cost: a.cost + b.cost, workingCost: a.workingCost + b.workingCost, pendingCost: a.pendingCost + b.pendingCost,
    balance: a.balance + b.balance, workingBalance: a.workingBalance + b.workingBalance,
    revenue: a.revenue + b.revenue, larsaRevenue,
    companyExpenses: a.companyExpenses + b.companyExpenses, companyNet,
    margin: larsaRevenue > 0 ? (companyNet / larsaRevenue) * 100 : 0,
    unapproved: a.unapproved + b.unapproved,
    status: a.status === "red" || b.status === "red" ? "red"
      : a.status === "yellow" || b.status === "yellow" ? "yellow" : "green",
  };
}

function ConstructionFinancials({
  snapshot, viewer,
}: {
  snapshot: AccountingSnapshot;
  viewer: StaffUser | null;
}) {
  const [useSample, setUseSample] = useState(false);
  const [region, setRegion] = useState("All");
  const [currency, setCurrency] = useState<"IQD" | "USD">("IQD");
  const [openProject, setOpenProject] = useState("");
  /* One authoritative calculation: when the shared ledger is reachable its
     figures replace the local sums entirely, so this page, the engine's
     summary, the client statement and every export agree by construction. */
  const [serverRows, setServerRows] = useState<Record<string, ProjectFinancials> | null>(null);
  const [ledgerNote, setLedgerNote] = useState("");
  useEffect(() => {
    let cancelled = false;
    // Deferred a tick, matching the hydrate pattern used elsewhere here, so
    // the effect never sets state synchronously during render.
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (useSample) { setServerRows(null); setLedgerNote(""); return; }
      const client = supabaseConfigured() ? getSupabaseClient() : null;
      if (!client) { setLedgerNote("Offline figures — the shared accounting ledger is not connected."); return; }
      client.rpc("acct_company_financials", { p_project_ids: null, p_region: null }).then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) { setLedgerNote("Offline figures — could not reach the shared accounting ledger."); return; }
        const payload = data as { rows?: ServerFinancialRow[] };
        const map: Record<string, ProjectFinancials> = {};
        (payload.rows || []).forEach((row) => {
          const id = String((row as Record<string, unknown>).project_id || "");
          if (id) map[id] = fromServerRow(row);
        });
        setServerRows(map);
        setLedgerNote("");
      }, () => { if (!cancelled) setLedgerNote("Offline figures — could not reach the shared accounting ledger."); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [useSample]);


  const sample = useMemo(() => sampleConstructionSnapshot(snapshot.rate), [snapshot.rate]);
  const live = useSample ? sample : snapshot;
  /* Server figures win whenever the ledger answered for a project; the local
     sums remain as the offline fallback and for the worked example. */
  const figuresFor = useCallback((ids: Set<string>) => {
    if (serverRows && !useSample) {
      let total = ZERO_FINANCIALS;
      let found = false;
      ids.forEach((id) => {
        const row = serverRows[id];
        if (row) { total = addFinancials(total, row); found = true; }
      });
      if (found) return total;
    }
    return financialsFor(live, ids);
  }, [serverRows, useSample, live]);
  const rate = live.rate;
  const show = (value: number) => formatMoney(value, currency, rate);
  const brief = (value: number) => formatCompact(value, currency, rate);

  // Only projects this account may see, and only construction ones.
  const allowed = useMemo(
    () => (useSample
      ? new Set(sample.projects.map((row) => row.id))
      : visibleProjectIds(viewer, snapshot.projects)),
    [useSample, sample, viewer, snapshot.projects],
  );
  const isConstruction = (row: AccountingProject) => row.type === "Construction" || row.phase === "Execution";
  const projects = useMemo(
    () => live.projects.filter((row) => allowed.has(row.id) && isConstruction(row)
      && (region === "All" || row.region === region)),
    [live.projects, allowed, region],
  );
  const scopeIds = useMemo(() => new Set(projects.map((row) => row.id)), [projects]);

  const rows = useMemo(
    () => projects
      .map((project) => ({
        project,
        figures: figuresFor(new Set([project.id])),
        months: monthlySeries(live, new Set([project.id])),
      }))
      .sort((a, b) => b.figures.funding - a.figures.funding),
    [projects, live, figuresFor],
  );
  const totals = useMemo(
    () => (scopeIds.size ? figuresFor(scopeIds) : ZERO_FINANCIALS),
    [scopeIds, figuresFor],
  );
  const totalMonths = useMemo(
    () => (scopeIds.size ? monthlySeries(live, scopeIds) : []),
    [scopeIds, live],
  );
  const regionRows = useMemo(() => ["Iraq", "USA"].map((name) => {
    const ids = new Set(live.projects
      .filter((row) => allowed.has(row.id) && isConstruction(row) && row.region === name)
      .map((row) => row.id));
    return { name, count: ids.size, figures: ids.size ? figuresFor(ids) : ZERO_FINANCIALS };
  }), [live, allowed, figuresFor]);

  const scale = Math.max(1, ...rows.map((row) => Math.max(row.figures.netFunding, row.figures.workingCost)));

  /* Two separate groups of tiles, never mixed into a single "income".
     Client funds are money held for the project; company figures are what
     Larsa earned. */
  const clientTiles: { label: string; value: number; note: string; tone: string }[] = [
    { label: "Gross client funding", value: totals.funding, note: "Received and held for projects", tone: "in" },
    { label: "Consultancy fee", value: totals.fees, note: "Taken from funding", tone: "in" },
    { label: "Net construction funds", value: totals.netFunding, note: "Available to spend", tone: "in" },
    { label: "Approved cost", value: totals.cost, note: "Materials + labour + other", tone: "out" },
    { label: "Working cost", value: totals.workingCost, note: totals.pendingCost > 0 ? `Incl. ${show(totals.pendingCost)} unapproved` : "All approved", tone: "out" },
    { label: "Client balance held", value: totals.balance, note: `Working: ${show(totals.workingBalance)}`, tone: "hold" },
  ];
  const companyTiles: { label: string; value: number; note: string; tone: string }[] = [
    { label: "Consultancy fee revenue", value: totals.fees, note: "Earned by Larsa", tone: "in" },
    { label: "Engineering revenue", value: totals.revenue, note: "Booked to projects", tone: "in" },
    { label: "Larsa revenue", value: totals.larsaRevenue, note: "Fees + engineering + other", tone: "in" },
    { label: "Larsa expenses", value: totals.companyExpenses, note: "Costs Larsa itself paid", tone: "out" },
    { label: "Company net profit", value: totals.companyNet, note: `${totals.margin.toFixed(1)}% margin`, tone: totals.companyNet < 0 ? "down" : "up" },
  ];

  return (
    <div className="native-scroll">
      <section className="overview-hero">
        <div>
          <span className="eyebrow">Accounting</span>
          <h2>Construction financials</h2>
          <p>
            What every construction project earned and what it cost — company total, each region,
            and each project month by month.
          </p>
        </div>
        <span className="access-pill">
          <CircleDollarSign size={16} /> {currency === "IQD" ? `1 USD = ${rate.toLocaleString("en-US")} IQD` : "US dollars"}
        </span>
      </section>

      <section className="fin-toolbar">
        <label>
          <span>Region</span>
          <select value={region} onChange={(event) => setRegion(event.target.value)}>
            <option value="All">Whole company</option>
            <option value="Iraq">Iraq</option>
            <option value="USA">USA</option>
          </select>
        </label>
        <div className="fin-currency" role="group" aria-label="Currency">
          {(["IQD", "USD"] as const).map((code) => (
            <button
              type="button"
              key={code}
              className={currency === code ? "active" : ""}
              onClick={() => setCurrency(code)}
            >
              {code}
            </button>
          ))}
        </div>
        <label className="fin-sample">
          <input type="checkbox" checked={useSample} onChange={(event) => setUseSample(event.target.checked)} />
          <span>Worked example</span>
        </label>
      </section>

      {useSample && (
        <p className="fin-note">
          A four-project example, so the figures and layout can be checked. Nothing is saved or
          synced — untick to return to your own accounting data.
        </p>
      )}

      {ledgerNote && <p className="fin-note">{ledgerNote}</p>}
      {serverRows && (
        <p className="fin-note">
          Figures come from the shared accounting ledger — the same calculation the accounting
          engine, the client statement and every export use.
        </p>
      )}

      {totals.unapproved > 0 && (
        <p className="fin-note" style={{ borderInlineStartColor: "#b58900", color: "#7a5c00" }}>
          ⏳ Contains {totals.unapproved} unapproved entr{totals.unapproved === 1 ? "y" : "ies"}. Working
          figures include every saved entry — approval changes reliability, never the amounts.
        </p>
      )}

      <section className="panel">
        <div className="section-head">
          <div>
            <span className="eyebrow">A · Client fund control</span>
            <h3>Money held and managed for clients</h3>
          </div>
          <span className="black-badge">not Larsa revenue</span>
        </div>
        <p className="fin-note">
          Client construction funding is held in trust for the project. It is never counted as
          Larsa income, and construction spending out of it is never a Larsa company expense.
        </p>
        <section className="fin-tiles">
          {clientTiles.map((tile) => (
            <article key={tile.label} className={`fin-tile ${tile.tone}`}>
              <small>{tile.label}</small>
              <b title={show(tile.value)}>{brief(tile.value)}</b>
              <em>{tile.note}</em>
            </article>
          ))}
        </section>
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <span className="eyebrow">B · Larsa company accounting</span>
            <h3>What the company actually earned</h3>
          </div>
          <span className="black-badge">{show(totals.companyNet)} net profit</span>
        </div>
        <p className="fin-note">
          Larsa revenue = consultancy fees earned + engineering revenue + other Larsa revenue.
          Company net profit = Larsa revenue − Larsa&rsquo;s own expenses.
        </p>
        <section className="fin-tiles">
          {companyTiles.map((tile) => (
            <article key={tile.label} className={`fin-tile ${tile.tone}`}>
              <small>{tile.label}</small>
              <b title={show(tile.value)}>{brief(tile.value)}</b>
              <em>{tile.note}</em>
            </article>
          ))}
        </section>
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <span className="eyebrow">Month by month</span>
            <h3>{region === "All" ? "All construction projects" : `${region} construction`}</h3>
          </div>
          <span className="black-badge">{show(totals.companyNet)} company net</span>
        </div>
        {totalMonths.length
          ? <MonthBars points={totalMonths} currency={currency} rate={rate} />
          : <div className="empty compact">No dated entries yet, so there is nothing to plot.</div>}
      </section>

      <section className="panel">
        <div className="section-head">
          <div><span className="eyebrow">By region</span><h3>Iraq and USA side by side</h3></div>
        </div>
        <div className="table-wrap">
          <table className="data-table fin-table">
            <thead>
              <tr>
                <th>Region</th><th>Projects</th>
                <th>Client funding</th><th>Net funds</th>
                <th>Approved cost</th><th>Working cost</th><th>Client balance</th>
                <th>Larsa revenue</th><th>Company net</th><th>Margin</th>
              </tr>
            </thead>
            <tbody>
              {regionRows.map((row) => (
                <tr key={row.name}>
                  <td><b>{row.name}</b></td>
                  <td>{row.count}</td>
                  <td>{show(row.figures.funding)}</td>
                  <td>{show(row.figures.netFunding)}</td>
                  <td>{show(row.figures.cost)}</td>
                  <td>{show(row.figures.workingCost)}</td>
                  <td>{show(row.figures.balance)}</td>
                  <td>{show(row.figures.larsaRevenue)}</td>
                  <td className={row.figures.companyNet < 0 ? "fin-neg" : "fin-pos"}>{show(row.figures.companyNet)}</td>
                  <td>{row.figures.margin.toFixed(1)}%</td>
                </tr>
              ))}
              <tr className="fin-total-row">
                <td><b>Total</b></td>
                <td>{regionRows.reduce((sum, row) => sum + row.count, 0)}</td>
                <td>{show(totals.funding)}</td>
                <td>{show(totals.netFunding)}</td>
                <td>{show(totals.cost)}</td>
                <td>{show(totals.workingCost)}</td>
                <td>{show(totals.balance)}</td>
                <td>{show(totals.larsaRevenue)}</td>
                <td className={totals.companyNet < 0 ? "fin-neg" : "fin-pos"}>{show(totals.companyNet)}</td>
                <td>{totals.margin.toFixed(1)}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="section-head">
          <div>
            <span className="eyebrow">Project by project</span>
            <h3>{rows.length} construction project{rows.length === 1 ? "" : "s"}</h3>
          </div>
        </div>
        {!rows.length && (
          <div className="empty compact">
            No construction projects to report yet. Add them in the accounting engine, or tick
            Worked example above to see how this reads with figures in place.
          </div>
        )}
        {rows.map(({ project, figures, months }) => {
          const open = openProject === project.id;
          return (
            <article className="project-financial" key={project.id}>
              <button
                type="button"
                className="project-financial-head"
                onClick={() => setOpenProject(open ? "" : project.id)}
                aria-expanded={open}
              >
                <span className="pf-name">
                  <b>{project.code ? `${project.code} · ` : ""}{project.name}</b>
                  <small>{[project.clientName, project.region, project.status].filter(Boolean).join(" · ")}</small>
                </span>
                <span className="pf-figure"><small>Client funds</small><b>{brief(figures.netFunding)}</b></span>
                <span className="pf-figure"><small>Spent</small><b>{brief(figures.workingCost)}</b></span>
                <span className="pf-figure">
                  <small>Larsa net</small>
                  <b className={figures.companyNet < 0 ? "fin-neg" : undefined}>{brief(figures.companyNet)}</b>
                </span>
                {figures.unapproved > 0 && (
                  <span className="pf-figure" title={`Contains ${figures.unapproved} unapproved entries`}>
                    <small>Review</small><b style={{ color: "#b58900" }}>⏳ {figures.unapproved}</b>
                  </span>
                )}
                <ChevronRight size={16} className={open ? "pf-caret open" : "pf-caret"} />
              </button>
              {/* Net construction funds against what has been spent, on one
                  scale across the list, so a project close to exhausting the
                  client's funds stands out. */}
              <div className="pf-bars">
                <span className="pf-bar income" style={{ width: `${(figures.netFunding / scale) * 100}%` }} />
                <span className="pf-bar cost" style={{ width: `${(figures.workingCost / scale) * 100}%` }} />
              </div>
              {open && (
                <div className="pf-open">
                  <div className="pf-detail">
                    {([
                      ["A · Gross client funding", figures.funding],
                      ["Consultancy fee taken", figures.fees],
                      ["Net construction funds", figures.netFunding],
                      ["Materials", figures.materials],
                      ["Labour", figures.labor],
                      ["Other construction costs", figures.expenses],
                      ["Approved cost", figures.cost],
                      ["Pending / unapproved cost", figures.pendingCost],
                      ["Working cost", figures.workingCost],
                      ["Approved client balance", figures.balance],
                      ["Working client balance", figures.workingBalance],
                      ["B · Consultancy fee earned", figures.fees],
                      ["Engineering revenue", figures.revenue],
                      ["Larsa revenue", figures.larsaRevenue],
                      ["Larsa expenses", figures.companyExpenses],
                      ["Company net profit", figures.companyNet],
                    ] as [string, number][]).map(([label, value]) => (
                      <div className="pf-row" key={label}>
                        <span>{label}</span>
                        <b className={label === "Company net profit" && value < 0 ? "fin-neg" : undefined}>{show(value)}</b>
                      </div>
                    ))}
                    <div className="pf-row total">
                      <span>Margin on Larsa revenue</span><b>{figures.margin.toFixed(1)}%</b>
                    </div>
                  </div>
                  {months.length > 0 && <MonthBars points={months} currency={currency} rate={rate} />}
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

function visibleProjectIds(user: StaffUser | null, projects: AccountingProject[]) {
  if (!user) return new Set<string>();
  const mode = isAdmin(user)
    ? "all"
    : user.projectAccessMode || projectAccessForPreset(user.access || "Engineer");
  if (mode === "all") return new Set(projects.map((project) => project.id));
  if (mode === "none") return new Set<string>();
  const explicit = new Set(user.projectIds || []);
  if (explicit.size) return explicit;
  return new Set(projects.filter((project) => {
    const assigned = [
      project.responsibleEngineer,
      project.projectManager,
      project.teamLeader,
      project.clientName,
      project.clientEmail,
    ].filter(Boolean);
    return assigned.some((value) =>
      identityMatches(value, user.id, true)
      || identityMatches(value, user.email || "", true)
      || identityMatches(value, user.name));
  }).map((project) => project.id));
}

export default function Home() {
  const [active, setActive] = useState<Item>(DEFAULT_ITEM);
  const activeRef = useRef(active);
  const [sessionUser, setSessionUser] = useState<StaffUser | null>(null);
  const sessionUserRef = useRef<StaffUser | null>(null);
  const [sessionMethod, setSessionMethod] = useState<SignInMethod | null>(null);
  const sessionMethodRef = useRef<SignInMethod | null>(null);
  const [previewOwner, setPreviewOwner] = useState<StaffUser | null>(null);
  const [navChannel, setNavChannel] = useState<NavChannel>("home");
  const [loginMode, setLoginMode] = useState<SignInMethod>("email");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginPin, setLoginPin] = useState(""); const [accessMode, setAccessMode] = useState<"signup" | "forgot" | "forgotPin" | null>(null); const [accountingGate, setAccountingGate] = useState<Item | null>(null); useEffect(() => { const u = sessionUser; if (!u || !u.email || u.platformAdmin !== undefined) return; (async () => { const client = getSupabaseClient(); if (!client) return; try { const { data } = await client.functions.invoke("auth-policy", { body: { op: "amPlatformAdmin", email: u.email } }); const admin = Boolean(data && (data as { admin?: boolean }).admin); setSessionUser((prev) => { const next = prev && prev.id === u.id ? { ...prev, platformAdmin: admin } : prev; if (next) sessionUserRef.current = next; return next; }); } catch { /* the entry just stays hidden */ } })(); }, [sessionUser]);
  const [showPassword, setShowPassword] = useState(false);
  // Email verification gate: only engaged when Supabase is configured (it's
  // what actually sends the code) and the account hasn't verified its email
  // yet. Without Supabase this stays entirely out of the way, same as sync.
  const [verifyStage, setVerifyStage] = useState<{ user: StaffUser; email: string; method?: SignInMethod } | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyError, setVerifyError] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyInfo, setVerifyInfo] = useState("");
  // "Keep me signed in" survives a browser restart; without it the session ends
  // with the tab, which is what made sign-in feel like it "stopped working".
  const [rememberMe, setRememberMe] = useState(false);
  const rememberRef = useRef(false);
  useEffect(() => { rememberRef.current = rememberMe; }, [rememberMe]);
  // Restore the remembered address and preference on first paint.
  useEffect(() => {
    try {
      const savedEmail = localStorage.getItem(REMEMBER_EMAIL_KEY);
      if (savedEmail) { setLoginEmail(savedEmail); setRememberMe(true); rememberRef.current = true; }
      else if (localStorage.getItem(KEEP_SESSION_KEY)) { setRememberMe(true); rememberRef.current = true; }
    } catch {
      // Storage can be unavailable; the form simply starts empty.
    }
  }, []);
  const [loginError, setLoginError] = useState(""); const [signupOpen, setSignupOpen] = useState(true); useEffect(() => { let alive = true; loadPolicy().then((next) => { if (alive) setSignupOpen(next.self_signup_enabled !== false); }).catch(() => {}); return () => { alive = false; }; }, []);
  const [hydrated, setHydrated] = useState(false);
  /* Read only after hydration: the server has no such global, and reading it
     during the first render would make the markup disagree with the client. */
  const inlineEngines = useMemo<Partial<Record<Engine, string>>>(() => {
    if (!hydrated || typeof window === "undefined") return {};
    return (window as Window & { __LARSA_ENGINE_HTML?: Partial<Record<Engine, string>> })
      .__LARSA_ENGINE_HTML || {};
  }, [hydrated]);
  const [menuOpen, setMenuOpen] = useState(false);
  /* On a wide screen the sidebar is a permanent column. It can now be folded
     away for the screens that want the width — schedules, ledgers, wide
     tables — and the choice is remembered per device. On a phone this state is
     not used at all: there the sidebar is already a drawer driven by menuOpen. */
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [navHistory, setNavHistory] = useState<Item[]>([]);
  const [openAccountingGroup, setOpenAccountingGroup] = useState("");
  const [dark, setDark] = useState(false);
  const [message, setMessage] = useState("");
  const dialog = useDialog();
  const [installPrompt, setInstallPrompt] = useState<InstallEvent | null>(null);
  const [installHelp, setInstallHelp] = useState(false);
  /* True only while waiting for the browser to offer its install dialog, so
     the button can say it is working instead of looking like a dead click. */
  const [installBusy, setInstallBusy] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [clock, setClock] = useState({ baghdad: "", texas: "" });
  const [storageTick, setStorageTick] = useState(0);
  const [recentId, setRecentId] = useState("");
  /* A short trail of recently opened areas, so Continue Working can offer the
     last few places as well as the very last one. Ids only — no record data
     leaves the device, and the list is capped. */
  const [recentTrail, setRecentTrail] = useState<string[]>([]);
  const [accessUsers, setAccessUsers] = useState<StaffUser[]>([]);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  /* The authoritative counts, read from Supabase. The local `notifications`
     array above is now only a fallback for a deployment with no backend — when
     one is configured, these are what the bell and the badge believe. */
  const [notifyCounts, setNotifyCounts] = useState<NotifyCounts>(EMPTY_COUNTS);
  const [bellOpen, setBellOpen] = useState(false);
  const [notifyTick, setNotifyTick] = useState(0);
  /* A notification id arriving from outside the running app — a tapped push
     banner, or a cold start on /?n=<id>. Held until the session is restored,
     because arriving signed-out must open the sign-in screen, not the record. */
  const [pendingNotification, setPendingNotification] = useState<string | null>(null);
  const [growthStore, setGrowthStore] = useState<GrowthStore>({
    version: 1,
    pointTargets: {},
    development: [],
  });
  const uploadRef = useRef<HTMLInputElement>(null);
  // Guards saveMyPoints against a double-click producing two performance rows —
  // the same 1.2s window punchClock uses for the same reason.
  const lastPointsSaveRef = useRef(0);
  const staffRef = useRef<HTMLIFrameElement>(null);
  const hrRef = useRef<HTMLIFrameElement>(null);
  const accountingRef = useRef<HTMLIFrameElement>(null);
  const refs = useMemo(
    () => ({ staff: staffRef, hr: hrRef, accounting: accountingRef }),
    [],
  );

  // If NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are set, this makes the three
  // localStorage stores shared across everyone's browser instead of one
  // machine at a time. If they aren't set, initLarsaSync is a no-op and the
  // app behaves exactly as it always has. See lib/supabase/sync.ts.
  /* The three engines run in same-origin iframes and write straight to
     localStorage. A write in another document of the same origin fires a
     `storage` event here, but nothing was listening, so the native pages kept
     showing whatever they read at mount: change the USD/IQD rate in the
     accounting engine and Construction Financials went on reporting the old
     one until a full reload. Re-reading on that event is what every native
     view already does when the parent app itself writes. */
  useEffect(() => {
    if (!hydrated) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key && !event.key.toLowerCase().startsWith("larsa")) return;
      setStorageTick((value) => value + 1);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [hydrated]);

  /* The sync effect above-any-toast problem: it runs before `notify` is
     declared, so the ledger-restore toast goes through a ref that the
     declaration below fills in. */
  const notifyRef = useRef<(message: string) => void>(() => {});
  /* One pending in-place engine refresh per synced store (see
     onRemoteChange below), so bursts of remote saves repaint once. */
  const remoteRefreshTimers = useRef<Partial<Record<string, number>>>({});
  useEffect(() => {
    if (!hydrated) return;
    console.log("[larsa-sync] effect fired, hydrated =", hydrated);
    /* Hand the accounting engine (same-origin iframe) the Supabase
       coordinates so its v4.0 cloud layer can reach the authoritative
       relational accounting store (acct_* tables + RPCs). NEXT_PUBLIC_*
       values are baked at build time and already public; the engine reuses
       the session this page's supabase-js client established. Without them
       the engine's accounting layer stays local-only, unchanged. */
    try {
      const bridgeUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const bridgeKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      if (bridgeUrl && bridgeKey) {
        localStorage.setItem("larsaSupabaseBridgeV1", JSON.stringify({ url: bridgeUrl, anonKey: bridgeKey }));
      } else {
        localStorage.removeItem("larsaSupabaseBridgeV1");
      }
    } catch { /* engine stays local-only */ }
    /* The rebase the engine-iframe wrapper (ENGINE_REBASE_SRC) calls on
       every engine save: three-way merge of the engine's copy onto whatever
       is stored NOW, so a stale wholesale write-back can no longer erase
       what others wrote in the meantime. Exposed whether or not Supabase is
       configured — the same hazard exists between the engines and the
       native pages on a single machine. */
    (window as Window & {
      __larsaEngineRebase?: (baseText: string | null, nextText: string, currentText: string) => string;
    }).__larsaEngineRebase = (baseText, nextText, currentText) => {
      try {
        return JSON.stringify(mergeStoreText(baseText, nextText, JSON.parse(currentText)));
      } catch {
        return nextText;
      }
    };
    const cleanup = initLarsaSync({
      onRemoteChange: (key) => {
        setStorageTick((value) => value + 1);
        /* Refresh the affected engine IN PLACE instead of reloading its
           iframe. The old blanket iframe reload blanked all three
           engines every time any other device saved anything — including
           the per-key catch-up that runs each time the app regains focus —
           which is the "pages keep blinking" report. Every engine exposes
           render() over an in-memory copy of exactly one synced store, so
           only the store that actually changed is re-read and re-rendered:
           no navigation, no white flash, no lost scroll or half-typed form.
           Coalesced per store so a burst of remote saves repaints once. */
        const timers = remoteRefreshTimers.current;
        const pending = timers[key];
        if (pending !== undefined) window.clearTimeout(pending);
        timers[key] = window.setTimeout(() => {
          delete timers[key];
          try {
            if (key === "larsaStaffV8") {
              staffRef.current?.contentWindow?.eval(`
                state=JSON.parse(localStorage.getItem("larsaStaffV8"))||state;
                if(currentUser)currentUser=state.users.find(function(user){return user.id===currentUser.id})||currentUser;
                if(typeof render==="function"&&currentUser)render();
              `);
            } else if (key === "larsa_hr_visual_counts_v5") {
              hrRef.current?.contentWindow?.eval(`
                if(typeof loadState==="function"){state=loadState();if(typeof render==="function")render();}
              `);
            } else {
              accountingRef.current?.contentWindow?.eval(`
                (function(){
                  var storeKey="";
                  for(var i=0;i<localStorage.length;i+=1){var k=localStorage.key(i);if(k&&k.lastIndexOf("_v34_clean")===k.length-10){storeKey=k;break}}
                  if(!storeKey)return;
                  try{ state=JSON.parse(localStorage.getItem(storeKey))||state; }catch(e){ return; }
                  if(typeof render==="function")render();
                })();
              `);
            }
          } catch { /* engine still booting; it reads the fresh store on its own first render */ }
        }, 350);
      },
      onStatusChange: (status) => {
        /* Once the shared blob has been pulled, restore anything the durable
           ledger holds that the blob lost — the standing repair for the
           class of incident where a stale device replaced the shared state.
           Restored punches re-enter the blob, re-render, and sync back up
           for every other device. */
        if (status !== "synced") return;
        reconcileStoreFromLedger().then(({ restored }) => {
          if (restored > 0) {
            setStorageTick((value) => value + 1);
            notifyRef.current(`${restored} attendance record${restored === 1 ? "" : "s"} restored from the durable ledger.`);
          }
        }).catch(() => { /* runs again on next open */ });
        /* And the same for accounts. An account missing from the blob is
           never read as a deletion — that is the failure this undoes — so
           anything the account ledger holds and the blob has lost comes
           back, unless it was deliberately tombstoned. */
        reconcileAccountsFromLedger().then(({ restored, names }) => {
          if (restored > 0) {
            setStorageTick((value) => value + 1);
            notifyRef.current(
              restored === 1
                ? `${names[0]}'s account was restored from the durable ledger.`
                : `${restored} accounts were restored from the durable ledger: ${names.slice(0, 3).join(", ")}${restored > 3 ? `, and ${restored - 3} more` : ""}.`,
            );
          }
        }).catch(() => { /* runs again on next open */ });
      },
    });
    /* Every staff-blob write also appends new clock events to the durable
       attendance ledger, and every account in it to the durable account
       ledger — both append-only and database-enforced. Installed AFTER
       initLarsaSync so all three wrappers of localStorage.setItem compose. */
    const cleanupLedger = initAttendanceLedger();
    const cleanupAccounts = initAccountLedger();
    return () => {
      cleanupAccounts();
      cleanupLedger();
      cleanup();
      const timers = remoteRefreshTimers.current;
      Object.keys(timers).forEach((key) => {
        const pending = timers[key];
        if (pending !== undefined) window.clearTimeout(pending);
        delete timers[key];
      });
      delete (window as Window & { __larsaEngineRebase?: unknown }).__larsaEngineRebase;
    };
  }, [hydrated, refs]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setRecentId(localStorage.getItem("larsa-control-recent") || "");
      try {
        const trail = JSON.parse(localStorage.getItem("larsa-control-recent-trail") || "[]");
        if (Array.isArray(trail)) setRecentTrail(trail.filter((id) => typeof id === "string").slice(0, 6));
      } catch { /* a corrupt trail is simply ignored */ }
      try {
        setNavCollapsed(localStorage.getItem("larsa-control-nav-collapsed") === "1");
      } catch { /* private mode: the sidebar simply starts open */ }
      setHydrated(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    sessionUserRef.current = sessionUser;
  }, [sessionUser]);

  useEffect(() => {
    sessionMethodRef.current = sessionMethod;
  }, [sessionMethod]);

  const notify = useCallback((text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(""), 3400);
  }, []);
  useEffect(() => { notifyRef.current = notify; }, [notify]);

  const readStaffUsers = useCallback((): StaffUser[] => {
    const stored = parseStore("larsaStaffV8");
    if (Array.isArray(stored?.users)) return stored.users;
    try {
      const raw = staffRef.current?.contentWindow?.eval("JSON.stringify(state.users||[])");
      return typeof raw === "string" ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => setAccessUsers(readStaffUsers()), 0);
    return () => clearTimeout(timer);
  }, [hydrated, readStaffUsers, storageTick]);

  useEffect(() => {
    if (!hydrated || !accessUsers.length) return;
    const timer = window.setTimeout(() => {
      const normalized = normalizeGrowthStore(parseStore(GROWTH_STORE_KEY), accessUsers);
      localStorage.setItem(GROWTH_STORE_KEY, JSON.stringify(normalized));
      setGrowthStore(normalized);
    }, 0);
    return () => clearTimeout(timer);
  }, [accessUsers, hydrated, storageTick]);

  // Each engine carries its own theme class. Push the shell's choice into all
  // three so one switch changes the whole application, not just this page.
  const applyThemeToFrames = useCallback((isDark: boolean) => {
    (Object.keys(refs) as Engine[]).forEach((engine) => {
      const win = refs[engine].current?.contentWindow;
      const doc = refs[engine].current?.contentDocument;
      if (!win || !doc?.body) return;
      try {
        if (engine === "staff") {
          win.eval(`
            document.body.classList.${isDark ? "add" : "remove"}("dark");
            if(typeof state==="object"&&state){state.theme=${isDark ? '"dark"' : '"light"'};if(typeof save==="function")save()}
          `);
        } else if (engine === "hr") {
          win.eval(`
            document.body.classList.${isDark ? "add" : "remove"}("dark");
            if(typeof state==="object"&&state){state.theme=${isDark ? '"dark"' : '"light"'};if(typeof save==="function")save()}
          `);
        } else {
          // The accounting engine is dark by default and opts into a light class.
          win.eval(`
            document.body.classList.${isDark ? "remove" : "add"}("light");
            if(typeof state==="object"&&state){state.settings=state.settings||{};state.settings.theme=${isDark ? '"dark"' : '"light"'};if(typeof save==="function")save()}
          `);
        }
      } catch {
        // The frame applies the saved theme when it finishes loading.
      }
    });
  }, [refs]);

  /* The saved choice has to be read before anything is written back, or the
     first render's default overwrites it and dark mode is lost on every
     reload. themeRead flips once the stored value has been applied; only
     after that does a change get persisted. */
  const [themeRead, setThemeRead] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem("larsa-control-theme");
        if (saved === "dark" || saved === "light") setDark(saved === "dark");
        else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) setDark(true);
      } catch { /* private mode */ }
      setThemeRead(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    applyThemeToFrames(dark);
    /* Installed on a desktop, the browser paints the window's title bar in the
       app's theme colour. That colour was a flat black while the app's own top
       bar is near-white, so the strip carrying the minimise / maximise / close
       buttons read as a black band bolted above the app instead of part of it.
       Kept in step with the theme here, the two surfaces meet as one. */
    try {
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", dark ? "#0d0f14" : "#f7f7f5");
    } catch { /* no document in a non-browser environment */ }
    if (!themeRead) return;
    try { localStorage.setItem("larsa-control-theme", dark ? "dark" : "light"); } catch { /* private mode */ }
  }, [applyThemeToFrames, dark, themeRead]);

  const applySessionToFrame = useCallback((engine: Engine, user: StaffUser, method: SignInMethod = "email") => {
    const frame = refs[engine].current;
    const win = frame?.contentWindow;
    const doc = frame?.contentDocument;
    if (!win || !doc) return;
    try {
      ensureEmbeddedStyle(doc, engine);
      if (engine === "staff") {
        const staffPermissions = staffPermissionsForUser(user);
        const staffAccess = enginePermissionSnapshot(user, "staff");
        const addDetailedAccess = (key: string, item: Item) => {
          staffAccess[key] = {};
          permissionActionsFor(item).forEach((action) => {
            staffAccess[key][action] = hasItemPermission(user, item, action);
          });
        };
        addDetailedAccess("performanceReview", PERFORMANCE_REVIEW_ITEM);
        addDetailedAccess("performanceTargets", PERFORMANCE_TARGETS_ITEM);
        addDetailedAccess("notifications", NOTIFICATIONS_ITEM);
        win.eval(`
          currentUser=state.users.find(function(user){return user.id===${JSON.stringify(user.id)}})||null;
          if(currentUser)currentUser.permissions=${JSON.stringify(staffPermissions)};
          window.__larsaPinQuick=${method === "pin" ? "true" : "false"};
          window.__larsaStaffAccess=${JSON.stringify(staffAccess)};
          window.__larsaStaffCan=function(section,action){
            var row=window.__larsaStaffAccess&&window.__larsaStaffAccess[section];
            return !!(row&&row[action||"view"]);
          };
          if(!window.__larsaActionGuardInstalled){
            window.__larsaActionGuardInstalled=true;
            var __larsaActionGuard=function(name,sectionForArguments,actionForArguments){
              var original=window[name];
              if(typeof original!=="function"||original.__larsaPermissionWrapped)return;
              var wrapped=function(){
                var args=arguments;
                var section=typeof sectionForArguments==="function"?sectionForArguments(args):sectionForArguments;
                var action=typeof actionForArguments==="function"?actionForArguments(args):actionForArguments;
                if(!window.__larsaStaffCan(section,action)){
                  if(typeof toast==="function")toast("You do not have permission for this action.");
                  return;
                }
                var result=original.apply(this,args);
                if(typeof window.__larsaApplyStaffControls==="function")setTimeout(window.__larsaApplyStaffControls,0);
                return result;
              };
              wrapped.__larsaPermissionWrapped=true;
              window[name]=wrapped;
              try{eval(name+"=window[name]")}catch(e){}
            };
            __larsaActionGuard("clockToggle","clock","add");
            __larsaActionGuard("openSession","clock","edit");
            __larsaActionGuard("openLeaveModal","approvals","add");
            __larsaActionGuard("submitLeave","approvals","add");
            __larsaActionGuard("openScheduleRequestModal","approvals","add");
            __larsaActionGuard("submitScheduleRequest","approvals","add");
            __larsaActionGuard("approveReq","approvals","approve");
            __larsaActionGuard("rejectReq","approvals","approve");
            __larsaActionGuard("flowEditor","approvals","manage");
            __larsaActionGuard("saveFlowFromForm","approvals","manage");
            __larsaActionGuard("openShiftModal","schedule",function(args){return args[0]?"edit":"add"});
            __larsaActionGuard("saveShift","schedule",function(args){return args[0]?"edit":"add"});
            __larsaActionGuard("addShift","schedule","add");
            __larsaActionGuard("dropShift","schedule","edit");
            __larsaActionGuard("removeShift","schedule","delete");
            __larsaActionGuard("removeScheduled","schedule","delete");
            __larsaActionGuard("deleteShift","schedule","delete");
            __larsaActionGuard("autoSchedule","schedule","manage");
            __larsaActionGuard("autoScheduleV22","schedule","manage");
            __larsaActionGuard("autoScheduleV24","schedule","manage");
            __larsaActionGuard("approveWeek","schedule","approve");
            __larsaActionGuard("openPerfRowModal","performance",function(args){return args[0]?"edit":"add"});
            __larsaActionGuard("savePerfRow","performance",function(args){return args[0]?"edit":"add"});
            __larsaActionGuard("deletePerf","performance","delete");
            __larsaActionGuard("submitPerformance","performance","add");
            __larsaActionGuard("approvePerf","performanceReview","approve");
            __larsaActionGuard("openColumnModal","performanceTargets","manage");
            __larsaActionGuard("saveColumn","performanceTargets","manage");
            __larsaActionGuard("targetManager","performanceTargets","manage");
            __larsaActionGuard("sendNotifications","notifications","manage");
            __larsaActionGuard("openUserModal","people",function(args){return args[0]?"edit":"add"});
            __larsaActionGuard("saveUser","people",function(args){return args[0]?"edit":"add"});
            __larsaActionGuard("toggleUser","people","edit");
            __larsaActionGuard("deleteUser","people","delete");
            __larsaActionGuard("openConstraintModal","people","edit");
            __larsaActionGuard("saveConstraint","people","edit");
            __larsaActionGuard("removeConstraint","people","delete");
            __larsaActionGuard("openRuleModal","rules",function(args){return args[0]?"edit":"add"});
            __larsaActionGuard("saveRule","rules",function(args){return args[0]?"edit":"add"});
            __larsaActionGuard("toggleRule","rules","edit");
            __larsaActionGuard("setRuleCheck","rules","edit");
            __larsaActionGuard("deleteRule","rules","delete");
            __larsaActionGuard("downloadBackup","backup","export");
            __larsaActionGuard("restoreBackup","backup","manage");
            __larsaActionGuard("importCSVText","backup","add");
            __larsaActionGuard("exportTimesheetCSV23","timesheet","export");
            __larsaActionGuard("exportCurrentReportCSV","reports","export");
            __larsaActionGuard("downloadCSV",function(){return activePage==="backup"?"backup":"reports"},"export");
            var __larsaObjectGuard=function(object,name,section,action){
              if(!object||typeof object[name]!=="function"||object[name].__larsaPermissionWrapped)return;
              var original=object[name];
              var wrapped=function(){
                if(!window.__larsaStaffCan(section,action)){
                  if(typeof toast==="function")toast("You do not have permission for this action.");
                  return;
                }
                var result=original.apply(this,arguments);
                if(typeof window.__larsaApplyStaffControls==="function")setTimeout(window.__larsaApplyStaffControls,0);
                return result;
              };
              wrapped.__larsaPermissionWrapped=true;
              object[name]=wrapped;
            };
            __larsaObjectGuard(window.V11,"addConstraint","rules","add");
            __larsaObjectGuard(window.V11,"removeConstraint","rules","delete");
            window.__larsaApplyStaffControls=function(){
              document.querySelectorAll("button").forEach(function(button){
                var code=button.getAttribute("onclick")||"";
                var required=null;
                if(/clockToggle/.test(code))required=["clock","add"];
                else if(/openLeaveModal|submitLeave|openScheduleRequestModal|submitScheduleRequest/.test(code))required=["approvals","add"];
                else if(/approveReq|rejectReq/.test(code))required=["approvals","approve"];
                else if(/flowEditor|saveFlowFromForm/.test(code))required=["approvals","manage"];
                else if(/autoSchedule/.test(code))required=["schedule","manage"];
                else if(/approveWeek/.test(code))required=["schedule","approve"];
                else if(/deleteShift|removeShift|removeScheduled/.test(code))required=["schedule","delete"];
                else if(/openShiftModal\\(\\)|addShift/.test(code))required=["schedule","add"];
                else if(/openShiftModal|saveShift|dropShift/.test(code))required=["schedule","edit"];
                else if(/approvePerf/.test(code))required=["performanceReview","approve"];
                else if(/deletePerf/.test(code))required=["performance","delete"];
                else if(/openPerfRowModal\\(\\)/.test(code))required=["performance","add"];
                else if(/openPerfRowModal|savePerfRow/.test(code))required=["performance","edit"];
                else if(/openColumnModal|saveColumn|targetManager/.test(code))required=["performanceTargets","manage"];
                else if(/sendNotifications/.test(code))required=["notifications","manage"];
                else if(/deleteUser/.test(code))required=["people","delete"];
                else if(/openUserModal\\(\\)/.test(code))required=["people","add"];
                else if(/openUserModal|saveUser|openConstraintModal|saveConstraint|toggleUser/.test(code))required=["people","edit"];
                else if(/deleteRule/.test(code))required=["rules","delete"];
                else if(/openRuleModal\\(\\)/.test(code))required=["rules","add"];
                else if(/openRuleModal|saveRule|toggleRule|setRuleCheck/.test(code))required=["rules","edit"];
                else if(/restoreBackup/.test(code))required=["backup","manage"];
                else if(/importCSVText/.test(code))required=["backup","add"];
                else if(/downloadBackup/.test(code))required=["backup","export"];
                else if(/exportTimesheetCSV/.test(code))required=["timesheet","export"];
                else if(/exportCurrentReportCSV|downloadCSV/.test(code))required=[activePage==="backup"?"backup":"reports","export"];
                if(required){
                  if(window.__larsaStaffCan(required[0],required[1]))button.style.removeProperty("display");
                  else button.style.setProperty("display","none","important");
                }
              });
              if(typeof activePage!=="undefined"&&activePage==="people"){
                var pageTitle=document.getElementById("pageH");
                var pageCopy=document.getElementById("pageP");
                if(pageTitle&&pageTitle.textContent!=="Employee Details")pageTitle.textContent="Employee Details";
                if(pageCopy&&pageCopy.textContent!=="Profiles, roles, departments, and employee notes"){
                  pageCopy.textContent="Profiles, roles, departments, and employee notes";
                }
                document.querySelectorAll(".cardTitle").forEach(function(title){
                  var text=title.textContent.trim();
                  if(text==="Engineers, Roles, Permissions, Notes, and Constraints"){
                    title.textContent="Employee records, roles, and notes";
                  }
                  if(text==="Team by Access Role"){
                    var roleCard=title.closest(".card");
                    if(roleCard){
                      var roleGrid=roleCard.parentElement;
                      roleCard.style.display="none";
                      if(roleGrid)roleGrid.style.gridTemplateColumns="1fr";
                    }
                  }
                });
                var accessSort=document.querySelector('#lxPplSort option[value="access"]');
                if(accessSort)accessSort.remove();
                document.querySelectorAll('button[onclick*="openUserModal()"],button[onclick*="toggleUser"],button[onclick*="deleteUser"]').forEach(function(button){
                  button.style.setProperty("display","none","important");
                });
                document.querySelectorAll('button[onclick*="openConstraintModal"]').forEach(function(button){
                  button.style.setProperty("display","none","important");
                });
                document.querySelectorAll('button[onclick*="openUserModal"]').forEach(function(button){
                  if(!/openUserModal\\(\\)/.test(button.getAttribute("onclick")||"")&&button.textContent!=="Details"){
                    button.textContent="Details";
                  }
                });
                var peopleTable=document.querySelector("#content table.table");
                if(peopleTable){
                  peopleTable.classList.add("larsa-employee-table");
                  peopleTable.querySelectorAll("tr").forEach(function(row){
                    [4,5,7].forEach(function(index){
                      if(row.children[index])row.children[index].style.display="none";
                    });
                  });
                }
                ["uPin","uUser","uPass","uAccess","uEnabled"].forEach(function(id){
                  var field=document.getElementById(id);
                  if(field&&field.closest(".field"))field.closest(".field").style.display="none";
                });
                ["uName","uDept","uRole"].forEach(function(id){
                  var field=document.getElementById(id);
                  if(field)field.disabled=true;
                });
                var permissionBox=document.getElementById("permBox");
                if(permissionBox&&permissionBox.closest(".card"))permissionBox.closest(".card").style.display="none";
                document.querySelectorAll(".modalHeader h2").forEach(function(title){
                  if(/User/.test(title.textContent))title.textContent="Edit Employee Details";
                });
                document.querySelectorAll('button[onclick*="saveUser"]').forEach(function(button){
                  if(button.textContent!=="Save Details")button.textContent="Save Details";
                });
              }
              if(typeof activePage!=="undefined"&&activePage==="backup"){
                var backupTitle=document.getElementById("pageH");
                var backupCopy=document.getElementById("pageP");
                if(backupTitle&&backupTitle.textContent!=="Staff CSV & Import Tools"){
                  backupTitle.textContent="Staff CSV & Import Tools";
                }
                if(backupCopy&&backupCopy.textContent!=="CSV import, table exports, print tools, and time references"){
                  backupCopy.textContent="CSV import, table exports, print tools, and time references";
                }
                document.querySelectorAll('button[onclick*="downloadBackup"],label').forEach(function(control){
                  var code=control.getAttribute("onclick")||control.innerHTML||"";
                  if(/downloadBackup|restoreBackup/.test(code))control.style.setProperty("display","none","important");
                });
                document.querySelectorAll(".v25-backup-title h3").forEach(function(title){
                  if(title.textContent.trim()==="Full System Backup"){
                    var backupCard=title.closest(".v25-backup-card");
                    if(backupCard)backupCard.style.setProperty("display","none","important");
                  }
                });
              }
              if(typeof activePage!=="undefined"&&activePage==="approvals"){
                var approvalTitle=document.getElementById("pageH");
                var approvalCopy=document.getElementById("pageP");
                if(approvalTitle&&approvalTitle.textContent!=="Leave & Requests")approvalTitle.textContent="Leave & Requests";
                if(approvalCopy&&approvalCopy.textContent!=="Leave and schedule requests, approvals, and configurable workflows"){
                  approvalCopy.textContent="Leave and schedule requests, approvals, and configurable workflows";
                }
                document.querySelectorAll("#content .requestCard").forEach(function(card){
                  var title=card.querySelector(".cardTitle");
                  if(title&&/^Performance\\s*·/.test(title.textContent.trim())){
                    card.style.setProperty("display","none","important");
                  }
                });
                var requests=(state.approvals||[]).filter(function(request){return request.type!=="Performance"});
                document.querySelectorAll("#content .cardTitle").forEach(function(title){
                  if(title.textContent.trim()==="Approval Queue"){
                    var queue=title.closest(".card");
                    var badge=queue&&queue.querySelector(".cardHeader .badge");
                    if(badge)badge.textContent=requests.filter(function(request){return request.status==="Pending"}).length+" pending";
                  }
                });
                document.querySelectorAll("#content .lx-sectionTitle").forEach(function(title){
                  if(title.textContent.trim()!=="Approval Summary")return;
                  var grid=title.nextElementSibling;
                  if(!grid)return;
                  var values=grid.querySelectorAll(".lx-stat .n");
                  var counts={
                    Pending:requests.filter(function(request){return request.status==="Pending"}).length,
                    Approved:requests.filter(function(request){return request.status==="Approved"}).length,
                    Rejected:requests.filter(function(request){return request.status==="Rejected"}).length
                  };
                  [requests.length,counts.Pending,counts.Approved,counts.Rejected].forEach(function(value,index){
                    if(values[index])values[index].textContent=String(value);
                  });
                });
              }
            };
            if(!window.__larsaStaffControlsObserver){
              window.__larsaStaffControlsObserver=new MutationObserver(function(){
                setTimeout(window.__larsaApplyStaffControls,0);
              });
              ["content","actions"].forEach(function(id){
                var target=document.getElementById(id);
                if(target)window.__larsaStaffControlsObserver.observe(target,{childList:true,subtree:true});
              });
            }
            var __larsaOriginalRender=window.render;
            window.render=function(){
              var result=__larsaOriginalRender.apply(this,arguments);
              setTimeout(window.__larsaApplyStaffControls,0);
              return result;
            };
            try{render=window.render}catch(e){}
          }
          if(!window.__larsaPinGuardInstalled){
            window.__larsaPinGuardInstalled=true;
            var __larsaRenderPerformance=renderPerformance;
            var __larsaOpenPerfRowModal=openPerfRowModal;
            var __larsaSavePerfRow=savePerfRow;
            var __larsaApprovePerf=approvePerf;
            var __larsaDeletePerf=deletePerf;
            var __larsaOpenColumnModal=openColumnModal;
            renderPerformance=function(){
              if(window.__larsaPinQuick&&currentUser)sessionStorage.pfEmp=currentUser.name;
              __larsaRenderPerformance();
              if(!window.__larsaPinQuick)return;
              var employeeFilter=document.getElementById("pfEmp");
              if(employeeFilter){employeeFilter.value=currentUser.name;employeeFilter.disabled=true}
              document.querySelectorAll("button").forEach(function(button){
                var action=button.getAttribute("onclick")||"";
                if(/openColumnModal|approvePerf|deletePerf/.test(action))button.remove();
              });
            };
            openPerfRowModal=function(id){
              if(!window.__larsaPinQuick)return __larsaOpenPerfRowModal(id);
              var row=id&&state.performance.find(function(item){return item.id===id});
              if(row&&row.uid!==currentUser.id&&row.Engineer!==currentUser.name){
                toast("You can only edit your own points.");return;
              }
              __larsaOpenPerfRowModal(id);
              var engineer=document.getElementById("pr_Engineer");
              if(engineer){engineer.value=currentUser.name;engineer.disabled=true}
              var status=document.getElementById("pr_Status");
              if(status&&!id){status.value="Draft";status.disabled=true}
            };
            savePerfRow=function(id){
              if(!window.__larsaPinQuick)return __larsaSavePerfRow(id);
              var row=id&&state.performance.find(function(item){return item.id===id});
              if(row&&row.uid!==currentUser.id&&row.Engineer!==currentUser.name){
                toast("You can only edit your own points.");return;
              }
              var engineer=document.getElementById("pr_Engineer");
              if(engineer)engineer.value=currentUser.name;
              return __larsaSavePerfRow(id);
            };
            approvePerf=function(id){
              if(!window.__larsaPinQuick)return __larsaApprovePerf(id);
              toast("Your points will be approved by your manager.");
            };
            deletePerf=function(id){
              if(!window.__larsaPinQuick)return __larsaDeletePerf(id);
              var row=state.performance.find(function(item){return item.id===id});
              if(row&&(row.uid===currentUser.id||row.Engineer===currentUser.name))return __larsaDeletePerf(id);
              toast("You can only change your own points.");
            };
            openColumnModal=function(){
              if(!window.__larsaPinQuick)return __larsaOpenColumnModal();
              toast("Performance columns are managed by administration.");
            };
          }
          if(currentUser){
            if(typeof save==="function")save();
            if(typeof enterApp==="function")enterApp();
          }
          logout=function(){parent.postMessage({type:"larsa-signout"},location.origin)};
        `);
        return;
      }
      if (engine === "hr") {
        const permissions = enginePermissionSnapshot(user, "hr");
        const hrIdentity = {
          id: user.id,
          name: user.name,
          email: user.email || "",
          department: user.department || "",
          scope: user.permissionProfile?.scope || defaultScopeForPreset(user.access || "Engineer"),
        };
        win.eval(`
          window.__larsaAccess=${JSON.stringify(permissions)};
          window.__larsaHrUser=${JSON.stringify(hrIdentity)};
          window.__larsaCan=function(section,action){
            var row=window.__larsaAccess&&window.__larsaAccess[section];
            return !!(row&&row[action||"view"]);
          };
          if(!window.__larsaHrScopeInstalled&&typeof activePeople==="function"){
            window.__larsaHrScopeInstalled=true;
            var __larsaAllHrPeople=window.activePeople;
            window.activePeople=function(){
              var rows=__larsaAllHrPeople.apply(this,arguments);
              var actor=window.__larsaHrUser||{};
              if(actor.scope==="company")return rows;
              var normal=function(value){return String(value||"").toLowerCase().replace(/[^a-z0-9]+/g,"")};
              var actorName=normal(actor.name),actorEmail=normal(actor.email),actorDepartment=normal(actor.department);
              return rows.filter(function(person){
                var isSelf=normal(person.id)===normal(actor.id)||normal(person.name)===actorName||(actorEmail&&normal(person.email)===actorEmail);
                if(actor.scope==="own")return isSelf;
                if(actor.scope==="team")return isSelf||normal(person.manager)===actorName;
                var personDepartment=normal(person.selections&&person.selections.department||person.department);
                return isSelf||!!actorDepartment&&(personDepartment===actorDepartment||personDepartment.includes(actorDepartment)||actorDepartment.includes(personDepartment));
              });
            };
            try{activePeople=window.activePeople}catch(e){}
          }
          if(!window.__larsaAccessGuardInstalled){
            window.__larsaAccessGuardInstalled=true;
            var __larsaOriginalGo=window.go;
            window.go=function(section){
              if(!window.__larsaCan(section,"view")){
                if(typeof toast==="function")toast("You do not have access to this area.");
                return;
              }
              return __larsaOriginalGo.apply(this,arguments);
            };
            try{go=window.go}catch(e){}
            var __larsaGuard=function(name,section,actionForArguments){
              var original=window[name];
              if(typeof original!=="function")return;
              window[name]=function(){
                var action=typeof actionForArguments==="function"?actionForArguments(arguments):actionForArguments;
                if(!window.__larsaCan(section,action)){
                  if(typeof toast==="function")toast("You do not have permission for this action.");
                  return;
                }
                return original.apply(this,arguments);
              };
              try{eval(name+"=window[name]")}catch(e){}
            };
            __larsaGuard("openPersonModal","people",function(args){return args[0]?"edit":"add"});
            __larsaGuard("savePerson","people",function(args){return args[0]?"edit":"add"});
            __larsaGuard("deletePerson","people","delete");
            __larsaGuard("openCategoryModal","matrix",function(args){return args[0]?"edit":"add"});
            __larsaGuard("saveCategory","matrix",function(args){return args[0]?"edit":"add"});
            __larsaGuard("deleteCategory","matrix","delete");
            __larsaGuard("openItemModal","matrix",function(args){return args[1]?"edit":"add"});
            __larsaGuard("saveItem","matrix",function(args){return args[1]?"edit":"add"});
            __larsaGuard("deleteItem","matrix","delete");
            __larsaGuard("exportCSV","reports","export");
            __larsaGuard("exportJSON","reports","export");
            window.__larsaApplyHrControls=function(){
              document.querySelectorAll("button").forEach(function(button){
                var code=button.getAttribute("onclick")||"";
                var allowed=true;
                if(/openPersonModal\\(\\)/.test(code))allowed=window.__larsaCan("people","add");
                else if(/openPersonModal/.test(code))allowed=window.__larsaCan("people","edit");
                else if(/deletePerson/.test(code))allowed=window.__larsaCan("people","delete");
                else if(/openCategoryModal\\(\\)/.test(code)||/openItemModal\\([^,]+\\)/.test(code))allowed=window.__larsaCan("matrix","add");
                else if(/openCategoryModal|openItemModal/.test(code))allowed=window.__larsaCan("matrix","edit");
                else if(/deleteCategory|deleteItem/.test(code))allowed=window.__larsaCan("matrix","delete");
                else if(/exportCSV|window\\.print/.test(code))allowed=window.__larsaCan("reports","export");
                if(allowed)button.style.removeProperty("display");
                else button.style.setProperty("display","none","important");
              });
              var heroCopy=document.querySelector(".heroCard p");
              if(heroCopy)heroCopy.textContent="Clear people, skill, software, degree, discipline, credential, and rank coverage.";
              document.querySelectorAll(".cardTitle").forEach(function(title){
                if(title.textContent.trim()==="Smart HR Scope")title.textContent="HR at a glance";
              });
              document.querySelectorAll(".subtitle").forEach(function(subtitle){
                if(subtitle.textContent.trim()==="This is not a duplicate of other platforms."){
                  subtitle.textContent="Focused employee, skill, and credential insights.";
                }
              });
              var smartTitle=document.querySelector(".smartNote strong");
              if(smartTitle)smartTitle.textContent="Skills and people overview";
              var smartText=document.querySelector(".smartNote span");
              if(smartText)smartText.textContent="Employee files, classifications, skills, software, credentials, degrees, disciplines, and work arrangements in one clear view.";
            };
            var __larsaOriginalRender=window.render;
            window.render=function(){
              var result=__larsaOriginalRender.apply(this,arguments);
              setTimeout(window.__larsaApplyHrControls,0);
              return result;
            };
            try{render=window.render}catch(e){}
          }
          if(typeof page!=="undefined"&&!window.__larsaCan(page,"view")){
            var first=["dashboard","people","matrix","reports"].find(function(section){return window.__larsaCan(section,"view")});
            if(first)page=first;
          }
          if(typeof render==="function")render();
        `);
        return;
      }
      if (engine === "accounting") {
        const accountingSnapshot = readAccountingSnapshot();
        const allowedProjectIds = [...visibleProjectIds(user, accountingSnapshot.projects)];
        const mappedUser = {
          id: `staff_${user.id}`,
          name: user.name,
          email: user.email || `${user.username || user.id}@larsaeng.com`,
          role: accountingRole(user),
          region: "Shared",
          active: true,
          department: user.department || "",
          dataScope: user.permissionProfile?.scope || defaultScopeForPreset(user.access || "Engineer"),
          permissions: accountingPermissionsForUser(user),
          projectAccessMode: isAdmin(user)
            ? "all"
            : user.projectAccessMode || projectAccessForPreset(user.access || "Engineer"),
          projectIds: allowedProjectIds,
        };
        /* Commission has to attach to a real person, not to whatever someone
           typed. The engine already supports select fields, so the roster is
           handed over and the two name fields become dropdowns. */
        const salesRoster = readStaffUsers()
          .filter((person) => person.enabled !== false)
          .map((person) => person.name)
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b));
        /* Assigning who may enter or approve a project's accounting has to
           pick a real Larsa Control account, not a typed-in address. The
           roster of people who actually hold an accounting-capable role is
           handed to the engine so those fields become dropdowns. */
        const accountingRoster = readStaffUsers()
          .filter((person) => person.enabled !== false && person.email)
          .map((person) => ({
            email: String(person.email || "").toLowerCase(),
            name: person.name || person.email || "",
            role: accountingRole(person),
            access: person.access || "",
          }))
          .filter((person) => person.email.includes("@"))
          .sort((a, b) => a.name.localeCompare(b.name));
        win.eval(`
          currentUser=${JSON.stringify(mappedUser)};
          /* Running inside the authenticated Larsa Control work area. The
             engine's own local-prototype plumbing — Supabase sync setup,
             push/pull/replace of the serialized state, and the local audit
             trail — is hidden here: the backend ledger and its append-only
             history are the only source of truth in production. */
          window.__larsaProductionMode=true;
          window.__larsaSalesRoster=${JSON.stringify(salesRoster)};
          window.__larsaAccountingRoster=${JSON.stringify(accountingRoster)};
          window.__larsaCanProject=function(projectId){
            if(!currentUser)return false;
            if(currentUser.projectAccessMode==="all")return true;
            if(currentUser.projectAccessMode==="none")return false;
            return (currentUser.projectIds||[]).includes(String(projectId||""));
          };
          var login=document.getElementById("loginScreen");
          var publicView=document.getElementById("publicScreen");
          var app=document.getElementById("app");
          if(login)login.style.display="none";
          if(publicView)publicView.style.display="none";
          if(app)app.style.display="flex";
          if(typeof xVisible==="function"&&!window.__larsaScopeGuardInstalled){
            window.__larsaScopeGuardInstalled=true;
            var __larsaBaseVisible=xVisible;
            xVisible=function(record){
              var projectId=record&&(
                record.projectId||record.projectID||record.ProjectId||record.project_id
              );
              if(!projectId&&record&&state&&Array.isArray(state.projects)&&state.projects.some(function(project){
                return project.id===record.id;
              }))projectId=record.id;
              if(projectId)return window.__larsaCanProject(projectId);
              if(!__larsaBaseVisible(record))return false;
              var scope=currentUser&&currentUser.dataScope||"company";
              if(scope==="company")return true;
              var ownerValues=[
                record&&record.createdBy,record&&record.user,record&&record.email,
                record&&record.engineer,record&&record.Engineer,record&&record.employee,
                record&&record.responsibleEngineer,record&&record.projectManager,
                record&&record.teamLeader,record&&record.assignedTo
              ].filter(Boolean).map(function(value){return String(value).toLowerCase()});
              var identity=[currentUser.id,currentUser.email,currentUser.name].filter(Boolean).map(function(value){return String(value).trim().toLowerCase()});
              var isWordChar=function(character){return !!character&&"abcdefghijklmnopqrstuvwxyz0123456789".indexOf(character)>=0};
              var wordMatch=function(field,target){
                if(!field||!target)return false;
                if(field===target)return true;
                if(target.length<3)return false;
                var at=field.indexOf(target);
                while(at>=0){
                  var before=at===0?"":field.charAt(at-1);
                  var after=field.charAt(at+target.length);
                  if(!isWordChar(before)&&!isWordChar(after))return true;
                  at=field.indexOf(target,at+1);
                }
                return false;
              };
              if(scope==="own")return ownerValues.some(function(value){return identity.includes(value)});
              if(scope==="department"){
                var department=String(record&&record.department||"").toLowerCase();
                return !!department&&department===String(currentUser.department||"").toLowerCase();
              }
              return ownerValues.some(function(value){
                return identity.some(function(person){return wordMatch(value,person)});
              });
            };
            try{window.xVisible=xVisible}catch(e){}
            var __larsaProjectLookup=window.project;
            if(typeof __larsaProjectLookup==="function"){
              window.project=function(id){
                if(!window.__larsaCanProject(id))return undefined;
                return __larsaProjectLookup.apply(this,arguments);
              };
              try{project=window.project}catch(e){}
            }
            window.__larsaWithProjectScope=function(callback,thisArg,args){
              if(!currentUser||currentUser.projectAccessMode==="all"){
                return callback.apply(thisArg,args||[]);
              }
              var collections=[
                "projects","funding","revenue","expenses","materials","projectLabor",
                "boqItems","documents","reviewQueue"
              ];
              var saved={};
              collections.forEach(function(name){
                if(!Array.isArray(state[name]))return;
                saved[name]=state[name];
                state[name]=state[name].filter(function(record){
                  if(name==="projects")return window.__larsaCanProject(record.id);
                  var id=record&&(
                    record.projectId||record.projectID||record.ProjectId||record.project_id
                  );
                  return !id||window.__larsaCanProject(id);
                });
              });
              try{return callback.apply(thisArg,args||[])}
              finally{Object.keys(saved).forEach(function(name){state[name]=saved[name]})}
            };
            [
              "render","openEditor","addNew","xExportTable","v33AdvancedExcel",
              "v34ExportSection","v39WorkbookFromCollections"
            ].forEach(function(name){
              var original=window[name];
              if(typeof original!=="function"||original.__larsaProjectWrapped)return;
              var wrapped=function(){
                return window.__larsaWithProjectScope(original,this,arguments);
              };
              wrapped.__larsaProjectWrapped=true;
              window[name]=wrapped;
              try{eval(name+"=window[name]")}catch(e){}
            });
          }
          if(!window.__larsaAccountingCleanupInstalled){
            window.__larsaAccountingCleanupInstalled=true;
            window.__larsaApplyAccountingCleanup=function(){
              if(typeof activeSection!=="undefined"&&activeSection!=="settings")return;
              var view=document.getElementById("view");
              if(!view)return;
              var heading=function(text){
                return Array.from(view.querySelectorAll("h1,h2,h3")).find(function(node){
                  return node.textContent.trim()===text;
                });
              };
              var cardFor=function(text){
                var title=heading(text);
                return title&&title.closest(".card");
              };
              [
                "Users & Access",
                "Role permission defaults",
                "Backup & Data",
                "Backup & Data (kept forever)",
                "User Account Tools",
                "Restore Points / Backup Control",
                "Custom Access Control"
              ].forEach(function(text){
                var card=cardFor(text);
                if(card)card.style.display="none";
              });
              var pageHeading=view.querySelector(".page-head h1");
              if(pageHeading)pageHeading.textContent="Accounting Settings";
              view.querySelectorAll(".notice").forEach(function(note){
                if(/prototype access control|permissions are selectable per user/i.test(note.textContent))note.style.display="none";
              });
              var advancedCard=cardFor("Payroll Tax Settings");
              if(advancedCard&&advancedCard.dataset.larsaAdvancedOpen!=="true")advancedCard.style.display="none";
              var advancedButton=Array.from(view.querySelectorAll("button")).find(function(button){
                return button.textContent.trim()==="Show / Hide Advanced JSON";
              });
              if(advancedButton){
                advancedButton.textContent="Advanced tax JSON";
                advancedButton.removeAttribute("onclick");
                advancedButton.onclick=function(){
                  var card=cardFor("Payroll Tax Settings");
                  if(!card)return;
                  var open=card.dataset.larsaAdvancedOpen!=="true";
                  card.dataset.larsaAdvancedOpen=open?"true":"false";
                  card.style.display=open?"":"none";
                  var json=document.getElementById("tax_json");
                  if(json)json.style.display=open?"block":"none";
                };
              }
              var systemCard=cardFor("Backup Center / System Check");
              if(systemCard){
                var systemTitle=heading("Backup Center / System Check");
                if(systemTitle)systemTitle.textContent="System Tools";
                systemCard.querySelectorAll("button,label").forEach(function(control){
                  if(/Export JSON Backup|Import Backup/i.test(control.textContent))control.style.display="none";
                });
                systemCard.querySelectorAll("p").forEach(function(copy){
                  if(/Backup includes/i.test(copy.textContent))copy.textContent="Run accounting integrity checks or export the advanced workbook.";
                });
              }
              var supabaseCard=cardFor("Supabase Sync / Production Setup");
              if(supabaseCard){
                var supabaseCopy=supabaseCard.querySelector("p");
                if(supabaseCopy)supabaseCopy.textContent="Configure the optional production database, authentication, and synchronization connection.";
                supabaseCard.querySelectorAll("button").forEach(function(button){
                  var text=button.textContent.trim();
                  if(text==="Push Backup to Supabase")button.textContent="Push to Supabase";
                  if(text==="Pull / Merge from Supabase")button.textContent="Pull & Merge";
                });
              }
            };
            var __larsaOriginalAccountingRender=window.render;
            window.render=function(){
              var result=__larsaOriginalAccountingRender.apply(this,arguments);
              setTimeout(window.__larsaApplyAccountingCleanup,0);
              return result;
            };
            try{render=window.render}catch(e){}
          }
          /* ------------------------------------------------------------
             LEDGER TOOLBAR AND TOTALS
             Every ledger page gains a period, a currency view, a density
             and a print action, and every table gains a totals row. Done
             from out here so the accounting engine itself is untouched:
             it already exposes usd(), money(), printDoc() and
             printHeader(), so this reuses its arithmetic rather than
             re-implementing money handling. Columns are identified the
             same way the engine renders them — numeric columns carry the
             "right" class — so this holds for every section, including
             any added later.
             ------------------------------------------------------------ */
          /* Salesman and commission recipient become dropdowns of real staff.
             The engine's own field system already understands select + opts, so
             this only swaps the field type; every existing typed-in name is kept
             as an option so historic records still show and still edit. */
          if(!window.__larsaSalesFieldsInstalled&&typeof SCHEMA!=="undefined"){
            window.__larsaSalesFieldsInstalled=true;
            window.__larsaSalesOptions=function(){
              var roster=(window.__larsaSalesRoster||[]).slice();
              var seen={};roster.forEach(function(name){seen[name]=true});
              // Names already recorded against revenue or commissions must not
              // vanish from the list, or editing an old row would wipe them.
              [(state&&state.revenue)||[],(state&&state.commissions)||[]].forEach(function(rows,index){
                rows.forEach(function(row){
                  var name=index===0?row.salesman:row.person;
                  if(name&&!seen[name]){seen[name]=true;roster.push(name)}
                });
              });
              return [""].concat(roster.sort());
            };
            var asPicker=function(collection,key){
              var fields=SCHEMA[collection];
              if(!Array.isArray(fields))return;
              fields.forEach(function(field){
                if(field.k!==key)return;
                field.type="select";
                // A getter keeps the list correct as staff are added or removed.
                Object.defineProperty(field,"opts",{
                  configurable:true,
                  get:function(){return window.__larsaSalesOptions()},
                });
              });
            };
            asPicker("revenue","salesman");
            asPicker("commissions","person");
          }
          if(!window.__larsaLedgerToolsInstalled){
            window.__larsaLedgerToolsInstalled=true;
            window.__larsaLF={preset:"all",from:"",to:"",cur:"asis",mode:"detailed"};
            var larsaLF=window.__larsaLF;
            var larsaIso=function(d){return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10)};
            window.__larsaRange=function(){
              var n=new Date(),y=n.getFullYear(),m=n.getMonth(),p=larsaLF.preset;
              if(p==="all")return["",""];
              if(p==="custom")return[larsaLF.from,larsaLF.to];
              if(p==="month")return[larsaIso(new Date(y,m,1)),larsaIso(new Date(y,m+1,0))];
              if(p==="quarter"){var q=Math.floor(m/3)*3;return[larsaIso(new Date(y,q,1)),larsaIso(new Date(y,q+3,0))]}
              if(p==="year")return[larsaIso(new Date(y,0,1)),larsaIso(new Date(y,11,31))];
              if(p==="last")return[larsaIso(new Date(y-1,0,1)),larsaIso(new Date(y-1,11,31))];
              return["",""];
            };
            var larsaNum=function(text){
              var cleaned=String(text||"").split("").filter(function(ch){
                return (ch>="0"&&ch<="9")||ch==="."||ch==="-";
              }).join("");
              var value=parseFloat(cleaned);
              return isFinite(value)?value:null;
            };
            /* A cell says which currency it is in. Totals are grouped by that
               currency and never merged: adding IQD to USD produces a number
               that means nothing, and labelling it "$" makes it worse. */
            var larsaCur=function(text){
              var s=String(text||"");
              if(s.indexOf("IQD")>=0||s.indexOf("د.ع")>=0)return "IQD";
              if(s.indexOf("$")>=0||s.indexOf("USD")>=0)return "USD";
              return "";
            };
            var larsaFmt=function(value,currency){
              var rounded=Math.round(value*100)/100;
              try{ if(typeof money==="function"&&currency)return money(rounded,currency); }catch(e){}
              var text=rounded.toLocaleString();
              return currency==="IQD"?text+" IQD":currency==="USD"?"$"+text:text;
            };
            /* An exchange rate is a rate, not an amount: a column of rates has
               no total, so its footer cell stays descriptive instead. */
            var larsaIsRateCol=function(label){
              return /rate|سعر\s*الصرف|fx/i.test(String(label||""));
            };
            /* A row is kept when it carries no date at all, so summary rows and
               reference tables are never silently emptied by a period filter. */
            window.__larsaApplyLedger=function(){
              var view=document.getElementById("view");
              if(!view)return;
              var range=window.__larsaRange(),from=range[0],to=range[1];
              view.querySelectorAll("table").forEach(function(table){
                var heads=Array.prototype.slice.call(table.querySelectorAll("thead th"));
                if(!heads.length)return;
                var dateAt=-1;
                heads.forEach(function(th,index){
                  if(dateAt<0&&/date|paid|due/i.test(th.textContent||""))dateAt=index;
                });
                var body=table.querySelector("tbody");
                if(!body)return;
                var rows=Array.prototype.slice.call(body.querySelectorAll("tr"));
                var shown=0;
                rows.forEach(function(row){
                  var cells=row.querySelectorAll("td");
                  if(!cells.length)return;
                  var keep=true;
                  if(dateAt>=0&&cells[dateAt]&&(from||to)){
                    var stamp=(cells[dateAt].textContent||"").trim().slice(0,10);
                    // Escape-free ISO check: a regex here would need doubled
                    // backslashes inside the template literal, which is exactly
                    // the sort of thing that silently stops matching.
                    var looksIso=stamp.length===10&&stamp.charAt(4)==="-"&&stamp.charAt(7)==="-";
                    if(looksIso){
                      if(from&&stamp<from)keep=false;
                      if(to&&stamp>to)keep=false;
                    }
                  }
                  row.style.display=keep?"":"none";
                  if(keep)shown++;
                });
                /* Totals, per currency. Each numeric column is summed into a
                   bucket per currency found in its own cells, so a table
                   holding both IQD and USD rows reports "12,000,000 IQD ·
                   $1,000" rather than one meaningless number. Rate columns
                   are never summed. */
                var old=table.querySelector("tfoot.larsa-totals");
                if(old)old.remove();
                var sums={},any=false,rateCols={};
                heads.forEach(function(th,index){
                  if(!th.classList.contains("right"))return;
                  if(/action/i.test(th.textContent||""))return;
                  if(larsaIsRateCol(th.textContent)){rateCols[index]=true;return}
                  var buckets={},seen=false;
                  rows.forEach(function(row){
                    if(row.style.display==="none")return;
                    var cell=row.querySelectorAll("td")[index];
                    if(!cell)return;
                    var value=larsaNum(cell.textContent);
                    if(value===null)return;
                    var cur=larsaCur(cell.textContent);
                    if(!cur){
                      // Fall back to the row's own currency column when the
                      // cell itself is unlabelled.
                      var rowCells=row.querySelectorAll("td");
                      for(var ci=0;ci<rowCells.length;ci++){
                        var found=larsaCur(rowCells[ci].textContent);
                        if(found){cur=found;break}
                      }
                    }
                    if(!cur)cur="—";
                    buckets[cur]=(buckets[cur]||0)+value;seen=true;
                  });
                  if(seen){sums[index]=buckets;any=true}
                });
                if(!any)return;
                var foot=document.createElement("tfoot");
                foot.className="larsa-totals";
                var tr=document.createElement("tr");
                heads.forEach(function(th,index){
                  var td=document.createElement("td");
                  if(index===0){td.textContent="Total · "+shown+" record"+(shown===1?"":"s")}
                  else if(rateCols[index]){
                    td.className="right";
                    td.textContent="per entry";
                    td.title="Exchange rates are per entry and are never added together";
                  }
                  else if(sums[index]!==undefined){
                    var buckets=sums[index];
                    var keys=Object.keys(buckets);
                    td.className="right";
                    td.textContent=keys.map(function(cur){
                      return larsaFmt(buckets[cur],cur==="—"?"":cur);
                    }).join(" · ");
                    if(keys.length>1)td.title="Currencies are totalled separately and never added together";
                  }
                  tr.appendChild(td);
                });
                foot.appendChild(tr);
                table.appendChild(foot);
              });
              if(larsaLF.mode==="summary"){
                view.querySelectorAll("table").forEach(function(table){
                  var body=table.querySelector("tbody");
                  if(body)body.style.display="none";
                });
              }
            };
            window.__larsaSetLedger=function(key,value){
              window.__larsaLF[key]=value;
              window.__larsaRenderToolbar();
              window.__larsaApplyLedger();
            };
            window.__larsaPrintLedger=function(){
              var view=document.getElementById("view");
              if(!view)return;
              var range=window.__larsaRange();
              var heading=view.querySelector(".page-head h1");
              var title=(heading?heading.textContent:"Accounting")+
                (range[0]||range[1]?(" · "+(range[0]||"start")+" to "+(range[1]||"today")):" · All history");
              var clone=view.cloneNode(true);
              clone.querySelectorAll(".larsa-ledger-bar,.row-actions,th:last-child,td:last-child").forEach(function(node){node.remove()});
              clone.querySelectorAll("tr").forEach(function(row){
                if(row.style.display==="none")row.remove();
              });
              try{ printDoc(title,printHeader(title)+clone.innerHTML) }
              catch(e){ window.print() }
            };
            /* Built with real elements and listeners rather than an HTML
               string: no quote escaping to get wrong, and no inline handlers. */
            window.__larsaRenderToolbar=function(){
              var view=document.getElementById("view");
              if(!view)return;
              var existing=view.querySelector(".larsa-ledger-bar");
              if(existing)existing.remove();
              if(!view.querySelector("table"))return;
              var f=window.__larsaLF;
              var bar=document.createElement("div");
              bar.className="larsa-ledger-bar";
              var field=function(label,control){
                var wrap=document.createElement("label");
                wrap.appendChild(document.createTextNode(label));
                wrap.appendChild(control);
                bar.appendChild(wrap);
                return control;
              };
              var picker=function(key,pairs){
                var select=document.createElement("select");
                pairs.forEach(function(pair){
                  var option=document.createElement("option");
                  option.value=pair[0];option.textContent=pair[1];
                  if(f[key]===pair[0])option.selected=true;
                  select.appendChild(option);
                });
                select.addEventListener("change",function(){window.__larsaSetLedger(key,select.value)});
                return select;
              };
              field("Period",picker("preset",[
                ["all","All history"],["month","This month"],["quarter","This quarter"],
                ["year","This year"],["last","Last year"],["custom","Custom period"]]));
              if(f.preset==="custom"){
                ["from","to"].forEach(function(key){
                  var input=document.createElement("input");
                  input.type="date";input.value=f[key]||"";
                  input.addEventListener("change",function(){window.__larsaSetLedger(key,input.value)});
                  field(key==="from"?"From":"To",input);
                });
              }
              field("Detail",picker("mode",[["detailed","Detailed"],["summary","Summary totals"]]));
              var print=document.createElement("button");
              print.type="button";print.textContent="Print / PDF";
              print.addEventListener("click",function(){window.__larsaPrintLedger()});
              bar.appendChild(print);
              var head=view.querySelector(".page-head");
              if(head&&head.parentNode)head.parentNode.insertBefore(bar,head.nextSibling);
              else view.insertBefore(bar,view.firstChild);
            };
            var __larsaLedgerRender=window.render;
            window.render=function(){
              var result=__larsaLedgerRender.apply(this,arguments);
              setTimeout(function(){
                try{ window.__larsaRenderToolbar(); window.__larsaApplyLedger(); }catch(e){}
              },0);
              return result;
            };
            try{render=window.render}catch(e){}
            var larsaStyle=document.createElement("style");
            larsaStyle.textContent=
              ".larsa-ledger-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:10px 0 14px;padding:11px 13px;border:1px solid var(--line,#e6e8ec);border-radius:14px;background:var(--panel,#fff)}"+
              ".larsa-ledger-bar label{display:grid;gap:4px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;opacity:.7}"+
              ".larsa-ledger-bar select,.larsa-ledger-bar input{min-height:34px;padding:6px 9px;border:1px solid var(--line,#dfe1e5);border-radius:9px;background:var(--surface,#fff);font:inherit;font-size:12.5px}"+
              ".larsa-ledger-bar button{min-height:34px;padding:7px 14px;border:1px solid #17181b;border-radius:9px;background:#17181b;color:#fff;font-weight:800;font-size:12px;cursor:pointer}"+
              "tfoot.larsa-totals td{padding:9px 10px;border-top:2px solid var(--line,#e6e8ec);font-weight:900;background:var(--surface,#fafbfc)}"+
              "tfoot.larsa-totals td.right{text-align:right}"+
              "@media print{.larsa-ledger-bar{display:none!important}}";
            document.head.appendChild(larsaStyle);
          }
          if(typeof can==="function"&&!can("view",typeof XSM!=="undefined"?(XSM[activeSection]||activeSection):activeSection))activeSection="dashboard";
          if(typeof render==="function")render();
          signOut=function(){parent.postMessage({type:"larsa-signout"},location.origin)};
        `);
      }
    } catch {
      notify(`${engine === "staff" ? "Timeclock" : engine === "hr" ? "HR" : "Accounting"} access is still loading.`);
    }
  }, [notify, refs]);

  const completeSignIn = useCallback((user: StaffUser, method: SignInMethod = "email") => {
    const normalizedUser = user.permissionProfile
      ? { ...user, permissions: staffPermissionsForUser(user) }
      : user;
    persistSession(normalizedUser, method, rememberRef.current);
    sessionUserRef.current = normalizedUser;
    sessionMethodRef.current = method;
    setSessionUser(normalizedUser);
    setSessionMethod(method);
    setPreviewOwner(null);
    setLoginError("");
    /* Alerts survive a sign-out, so this browser may still hold a subscription
       that belongs to whoever used it last. Claiming it here re-points it at
       the person now signed in — silently, without asking permission again. */
    void adoptPushSubscription(normalizedUser.id, normalizedUser.name);
    (Object.keys(refs) as Engine[]).forEach((engine) => applySessionToFrame(engine, normalizedUser, method));
    const requestedView = new URLSearchParams(window.location.search).get("view");
    const requestedItem = ITEMS.find((item) => item.id === requestedView);
    // A PIN is a shift-floor sign-in: it must land on the clock with no extra taps.
    const pinLanding = ITEMS.find((item) => item.id === "quick-clock");
    const landingItem = requestedItem && canOpenInSession(normalizedUser, requestedItem, method)
      ? requestedItem
      : method === "pin" && pinLanding && canOpenInSession(normalizedUser, pinLanding, method)
        ? pinLanding
        : ITEMS.find((item) => item.id === "overview") || DEFAULT_ITEM;
    setNavChannel(channelForItem(landingItem));
    setActive(landingItem);
  }, [applySessionToFrame, refs]);

  const startAccessPreview = (user: StaffUser) => {
    const owner = sessionUserRef.current;
    if (!owner || sessionMethodRef.current === "pin" || !hasItemPermission(owner, ACCESS_ITEM, "view")) {
      notify("Only an authorized administrator can start an access preview.");
      return;
    }
    const previewUser = {
      ...user,
      permissions: staffPermissionsForUser(user),
    };
    setPreviewOwner(owner);
    sessionUserRef.current = previewUser;
    sessionMethodRef.current = "email";
    setSessionUser(previewUser);
    setSessionMethod("email");
    (Object.keys(refs) as Engine[]).forEach((engine) => applySessionToFrame(engine, previewUser, "email"));
    setNavChannel("home");
    setActive(ITEMS.find((item) => item.id === "overview") || DEFAULT_ITEM);
    setMenuOpen(false);
    notify(`Previewing the workspace as ${previewUser.name}.`);
  };

  const endAccessPreview = () => {
    if (!previewOwner) return;
    const owner = previewOwner;
    sessionUserRef.current = owner;
    sessionMethodRef.current = "email";
    setSessionUser(owner);
    setSessionMethod("email");
    setPreviewOwner(null);
    (Object.keys(refs) as Engine[]).forEach((engine) => applySessionToFrame(engine, owner, "email"));
    setNavChannel("admin");
    setActive(ACCESS_ITEM);
    setMenuOpen(false);
    notify("Access preview closed.");
  };

  const [viewerSession, setViewerSession] = useState<ViewerSession | null>(null);
  const viewerSessionRef = useRef<ViewerSession | null>(null);

  const completeViewerSignIn = useCallback((session: ViewerSession) => {
    viewerSessionRef.current = session;
    setViewerSession(session);
    try { sessionStorage.setItem(VIEWER_SESSION_KEY, JSON.stringify(session)); } catch { /* a refused write must never block sign-in */ }
    setLoginError("");
  }, []);

  const viewerSignOut = useCallback(async () => {
    const client = getSupabaseClient();
    if (client) { try { await client.auth.signOut(); } catch { /* the local session is cleared either way */ } }
    try { sessionStorage.removeItem(VIEWER_SESSION_KEY); } catch { /* nothing to clear */ }
    viewerSessionRef.current = null;
    setViewerSession(null);
  }, []);

  // Rebuilds a Viewer's shell from their live viewer_accounts row, never from
  // the cached snapshot alone — an admin who disables or rescopes a Viewer
  // between visits must take effect on the very next load, not the next
  // password change. A stale or now-invalid Supabase session (expired,
  // deleted, disabled) always ends in a clean sign-out, never a stuck screen.
  useEffect(() => {
    let cancelled = false;
    const raw = (() => { try { return sessionStorage.getItem(VIEWER_SESSION_KEY); } catch { return null; } })();
    if (!raw) return;
    let cached: ViewerSession | null = null;
    try { cached = JSON.parse(raw) as ViewerSession; } catch { cached = null; }
    if (!cached?.id) { try { sessionStorage.removeItem(VIEWER_SESSION_KEY); } catch { /* nothing to clear */ } return; }
    const client = getSupabaseClient();
    if (!client) return;
    client.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const authUserId = data.session?.user?.id;
      if (!authUserId) { try { sessionStorage.removeItem(VIEWER_SESSION_KEY); } catch { /* nothing to clear */ } return; }
      client
        .from("viewer_accounts")
        .select("id, username, display_name, project_access_mode, allowed_project_ids, enabled, expires_at")
        .eq("auth_user_id", authUserId)
        .maybeSingle()
        .then(({ data: row }) => {
          if (cancelled) return;
          const expired = Boolean(row?.expires_at) && new Date(row!.expires_at as string).getTime() < Date.now();
          if (!row || row.enabled === false || expired) {
            void client.auth.signOut();
            try { sessionStorage.removeItem(VIEWER_SESSION_KEY); } catch { /* nothing to clear */ }
            return;
          }
          const restored: ViewerSession = {
            id: row.id, username: row.username, displayName: row.display_name,
            projectAccessMode: ((row.project_access_mode as string) || "assigned") as "all" | "assigned" | "none",
            allowedProjectIds: Array.isArray(row.allowed_project_ids) ? row.allowed_project_ids as string[] : [],
          };
          viewerSessionRef.current = restored;
          setViewerSession(restored);
        });
    });
    return () => { cancelled = true; };
  }, []);

  // Tried only after the employee lookup below has already failed: Viewer
  // usernames live in their own table, never in larsaStaffV8, so this never
  // changes which employee a matching email+password signs in as.
  const tryViewerSignIn = async (candidateUsername: string, candidatePassword: string): Promise<"signed-in" | "disabled" | "no-match"> => {
    const uname = candidateUsername.trim().toLowerCase();
    if (!uname || !supabaseConfigured()) return "no-match";
    const client = getSupabaseClient();
    if (!client) return "no-match";
    const { data, error } = await client.auth.signInWithPassword({
      email: `${uname}@${VIEWER_EMAIL_DOMAIN}`,
      password: candidatePassword,
    });
    if (error || !data.session) return "no-match";
    const { data: row } = await client
      .from("viewer_accounts")
      .select("id, username, display_name, project_access_mode, allowed_project_ids, enabled, expires_at")
      .eq("auth_user_id", data.session.user.id)
      .maybeSingle();
    if (!row) { await client.auth.signOut(); return "no-match"; }
    const expired = Boolean(row.expires_at) && new Date(row.expires_at as string).getTime() < Date.now();
    if (row.enabled === false || expired) { await client.auth.signOut(); return "disabled"; }
    completeViewerSignIn({
      id: row.id, username: row.username, displayName: row.display_name,
      projectAccessMode: ((row.project_access_mode as string) || "assigned") as "all" | "assigned" | "none",
      allowedProjectIds: Array.isArray(row.allowed_project_ids) ? row.allowed_project_ids as string[] : [],
    });
    return "signed-in";
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = sessionStorage.getItem("larsa-control-session")
          || localStorage.getItem(KEEP_SESSION_KEY);
        /* Two shapes have been written over time: the bare user record, and
           the { user, method } envelope used since v9. Both must still load. */
        const parsed = saved
          ? JSON.parse(saved) as { user?: StaffUser; method?: SignInMethod } | StaffUser
          : null;
        const envelope = parsed && "user" in parsed
          ? parsed as { user?: StaffUser; method?: SignInMethod }
          : null;
        const user: StaffUser | null = envelope ? envelope.user ?? null : parsed as StaffUser | null;
        const method: SignInMethod = envelope?.method || "email";
        const currentUser = user?.id
          ? readStaffUsers().find((row) => row.id === user.id) || user
          : null;
        if (currentUser?.id && currentUser.enabled !== false) {
          const expiredEmailSession = method === "email"
            && supabaseConfigured()
            && Boolean(currentUser.email)
            && false; /* the server check added below decides; the local device list is wiped whenever the blob is overwritten, so judging by it signed everyone out */
          if (expiredEmailSession) {
            sessionStorage.removeItem("larsa-control-session");
            try { localStorage.removeItem(KEEP_SESSION_KEY); } catch { /* nothing to clear */ }
          } else {
            completeSignIn(currentUser, method || "email"); if (method === "email" && supabaseConfigured() && currentUser.email) { checkVerification({ id: currentUser.id, email: currentUser.email, access: currentUser.access, role: currentUser.role }).then((verdict) => { if (verdict && verdict.required && verdict.policy.force_relogin) { sessionStorage.removeItem("larsa-control-session"); try { localStorage.removeItem(KEEP_SESSION_KEY); } catch { /* nothing to clear */ } sessionUserRef.current = null; setSessionUser(null); setLoginError("For security, please sign in and verify your email again."); } }); }
          }
        }
      } catch {
        sessionStorage.removeItem("larsa-control-session");
        try { localStorage.removeItem(KEEP_SESSION_KEY); } catch { /* nothing to clear */ }
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [completeSignIn, readStaffUsers]);

  // Every account that already had a working email + password before this
  // feature shipped is grandfathered in as verified the first time anyone
  // signs in after the update — otherwise the whole staff list would be
  // locked out at once over an address nobody was ever asked to confirm.
  // Runs once; a flag on the store itself (not per-user) prevents repeats.
  const migrateEmailVerification = useCallback(() => {
    try {
      const store = parseStore("larsaStaffV8") as { users?: StaffUser[]; emailVerifyMigratedV1?: boolean } | null;
      if (!store || !Array.isArray(store.users) || store.emailVerifyMigratedV1) return;
      store.users = store.users.map((row) => (
        row.email && row.password && row.emailVerified === undefined
          ? { ...row, emailVerified: true }
          : row
      ));
      store.emailVerifyMigratedV1 = true;
      localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    } catch {
      // Nothing to migrate yet if the store isn't there — a brand-new
      // account will simply verify normally on its first sign-in.
    }
  }, []);

  const persistEmailVerified = useCallback((userId: string, verified: boolean) => {
    try {
      const store = parseStore("larsaStaffV8") as { users?: StaffUser[] } | null;
      if (!store || !Array.isArray(store.users)) return;
      const index = store.users.findIndex((row) => row.id === userId);
      if (index < 0) return;
      store.users[index] = { ...store.users[index], emailVerified: verified, touchedAt: serverNowIso() };
      localStorage.setItem("larsaStaffV8", JSON.stringify(store));
      (Object.keys(refs) as Engine[]).forEach((engine) => {
        try {
          refs[engine].current?.contentWindow?.eval(`
            state=JSON.parse(localStorage.getItem("larsaStaffV8"));
            if(currentUser)currentUser=state.users.find(function(user){return user.id===currentUser.id})||currentUser;
            if(typeof render==="function"&&currentUser)render();
          `);
        } catch {
          // The embedded module will pick up the change on its next render.
        }
      });
    } catch {
      // A failed write here just means the account re-verifies next sign-in.
    }
  }, [refs]);

  const sendVerificationCode = useCallback(async (email: string) => {
    const client = getSupabaseClient();
    if (!client) return "Verification is unavailable right now.";
    const { data: sent } = await client.functions.invoke("auth-code", { body: { op: "send", email, purpose: "verify" } }); const error = sent && sent.ok ? null : { message: (sent && sent.error) || "Could not send a verification code." };
    if (!error) return "";
    /* The default Supabase sender allows only a couple of emails an hour and
       the ceiling cannot be raised -- it lifts once a real SMTP provider is
       configured. Saying "rate limit exceeded" reads like a fault in the app,
       so name the cause and the wait instead. */
    if (/rate limit/i.test(error.message)) {
      return "Too many codes requested. The email service allows only a few per hour — wait about an hour, or ask an administrator to finish the mail setup to remove this limit.";
    }
    return `Could not send a verification code: ${error.message}`;
  }, []);

  /* Checks a code without touching the sign-in flow's state, so the same
     Supabase OTP can also guard sensitive changes made while already
     signed in -- a new password, a new PIN, or a new email address. */
  const checkEmailCode = useCallback(async (email: string, code: string) => {
    const client = getSupabaseClient();
    if (!client) return "Verification is unavailable right now.";
    const { data: checked } = await client.functions.invoke("auth-code", { body: { op: "verify", email, purpose: "verify", code: code.trim() } }); const error = checked && checked.ok ? null : { message: (checked && checked.error) || "That code was not accepted." };
    return error ? "That code was not accepted. Check it and try again." : "";
  }, []);

  const confirmVerifyCode = async () => {
    if (!verifyStage) return;
    const code = verifyCode.trim();
    if (!code) { setVerifyError("Enter the 6-digit code from your email."); return; }
    setVerifyBusy(true);
    setVerifyError("");
    const client = getSupabaseClient();
    if (!client) { setVerifyBusy(false); setVerifyError("Verification is unavailable right now."); return; }
    const { data: confirmed } = await client.functions.invoke("auth-code", { body: { op: "verify", email: verifyStage.email, purpose: "verify", code, userId: verifyStage.user.id } }); const error = confirmed && confirmed.ok ? null : { message: (confirmed && confirmed.error) || "That code was not accepted." };
    setVerifyBusy(false);
    if (error) { setVerifyError("That code didn't match. Check your email and try again."); return; }
    persistEmailVerified(verifyStage.user.id, true);
    let nextDevices = withDeviceRecorded(verifyStage.user.devices, getDeviceId(), describeDevice(), { verified: true });
    try {
      const deviceStore = parseStore("larsaStaffV8") as { users?: StaffUser[] } | null;
      if (deviceStore && Array.isArray(deviceStore.users)) {
        const seat = deviceStore.users.findIndex((row) => row.id === verifyStage.user.id);
        if (seat >= 0) {
          nextDevices = withDeviceRecorded(deviceStore.users[seat].devices, getDeviceId(), describeDevice(), { verified: true });
          deviceStore.users[seat] = { ...deviceStore.users[seat], emailVerified: true, devices: nextDevices };
          localStorage.setItem("larsaStaffV8", JSON.stringify(deviceStore));
        }
      }
    } catch { /* Remembering the device is a convenience; sign-in must not fail on it. */ }
    const verifiedUser = { ...verifyStage.user, emailVerified: true, devices: nextDevices };
    const rememberedEmail = verifyStage.email;
    /* A PIN sign-in that needed a code is still a PIN sign-in: it must finish
       with the PIN session's own reduced surface, never a full email session. */
    const rememberedMethod: SignInMethod = verifyStage.method || "email";
    setVerifyStage(null);
    setVerifyCode("");
    setVerifyInfo("");
    try {
      if (rememberMe && rememberedMethod === "email") localStorage.setItem(REMEMBER_EMAIL_KEY, rememberedEmail);
      else if (rememberedMethod === "email") localStorage.removeItem(REMEMBER_EMAIL_KEY);
    } catch {
      // Remembering the address is a convenience, never a sign-in requirement.
    }
    completeSignIn(verifiedUser, rememberedMethod);
  };

  const resendVerifyCode = async () => {
    if (!verifyStage) return;
    setVerifyBusy(true);
    setVerifyError("");
    const problem = await sendVerificationCode(verifyStage.email);
    setVerifyBusy(false);
    if (problem) setVerifyError(problem);
    else setVerifyInfo(`We sent a new code to ${verifyStage.email}.`);
  };

  const cancelVerify = () => {
    setVerifyStage(null);
    setVerifyCode("");
    setVerifyError("");
    setVerifyInfo("");
  };

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    const users = readStaffUsers();
    if (!users.length) {
      setLoginError("Staff access is still loading. Please try again.");
      return;
    }
    const enteredPin = loginPin.trim();
    // Phone keyboards add capitals and stray spaces, and pasted addresses often
    // carry an invisible trailing space. Normalise both sides before comparing.
    const enteredEmail = loginEmail.trim().toLowerCase();
    const enteredPass = loginPass.trim();
    // A blank field must never match a record that also stores a blank secret.
    if (loginMode === "pin" ? !enteredPin : !enteredEmail || !enteredPass) {
      setLoginError(loginMode === "pin" ? "Enter your Employee PIN." : "Enter your work email and password.");
      return;
    }
    // The local part alone is accepted, so "ajumaah" works as well as the
    // full address — a frequent cause of "not recognized" on a phone.
    const enteredLocal = enteredEmail.includes("@") ? enteredEmail.split("@")[0] : enteredEmail;
    const emailMatches = (row: StaffUser) => {
      const staffEmail = row.email?.trim().toLowerCase() || "";
      const account = row.username?.trim().toLowerCase() || "";
      return staffEmail === enteredEmail
        || (Boolean(account) && `${account}@larsaeng.com` === enteredEmail)
        || (Boolean(account) && account === enteredLocal)
        || (Boolean(staffEmail) && staffEmail.split("@")[0] === enteredLocal);
    };
    const pinUser = loginMode === "pin" ? await findByPin(users, enteredPin) : null; const user = loginMode === "pin"
      ? pinUser
      : users.find((row) => row.enabled !== false
        && Boolean(row.password)
        && emailMatches(row)
        );
    const credentialOk = user ? (loginMode === "pin" ? true : await verifyPassword(enteredPass, user.password)) : false; if (!user || !credentialOk) {
      // No employee matched — the same box also accepts a Viewer's
      // username+password (see tryViewerSignIn), so that is checked before
      // giving up. Employee usernames and Viewer usernames are separate
      // namespaces in separate tables, so this never changes which employee
      // a correct email+password pair signs in as.
      if (loginMode === "email") {
        const viewerResult = await tryViewerSignIn(enteredLocal, enteredPass);
        if (viewerResult === "signed-in") return;
        if (viewerResult === "disabled") {
          setLoginError("This account is no longer active. Contact your Larsa Engineering contact.");
          return;
        }
      }
      /* Separate the failures so people stop retyping a correct password
         against an address that simply has no account — and, just as
         importantly, so somebody whose account exists but cannot sign in yet
         is told WHY. A new sign-up waiting on an administrator used to be
         told its password was wrong, which sent people round in circles
         changing a password that was never the problem. */
      const account = loginMode === "email" ? users.find((row) => emailMatches(row)) : null;
      if (account?.offboarded) {
        setLoginError("This account has been offboarded. Ask an administrator to restore it.");
        return;
      }
      if (account?.pendingApproval) {
        setLoginError("Your account is waiting for an administrator to approve it. You will be able to sign in once it is approved.");
        return;
      }
      if (account && account.enabled === false) {
        setLoginError("This account is disabled. Ask an administrator to re-enable it.");
        return;
      }
      setLoginError(loginMode === "pin"
        ? "PIN not recognized."
        : account
          ? "That password does not match this account."
          : "No account found for that email address.");
      return;
    }
    if (loginMode === "email") {
      migrateEmailVerification();
      const refreshed = readStaffUsers().find((row) => row.id === user.id) || user;
      const periodic = supabaseConfigured() && refreshed.email ? await checkVerification({ id: refreshed.id, email: refreshed.email, access: refreshed.access, role: refreshed.role }) : null;      const periodicDue = periodic ? periodic.required : deviceNeedsVerification(refreshed, getDeviceId());
      /* Whether this mailbox has EVER been proved is answered by the server
         first: user_verification stamps every accepted code and is keyed to
         the person's email, so it cannot be lost the way a flag inside the
         shared staff document can. The blob's emailVerified used to be the
         only witness, and every time a stale save reverted it the app
         demanded a code at the very next sign-in — regardless of the
         interval configured in Platform Settings. The flag stays as the
         offline fallback, and is healed from the server verdict below so
         the document converges back to the truth. */
      const initialRequired = periodic
        ? periodic.policy.enabled !== false && periodic.policy.initial_verification_required !== false
        : true;
      const initialProven = refreshed.emailVerified === true || Boolean(periodic?.lastVerifiedAt);
      if (periodic?.lastVerifiedAt && refreshed.emailVerified !== true) {
        persistEmailVerified(refreshed.id, true);
      }
      if (supabaseConfigured() && refreshed.email && ((initialRequired && !initialProven) || periodicDue)) {
        setVerifyError("");
        setVerifyInfo("Sending your verification code…");
        setVerifyBusy(true);
        sendVerificationCode(refreshed.email).then((problem) => {
          setVerifyBusy(false);
          if (problem) { setVerifyInfo(""); setLoginError(problem); return; }
          setVerifyStage({ user: refreshed, email: refreshed.email as string });
          setVerifyInfo(`We sent a 6-digit code to ${refreshed.email}. Enter it below to finish signing in.`);
        });
        return;
      }
    }
    /* PIN sign-in proves its inbox the same way email sign-in does: the first
       time (and again every configured period — weekly by default) the person
       enters an emailed code. Governed by Platform Settings, where the period
       is set and the whole check can be switched off, exactly like the email
       policy above. A username-only account with no mailbox is never asked. */
    if (loginMode === "pin" && supabaseConfigured() && user.email) {
      const pinPolicy = await loadPolicy();
      if (pinPolicy.enabled !== false && pinPolicy.pin_verification_required !== false) {
        const hours = Math.max(1, Number(pinPolicy.pin_hours) || 168);
        /* When this person last proved their inbox. Asked of the SERVER first:
           it stamps user_verification every time a code is accepted, and that
           record cannot be lost the way a field inside the shared staff blob
           can. Anchoring on the local device stamp alone is what made a weekly
           policy behave as if it were every-single-sign-in. The device stamp
           stays as the fallback for when Supabase cannot be reached. */
        const serverStatus = await checkVerification({ id: user.id, email: user.email, access: user.access, role: user.role });
        const device = findDevice(user, getDeviceId());
        const deviceAt = device?.lastVerified ? new Date(device.lastVerified).getTime() : 0;
        const serverAt = serverStatus?.lastVerifiedAt ? new Date(serverStatus.lastVerifiedAt).getTime() : 0;
        const verifiedAt = Math.max(Number.isFinite(serverAt) ? serverAt : 0, Number.isFinite(deviceAt) ? deviceAt : 0);
        const pinDue = !verifiedAt || Date.now() - verifiedAt >= hours * 3600000;
        if (pinDue) {
          setVerifyError("");
          setVerifyInfo("Sending your verification code…");
          setVerifyBusy(true);
          sendVerificationCode(user.email).then((problem) => {
            setVerifyBusy(false);
            if (problem) { setVerifyInfo(""); setLoginError(problem); return; }
            setVerifyStage({ user, email: user.email as string, method: "pin" });
            setVerifyInfo(`We sent a 6-digit code to ${user.email}. Enter it below to finish signing in.`);
          });
          return;
        }
      }
    }
    try {
      if (rememberMe && loginMode === "email") localStorage.setItem(REMEMBER_EMAIL_KEY, enteredEmail);
      else localStorage.removeItem(REMEMBER_EMAIL_KEY);
    } catch {
      // Remembering the address is a convenience, never a sign-in requirement.
    }
    if (loginMode === "email") { try { const deviceStore = parseStore("larsaStaffV8") as { users?: StaffUser[] } | null; if (deviceStore && Array.isArray(deviceStore.users)) { const seat = deviceStore.users.findIndex((row) => row.id === user.id); if (seat >= 0) { deviceStore.users[seat] = { ...deviceStore.users[seat], devices: withDeviceRecorded(deviceStore.users[seat].devices, getDeviceId(), describeDevice(), { verified: true }) }; localStorage.setItem("larsaStaffV8", JSON.stringify(deviceStore)); } } } catch { /* remembering the device is a convenience, never a requirement */ } } if (needsUpgrade(loginMode === "pin" ? user.pin : user.password)) { try { const legacyStore = parseStore("larsaStaffV8") as { users?: StaffUser[] } | null; if (legacyStore && Array.isArray(legacyStore.users)) { const at = legacyStore.users.findIndex((row) => row.id === user.id); if (at >= 0) { legacyStore.users[at] = { ...legacyStore.users[at], ...(loginMode === "pin" ? { pin: await hashPin(enteredPin), pinChangedAt: serverNowIso() } : { password: await hashPassword(enteredPass), passwordChangedAt: serverNowIso() }) }; localStorage.setItem("larsaStaffV8", JSON.stringify(legacyStore)); } } } catch { /* Rewriting the old secret is best effort; sign-in must not fail on it. */ } } completeSignIn(readStaffUsers().find((row) => row.id === user.id) || user, loginMode);
  };

  const signOut = useCallback(() => {
    sessionStorage.removeItem("larsa-control-session");
    // Signing out is deliberate: drop the kept session too, but leave the
    // remembered address so the next sign-in is still one field shorter.
    try { localStorage.removeItem(KEEP_SESSION_KEY); } catch { /* nothing to clear */ }
    /* Alerts are NOT cancelled here. Turning them on is a decision the person
       made, and signing out — which this app does by itself when a
       verification interval lapses — is not them changing their mind. They
       used to be dropped on every sign-out, so everybody had to switch them
       back on again and again. The shared-machine case is handled where it
       actually arises instead: the next person to sign in adopts this
       browser's subscription (see adoptPushSubscription), which moves the row
       to them and stops the previous account receiving on it. */
    setBellOpen(false);
    setNotifyCounts(EMPTY_COUNTS);
    setNotifyActor(null);
    setAppBadge(0);
    sessionUserRef.current = null;
    sessionMethodRef.current = null;
    setSessionUser(null);
    setSessionMethod(null);
    setPreviewOwner(null);
    setNavChannel("home");
    setLoginEmail("");
    setLoginPass("");
    setLoginPin("");
    setMenuOpen(false);
    try {
      staffRef.current?.contentWindow?.eval("currentUser=null;byId('app').classList.add('hidden')");
      accountingRef.current?.contentWindow?.eval("currentUser=null;var app=document.getElementById('app');if(app)app.style.display='none'");
    } catch {
      // The outer sign-in remains authoritative if an embedded view is reloading.
    }
  }, []);

  /* A kept browser session ends with the same verification window as a fresh
     sign-in. When it expires, the next screen is the normal email + code flow.

     Never while an access preview is running, though. A preview swaps
     sessionUser to the person being previewed, and THEY have of course never
     verified the administrator's device — so this effect used to see an
     expired window the moment a preview began and sign the administrator
     straight out of their own real session ("preview as other user logs out
     directly"). A preview borrows an identity, not a session: the owner's
     own verification window was checked when they signed in and resumes
     governing the moment the preview ends. */
  useEffect(() => {
    if (previewOwner) return;
    if (!sessionUser || sessionMethod !== "email" || !supabaseConfigured() || !sessionUser.email) return;
    const remaining = verificationRemainingMs(sessionUser, getDeviceId()); if (remaining <= 0) { checkVerification({ id: sessionUser.id, email: sessionUser.email, access: sessionUser.access, role: sessionUser.role }).then((verdict) => { if (verdict && verdict.required && verdict.policy.force_relogin) signOut(); }); return; }
    const timer = window.setTimeout(signOut, Math.max(0, Math.min(remaining, 2147483647)));
    return () => window.clearTimeout(timer);
  }, [previewOwner, sessionMethod, sessionUser, signOut]);

  const clickWhenReady = useCallback(
    (find: () => HTMLButtonElement | null, missingMessage: string) => {
      let tries = 0;
      const attempt = () => {
        const button = find();
        if (button) {
          button.click();
          return;
        }
        tries += 1;
        if (tries > 15) {
          notify(missingMessage);
          return;
        }
        window.setTimeout(attempt, 60);
      };
      attempt();
    },
    [notify],
  );

  const navigateInner = useCallback(
    (item: Item) => {
      const user = sessionUserRef.current;
      const method = sessionMethodRef.current;
      if (!user || !canOpenInSession(user, item, method)) {
        notify("You do not have access to this area.");
        return;
      }
      if (!item.engine || !item.section) return;
      const frame = refs[item.engine].current;
      const win = frame?.contentWindow;
      const doc = frame?.contentDocument;
      if (!win || !doc) return;
      try {
        ensureEmbeddedStyle(doc, item.engine);
        if (item.engine === "staff") {
          const login = doc.getElementById("login");
          if (login && !login.classList.contains("hidden")) {
            applySessionToFrame("staff", user, method || "email");
          }
          // The staff engine paints its nav (and the data-page hooks) shortly after
          // load, so poll briefly instead of assuming the button already exists.
          clickWhenReady(
            () => doc.querySelector<HTMLButtonElement>(`.nav button[data-page="${item.section}"]`),
            "This page is not available for your Timeclock account.",
          );
          return;
        }
        if (item.engine === "hr") {
          const go = (win as Window & { go?: (page: string) => void }).go;
          if (typeof go === "function") go(item.section);
          return;
        }
        const app = doc.getElementById("app");
        const appVisible = app ? getComputedStyle(app).display !== "none" : false;
        if (!appVisible) {
          applySessionToFrame("accounting", user, method || "email");
        }
        clickWhenReady(
          () => doc.querySelector<HTMLButtonElement>(`.nav-item[data-sec="${item.section}"]`),
          "This page is not available for your Accounting account.",
        );
      } catch {
        notify("That page is waiting for its module to finish loading.");
      }
    },
    [applySessionToFrame, clickWhenReady, notify, refs],
  );

  const prepareFrame = useCallback(
    (engine: Engine) => {
      const frame = refs[engine].current;
      if (!frame) return;
      let tries = 0;
      const timer = window.setInterval(() => {
        tries += 1;
        try {
          const doc = frame.contentDocument;
          const ready =
            engine === "accounting"
              ? doc?.getElementById("view")
              : doc?.getElementById("content");
          if (!doc?.head || !doc.body || !ready) {
            if (tries > 160) clearInterval(timer);
            return;
          }
          ensureEmbeddedStyle(doc, engine);
          /* Wrap the engine's own localStorage before anything can save:
             every engine write is rebased onto the current stored text so a
             stale in-memory copy can never erase newer work. See
             ENGINE_REBASE_SRC. */
          try {
            (frame.contentWindow as (Window & { eval(code: string): unknown }) | null)?.eval(ENGINE_REBASE_SRC);
          } catch { /* the engine still saves; the sync guard and repair_008 heal behind it */ }
          applyThemeToFrames(dark);
          const signedInUser = sessionUserRef.current;
          const signedInMethod = sessionMethodRef.current;
          if (signedInUser) applySessionToFrame(engine, signedInUser, signedInMethod || "email");
          if (signedInUser && activeRef.current.engine === engine) navigateInner(activeRef.current);
          setStorageTick((value) => value + 1);
          clearInterval(timer);
        } catch {
          if (tries > 160) clearInterval(timer);
        }
      }, 200);
    },
    [applySessionToFrame, applyThemeToFrames, dark, navigateInner, refs],
  );

  useEffect(() => {
    if (!menuOpen && !installHelp) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (installHelp) setInstallHelp(false);
      else setMenuOpen(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [installHelp, menuOpen]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data?.type === "larsa-signout") signOut();
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [signOut]);

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const format = (timeZone: string) =>
        new Intl.DateTimeFormat("en-US", {
          timeZone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        }).format(now);
      setClock({ baghdad: format("Asia/Baghdad"), texas: format("America/Chicago") });
    };
    tick();
    const timer = setInterval(tick, 30000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const requestedView = new URLSearchParams(window.location.search).get("view");
    const requestedItem = ITEMS.find((item) => item.id === requestedView);
    if (!requestedItem || requestedItem.id === activeRef.current.id) return;
    const timer = window.setTimeout(() => {
      setNavChannel(channelForItem(requestedItem));
      setActive(requestedItem);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  /* Everything to do with installing lives in this one effect. It used to be
     two, each registering its own beforeinstallprompt listener, which was both
     redundant and beside the point: by the time either of them ran the browser
     had already fired that event and thrown it away, so Install could never do
     anything but show the manual steps. The head script now catches it first
     and parks it; this picks it up on mount and stays listening in case a later
     one arrives. */
  useEffect(() => {
    const standalone =
      matchMedia("(display-mode: standalone)").matches ||
      matchMedia("(display-mode: window-controls-overlay)").matches ||
      matchMedia("(display-mode: minimal-ui)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const bridge = (window as WindowWithInstall).__larsaInstall;
    const adopt = () => {
      const parked = (window as WindowWithInstall).__larsaInstall?.event;
      if (parked) setInstallPrompt(parked);
    };
    const startupTimer = window.setTimeout(() => {
      setInstalled(standalone || Boolean(bridge?.installed));
      adopt();
      /* Already installed and opened in a normal tab: the browser stays silent
         rather than firing beforeinstallprompt, so without this the button
         would sit there offering an install that can never happen. Chromium
         only; everywhere else this is simply absent. */
      const related = (navigator as Navigator & {
        getInstalledRelatedApps?: () => Promise<Array<{ platform?: string }>>;
      }).getInstalledRelatedApps;
      related?.call(navigator)
        .then((apps) => { if (apps?.length) setInstalled(true); })
        .catch(() => undefined);
    }, 0);
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
      setInstallHelp(false);
      notify("Larsa Control is installed — open it from your home screen, Dock, or Start menu.");
    };
    window.addEventListener("larsa:installable", adopt);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    /* Keeping the installed app on the current version. The worker already
       takes over the moment it activates, but the PAGE went on running the
       old code until somebody happened to close and reopen it — which is why
       a shipped fix could sit unseen on a phone for days. Now the app asks
       whether a newer worker exists (on load, and whenever it comes back to
       the foreground) and reloads once when one takes over, so the new
       version replaces the old one by itself. */
    let updateCheck: (() => void) | null = null;
    navigator.serviceWorker?.register("/sw.js").then((registration) => {
      registration.update().catch(() => undefined);
      updateCheck = () => { if (!document.hidden) registration.update().catch(() => undefined); };
      document.addEventListener("visibilitychange", updateCheck);
    }).catch(() => undefined);
    /* Only a REPLACEMENT is worth a reload. On a first install there was no
       controller, and reloading then would restart the app under somebody's
       hands for no reason — and could loop. */
    const hadController = Boolean(navigator.serviceWorker?.controller);
    let reloading = false;
    const onControllerChange = () => {
      if (!hadController || reloading) return;
      reloading = true;
      window.location.reload();
    };
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);

    return () => {
      clearTimeout(startupTimer);
      window.removeEventListener("larsa:installable", adopt);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
      if (updateCheck) document.removeEventListener("visibilitychange", updateCheck);
    };
    // notify is stable for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active.engine || !sessionUser) return;
    const timer = window.setTimeout(() => navigateInner(active), 40);
    return () => clearTimeout(timer);
  }, [active, navigateInner, sessionUser]);

  const choose = (item: Item, channel = channelForItem(item), record = true) => {
    if (!canOpenInSession(sessionUserRef.current, item, sessionMethodRef.current)) {
      notify("You do not have access to this area.");
      return;
    }
    /* The email-code identity gate only makes sense for accounts that HAVE an
       email. Username-only accounts (clients, trainees, interns an admin set
       up without an address) have no mailbox to verify — their access is
       already scoped and password-protected, so they pass straight through. */
    if (!previewOwner && item.engine === "accounting" && sessionUserRef.current && sessionUserRef.current.email && accountingNeedsVerification(sessionUserRef.current, getDeviceId())) { setAccountingGate(item); return; } setNavChannel(item.id === "overview" ? "home" : channel);
    /* Recorded only once the navigation is certain to happen: everything that
       could refuse it has already returned above. Going Back passes record
       false, or the two would push each other back and forth for ever. */
    if (record && activeRef.current && activeRef.current.id !== item.id) {
      const from = activeRef.current;
      setNavHistory((stack) => [...stack, from].slice(-30));
    }
    setActive(item);
    if (!["overview", "admin"].includes(item.id)) {
      localStorage.setItem("larsa-control-recent", item.id);
      setRecentId(item.id);
      setRecentTrail((prev) => {
        const next = [item.id, ...prev.filter((id) => id !== item.id)].slice(0, 6);
        try { localStorage.setItem("larsa-control-recent-trail", JSON.stringify(next)); } catch { /* private mode */ }
        return next;
      });
    }
    setMenuOpen(false);
  };

  /* Opening a notification. The stored itemId is an app item id, never a URL,
     so the worst a bad value can do is fail to match and leave you where you
     were — it cannot navigate anywhere that is not already a screen in this
     app, and it cannot reach a screen this person may not open, because
     choose() runs the same access check as every other navigation. */
  const openNotification = (row: { id: string; itemId?: string | null }) => {
    setBellOpen(false);
    const actor = sessionUserRef.current;
    if (actor?.id && notifyConfigured()) {
      void markNotifications({ id: actor.id, name: actor.name }, [row.id], "read")
        .then(() => setNotifyTick((value) => value + 1));
    }
    if (!row.itemId) return;
    const target = ITEMS.find((item) => item.id === row.itemId);
    if (target) choose(target);
  };

  /* Tapping a push banner should land on the thing it is about, not just focus
     whatever tab happened to be open. The worker sends the path it validated;
     the id in it is looked up here and routed in-app, so no reload is needed. */
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type !== "larsa:notification-click") return;
      setNotifyTick((value) => value + 1);
      if (data.notificationId) setPendingNotification(String(data.notificationId));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  /* Cold start from a push: the worker opened /?n=<id> because no window was
     running. The id is consumed and stripped from the address bar so a later
     refresh does not re-open it. */
  useEffect(() => {
    if (!hydrated) return;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("n");
    if (!id) return;
    params.delete("n");
    const rest = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));
    const timer = window.setTimeout(() => setPendingNotification(id), 0);
    return () => clearTimeout(timer);
  }, [hydrated]);

  /* Where Back goes. A stack of the areas actually visited this session, not
     the browser's history: this is a single page, so the browser's own Back
     button leaves the app altogether rather than stepping through it. */
  const goBack = () => {
    const previous = navHistory[navHistory.length - 1];
    if (!previous) return;
    setNavHistory((stack) => stack.slice(0, -1));
    choose(previous, channelForItem(previous), false);
  };

  /* ---- The phone's system Back button. ----------------------------------
     This is a single-URL app: every screen is React state, so the browser
     held exactly one history entry and the first system Back closed the app
     from anywhere. The fix keeps one sentinel entry on top of the stack; a
     system Back (or an iOS edge-swipe) consumes it, lands here, and the app
     decides what "back" means before re-arming the sentinel:

       1. an open layer closes first — dialog, snapshot viewer, popover
          (registered in app/backstack.ts), then the notification bell, the
          navigation drawer, the install sheet, the accounting gate, or the
          sign-in sub-screens;
       2. otherwise the same in-app history the visible Back button uses
          (goBack) steps to the previous logical screen;
       3. otherwise, anywhere but Home, it returns to Home;
       4. on Home (or the sign-in screen) it shows "Press back again to
          exit" and does NOT re-arm — so a second press within two seconds
          reaches the browser with nothing left to pop, and the system
          itself minimizes or leaves the app. If the two seconds lapse, the
          sentinel is re-armed and the person stays put.

     No screen navigation is duplicated and no second router is created: the
     sentinel only decides whether a press is handled by the app or released
     to the system. */
  const [exitHint, setExitHint] = useState(false);
  const systemBackRef = useRef<{ armed: boolean; timer: number | null; leaving: number | null }>({ armed: false, timer: null, leaving: null });
  const armSentinel = () => {
    try { window.history.pushState({ larsa: "sentinel" }, ""); } catch { /* history unavailable */ }
  };
  const handleSystemBack = () => {
    const flags = systemBackRef.current;
    /* Mid-departure: keep stepping out through any stale same-document
       entries a refresh left behind, then hand control to the system. If the
       app is still visible shortly after, the departure is over — restore
       normal handling so nobody is ever trapped. */
    if (flags.leaving !== null) {
      window.clearTimeout(flags.leaving);
      flags.leaving = window.setTimeout(() => { flags.leaving = null; armSentinel(); }, 400);
      try { window.history.back(); } catch { /* nothing to leave through */ }
      return;
    }
    if (popBackCloser()) { armSentinel(); return; }
    if (bellOpen) { setBellOpen(false); armSentinel(); return; }
    if (menuOpen) { setMenuOpen(false); armSentinel(); return; }
    if (installHelp) { setInstallHelp(false); armSentinel(); return; }
    if (accountingGate) { setAccountingGate(null); armSentinel(); return; }
    if (!sessionUser && accessMode) { setAccessMode(null); armSentinel(); return; }
    if (sessionUser && navHistory.length) { goBack(); armSentinel(); return; }
    if (sessionUser && active.id !== "overview") {
      choose(ITEMS.find((item) => item.id === "overview") || DEFAULT_ITEM, "home", false);
      armSentinel();
      return;
    }
    if (flags.timer) { window.clearTimeout(flags.timer); flags.timer = null; }
    if (flags.armed) {
      flags.armed = false;
      setExitHint(false);
      flags.leaving = window.setTimeout(() => { flags.leaving = null; armSentinel(); }, 400);
      try { window.history.back(); } catch { /* the system takes it from here */ }
      return;
    }
    flags.armed = true;
    setExitHint(true);
    flags.timer = window.setTimeout(() => {
      flags.armed = false;
      flags.timer = null;
      setExitHint(false);
      armSentinel();
    }, 2000);
  };
  /* The popstate listener is registered once, but the handler reads live
     state — so the listener calls through a ref that an every-render effect
     keeps pointing at the freshest closure. */
  const systemBackHandlerRef = useRef(handleSystemBack);
  useEffect(() => { systemBackHandlerRef.current = handleSystemBack; });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.history.replaceState({ larsa: "base" }, "");
      window.history.pushState({ larsa: "sentinel" }, "");
    } catch { /* private mode or an embedded context without history */ }
    const onPop = () => systemBackHandlerRef.current();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /* Whether this browser has a real install API at all. Chromium fires
     beforeinstallprompt; Safari and Firefox never will, and no amount of
     waiting changes that — there the written steps ARE the way in. */
  const installApiExists = () => typeof window !== "undefined" && "onbeforeinstallprompt" in window;

  /* The browser decides when a site may be installed, and on Chromium it
     reaches that decision a moment AFTER the page loads — it needs the
     manifest, the service worker and its own engagement check first. Clicking
     Install inside that gap found nothing parked and went straight to the
     manual steps, which is the "sometimes it shows options instead of just
     installing" people hit. So when the event has not arrived yet, wait a
     short while for it rather than giving up on the first look.

     Two seconds is deliberate: Chrome keeps a user gesture "active" for five,
     so the prompt() that follows still counts as coming from the click. */
  const waitForInstallEvent = (ms: number) => new Promise<InstallEvent | null>((resolve) => {
    const parked = () => (window as WindowWithInstall).__larsaInstall?.event || null;
    const already = parked();
    if (already) { resolve(already); return; }
    let settled = false;
    const finish = (value: InstallEvent | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("larsa:installable", onArrival);
      window.removeEventListener("beforeinstallprompt", onArrival);
      resolve(value);
    };
    /* Both are listened for because the head script parks the event and
       announces it, while a late one arrives as the raw browser event. */
    const onArrival = (event: Event) => finish(parked() || (event as InstallEvent));
    const timer = window.setTimeout(() => finish(null), ms);
    window.addEventListener("larsa:installable", onArrival);
    window.addEventListener("beforeinstallprompt", onArrival);
  });

  const install = async () => {
    const bridge = (window as WindowWithInstall).__larsaInstall;
    /* Already installed. Offering somebody instructions for something they
       have already done reads as the app being broken. */
    if (installed || bridge?.installed) {
      notify("Larsa Control is already installed — open it from your home screen, Dock, or Start menu.");
      return;
    }
    let prompt = installPrompt || bridge?.event || null;
    if (!prompt && installApiExists()) {
      setInstallBusy(true);
      prompt = await waitForInstallEvent(2000);
      setInstallBusy(false);
    }
    if (!prompt) {
      setInstallHelp(true);
      return;
    }
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      /* Dismissed is a decision, not a failure: showing the manual steps to
         somebody who just said "not now" would be nagging. */
      if (choice?.outcome === "accepted") notify("Installing Larsa Control…");
    } catch {
      // Single-use and already spent, or refused; the steps still work.
      setInstallHelp(true);
    }
    /* The event is single-use, so it goes either way. The listeners stay up,
       so if the browser offers another one it is adopted and the next click
       installs directly again. */
    setInstallPrompt(null);
    if (bridge) bridge.event = null;
  };

  /* Pushes the saved logs into the embedded engine so both views agree
     immediately rather than after the engine's next natural render. */
  /* Deliberately deferred. This re-parses the whole staff blob inside the
     engine's iframe and runs its full render(), and every caller was invoking
     it synchronously between writing localStorage and React re-rendering — so
     that work landed BETWEEN the click and the repaint. On a clock-in that is
     the entire perceived lag: the button had already done its job and was
     waiting on an iframe to finish redrawing before anything moved on screen.

     Nothing depends on it having finished (the only failure path is a swallowed
     catch, and the engine re-reads the store on its next render anyway), so
     handing it to a timeout lets the click paint first and the engine catch up
     immediately after. */
  const refreshStaffEngine = useCallback(() => {
    window.setTimeout(() => {
      try {
        staffRef.current?.contentWindow?.eval(`
          state=JSON.parse(localStorage.getItem("larsaStaffV8"));
          if(typeof render==="function"&&currentUser)render();
        `);
      } catch {
        // The engine picks the saved log up on its next render.
      }
    }, 0);
  }, []);

  const saveMyPoints = (draft: PerformanceDraft, submit: boolean) => {
    const user = sessionUserRef.current;
    const win = staffRef.current?.contentWindow;
    if (!user || !win) {
      notify("The performance area is still loading. Please try again.");
      return false;
    }
    /* Same double-tap guard punchClock uses, and for the same reason: a row
       written here has no save timestamp of its own to check on the way back
       out of storage, so the window has to be held on the way in instead. */
    const saveNow = Date.now();
    if (saveNow - lastPointsSaveRef.current < 1200) return false;
    lastPointsSaveRef.current = saveNow;
    /* Points belong to the week the work was completed in, not the week it
       happens to be typed in -- otherwise a Monday morning catch-up lands in
       the wrong week and the lock means nothing. */
    const workDate = draft.workDate || new Date().toISOString().slice(0, 10);
    const week = weekOfDate(workDate);
    /* Checked here and not only in the form: the form's copy of the store can be
       a render behind, and a week can be locked while somebody has the page
       open. This is the check that actually decides. */
    const store = parseStore("larsaStaffV8");
    const lock = weekLockFor(store, week);
    const row = {
      id: `p${Date.now()}${Math.random()}`,
      Week: week,
      Date: workDate,
      Engineer: user.name,
      Department: user.department || "",
      "Job Number": draft.jobNumber.trim(),
      "Client Code": draft.clientCode.trim(),
      "Work Category": draft.workCategory,
      Discipline: draft.discipline.trim(),
      "Assigned By": "",
      Reviewer: "",
      // Only a review carries hours; everything else is scored on points alone.
      "Hours Spent": draft.workCategory === "Review" ? Number(draft.hoursSpent) || 0 : 0,
      "Assigned Points": Number(draft.assignedPoints) || 0,
      /* Stored under its original key. Every target, summary, report and export
         reads "Submitted Points", so renaming the key would orphan all of them
         and every entry already on record. The label is what changed. */
      "Submitted Points": Number(draft.submittedPoints) || 0,
      "Approved Points": 0,
      Status: "Draft",
      Notes: draft.notes.trim(),
      uid: user.id,
    };

    /* A closed week does not refuse the work -- it re-routes it. The entry is
       filled in exactly as it would be normally, then travels as a request
       carrying the whole row, so the approver decides on the actual points,
       job and hours rather than on a bare "let me in". Nothing is written to
       performance until that decision. */
    if (lock) {
      if (!store) { notify("Performance records are still loading. Please try again."); return false; }
      if (!draft.lateReason.trim()) {
        notify("Add a reason for the late entry — your approver needs to know why it missed the week.");
        return false;
      }
      if (!Array.isArray(store.approvals)) store.approvals = [];
      /* Late points do NOT walk an approval chain. A points figure is a
         records question, not a leave question: it goes straight to the
         reviewers — anyone GRANTED approve access on Leave & Requests — and a
         single decision settles it. An empty flow is exactly the single-step
         path decideRequest has always enforced: whoever may approve, may
         approve, and the first decision is final. */
      const approvalsGate = ITEMS.find((item) => item.id === "staff-approvals");
      const reviewers = (store.users as StaffUser[]).filter((entry) =>
        entry.enabled !== false && entry.id !== user.id && approvalsGate && hasItemPermission(entry, approvalsGate, "approve"));
      const flow: string[] = [];
      const bounds = weekBounds(week);
      const record: LeaveRequest = {
        id: `r${Date.now()}`,
        type: "Points Unlock",
        uid: user.id,
        requestType: week,
        week,
        entry: { ...row, Status: "Pending approval" },
        date: workDate,
        from: bounds.from,
        to: bounds.to,
        reason: draft.lateReason.trim(),
        status: "Pending",
        flow,
        step: 0,
        history: [],
        createdAt: new Date().toISOString(),
      };
      store.approvals.unshift(record);
      localStorage.setItem("larsaStaffV8", JSON.stringify(store));
      refreshStaffEngine();
      raiseNotification({
        event: "points.unlock",
        title: `${user.name} wants to add points to closed week ${week}`,
        body: `${row["Job Number"] || "Entry"} · ${row["Work Category"]} · ${row["Submitted Points"]} points · ${draft.lateReason.trim()}`,
        itemId: "my-requests", fromName: user.name,
        recipients: reviewers,
      });
      setStorageTick((value) => value + 1);
      notify(`Week ${week} is closed, so this entry went for review — any authorized reviewer can approve it.`);
      return true;
    }

    try {
      win.eval(`
        (function(){
          /* Both this page and the engine own larsaStaffV8, and the engine
             persists its whole in-memory state on save. Adding a row to a copy
             loaded ten minutes ago would write that stale copy back over
             everything saved since -- including the week lock that was just
             checked. So re-read first, then add. */
          try{ state=JSON.parse(localStorage.getItem("larsaStaffV8"))||state; }catch(e){ /* keep the loaded state */ }
          var row=${JSON.stringify(row)};
          if(!Array.isArray(state.performance))state.performance=[];
          state.performance.unshift(row);
          if(typeof save==="function")save();
          if(${submit ? "true" : "false"}&&typeof submitPerformance==="function")submitPerformance();
        })();
      `);
      notify(submit ? "Your points were submitted for approval." : "Your points were saved as a draft.");
      return true;
    } catch {
      notify("The performance area is still loading. Please try again.");
      return false;
    }
  };

  const punchClock = useCallback((mode: string, note = "") => {
    const user = sessionUserRef.current;
    if (!user) return false;
    const store = parseStore("larsaStaffV8");
    if (!store) {
      notify("Attendance records are still loading. Please try again.");
      return false;
    }
    if (!Array.isArray(store.logs)) store.logs = [];
    const latest = (store.logs as ClockLog[])
      .filter((log) => log.uid === user.id && (log.status === "In" || log.status === "Out"))
      .sort((left, right) => new Date(right.time || 0).getTime() - new Date(left.time || 0).getTime())[0];
    /* A double-tap is one decision, not two: without this, the second tap of an
       accidental double-click reads the first tap's "In" and instantly punches
       a zero-minute "Out".

       This used to swallow ten SECONDS of clicks and return true while doing
       nothing — so a second, entirely deliberate press did not register, said
       nothing, and still cleared the note as though it had worked. Pressing
       again inside the window renewed nothing but the confusion, which is
       exactly the "I have to click more than once" this fixes.

       1.2s covers a genuine double-fire from a mouse or a touch screen and
       nothing else. Past that, a press is a decision and is honoured — a short
       session is visible and can be trimmed, whereas a refused clock-out is
       silent and leaves the person looking like they never left. Returning
       false on suppression matters too: the caller keeps the note instead of
       clearing it, and the first press's toast is still on screen, so staying
       quiet here is feedback rather than the absence of it. */
    if (latest?.time && serverNowMs() - new Date(latest.time).getTime() < 1200) {
      return false;
    }
    const status = latest && latest.status === "In" ? "Out" : "In";
    /* Server-corrected time, not the device's. A phone with a wrong clock
       used to write that wrong clock straight into the attendance record;
       serverNowIso() applies the measured skew (see lib/supabase/sync.ts). */
    const now = serverNowIso();
    /* One truthful `active` flag per person. Punches only ever APPENDED, so
       every past clock-in kept its active=true forever (69 stale flags were
       live in production when this was written) and anything that rendered
       from the flag showed people on the clock long after they left. The
       punch that changes a person's state now also retires every stale flag
       that state contradicts. */
    (store.logs as ClockLog[]).forEach((log) => {
      if (log.uid === user.id && log.active && (log.status === "In" || log.status === "Out")) {
        log.active = false;
      }
    });
    // Same record shape the Timeclock engine writes, so both stay in step.
    store.logs.push({
      // uid + entropy so two people punching in the same millisecond on
      // different devices can never collide into one merged record.
      id: `l${user.id}${Date.now()}${Math.random()}`, uid: user.id, type: mode, status,
      time: now, active: status === "In", lastSeen: now, touchedAt: now,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    /* Persistence must not even wait out the sync debounce: the punch is
       already visible locally (state and timer flip instantly from the
       localStorage write above); this starts the backend write and the
       broadcast to other devices in the same breath. */
    pushSyncedKeyNow("larsaStaffV8");
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify(status === "In" ? `Clocked in · ${mode}` : `Clocked out · ${mode}`);
    return true;
  }, [notify, refreshStaffEngine]);

  /* Breaks use their own status values on purpose. Every hour calculation in
     this app pairs "In" with "Out", so a break recorded that way would be
     counted as a whole separate shift. These stay visible but inert. */
  const punchBreak = useCallback((note = "") => {
    const user = sessionUserRef.current;
    if (!user) return false;
    const store = parseStore("larsaStaffV8");
    if (!store) { notify("Attendance records are still loading."); return false; }
    if (!Array.isArray(store.logs)) store.logs = [];
    const latestBreak = (store.logs as ClockLog[])
      .filter((log) => log.uid === user.id && (log.status === "Break Start" || log.status === "Break End"))
      .sort((left, right) => new Date(right.time || 0).getTime() - new Date(left.time || 0).getTime())[0];
    const ending = latestBreak?.status === "Break Start";
    /* A break only makes sense inside a shift. Starting one while clocked out
       would leave an open break dangling into the next day and read as if the
       person were on a break they never took. Ending one is always allowed, so
       nobody can get stuck on break by clocking out first. */
    if (!ending) {
      const latestPunch = (store.logs as ClockLog[])
        .filter((log) => log.uid === user.id && (log.status === "In" || log.status === "Out"))
        .sort((left, right) => new Date(right.time || 0).getTime() - new Date(left.time || 0).getTime())[0];
      if (latestPunch?.status !== "In") {
        notify("Clock in first — a break has to sit inside a shift.");
        return false;
      }
    }
    const now = serverNowIso();
    store.logs.push({
      id: `l${user.id}${Date.now()}${Math.random()}`, uid: user.id, type: "Break",
      status: ending ? "Break End" : "Break Start",
      time: now, active: false, lastSeen: now, touchedAt: now,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    pushSyncedKeyNow("larsaStaffV8");
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify(ending ? "Break ended." : "Break started.");
    return true;
  }, [notify, refreshStaffEngine]);

  /* Clocking someone else in or out. Deliberately records who did it so the
     action is never anonymous in the attendance history. */

  /* Trimming a session an authorized person can already see. Deliberately
     one-way: the new clock-out may only move EARLIER, so this can reduce
     recorded time but never manufacture it. Adding hours stays behind the
     correction request and its approval chain, which is the whole point --
     nobody can quietly inflate their own attendance. */
  const trimSession = useCallback((uid: string, clockIn: string, newClockOut: string) => {
    const actor = sessionUserRef.current;
    const clockItem = ITEMS.find((item) => item.id === "staff-clock");
    /* Two doors in. A clock manager — the staff-clock "manage" capability
       (a Super Admin) or an Admin account — adjusts OTHER people's records,
       but only people inside their own data scope, checked below. And
       everyone who can use the clock may trim THEMSELVES: the one-way rule
       below means a trim can only shorten recorded time, so self-service can
       close a forgotten clock-out or hand back over-counted minutes but can
       never manufacture an hour — adding time still goes through the
       correction request and its approval. The uid equality is the scope:
       an ordinary account can never reach another person's record here. */
    const managesClock = Boolean(actor && clockItem && (hasItemPermission(actor, clockItem, "manage") || actor.access === "Admin"));
    const trimsOwnRecord = Boolean(actor && clockItem && uid === actor.id
      && (hasItemPermission(actor, clockItem, "edit") || hasItemPermission(actor, clockItem, "add")));
    if (!actor || !clockItem || (!managesClock && !trimsOwnRecord)) {
      notify("Your account cannot adjust attendance records.");
      return false;
    }
    /* Somebody else's record: the target has to be somebody the actor is
       authorized to manage. A Super Admin manages everyone (scopedUsers
       short-circuits on isAdmin); an Admin or a granted clock manager
       reaches exactly the people their configured data scope covers. This
       lives in the handler, not the panel, so a forged call fails the same
       way a forged click would — the UI list is convenience, not the gate. */
    if (uid !== actor.id && !scopedUsers(actor, accessUsers).some((user) => user.id === uid)) {
      notify("That employee is outside your data scope.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.logs)) { notify("Attendance records are still loading."); return false; }
    const logs = store.logs as ClockLog[];

    /* The decision is pure and shared (lib/attendance.mjs): identify the ONE
       session that starts at clockIn by walking the person's punches with
       the same pairing rules the session list uses, then validate the new
       clock-out against THAT session's own records and boundaries. "The
       first Out after this In" is gone — it used to grab the NEXT session's
       clock-out when an abandoned open session was trimmed, which rewrote a
       record nobody had selected and could flip the person's live status. */
    const plan = planTrim(logs, uid, clockIn, newClockOut, serverNowMs());
    if (!plan.ok) {
      if (plan.reason === "not-found") notify("That session could not be found.");
      else if (plan.reason === "invalid-time") notify("Enter a valid clock-out time.");
      else if (plan.reason === "not-after-in") notify("Clock-out has to be after clock-in.");
      else if (plan.reason === "future") notify("Clock-out cannot be in the future.");
      else if (plan.reason === "later-than-out") notify("You can only bring a clock-out earlier, not later. Use a correction request to add hours.");
      else notify("That would run into the next session. Pick a time before the following clock-in.");
      return false;
    }
    const { inLog, outLog } = plan.session;
    const previousOut = outLog?.time || null;
    const nextOutIso = new Date(newClockOut).toISOString();
    const stamp = `Adjusted by ${actor.name} on ${new Date().toLocaleDateString()}`;
    if (outLog) {
      /* This session's own clock-out, corrected in place: same record id,
         earlier time, the adjustment stamped beside any note it carried.
         Nothing else in the store is touched. The recency stamp is what
         keeps the trim final: a stale device still holding the longer
         pre-trim copy now loses to this record everywhere. */
      outLog.time = nextOutIso;
      outLog.lastSeen = outLog.time;
      outLog.note = outLog.note ? `${outLog.note} · ${stamp}` : stamp;
      outLog.touchedAt = serverNowIso();
    } else {
      /* An open (or abandoned) session: closing it counts as trimming to the
         chosen time. planTrim already proved the time sits before the
         person's next clock-in, so this can never swallow a later session
         — and a CURRENT open session closes only when it was deliberately
         the one selected. */
      logs.push({
        id: `l${uid}${Date.now()}${Math.random()}`, uid, type: inLog.type || "Office", status: "Out",
        time: nextOutIso, active: false,
        lastSeen: nextOutIso, note: stamp, clockedBy: actor.name, touchedAt: serverNowIso(),
      });
      inLog.active = false;
      inLog.touchedAt = serverNowIso();
    }
    /* The correction itself becomes part of the durable audit trail: who
       trimmed whose session, and both the before and after clock-outs. The
       original punch times additionally survive verbatim in the append-only
       attendance_events ledger, which a trim never rewrites. */
    logAccountEvent(actor, "attendance.session_trimmed", uid,
      accessUsers.find((user) => user.id === uid)?.name || uid, {
        clockIn: inLog.time || clockIn,
        previousClockOut: previousOut,
        newClockOut: nextOutIso,
        closedOpenSession: !outLog,
        self: uid === actor.id,
      });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    /* Same urgency as a punch: the adjusted record must reach the server
       before this tab can be closed, or a refresh inside the sync debounce
       would quietly hand the hours back. */
    pushSyncedKeyNow("larsaStaffV8");
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Attendance record adjusted.");
    return true;
  }, [notify, refreshStaffEngine, accessUsers]);

  /* Removes a session outright -- the clock-in and its matching clock-out.
     For a punch that should never have existed at all. */
  const resetSession = useCallback((uid: string, clockIn: string) => {
    const actor = sessionUserRef.current;
    const clockItem = ITEMS.find((item) => item.id === "staff-clock");
    if (!actor || !clockItem || !hasItemPermission(actor, clockItem, "manage")) {
      notify("Your account cannot reset attendance records.");
      return false;
    }
    /* Removal reaches only the people the actor manages, the same wall the
       trim path has. A Super Admin passes (scopedUsers short-circuits);
       anyone else holding the manage grant is bounded by their data scope. */
    if (uid !== actor.id && !scopedUsers(actor, accessUsers).some((user) => user.id === uid)) {
      notify("That employee is outside your data scope.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.logs)) { notify("Attendance records are still loading."); return false; }
    const logs = store.logs as ClockLog[];
    /* The same session pairing the list uses (lib/attendance.mjs), so the
       removal drops exactly the selected session's own records — for an
       abandoned open session that is the lone clock-in, never the NEXT
       session's clock-out, which the old "first Out after this In" match
       used to take with it. */
    const found = findPunchSession(logs, uid, clockIn);
    const drop = new Set([found?.inLog, found?.outLog].filter(Boolean).map((log) => log as ClockLog));
    if (!drop.size) { notify("That session could not be found."); return false; }
    store.logs = logs.filter((log) => !drop.has(log));
    /* The durable ledger never forgets a punch, so a deliberate removal has
       to be remembered too -- otherwise boot reconciliation would politely
       put the session straight back. */
    markLogsRemoved(store as { removedLogIds?: string[] }, Array.from(drop).map((log) => String(log.id || "")));
    logAccountEvent(actor, "attendance.session_removed", uid, uid, {
      clockIn, removed: Array.from(drop).map((log) => ({ id: log.id, status: log.status, time: log.time })),
    });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    /* removedLogIds has to reach the server ahead of any other device's boot
       reconciliation, or the ledger politely restores what was just removed. */
    pushSyncedKeyNow("larsaStaffV8");
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Session removed.");
    return true;
  }, [notify, refreshStaffEngine, accessUsers]);

  /* ---- Corrections (see CORRECTIONS_ITEM). Every handler gates on its own
     permission, writes the same store the engine reads, stamps who fixed what,
     and refreshes the engine — the identical discipline the clock and review
     handlers above follow. ---- */

  /* Reroute a pending request to different approvers. The decision itself is
     untouched — decideRequest still walks whatever flow the request carries —
     this only changes who that is, and says so in the request's history. */
  const editRequestFlow = useCallback((id: string, nextFlow: string[]) => {
    const actor = sessionUserRef.current;
    const item = ITEMS.find((row) => row.id === "admin-corrections");
    if (!actor || !item || !hasItemPermission(actor, item, "edit")) {
      notify("Your account cannot change approval flows.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.approvals)) { notify("Requests are still loading."); return false; }
    const index = (store.approvals as LeaveRequest[]).findIndex((row) => row.id === id);
    if (index < 0) { notify("That request could not be found."); return false; }
    const record = store.approvals[index] as LeaveRequest;
    if (record.status !== "Pending") { notify("Only a pending request's flow can be changed."); return false; }
    const clean = nextFlow
      .filter(Boolean)
      .filter((uid, at, all) => all.indexOf(uid) === at)
      .filter((uid) => uid !== record.uid)
      .filter((uid) => accessUsers.some((user) => user.id === uid && user.enabled !== false))
      .slice(0, 3);
    if (!clean.length) { notify("An approval flow needs at least one approver."); return false; }
    const step = Math.min(Math.max(Number(record.step) || 0, 0), clean.length - 1);
    const names = clean.map((uid) => accessUsers.find((user) => user.id === uid)?.name || uid);
    store.approvals[index] = {
      ...record,
      flow: clean,
      step,
      history: [...(record.history || []), {
        by: actor.name, action: "Flow changed", at: new Date().toISOString(),
        note: names.join(" → "),
      }],
    };
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Approval flow updated.");
    return true;
  }, [notify, refreshStaffEngine, accessUsers]);

  /* Sets who approves one person's requests, and in what order — the standing
     chain every FUTURE request of that type will follow. It writes the same
     flowConfig the Timeclock engine's own setup card writes, so the two views
     can never disagree; requests already in flight keep the chain they were
     raised with, which is the only honest thing to do with a decision that is
     already part-made (Corrections can reroute an individual one). */
  const saveApprovalFlow = useCallback((employeeId: string, type: string, steps: string[]) => {
    const actor = sessionUserRef.current;
    const item = ITEMS.find((row) => row.id === "hr-approval-flow");
    if (!actor || !item || !hasItemPermission(actor, item, "edit")) {
      notify("Your account cannot change approval flows.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.users)) { notify("The staff directory is still loading."); return false; }
    const people = store.users as StaffUser[];
    if (!people.some((row) => row.id === employeeId)) { notify("Choose an employee."); return false; }
    /* An approver has to be somebody who can actually act: a real, enabled
       account, never the requester themselves, and never the same person
       twice — a chain that asks one person twice is a chain with a step that
       can never be reached. */
    const clean = steps
      .filter(Boolean)
      .filter((id, at, all) => all.indexOf(id) === at)
      .filter((id) => id !== employeeId)
      .filter((id) => people.some((row) => row.id === id && row.enabled !== false && row.offboarded !== true))
      .slice(0, 3);
    if (!clean.length) { notify("An approval flow needs at least one approver."); return false; }
    const flowConfig = (store.flowConfig || {}) as Record<string, Record<string, string[]>>;
    flowConfig[employeeId] = { ...(flowConfig[employeeId] || {}), [type]: clean };
    store.flowConfig = flowConfig;
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    const names = clean.map((id) => people.find((row) => row.id === id)?.name || id);
    notify(`${type} approvals for ${people.find((row) => row.id === employeeId)?.name || "this person"}: ${names.join(" → ")}`);
    return true;
  }, [notify, refreshStaffEngine]);

  /* Fix the figures on a points entry. Scope-checked like the review handler;
     every fix stamps who corrected it and when, beside any review stamps. */
  const fixPerformanceRow = useCallback((rowId: string, patch: { date?: string; hours?: number; submitted?: number; approved?: number; status?: string; notes?: string }) => {
    const actor = sessionUserRef.current;
    const item = ITEMS.find((row) => row.id === "admin-corrections");
    if (!actor || !item || !hasItemPermission(actor, item, "edit")) {
      notify("Your account cannot correct points entries.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.performance)) { notify("Performance records are still loading."); return false; }
    const index = (store.performance as PerformanceRow[]).findIndex((row) => row.id === rowId);
    if (index < 0) { notify("That performance record could not be found."); return false; }
    const row = store.performance[index] as PerformanceRow;
    const employeeId = rowUserId(row, accessUsers);
    if (!scopedUsers(actor, accessUsers).some((user) => user.id === employeeId)) {
      notify("That employee is outside your data scope.");
      return false;
    }
    const next: PerformanceRow = { ...row };
    if (patch.date) { next.Date = patch.date; next.Week = weekOfDate(patch.date); }
    if (patch.hours !== undefined) next["Hours Spent"] = Math.max(0, finiteNumber(patch.hours));
    if (patch.submitted !== undefined) next["Submitted Points"] = Math.max(0, finiteNumber(patch.submitted));
    if (patch.approved !== undefined) next["Approved Points"] = Math.max(0, finiteNumber(patch.approved));
    if (patch.status) next.Status = patch.status;
    if (patch.notes !== undefined) next.Notes = patch.notes;
    next["Corrected By"] = actor.name;
    next["Corrected At"] = new Date().toISOString();
    store.performance[index] = next;
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Points entry corrected.");
    return true;
  }, [notify, refreshStaffEngine, accessUsers]);

  /* Fix a session's clock-in and clock-out. Unlike trim, this can move either
     punch in either direction — that is the point of a correction — so it is
     gated by its own permission and stamps the change on both logs. */
  const fixClockSession = useCallback((uid: string, clockIn: string, newIn: string, newOut: string | null) => {
    const actor = sessionUserRef.current;
    const item = ITEMS.find((row) => row.id === "admin-corrections");
    if (!actor || !item || !hasItemPermission(actor, item, "edit")) {
      notify("Your account cannot correct clock records.");
      return false;
    }
    /* The person being corrected has to be inside the actor's data scope —
       the same wall fixPerformanceRow already has, closed here too so a
       crafted call cannot reach an employee the screen would never list. */
    if (uid !== actor.id && !scopedUsers(actor, accessUsers).some((user) => user.id === uid)) {
      notify("That employee is outside your data scope.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.logs)) { notify("Attendance records are still loading."); return false; }
    const logs = store.logs as ClockLog[];
    const inAt = new Date(newIn).getTime();
    const outAt = newOut ? new Date(newOut).getTime() : null;
    if (!Number.isFinite(inAt)) { notify("Enter a valid clock-in time."); return false; }
    if (inAt > serverNowMs()) { notify("Clock-in cannot be in the future."); return false; }
    if (outAt !== null && (!Number.isFinite(outAt) || outAt <= inAt)) { notify("Clock-out has to be after clock-in."); return false; }
    if (outAt !== null && outAt > serverNowMs()) { notify("Clock-out cannot be in the future."); return false; }
    /* The one session that starts at clockIn, by the same pairing walk the
       session list makes (lib/attendance.mjs) — its own clock-out or none,
       plus the neighbouring-session boundaries. The old "first Out after
       this In" match could hand back the NEXT session's clock-out when an
       abandoned session was corrected, and the fix would rewrite it. */
    const found = findPunchSession(logs, uid, clockIn);
    if (!found) { notify("That session could not be found."); return false; }
    const { inLog, outLog, prevTime, nextTime } = found;
    /* A correction may move either punch in either direction, but never
       across a NEIGHBOURING session — that would splice two sessions into
       one and re-pair every punch after it. */
    if (prevTime !== null && inAt <= prevTime) {
      notify("That clock-in would overlap the previous session. Pick a later time.");
      return false;
    }
    if (outAt !== null && nextTime !== null && outAt >= nextTime) {
      notify("That clock-out would run into the next session. Pick an earlier time.");
      return false;
    }
    const previous = { clockIn: inLog.time || clockIn, clockOut: outLog?.time || null };
    const stamp = `Fixed by ${actor.name} on ${new Date().toLocaleDateString()}`;
    inLog.time = new Date(inAt).toISOString();
    inLog.lastSeen = inLog.time;
    inLog.note = inLog.note ? `${inLog.note} · ${stamp}` : stamp;
    inLog.touchedAt = serverNowIso();
    if (outLog && outAt !== null) {
      outLog.time = new Date(outAt).toISOString();
      outLog.lastSeen = outLog.time;
      outLog.note = outLog.note ? `${outLog.note} · ${stamp}` : stamp;
      outLog.touchedAt = serverNowIso();
    } else if (!outLog && outAt !== null) {
      logs.push({
        id: `l${uid}${Date.now()}${Math.random()}`, uid, type: inLog.type || "Office", status: "Out",
        time: new Date(outAt).toISOString(), active: false,
        lastSeen: new Date(outAt).toISOString(), note: stamp, clockedBy: actor.name, touchedAt: serverNowIso(),
      });
      inLog.active = false;
    }
    logAccountEvent(actor, "attendance.session_corrected", uid,
      accessUsers.find((user) => user.id === uid)?.name || uid, {
        previousClockIn: previous.clockIn,
        previousClockOut: previous.clockOut,
        newClockIn: inLog.time,
        newClockOut: outAt !== null ? new Date(outAt).toISOString() : previous.clockOut,
      });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    pushSyncedKeyNow("larsaStaffV8");
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Clock record corrected.");
    return true;
  }, [notify, refreshStaffEngine, accessUsers]);

  /* Add a session that was never punched — the same append-a-pair shape the
     approved-correction path materialises, stamped as a manual entry. */
  const addClockSession = useCallback((uid: string, date: string, from: string, to: string, mode: string) => {
    const actor = sessionUserRef.current;
    const item = ITEMS.find((row) => row.id === "admin-corrections");
    if (!actor || !item || !hasItemPermission(actor, item, "edit")) {
      notify("Your account cannot add clock records.");
      return false;
    }
    if (!accessUsers.some((user) => user.id === uid)) { notify("Choose an employee."); return false; }
    /* Only somebody the actor manages — the same scope wall the other
       correction handlers keep, so a crafted call cannot write hours onto
       an employee the screen would never offer. */
    if (uid !== actor.id && !scopedUsers(actor, accessUsers).some((user) => user.id === uid)) {
      notify("That employee is outside your data scope.");
      return false;
    }
    const at = (time: string) => new Date(`${date}T${time}:00`);
    const inDate = at(from); const outDate = at(to);
    if (!date || Number.isNaN(inDate.getTime()) || Number.isNaN(outDate.getTime())) { notify("Enter a valid date and times."); return false; }
    if (outDate.getTime() <= inDate.getTime()) { notify("Clock-out has to be after clock-in."); return false; }
    if (outDate.getTime() > Date.now()) { notify("The session cannot end in the future."); return false; }
    const store = parseStore("larsaStaffV8");
    if (!store) { notify("Attendance records are still loading."); return false; }
    if (!Array.isArray(store.logs)) store.logs = [];
    const stamp = `Manual entry by ${actor.name}`;
    const pair: [string, Date][] = [["In", inDate], ["Out", outDate]];
    pair.forEach(([status, when], position) => {
      (store.logs as ClockLog[]).push({
        id: `l${Date.now()}${position}`, uid, type: mode || "Office", status,
        time: when.toISOString(), active: false, lastSeen: when.toISOString(),
        note: stamp, clockedBy: actor.name, touchedAt: serverNowIso(),
      });
    });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    pushSyncedKeyNow("larsaStaffV8");
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Session added.");
    return true;
  }, [notify, refreshStaffEngine, accessUsers]);

  /* Remove a session from Corrections. Same drop as resetSession, but gated by
     this screen's own delete permission so it can be granted separately. */
  const removeClockSession = useCallback((uid: string, clockIn: string) => {
    const actor = sessionUserRef.current;
    const item = ITEMS.find((row) => row.id === "admin-corrections");
    if (!actor || !item || !hasItemPermission(actor, item, "delete")) {
      notify("Your account cannot remove clock records.");
      return false;
    }
    /* Same scope wall as every other correction handler. */
    if (uid !== actor.id && !scopedUsers(actor, accessUsers).some((user) => user.id === uid)) {
      notify("That employee is outside your data scope.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.logs)) { notify("Attendance records are still loading."); return false; }
    const logs = store.logs as ClockLog[];
    /* Exact-session pairing (lib/attendance.mjs): drop THIS session's own
       records only — never a neighbouring session's clock-out. */
    const found = findPunchSession(logs, uid, clockIn);
    const drop = new Set([found?.inLog, found?.outLog].filter(Boolean).map((log) => log as ClockLog));
    if (!drop.size) { notify("That session could not be found."); return false; }
    store.logs = logs.filter((log) => !drop.has(log));
    /* The durable ledger never forgets a punch, so a deliberate removal has
       to be remembered too -- otherwise boot reconciliation would politely
       put the session straight back. */
    markLogsRemoved(store as { removedLogIds?: string[] }, Array.from(drop).map((log) => String(log.id || "")));
    logAccountEvent(actor, "attendance.session_removed", uid, uid, {
      clockIn, removed: Array.from(drop).map((log) => ({ id: log.id, status: log.status, time: log.time })),
    });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    pushSyncedKeyNow("larsaStaffV8");
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Session removed.");
    return true;
  }, [notify, refreshStaffEngine, accessUsers]);

  /* Appending to somebody's formal record. Deliberately append-only: there is
     no edit or delete path, because a personnel file that can be quietly
     rewritten is not a record of anything. It lives in the same synced blob as
     the rest of the staff data, so it reaches every device the same way. */
  const saveFormalRecord = useCallback((record: FormalRecord) => {
    const actor = sessionUserRef.current;
    if (!actor || !hasItemPermission(actor, PERFORMANCE_HISTORY_ITEM, "add")) {
      notify("Your account cannot add to an employee record.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store) { notify("Staff records are still loading."); return false; }
    const existing = Array.isArray(store.formalRecords) ? store.formalRecords as FormalRecord[] : [];
    store.formalRecords = [record, ...existing];
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    logAccountEvent(actor, "performance.record_added", record.uid,
      `${record.kind}: ${record.title}`, { kind: String(record.kind), date: record.date });
    notify("Record added.");
    return true;
  }, [notify, refreshStaffEngine]);

  const saveSchedule = useCallback((userId: string, day: string, entries: { start?: string; end?: string; code?: string; name?: string }[]) => {
    const actor = sessionUserRef.current;
    const scheduleItem = ITEMS.find((item) => item.id === "staff-schedule");
    const mayEdit = Boolean(actor && scheduleItem
      && (hasItemPermission(actor, scheduleItem, "edit") || hasItemPermission(actor, scheduleItem, "manage")));
    if (!actor || !mayEdit) {
      notify("Your account cannot change the schedule.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store) { notify("The schedule is still loading."); return false; }
    store.schedule ||= {};
    store.schedule[userId] ||= {};
    store.schedule[userId][day] = entries.map((entry, index) => ({
      ...entry, instance: `i${Date.now()}_${index}`,
    }));
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    try {
      staffRef.current?.contentWindow?.eval(`
        state=JSON.parse(localStorage.getItem("larsaStaffV8"));
        if(typeof render==="function"&&currentUser)render();
      `);
    } catch {
      // The engine reloads the saved schedule on its next render.
    }
    setStorageTick((value) => value + 1);
    return true;
  }, [notify]);

  const autoBuildWeek = useCallback(async (settings: BuildSettings = DEFAULT_BUILD) => {
    const actor = sessionUserRef.current;
    const scheduleItem = ITEMS.find((item) => item.id === "staff-schedule");
    const mayManage = Boolean(actor && scheduleItem && hasItemPermission(actor, scheduleItem, "manage"));
    if (!actor || !mayManage) {
      notify("Auto build needs the Manage permission on Weekly Schedule.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.users)) {
      notify("The staff directory is still loading.");
      return false;
    }
    if (!(await dialog.confirm("Rebuild this week's schedule using the current build rules? Days you have already set will be replaced."))) return false;
    const staff = (store.users as StaffUser[]).filter((user) => user.enabled !== false);
    const previous = (store.schedule || {}) as Record<string, Record<string, { code?: string }[]>>;
    store.schedule ||= {};

    // How each person is treated: fixed patterns first, then a fair rotation of
    // office days up to the requested number per person.
    const profileFor = (user: StaffUser) => {
      const text = `${user.department || ""} ${user.role || ""}`;
      if (/construction|site/i.test(text)) return "site";
      if (/business development|sales/i.test(text)) return "sales";
      return "office";
    };
    // Days a person is locked out of the office, taken from their existing week.
    const lockedDays = (user: StaffUser) => {
      const locked = new Set<string>();
      if (!settings.respectConstraints) return locked;
      OFFICE_WEEK.forEach((day) => {
        const code = (previous[user.id]?.[day] || [])
          .map((entry) => String(entry.code || "").toUpperCase()).find(Boolean);
        if (code === "GOV" || code === "STB") locked.add(day);
      });
      return locked;
    };

    const openDays = DEFAULT_OPEN_DAYS;
    const perDay: Record<string, number> = Object.fromEntries(OFFICE_WEEK.map((day) => [day, 0]));
    const assigned: Record<string, Record<string, string>> = {};

    staff.forEach((user, userIndex) => {
      assigned[user.id] = {};
      const profile = profileFor(user);
      const locked = lockedDays(user);
      let officeDays = 0;
      openDays.forEach((day, dayIndex) => {
        if (locked.has(day)) {
          const keep = (previous[user.id]?.[day] || [])
            .map((entry) => String(entry.code || "").toUpperCase()).find(Boolean) || "OFF";
          assigned[user.id][day] = keep;
          return;
        }
        if (settings.teamMeetingDay && day === settings.teamMeetingDay) {
          assigned[user.id][day] = profile === "site" ? "SITE" : "MON";
          perDay[day] += 1; officeDays += 1;
          return;
        }
        if (profile === "site") { assigned[user.id][day] = "SITE"; perDay[day] += 1; return; }
        if (profile === "sales") { assigned[user.id][day] = "USA"; return; }
        const needsMore = officeDays < settings.officeDaysPerPerson;
        const roomToday = perDay[day] < settings.targetInOffice;
        // Rotate the starting slot so the same people are not always in together.
        const wantsToday = (userIndex + dayIndex) % Math.max(1, openDays.length) < settings.officeDaysPerPerson;
        if (needsMore && roomToday && wantsToday) {
          assigned[user.id][day] = ["M", "MID", "E"][(userIndex + dayIndex) % 3];
          perDay[day] += 1; officeDays += 1;
        } else {
          assigned[user.id][day] = "WFH";
        }
      });
      // Days outside the open week default to rest unless already locked.
      OFFICE_WEEK.filter((day) => !openDays.includes(day)).forEach((day) => {
        assigned[user.id][day] = assigned[user.id][day] || "OFF";
      });
    });

    // Top up any day that fell below the minimum by converting WFH to office.
    openDays.forEach((day) => {
      if (perDay[day] >= settings.minInOffice) return;
      for (const user of staff) {
        if (perDay[day] >= settings.minInOffice) break;
        if (assigned[user.id][day] !== "WFH") continue;
        assigned[user.id][day] = "MID";
        perDay[day] += 1;
      }
    });

    /* The meeting's hours are chosen alongside its day, so they are saved onto
       the MON shift itself before the roster is written. Everything downstream
       — the entries below, the legend, the palette chip, the drag-and-drop
       assignment — already reads the catalogue, so correcting it in one place
       keeps them all quoting the same time. Left empty, nothing is touched and
       whatever the office already runs stands. */
    const meetingStart = String(settings.teamMeetingStart || "").trim();
    const meetingEnd = String(settings.teamMeetingEnd || "").trim();
    if (settings.teamMeetingDay && meetingStart && meetingEnd) {
      const savedTypes: ShiftType[] = Array.isArray(store[SHIFT_TYPES_KEY]) ? store[SHIFT_TYPES_KEY] : [];
      const existing = savedTypes.find((row) => String(row?.code || "").toUpperCase() === "MON");
      store[SHIFT_TYPES_KEY] = [
        ...savedTypes.filter((row) => String(row?.code || "").toUpperCase() !== "MON"),
        {
          ...(existing || {}),
          code: "MON",
          label: existing?.label || SHIFT_CODES.MON.label,
          start: meetingStart,
          end: meetingEnd,
          time: `${meetingStart} – ${meetingEnd}`,
          tone: existing?.tone || SHIFT_CODES.MON.tone,
        },
      ];
    }

    staff.forEach((user, userIndex) => {
      store.schedule[user.id] ||= {};
      OFFICE_WEEK.forEach((day, dayIndex) => {
        const code = assigned[user.id][day] || "OFF";
        const times = shiftTimesFor(code, store);
        store.schedule[user.id][day] = code === "OFF" ? [] : [{
          code, name: shiftCatalogue(store)[code]?.label || code,
          start: times[0], end: times[1], instance: `i${Date.now()}_${userIndex}_${dayIndex}`,
        }];
      });
    });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    try {
      staffRef.current?.contentWindow?.eval(`
        state=JSON.parse(localStorage.getItem("larsaStaffV8"));
        if(typeof render==="function"&&currentUser)render();
      `);
    } catch {
      // The engine reloads the saved schedule on its next render.
    }
    setStorageTick((value) => value + 1);
    raiseNotification({
      event: "schedule.changed",
      title: "Weekly schedule rebuilt",
      body: `${actor.name} rebuilt this week's schedule. Check your shifts.`,
      itemId: "week-schedule", fromName: actor.name,
      recipients: staff.filter((person) => person.id !== actor.id),
    });
    notify(`Week rebuilt: ${settings.officeDaysPerPerson} office days per person, ${settings.targetInOffice} in daily.`);
    return true;
  }, [notify]);

  const saveShiftColours = useCallback((colours: Record<string, string>) => {
    const store = parseStore("larsaStaffV8");
    if (!store) return false;
    store.shiftColours = colours;
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    setStorageTick((value) => value + 1);
    return true;
  }, []);

  const submitRequest = useCallback((draft: {
    type: string; requestType: string; from: string; to: string; reason: string;
  }) => {
    const actor = sessionUserRef.current;
    if (!actor) return false;
    const store = parseStore("larsaStaffV8");
    if (!store) { notify("Requests are still loading. Please try again."); return false; }
    if (!draft.from || !draft.to) { notify("Choose a start and end date."); return false; }
    if (draft.to < draft.from) { notify("The end date cannot be before the start date."); return false; }
    if (!Array.isArray(store.approvals)) store.approvals = [];
    // Route to the configured approvers, falling back to this person's manager.
    const flowConfig = (store.flowConfig || {}) as Record<string, Record<string, string[]>>;
    const configured = flowConfig[actor.id]?.[draft.type];
    const managerId = (store.users as StaffUser[])
      .find((row) => row.name && actor.manager && row.name.toLowerCase() === actor.manager.toLowerCase())?.id;
    const flow = configured?.length ? configured : [managerId || "u1"];
    const record: LeaveRequest = {
      id: `r${Date.now()}`,
      type: draft.type,
      uid: actor.id,
      requestType: draft.requestType,
      date: draft.from,
      from: draft.from,
      to: draft.to,
      reason: draft.reason.trim() || `${draft.type} request`,
      status: "Pending",
      flow,
      step: 0,
      history: [],
      createdAt: new Date().toISOString(),
    };
    store.approvals.unshift(record);
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    /* Only the approver it is actually WITH is told — the first step of the
       chain. Telling everybody in the chain at once meant the second and third
       approvers were asked to act on something that was not theirs yet, and
       they cannot act on it: decideRequest refuses anyone but the current
       holder. Each later approver is notified by decideRequest at the moment
       the request reaches them. */
    const approvers = (store.users as StaffUser[]).filter((row) => row.id === flow[0]);
    raiseNotification({
      event: "leave.requested",
      title: `${draft.type} request from ${actor.name}`,
      body: `${draft.requestType} · ${draft.from} to ${draft.to} · ${requestDays(record)} day(s)`,
      itemId: "my-requests", fromName: actor.name, recipients: approvers,
    });
    setStorageTick((value) => value + 1);
    notify(`${draft.type} request submitted for approval.`);
    return true;
  }, [notify]);

  /* Attendance corrections: a forgotten clock in/out, an unrecorded break, or
     hours worked that the clock never captured. These deliberately do NOT write
     attendance directly -- they raise a request on the person's normal approval
     chain, and only a full approval turns them into real records. */
  const submitCorrection = useCallback((draft: {
    kind: "Missed Clock" | "Missed Break" | "Extra Hours";
    date: string; from: string; to: string; reason: string; mode: string;
  }) => {
    const actor = sessionUserRef.current;
    if (!actor) return false;
    const store = parseStore("larsaStaffV8");
    if (!store) { notify("Requests are still loading. Please try again."); return false; }
    if (!draft.date || !draft.from || !draft.to) { notify("Enter the date and both times."); return false; }
    if (draft.to <= draft.from) { notify("The end time has to be after the start time."); return false; }
    if (!draft.reason.trim()) { notify("Add a short reason — your approver needs the context."); return false; }
    if (!Array.isArray(store.approvals)) store.approvals = [];
    /* Attendance corrections do NOT walk an approval chain either. A wrong
       clock-in is a records question: it goes straight to the reviewers —
       anyone GRANTED approve access on Leave & Requests — and one decision
       settles and materialises it. Same single-step path as late points. */
    const approvalsGate = ITEMS.find((item) => item.id === "staff-approvals");
    const approvers = (store.users as StaffUser[]).filter((row) =>
      row.enabled !== false && row.id !== actor.id && approvalsGate && hasItemPermission(row, approvalsGate, "approve"));
    const record: LeaveRequest = {
      id: `r${Date.now()}`,
      type: draft.kind,
      uid: actor.id,
      requestType: draft.mode,
      date: draft.date,
      from: draft.from,
      to: draft.to,
      reason: draft.reason.trim(),
      status: "Pending",
      flow: [],
      step: 0,
      history: [],
      createdAt: new Date().toISOString(),
    };
    store.approvals.unshift(record);
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    raiseNotification({
      event: "clock.correction",
      title: `${draft.kind} correction from ${actor.name}`,
      body: `${draft.date} · ${draft.from}–${draft.to} · ${draft.reason.trim()}`,
      itemId: "my-requests", fromName: actor.name, recipients: approvers,
    });
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Correction request submitted for approval.");
    return true;
  // raiseNotification is a module-level function, so it is not a dependency.
  }, [notify, refreshStaffEngine]);

  /* Closing a performance week. Same permission as setting weekly targets --
     whoever owns the numbers owns when they stop moving. Locking is a manual
     act every Saturday, never a scheduled one, so this is only ever reached
     from a button somebody pressed. */
  const setWeekLock = useCallback((week: string, locked: boolean, note = "") => {
    const actor = sessionUserRef.current;
    const mayManage = Boolean(
      actor
      && (
        hasItemPermission(actor, PERFORMANCE_TARGETS_ITEM, "manage")
        || hasItemPermission(actor, PERFORMANCE_CENTER_ITEM, "manage")
      ),
    );
    if (!actor || !mayManage) {
      notify("Your account cannot lock or unlock a performance week.");
      return false;
    }
    if (!week) { notify("Choose a week first."); return false; }
    const store = parseStore("larsaStaffV8");
    if (!store) { notify("Performance records are still loading. Please try again."); return false; }
    const locks = weekLocks(store);
    if (locked) {
      locks[week] = { week, lockedBy: actor.name, lockedAt: new Date().toISOString(), note: note.trim() };
    } else {
      delete locks[week];
    }
    store.weekLocks = locks;
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    const people = (store.users as StaffUser[] || []).filter((row) => row.enabled !== false && row.id !== actor.id);
    raiseNotification({
      event: "points.week",
      title: locked ? `Performance week ${week} is closed` : `Performance week ${week} reopened`,
      body: locked
        ? `${actor.name} locked ${week}. Anything still to add for that week now goes to your approver with its details.${note.trim() ? ` · ${note.trim()}` : ""}`
        : `${actor.name} reopened ${week}. You can add points to it again.`,
      itemId: "my-points", fromName: actor.name, recipients: people,
    });
    setStorageTick((value) => value + 1);
    notify(locked
      ? `Week ${week} is locked. Points can no longer be added to it without approval.`
      : `Week ${week} is open again.`);
    return true;
  // raiseNotification is a module-level function, so it is not a dependency.
  }, [notify, refreshStaffEngine]);



  const decideRequest = useCallback((requestId: string, status: "Approved" | "Rejected", note = "") => {
    const actor = sessionUserRef.current;
    const approvalsItem = ITEMS.find((item) => item.id === "staff-approvals");
    if (!actor || !approvalsItem || !hasItemPermission(actor, approvalsItem, "approve")) {
      notify("Your account cannot approve requests.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.approvals)) { notify("Requests are still loading."); return false; }
    const index = store.approvals.findIndex((row: LeaveRequest) => row.id === requestId);
    if (index < 0) { notify("That request could not be found."); return false; }
    const record = store.approvals[index] as LeaveRequest;

    /* The approval chain, finally enforced. It has been recorded on every
       request since flows were added -- flow is the ordered list of approver
       ids, step is where the request has got to -- and then ignored: any one
       person holding the approve permission could resolve anything, which
       made a two-stage chain decorative. A configured chain is a statement
       about who decides, and it has to mean that.

       A request with no chain keeps the previous behaviour. Older records and
       anything created before flows existed have no flow, and turning this on
       must not freeze what is already in flight. */
    const flow = Array.isArray(record.flow) ? record.flow.filter(Boolean) : [];
    const { holder: waitingOn, step } = requestStage(record);
    /* A chain with somebody who has left the company in it would otherwise
       block for ever, so a Super Admin can still act -- but it is recorded as
       an override in the history rather than passed off as a normal decision,
       because somebody reading that trail later needs to see it happened. */
    const overriding = Boolean(waitingOn && waitingOn !== actor.id);
    if (overriding && !isAdmin(actor)) {
      const holder = (store.users as StaffUser[]).find((row) => row.id === waitingOn);
      notify(holder
        ? `This request is with ${holder.name} at the moment.`
        : "This request is with another approver at the moment.");
      return false;
    }

    /* Approving at a step that is not the last advances the request instead of
       closing it. Rejecting ends it wherever it stands -- a chain is a series
       of people who must all agree, so any one of them can stop it. */
    const advancing = status === "Approved" && flow.length > step + 1;
    const settled: "Approved" | "Rejected" | "Pending" = advancing ? "Pending" : status;
    const stamp = new Date().toISOString();
    store.approvals[index] = {
      ...record,
      status: settled,
      step: advancing ? step + 1 : step,
      /* Only a final decision names a decider. While a request is still moving
         through the chain, "decided by" would be a lie on the employee's copy. */
      ...(advancing ? {} : { decidedBy: actor.name, decidedAt: stamp }),
      history: [...(record.history || []), {
        by: actor.name,
        action: advancing ? `Approved (step ${step + 1} of ${flow.length})` : status,
        at: stamp,
        note: overriding ? `${note ? `${note} · ` : ""}Decided by an administrator out of turn` : note,
      }],
    };

    /* An approved attendance correction is what actually writes the missing
       records. Guarded on `materialised` so re-approving can never double-count,
       and breaks keep their own status values so they stay out of hour totals. */
    const CORRECTIONS = ["Missed Clock", "Missed Break", "Extra Hours"];
    const updated = store.approvals[index] as LeaveRequest & { materialised?: boolean };
    if (settled === "Approved" && CORRECTIONS.includes(String(record.type)) && !updated.materialised) {
      if (!Array.isArray(store.logs)) store.logs = [];
      const at = (time?: string) => new Date(`${record.date}T${time || "00:00"}:00`).toISOString();
      const stamp = `Approved correction (${record.type}) · ${record.reason || ""}`;
      const isBreak = record.type === "Missed Break";
      const kind = isBreak ? "Break" : (record.requestType || "Office");
      const pair: [string, string | undefined][] = isBreak
        ? [["Break Start", record.from], ["Break End", record.to]]
        : [["In", record.from], ["Out", record.to]];
      pair.forEach(([state, time], position) => {
        (store.logs as ClockLog[]).push({
          id: `l${Date.now()}${position}`, uid: record.uid, type: kind, status: state,
          time: at(time), lastSeen: at(time), note: stamp,
        });
      });
      updated.materialised = true;
    }

    /* Approving is what actually writes the entry into the closed week. It lands
       as Submitted, not Approved: this decision was whether it may enter a week
       that was already closed, which is a different question from what the work
       is worth. The points still go through the normal review, which is also
       where Approved Points is set. Guarded on `materialised` so re-approving
       can never enter it twice. */
    if (settled === "Approved" && record.type === "Points Unlock" && record.entry && !updated.materialised) {
      if (!Array.isArray(store.performance)) store.performance = [];
      (store.performance as PerformanceRow[]).unshift({
        ...record.entry,
        Status: "Submitted",
        "Late Entry": "Yes",
        "Late Reason": record.reason || "",
        "Allowed By": actor.name,
        "Allowed At": new Date().toISOString(),
      });
      updated.materialised = true;
    }

    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    const employee = (store.users as StaffUser[]).find((row) => row.id === record.uid);
    /* Still moving: the person who has to act next is the one who needs to
       hear about it. Telling the employee their request was "approved" here
       would be wrong twice over -- it is not approved, and there is nothing
       for them to do. */
    if (advancing) {
      const next = (store.users as StaffUser[]).find((row) => row.id === flow[step + 1]);
      if (next) {
        raiseNotification({
          event: "leave.raised",
          title: `${record.type} request needs your decision`,
          body: `${employee?.name || "An employee"} · ${record.requestType || record.type} · ${record.from} to ${record.to}. Approved by ${actor.name} at step ${step + 1} of ${flow.length}.`,
          itemId: "my-requests",
          fromName: actor.name, recipients: [next],
        });
      }
    } else if (employee) {
      const isUnlock = record.type === "Points Unlock";
      raiseNotification({
        event: "leave.decided",
        title: isUnlock
          ? `Late entry for week ${record.week} ${settled.toLowerCase()}`
          : `${record.type} request ${settled.toLowerCase()}`,
        body: isUnlock
          ? (settled === "Approved"
            ? `${actor.name} let your ${record.entry?.["Job Number"] || record.entry?.Project || "entry"} into closed week ${record.week}. It now waits for the normal points review.${note ? ` · ${note}` : ""}`
            : `${actor.name} did not accept your late entry for week ${record.week}.${note ? ` · ${note}` : ""}`)
          : `${actor.name} ${settled.toLowerCase()} your ${record.from} to ${record.to} request${note ? ` · ${note}` : ""}`,
        itemId: isUnlock && settled === "Approved" ? "my-points" : "my-requests",
        fromName: actor.name, recipients: [employee],
      });
    }
    setStorageTick((value) => value + 1);
    notify(advancing
      ? `Approved. This request now goes to step ${step + 2} of ${flow.length}.`
      : `Request ${settled.toLowerCase()}.`);
    return true;
  // raiseNotification is a module-level function, so it is not a dependency.
  }, [notify, refreshStaffEngine]);

  const saveGrowthStore = useCallback((next: GrowthStore) => {
    localStorage.setItem(GROWTH_STORE_KEY, JSON.stringify(next));
    setGrowthStore(next);
    setStorageTick((value) => value + 1);
  }, []);

  const saveWeeklyTarget = (userId: string, target: number) => {
    const actor = sessionUserRef.current;
    const mayManage = Boolean(
      actor
      && (
        hasItemPermission(actor, PERFORMANCE_TARGETS_ITEM, "manage")
        || hasItemPermission(actor, PERFORMANCE_CENTER_ITEM, "manage")
      ),
    );
    const allowedUser = actor && scopedUsers(actor, accessUsers).some((user) => user.id === userId);
    if (!actor || !mayManage || !allowedUser) {
      notify("Your account cannot change this employee's weekly target.");
      return false;
    }
    const normalizedTarget = Math.max(1, Math.round(finiteNumber(target)));
    saveGrowthStore({
      ...growthStore,
      pointTargets: { ...growthStore.pointTargets, [userId]: normalizedTarget },
    });
    notify(`Weekly target updated to ${normalizedTarget} points.`);
    return true;
  };

  const reviewPerformanceRow = (
    rowId: string,
    status: "Approved" | "Returned",
    approvedPoints?: number,
  ) => {
    const actor = sessionUserRef.current;
    if (!actor || !hasItemPermission(actor, PERFORMANCE_REVIEW_ITEM, "approve")) {
      notify("Your account cannot review performance points.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.performance)) {
      notify("Performance records are still loading.");
      return false;
    }
    const index = store.performance.findIndex((row: PerformanceRow) => row.id === rowId);
    if (index < 0) {
      notify("That performance record could not be found.");
      return false;
    }
    const row = store.performance[index] as PerformanceRow;
    const employeeId = rowUserId(row, accessUsers);
    if (!scopedUsers(actor, accessUsers).some((user) => user.id === employeeId)) {
      notify("That employee is outside your data scope.");
      return false;
    }
    store.performance[index] = {
      ...row,
      Status: status,
      "Approved Points": status === "Approved"
        ? Math.max(0, finiteNumber(approvedPoints ?? row["Submitted Points"]))
        : 0,
      "Reviewed By": actor.name,
      "Reviewed At": new Date().toISOString(),
    };
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    try {
      staffRef.current?.contentWindow?.eval(`
        state=JSON.parse(localStorage.getItem("larsaStaffV8"));
        if(typeof render==="function"&&currentUser)render();
      `);
    } catch {
      // The native report already uses the saved record.
    }
    setStorageTick((value) => value + 1);
    const employee = accessUsers.find((user) => user.id === employeeId);
    if (employee) {
      raiseNotification({
        event: "points.reviewed",
        title: status === "Approved" ? "Points approved" : "Points returned",
        body: `${actor.name} ${status === "Approved" ? "approved" : "returned"} your entry for ${row["Job Number"] || row.Project || "a job"}`,
        itemId: "performance-center", fromName: actor.name, recipients: [employee],
      });
    }
    notify(status === "Approved" ? "Performance points approved." : "Performance entry returned for revision.");
    return true;
  };

  const createDevelopment = (draft: DevelopmentDraft) => {
    const actor = sessionUserRef.current;
    if (!actor || !hasItemPermission(actor, DEVELOPMENT_ITEM, "add")) {
      notify("Your account cannot assign development activities.");
      return false;
    }
    const employee = scopedUsers(actor, accessUsers).find((user) => user.id === draft.employeeId);
    if (!employee) {
      notify("That employee is outside your data scope.");
      return false;
    }
    const now = new Date().toISOString();
    const record: DevelopmentRecord = {
      id: `dev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      employeeId: employee.id,
      employeeName: employee.name,
      title: draft.title.trim(),
      activityType: draft.activityType,
      skill: draft.skill.trim(),
      month: draft.month,
      dueDate: draft.dueDate,
      targetHours: Math.max(0, finiteNumber(draft.targetHours)),
      targetPresentations: Math.max(0, Math.round(finiteNumber(draft.targetPresentations))),
      completedHours: 0,
      completedPresentations: 0,
      assignedById: actor.id,
      assignedByName: actor.name,
      status: "Assigned",
      notes: draft.notes.trim(),
      evidenceUrl: "",
      createdAt: now,
      updatedAt: now,
      history: [{
        at: now,
        byId: actor.id,
        byName: actor.name,
        action: "Activity assigned",
        note: draft.notes.trim(),
      }],
    };
    saveGrowthStore({ ...growthStore, development: [record, ...growthStore.development] });
    raiseNotification({
      event: "development.assigned",
      title: "New development activity",
      body: `${actor.name} assigned "${record.title}" · due ${record.dueDate || record.month}`,
      itemId: "staff-development", fromName: actor.name, recipients: [employee],
    });
    setStorageTick((value) => value + 1);
    notify(`Development activity assigned to ${employee.name}.`);
    return true;
  };

  const updateDevelopment = (
    recordId: string,
    patch: Partial<Pick<DevelopmentRecord,
      "completedHours" | "completedPresentations" | "evidenceUrl" | "notes" | "status">>,
    action = "Progress updated",
    note = "",
  ) => {
    const actor = sessionUserRef.current;
    const current = growthStore.development.find((record) => record.id === recordId);
    if (!actor || !current || !hasItemPermission(actor, DEVELOPMENT_ITEM, "edit")) {
      notify("Your account cannot update this development record.");
      return false;
    }
    const visibleEmployee = scopedUsers(actor, accessUsers)
      .some((user) => user.id === current.employeeId);
    if (!visibleEmployee) {
      notify("That employee is outside your data scope.");
      return false;
    }
    const now = new Date().toISOString();
    const nextRecord: DevelopmentRecord = {
      ...current,
      ...patch,
      completedHours: patch.completedHours === undefined
        ? current.completedHours
        : Math.max(0, finiteNumber(patch.completedHours)),
      completedPresentations: patch.completedPresentations === undefined
        ? current.completedPresentations
        : Math.max(0, Math.round(finiteNumber(patch.completedPresentations))),
      updatedAt: now,
      history: [{
        at: now,
        byId: actor.id,
        byName: actor.name,
        action,
        note,
      }, ...current.history],
    };
    saveGrowthStore({
      ...growthStore,
      development: growthStore.development.map((record) =>
        record.id === recordId ? nextRecord : record),
    });
    notify(action === "Submitted for review" ? "Activity submitted to your reviewer." : "Development progress saved.");
    return true;
  };

  const reviewDevelopment = (
    recordId: string,
    status: "Approved" | "Returned",
    note = "",
  ) => {
    const actor = sessionUserRef.current;
    const current = growthStore.development.find((record) => record.id === recordId);
    if (!actor || !current || !hasItemPermission(actor, DEVELOPMENT_ITEM, "approve")) {
      notify("Your account cannot review development activities.");
      return false;
    }
    if (!scopedUsers(actor, accessUsers).some((user) => user.id === current.employeeId)) {
      notify("That employee is outside your data scope.");
      return false;
    }
    const now = new Date().toISOString();
    const nextRecord: DevelopmentRecord = {
      ...current,
      status,
      updatedAt: now,
      history: [{
        at: now,
        byId: actor.id,
        byName: actor.name,
        action: status === "Approved" ? "Activity approved" : "Activity returned",
        note,
      }, ...current.history],
    };
    saveGrowthStore({
      ...growthStore,
      development: growthStore.development.map((record) =>
        record.id === recordId ? nextRecord : record),
    });
    const employee = accessUsers.find((user) => user.id === current.employeeId);
    if (employee) {
      raiseNotification({
        event: "development.reviewed",
        title: status === "Approved" ? "Development approved" : "Development returned",
        body: `${actor.name} ${status === "Approved" ? "approved" : "returned"} "${current.title}"${note ? ` · ${note}` : ""}`,
        itemId: "staff-development", fromName: actor.name, recipients: [employee],
      });
    }
    setStorageTick((value) => value + 1);
    notify(status === "Approved" ? "Development activity approved." : "Development activity returned with feedback.");
    return true;
  };

  const deleteDevelopment = async (recordId: string) => {
    const actor = sessionUserRef.current;
    const current = growthStore.development.find((record) => record.id === recordId);
    if (!actor || !current || !hasItemPermission(actor, DEVELOPMENT_ITEM, "delete")) {
      notify("Your account cannot delete this development activity.");
      return false;
    }
    if (!scopedUsers(actor, accessUsers).some((user) => user.id === current.employeeId)) {
      notify("That employee is outside your data scope.");
      return false;
    }
    if (!(await dialog.confirm(`Delete "${current.title}" for ${current.employeeName}?`))) return false;
    saveGrowthStore({
      ...growthStore,
      development: growthStore.development.filter((record) => record.id !== recordId),
    });
    notify("Development activity deleted.");
    return true;
  };

  const updateAccountingProject = (
    projectId: string,
    patch: Partial<Pick<AccountingProject, "progress" | "status" | "phase">>,
  ) => {
    const actor = sessionUserRef.current;
    if (!actor || !hasItemPermission(actor, PROJECT_PORTAL_ITEM, "edit")) {
      notify("Your account cannot update project progress.");
      return false;
    }
    const snapshot = readAccountingSnapshot();
    if (!snapshot.key || !visibleProjectIds(actor, snapshot.projects).has(projectId)) {
      notify("That project is outside your assigned access.");
      return false;
    }
    const store = parseStore(snapshot.key);
    if (!store || !Array.isArray(store.projects)) {
      notify("Project records are still loading.");
      return false;
    }
    const index = store.projects.findIndex((project: AccountingProject) => project.id === projectId);
    if (index < 0) {
      notify("That project could not be found.");
      return false;
    }
    store.projects[index] = {
      ...store.projects[index],
      ...patch,
      progress: patch.progress === undefined
        ? finiteNumber(store.projects[index].progress)
        : Math.max(0, Math.min(100, finiteNumber(patch.progress))),
    };
    localStorage.setItem(snapshot.key, JSON.stringify(store));
    try {
      accountingRef.current?.contentWindow?.eval(`
        state=JSON.parse(localStorage.getItem(${JSON.stringify(snapshot.key)}));
        if(typeof render==="function")render();
      `);
    } catch {
      // The native project portal already uses the saved project.
    }
    /* The portal's progress slider is the schedule information that already
       exists in Larsa Control — reuse it: every change is also appended to
       the permanent accounting progress history (acct_progress_updates), so
       the accounting engine, the client-facing summary, and this portal all
       report the same number with full history. Best-effort: a sync hiccup
       never blocks the local save. */
    if (patch.progress !== undefined && supabaseConfigured()) {
      const client = getSupabaseClient();
      if (client) {
        client.rpc("acct_record_progress", {
          actor: {
            email: actor.email || `${actor.username || actor.id}@larsaeng.com`,
            name: actor.name,
            role: accountingRole(actor),
          },
          p_project_id: projectId,
          p_percent: Math.max(0, Math.min(100, finiteNumber(patch.progress))),
          p_date: new Date().toISOString().slice(0, 10),
          p_note: "Updated from the Project Portal",
        }).then(() => {}, () => { /* history sync retries on the next update */ });
      }
    }
    setStorageTick((value) => value + 1);
    const project = snapshot.projects.find((row) => row.id === projectId);
    raiseNotification({
      event: "project.updated",
      title: "Project updated",
      body: `${actor.name} updated ${project?.name || "a project"}${patch.progress === undefined ? "" : ` to ${Math.round(finiteNumber(patch.progress))}%`}`,
      itemId: "project-portal", fromName: actor.name,
      recipients: accessUsers.filter((person) =>
        person.id !== actor.id && visibleProjectIds(person, snapshot.projects).has(projectId)),
    });
    notify("Project progress updated.");
    return true;
  };

  const saveAccessUser = (nextUser: StaffUser, isNew: boolean) => {
    const actor = sessionUserRef.current;
    const requiredAction: PermissionAction = isNew ? "add" : "edit";
    if (!actor || !hasItemPermission(actor, ACCESS_ITEM, requiredAction)) {
      notify(`Your account cannot ${isNew ? "add users" : "edit user access"}.`);
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.users)) {
      notify("The staff directory is still loading. Please try again.");
      return false;
    }
    const existingRecord = store.users.find((row: StaffUser) => row.id === nextUser.id) as StaffUser | undefined;
    /* ---- Role hierarchy: Developer → Super Admin → Admin → everyone ----
       The Developer is the platform owner, identified by platform_admins
       membership resolved SERVER-SIDE at sign-in (never by display name),
       and their own row is additionally locked by the database trigger.
       Only the Developer touches the Super Admin tier; only the Developer
       or a Super Admin touches the Admin tier or Accounting access; and
       nobody — whatever their tier — changes their own role. */
    const actorIsDeveloper = actor.platformAdmin === true;
    const actorIsSuperAdmin = actor.access === "Super Admin";
    const previousAccess = existingRecord?.access || "";
    const nextAccess = nextUser.access || "";
    if (!isNew && existingRecord && actor.id === existingRecord.id
      && previousAccess !== nextAccess && previousAccess !== "Super Admin") {
      notify("You cannot change your own role. Another authorized administrator has to do it.");
      return false;
    }
    if ((nextAccess === "Super Admin") !== (previousAccess === "Super Admin")) {
      if (!actorIsDeveloper) {
        notify("Only the Developer can create or remove Super Admins.");
        return false;
      }
      /* Even the Developer cannot do it FROM THE APP: the database's account
         guard (app_state_guard_super_admin) refuses any app write that mints
         or alters a Super Admin — a deliberate, unbypassable hardening.
         Without this refusal the save used to sit in localStorage, every
         push from this browser was rejected by that guard, and every OTHER
         edit made here quietly reverted on the next pull — the "my role and
         name changes keep undoing themselves" report. Saying no honestly
         here keeps this device healthy; Super Admin changes are a
         server-side act by the platform owner. */
      notify("Super Admin cannot be granted or removed from the app — the database's account guard refuses that write. Every other role saves normally; changing the Super Admin tier is a server-side step.");
      return false;
    }
    if ((nextAccess === "Admin") !== (previousAccess === "Admin") && !actorIsDeveloper && !actorIsSuperAdmin) {
      notify("Only the Developer or a Super Admin can grant or remove the Admin role.");
      return false;
    }
    /* Accounting access is the strictest module: an Admin cannot grant,
       remove, or modify it — and the true financial permissions are ALSO
       enforced server-side (acct_set_permissions requires the platform
       owner plus a fresh emailed code), so a forged request cannot get
       around this either. */
    const accountingGrantsOf = (profile?: PermissionProfile) => JSON.stringify(
      Object.entries(profile?.grants || {})
        .filter(([itemId]) => itemId === "accounting-hub" || itemId.startsWith("acc-"))
        .sort(([left], [right]) => left.localeCompare(right)));
    const accountingWas = existingRecord?.accountingAccess === true;
    const accountingNow = nextUser.accountingAccess === true;
    if (!actorIsDeveloper && !actorIsSuperAdmin
      && (accountingGrantsOf(existingRecord?.permissionProfile) !== accountingGrantsOf(nextUser.permissionProfile)
        || accountingWas !== accountingNow)) {
      notify("Only the Developer or a Super Admin can change Accounting access.");
      return false;
    }
    /* This function is only reachable at all with "add"/"edit" on Users &
       Access, i.e. by an admin or someone explicitly authorised to manage
       staff -- an ordinary employee has no path here for anyone but
       themselves. That standing authority already vouches for the address,
       whether it is a brand-new account or an existing one getting a new
       email, so the email-code step (which exists to stop a self-service
       change nobody vetted) does not apply to it: the account is created, or
       the address updated, already verified. */
    const nextEmail = nextUser.email?.trim().toLowerCase() || "";
    const prepared: StaffUser = {
      ...nextUser,
      username: nextUser.username || nextUser.email?.split("@")[0] || "",
      projectAccessMode: nextUser.access === "Super Admin"
        ? "all"
        : nextUser.projectAccessMode || projectAccessForPreset(nextUser.access || "Engineer"),
      projectIds: nextUser.access === "Super Admin" ? [] : nextUser.projectIds || [],
      permissions: staffPermissionsForUser(nextUser),
      emailVerified: nextEmail ? true : undefined,
      /* Who was let into Accounting, when, and by whom — carried on the record
         itself as well as in the audit trail, so the answer is visible in the
         same place the switch is. */
      accountingAccess: accountingNow || undefined,
      accountingAccessAt: accountingNow === accountingWas
        ? existingRecord?.accountingAccessAt
        : new Date().toISOString(),
      accountingAccessBy: accountingNow === accountingWas
        ? existingRecord?.accountingAccessBy
        : (actor.name || actor.email || actor.id),
      /* Recency-of-edit stamp, in server time: the merge and the push guard
         use it so a stale wholesale write-back (a long-open engine iframe
         saving its old in-memory copy) can never drag this record backwards.
         This is what makes a role or name change actually STICK. */
      touchedAt: serverNowIso(),
    };
    const existingIndex = store.users.findIndex((row: StaffUser) => row.id === prepared.id);
    if (isNew) {
      if (existingIndex >= 0) {
        notify("This user already exists.");
        return false;
      }
      store.users.push(prepared);
      store.schedule ||= {};
      store.schedule[prepared.id] ||= {};
      ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday"].forEach((day) => {
        store.schedule[prepared.id][day] ||= [];
      });
      store.flowConfig ||= {};
      store.flowConfig[prepared.id] ||= {
        Leave: ["u1"],
        Schedule: ["u1"],
        Performance: ["u1"],
      };
    } else if (existingIndex >= 0) {
      const existing = store.users[existingIndex] as StaffUser;
      if (existing.access === "Super Admin") {
        prepared.access = "Super Admin";
        prepared.permissionProfile = presetPermissionProfile("Super Admin");
        prepared.permissions = STAFF_PERMISSION_LIST;
        prepared.enabled = true;
        prepared.projectAccessMode = "all";
        prepared.projectIds = [];
      }
      /* A changed email is an identity migration, never a silent overwrite:
         both addresses, the moment, and who did it are kept on the record
         and in the audit trail. */
      const previousEmail = (existing.email || "").trim().toLowerCase();
      if (previousEmail && nextEmail && previousEmail !== nextEmail) {
        prepared.emailHistory = [
          ...(existing.emailHistory || []),
          { from: previousEmail, to: nextEmail, at: new Date().toISOString(), by: actor.name },
        ];
        logAccountEvent(actor, "account.email_changed", existing.id, existing.name, { from: previousEmail, to: nextEmail });
      }
      if ((existing.historyMode || "all") !== (prepared.historyMode || "all")
        || (existing.historyFrom || "") !== (prepared.historyFrom || "")) {
        logAccountEvent(actor, "account.history_mode_changed", existing.id, existing.name, {
          from: { mode: existing.historyMode || "all", historyFrom: existing.historyFrom || null },
          to: { mode: prepared.historyMode || "all", historyFrom: prepared.historyFrom || null },
        });
      }
      /* Every role move is audited with who did it and both values. */
      if ((existing.access || "") !== (prepared.access || "")) {
        logAccountEvent(actor, "account.role_changed", existing.id, existing.name, {
          from: existing.access || "(none)", to: prepared.access || "(none)",
        });
      }
      /* So is every opening and closing of the Accounting door. */
      if (accountingWas !== accountingNow) {
        logAccountEvent(actor, "account.accounting_access_changed", existing.id, existing.name, {
          from: accountingWas, to: accountingNow,
        });
      }
      store.users[existingIndex] = { ...existing, ...prepared };
    } else {
      notify("That user could not be found.");
      return false;
    }
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    /* A role or identity change must reach the server before this tab can
       close or a stale copy can race it — same urgency as a punch. */
    pushSyncedKeyNow("larsaStaffV8");
    try {
      staffRef.current?.contentWindow?.eval(`
        state=JSON.parse(localStorage.getItem("larsaStaffV8"));
        if(currentUser)currentUser=state.users.find(function(user){return user.id===currentUser.id})||currentUser;
        if(typeof render==="function"&&currentUser)render();
      `);
    } catch {
      // The saved directory will be picked up when the embedded module next renders.
    }
    if (sessionUserRef.current?.id === prepared.id) {
      const method = sessionMethodRef.current || "email";
      sessionUserRef.current = prepared;
      setSessionUser(prepared);
      persistSession(prepared, method, rememberRef.current);
      (Object.keys(refs) as Engine[]).forEach((engine) => applySessionToFrame(engine, prepared, method));
      if (!canOpenInSession(prepared, activeRef.current, method)) {
        setNavChannel("home");
        setActive(ITEMS.find((item) => item.id === "overview") || DEFAULT_ITEM);
      }
    }
    setStorageTick((value) => value + 1);
    notify(isNew ? "New user added with custom access." : "User access saved.");
    return true;
  };

  const deleteAccessUser = async (target: StaffUser) => {
    const actor = sessionUserRef.current;
    if (!actor || !hasItemPermission(actor, ACCESS_ITEM, "delete")) {
      notify("Your account cannot delete user accounts.");
      return false;
    }
    if (target.access === "Super Admin" || target.id === actor.id) {
      notify("The protected owner account cannot be deleted.");
      return false;
    }
    if (!(await dialog.confirm(`Offboard ${target.name}? They lose access immediately, all their history stays viewable, and the account can be restored any time from the Offboarded tab.`))) {
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.users)) {
      notify("The staff directory is still loading. Please try again.");
      return false;
    }
    const existingIndex = store.users.findIndex((row: StaffUser) => row.id === target.id);
    if (existingIndex < 0) {
      notify("That user could not be found.");
      return false;
    }
    /* Nothing is removed. The record stays where it is — schedule, approval
       flows, hashed secrets and every work record intact — so a restore puts
       the person back exactly as they were. Sign-in is blocked the same way a
       disabled account is blocked: enabled false, on every sign-in path. */
    store.users[existingIndex] = {
      ...(store.users[existingIndex] as StaffUser),
      offboarded: true,
      enabled: false,
      pendingApproval: false,
      offboardedAt: new Date().toISOString(),
      offboardedBy: actor.name,
      touchedAt: serverNowIso(),
    };
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    logAccountEvent(actor, "account.offboarded", target.id, target.name, { access: target.access || "" });
    try {
      staffRef.current?.contentWindow?.eval(`
        state=JSON.parse(localStorage.getItem("larsaStaffV8"));
        if(typeof render==="function"&&currentUser)render();
      `);
    } catch {
      // The saved directory will be picked up when the embedded module next renders.
    }
    setStorageTick((value) => value + 1);
    notify(`${target.name} was offboarded. Their history stays viewable, and you can restore the account any time.`);
    return true;
  };

  /* The way back: reactivation. The account returns with the same access,
     same secrets and same records; a NEW employment period begins, and the
     admin chooses how much history current reporting should include:
     everything, the new period only, or from a chosen date. No choice
     deletes anything — stored history is permanent; the mode only shapes
     what reports display, and it can be changed later in the editor. */
  const restoreAccessUser = async (target: StaffUser, historyMode?: "all" | "current" | "from", historyFrom?: string) => {
    const actor = sessionUserRef.current;
    if (!actor || !hasItemPermission(actor, ACCESS_ITEM, "edit")) {
      notify("Your account cannot restore user accounts.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.users)) {
      notify("The staff directory is still loading. Please try again.");
      return false;
    }
    const existingIndex = store.users.findIndex((row: StaffUser) => row.id === target.id);
    if (existingIndex < 0) {
      notify("That user could not be found.");
      return false;
    }
    const existing = store.users[existingIndex] as StaffUser;
    const nowIso = new Date().toISOString();
    /* Close the period that ended at offboarding (synthesizing period 1 for
       records that predate employment periods), then open the new one. */
    const periods = Array.isArray(existing.employmentPeriods) && existing.employmentPeriods.length
      ? existing.employmentPeriods.map((period) => ({ ...period }))
      : [{ start: "", end: existing.offboardedAt || nowIso }];
    const lastPeriod = periods[periods.length - 1];
    if (lastPeriod && !lastPeriod.end) lastPeriod.end = existing.offboardedAt || nowIso;
    periods.push({ start: nowIso });
    const mode: "all" | "current" | "from" = historyMode || "all";
    store.users[existingIndex] = {
      ...existing,
      offboarded: false,
      enabled: true,
      offboardedAt: undefined,
      offboardedBy: undefined,
      recycled: false,
      recycledAt: undefined,
      recycledBy: undefined,
      touchedAt: serverNowIso(),
      employmentPeriods: periods,
      historyMode: mode,
      historyFrom: mode === "from" ? (historyFrom || nowIso) : undefined,
    };
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    logAccountEvent(actor, "account.reactivated", target.id, target.name, {
      access: target.access || "", historyMode: mode, historyFrom: mode === "from" ? (historyFrom || nowIso) : null,
      periodStart: nowIso,
    });
    try {
      staffRef.current?.contentWindow?.eval(`
        state=JSON.parse(localStorage.getItem("larsaStaffV8"));
        if(typeof render==="function"&&currentUser)render();
      `);
    } catch {
      // The saved directory will be picked up when the embedded module next renders.
    }
    setStorageTick((value) => value + 1);
    notify(`${target.name} is back. Their access works exactly as before.`);
    return true;
  };

  /* Offboarded → Recycling Bin. A soft deletion: sign-in stays blocked, all
     history stays reviewable and restorable, and — this is the point — the
     normalized email becomes AVAILABLE again for a new Create Account. */
  const recycleAccessUser = async (target: StaffUser) => {
    const actor = sessionUserRef.current;
    if (!actor || !hasItemPermission(actor, ACCESS_ITEM, "delete")) {
      notify("Your account cannot move accounts to the Recycling Bin.");
      return false;
    }
    if (!(await dialog.confirm(`Move ${target.name} to the Recycling Bin? All their history stays stored and restorable, and their email address becomes available for a new account.`))) {
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.users)) { notify("The staff directory is still loading. Please try again."); return false; }
    const existingIndex = store.users.findIndex((row: StaffUser) => row.id === target.id);
    if (existingIndex < 0) { notify("That user could not be found."); return false; }
    store.users[existingIndex] = {
      ...(store.users[existingIndex] as StaffUser),
      recycled: true,
      offboarded: true,
      enabled: false,
      recycledAt: new Date().toISOString(),
      recycledBy: actor.name,
      touchedAt: serverNowIso(),
    };
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    logAccountEvent(actor, "account.recycled", target.id, target.name, { email: (target.email || "").trim().toLowerCase() });
    setStorageTick((value) => value + 1);
    notify(`${target.name} is in the Recycling Bin. Their email can now be used for a new account; their history stays stored.`);
    return true;
  };

  /* Recycling Bin → Offboarded. Refused when the email has since been reused
     by another live account: restoring must never overwrite the person now
     holding that address — the conflict is explained instead, and the admin
     resolves it deliberately (change one of the emails, or recycle the new
     account) before trying again. */
  const restoreFromRecycleBin = async (target: StaffUser) => {
    const actor = sessionUserRef.current;
    if (!actor || !hasItemPermission(actor, ACCESS_ITEM, "edit")) {
      notify("Your account cannot restore accounts from the Recycling Bin.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.users)) { notify("The staff directory is still loading. Please try again."); return false; }
    const email = (target.email || "").trim().toLowerCase();
    const holder = email
      ? (store.users as StaffUser[]).find((row) =>
          row.id !== target.id && row.recycled !== true && (row.email || "").trim().toLowerCase() === email)
      : undefined;
    if (holder) {
      await dialog.confirm(`${target.name} cannot be restored yet: ${email} is now used by ${holder.name}'s account. Change one of the two emails (or move ${holder.name}'s account to the Recycling Bin) first — nothing is ever overwritten automatically.`);
      return false;
    }
    const existingIndex = store.users.findIndex((row: StaffUser) => row.id === target.id);
    if (existingIndex < 0) { notify("That user could not be found."); return false; }
    store.users[existingIndex] = {
      ...(store.users[existingIndex] as StaffUser),
      recycled: false,
      recycledAt: undefined,
      recycledBy: undefined,
      offboarded: true,
      enabled: false,
      touchedAt: serverNowIso(),
    };
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    logAccountEvent(actor, "account.bin_restored", target.id, target.name, { email });
    setStorageTick((value) => value + 1);
    notify(`${target.name} is back in Offboarded. Reactivate the account to give them access again.`);
    return true;
  };

  /* Permanent deletion — a separate, Super-Admin-only act (Part 15). Even
     this keeps the business history: attendance stays in the immutable
     ledger and in the clock logs, and the audit trail records a snapshot of
     the deleted account. Only the sign-in record itself is removed. */
  const purgeAccessUser = async (target: StaffUser) => {
    const actor = sessionUserRef.current;
    if (!actor || actor.access !== "Super Admin") {
      notify("Only the Super Admin can permanently delete an account.");
      return false;
    }
    if (!(await dialog.confirm(`Permanently delete ${target.name}'s account? Their attendance history and audit records stay stored, but the account itself cannot be recovered after this.`))) {
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.users)) { notify("The staff directory is still loading. Please try again."); return false; }
    const existing = (store.users as StaffUser[]).find((row) => row.id === target.id);
    if (!existing) { notify("That user could not be found."); return false; }
    if (existing.access === "Super Admin") { notify("The protected owner account cannot be deleted."); return false; }
    /* The ONLY deliberate account removal in the app, so the only place a
       tombstone is written. The server-side tombstone lands FIRST, before the
       local save: the repair_008 healing trigger re-adds any account that
       leaves the shared document without server-side evidence of deliberate
       removal, so a save that raced ahead of its own tombstone would simply
       be healed back. If the tombstone cannot be recorded, the delete is
       refused rather than left half-done — the failure direction this app
       always chooses is "the account survives". */
    const recorded = supabaseConfigured()
      ? await tombstoneAccount(target.id, actor.email || actor.name || actor.id,
        `Permanently deleted by ${actor.name || actor.email || actor.id}`)
      : true;
    if (!recorded) {
      notify("The deletion could not be recorded on the server. Check the connection and try again — nothing was changed.");
      return false;
    }
    store.users = (store.users as StaffUser[]).filter((row) => row.id !== target.id);
    /* The local list stops THIS device restoring the account from the ledger
       before the tombstone has been observed. */
    markAccountsRemoved(store, [target.id]);
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    pushSyncedKeyNow("larsaStaffV8");
    logAccountEvent(actor, "account.permanent_delete", target.id, target.name, {
      snapshot: { id: existing.id, name: existing.name, email: (existing.email || "").trim().toLowerCase(), access: existing.access || "", offboardedAt: existing.offboardedAt || null, recycledAt: existing.recycledAt || null },
    });
    setStorageTick((value) => value + 1);
    notify(`${target.name}'s account was permanently deleted. Attendance and audit history remain stored.`);
    return true;
  };

  // Walks every work area and confirms its target actually resolves inside the
  // embedded engine. This is the fastest way to tell "no permission" apart from
  // "the page genuinely is not there".
  const runSystemCheck = useCallback((): CheckRow[] => {
    const viewer = sessionUserRef.current;
    const rows: CheckRow[] = [];
    ITEMS.forEach((item) => {
      if (item.id === "my-points" && sessionMethodRef.current !== "pin") return;
      const area = item.engine === "staff" ? "Timeclock & Performance"
        : item.engine === "hr" ? "HR & Skills"
        : item.engine === "accounting" ? "Accounting"
        : "Built in";
      if (!item.engine) {
        rows.push({
          id: item.id, label: item.label, area,
          state: viewer && canOpen(viewer, item) ? "ready" : "permission",
          note: viewer && canOpen(viewer, item) ? "Native screen" : "Not granted to this account",
        });
        return;
      }
      const frame = refs[item.engine].current;
      const doc = frame?.contentDocument;
      const win = frame?.contentWindow as (Window & { go?: unknown }) | null | undefined;
      if (!doc || !doc.body) {
        rows.push({ id: item.id, label: item.label, area, state: "loading", note: "Module has not finished loading" });
        return;
      }
      if (item.engine === "hr") {
        const ok = typeof win?.go === "function";
        rows.push({
          id: item.id, label: item.label, area,
          state: ok ? "ready" : "loading",
          note: ok ? "Reachable" : "HR module still starting",
        });
        return;
      }
      const selector = item.engine === "staff"
        ? `.nav button[data-page="${item.section}"]`
        : `.nav-item[data-sec="${item.section}"]`;
      const found = doc.querySelector(selector);
      const anyNav = doc.querySelectorAll(item.engine === "staff" ? ".nav button" : ".nav-item").length;
      rows.push({
        id: item.id, label: item.label, area,
        state: found ? "ready" : anyNav ? "permission" : "loading",
        note: found
          ? "Reachable"
          : anyNav
            ? "Hidden by this account's permissions in the module"
            : "Module navigation has not rendered yet",
      });
    });
    return rows;
  }, [refs]);

  /* Secrets never travel in a backup file. The file is plain JSON that gets
     mailed around and left in Downloads folders; a copy of every password
     hash — or worse, a not-yet-upgraded plaintext PIN — inside it turns
     "restore my data" into "here are the keys to every account". Restoring a
     credential-free user record is safe: verifySecret simply asks the person
     to reset, which is the correct outcome for a machine that lost state. */
  const SECRET_KEYS = new Set(["password", "pin", "pass", "passHash", "passSalt", "passIterations", "supabaseUrl", "supabaseAnonKey", "supabaseServiceKey"]);
  const stripSecrets = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripSecrets);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
        if (SECRET_KEYS.has(key)) return;
        out[key] = stripSecrets(entry);
      });
      return out;
    }
    return value;
  };

  const exportBackup = (scope: BackupScope) => {
    const stores: Record<string, unknown> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.toLowerCase().startsWith("larsa")) continue;
      if (scope !== "all" && backupAreaForKey(key) !== scope) continue;
      // Session payloads are identity material, not data — never exported.
      if (key === "larsa-control-session-keep") continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      try {
        stores[key] = stripSecrets(JSON.parse(raw));
      } catch {
        stores[key] = raw;
      }
    }
    if (!Object.keys(stores).length) {
      notify(`No ${BACKUP_SCOPES[scope].label.toLowerCase()} data is available on this device yet.`);
      return;
    }
    saveDownload(
      `larsa-${BACKUP_SCOPES[scope].file}-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(
        {
          format: "Larsa Control Backup",
          version: 3,
          scope,
          scopeLabel: BACKUP_SCOPES[scope].label,
          exportedAt: new Date().toISOString(),
          stores,
        },
        null,
        2,
      ),
    );
    notify(`${BACKUP_SCOPES[scope].label} backup downloaded.`);
  };

  const restoreBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      /* Validate BEFORE touching anything: the file must declare itself a
         Larsa backup of a version this build understands, and every store
         must serialise cleanly. Half-restoring a corrupt file used to be
         possible — the loop below wrote store three and then threw on store
         four, leaving live data part-old, part-new. Now the whole payload is
         prepared first and only then written, all-or-nothing. */
      if (payload?.format !== "Larsa Control Backup") throw new Error("format");
      if (typeof payload.version !== "number" || payload.version < 1 || payload.version > 3) throw new Error("version");
      if (!payload?.stores || typeof payload.stores !== "object") throw new Error("stores");
      /* Backups carry no credentials (see exportBackup), so restoring the
         staff store must not wipe the credentials people are using right
         now: each incoming user that lacks a secret inherits the one already
         on this device for the same account. A truly fresh machine restores
         credential-free users, who reset their password — by design. */
      const withKeptCredentials = (key: string, value: unknown): unknown => {
        if (key !== "larsaStaffV8" || !value || typeof value !== "object") return value;
        const current = parseStore("larsaStaffV8");
        const existing = new Map(((current?.users as StaffUser[]) || []).map((user) => [user.id, user]));
        const incoming = value as { users?: StaffUser[] };
        if (!Array.isArray(incoming.users)) return value;
        return {
          ...incoming,
          users: incoming.users.map((user) => {
            const known = existing.get(user.id);
            if (!known) return user;
            return {
              ...user,
              ...(user.password === undefined && known.password !== undefined ? { password: known.password } : {}),
              ...(user.pin === undefined && known.pin !== undefined ? { pin: known.pin } : {}),
            };
          }),
        };
      };
      const prepared = Object.entries(payload.stores)
        .filter(([key]) => key.toLowerCase().startsWith("larsa"))
        .map(([key, value]) => {
          const kept = withKeptCredentials(key, value);
          return [key, typeof kept === "string" ? kept : JSON.stringify(kept)] as const;
        });
      if (!prepared.length) throw new Error("empty");
      const scopeLabel = typeof payload.scopeLabel === "string" ? payload.scopeLabel : "selected";
      if (!confirm(`Restore ${scopeLabel.toLowerCase()} data from this backup? Matching records will be replaced.`)) return;
      const previous = prepared.map(([key]) => [key, localStorage.getItem(key)] as const);
      try {
        prepared.forEach(([key, value]) => localStorage.setItem(key, value));
      } catch (writeError) {
        // Quota or storage failure mid-write: put back what was there.
        previous.forEach(([key, value]) => {
          if (value === null) localStorage.removeItem(key);
          else localStorage.setItem(key, value);
        });
        throw writeError;
      }
      (Object.keys(refs) as Engine[]).forEach((engine) =>
        refs[engine].current?.contentWindow?.location.reload(),
      );
      setStorageTick((value) => value + 1);
      notify(`${scopeLabel} backup restored. Work areas are reloading.`);
    } catch {
      notify("This is not a valid Larsa Control backup.");
    }
  };

  const syncStaff = () => {
    const staff = parseStore("larsaStaffV8");
    if (!staff?.users?.length) {
      notify("Open Timeclock & Performance once so its staff list is available.");
      return;
    }
    if (
      !confirm(
        "Use Timeclock & Performance as the identity master? HR skills and Accounting payroll values will be preserved.",
      )
    )
      return;
    const users = staff.users.filter((user: Record<string, unknown>) => user.enabled !== false);
    let hrAdded = 0;
    let accountingAdded = 0;
    const hr = parseStore("larsa_hr_visual_counts_v5");
    if (Array.isArray(hr?.people)) {
      users.forEach((user: Record<string, unknown>) => {
        const person = hr.people.find(
          (row: Record<string, unknown>) => normalizeName(row.name) === normalizeName(user.name),
        );
        if (person) {
          Object.assign(person, {
            name: user.name,
            role: user.role || person.role,
            email: user.email || person.email,
            phone: user.phone || person.phone,
            location: user.location || person.location,
            attendanceNote: user.notes || person.attendanceNote,
          });
        } else {
          hr.people.push({
            id: `HR_${normalizeName(user.name) || Date.now()}`,
            name: user.name,
            role: user.role || "",
            email: user.email || "",
            phone: user.phone || "",
            location: user.location || "",
            manager: user.manager || "",
            join: new Date().toISOString().slice(0, 10),
            attendanceNote: user.notes || "",
            selections: {},
          });
          hrAdded += 1;
        }
      });
      localStorage.setItem("larsa_hr_visual_counts_v5", JSON.stringify(hr));
    }
    const accountingKey =
      Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
        .filter((key): key is string => Boolean(key))
        .find((key) => key.endsWith("_v34_clean")) ||
      "larsa_enterprise_v3_new_account_20260630_v34_clean";
    const accounting = parseStore(accountingKey);
    if (Array.isArray(accounting?.employees)) {
      users.forEach((user: Record<string, unknown>) => {
        const employee = accounting.employees.find(
          (row: Record<string, unknown>) => normalizeName(row.name) === normalizeName(user.name),
        );
        if (employee) {
          Object.assign(employee, {
            name: user.name,
            email: user.email || employee.email,
            role: user.role || employee.role,
            active: true,
          });
        } else {
          const usa = String(user.location || "").toLowerCase().includes("usa");
          accounting.employees.push({
            id: `emp_${normalizeName(user.name) || Date.now()}`,
            name: user.name,
            email: user.email || "",
            role: user.role || "Engineer",
            region: usa ? "USA" : "Iraq",
            payrollRegion: usa ? "USA" : "Iraq",
            employmentType: usa ? "W2 Employee" : "Iraq Employee",
            payType: "Salary",
            paySchedule: "Monthly",
            baseSalary: 0,
            defaultSalary: 0,
            currency: usa ? "USD" : "IQD",
            active: true,
            notes: "Identity synchronized from Timeclock & Performance.",
          });
          accountingAdded += 1;
        }
      });
      localStorage.setItem(accountingKey, JSON.stringify(accounting));
    }
    hrRef.current?.contentWindow?.location.reload();
    accountingRef.current?.contentWindow?.location.reload();
    setStorageTick((value) => value + 1);
    notify(`Staff synchronized. Added ${hrAdded} HR and ${accountingAdded} payroll records.`);
  };

  // These each walk localStorage and JSON.parse stores that can reach hundreds of
  // kilobytes. Without memoisation they ran on every keystroke, toast, and clock
  // tick, which is the main source of input lag on phones.
  const storage = useMemo(() => {
    if (!hydrated || typeof window === "undefined") return [] as { key: string; size: string }[];
    const rows: { key: string; size: string }[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.toLowerCase().startsWith("larsa")) continue;
      const bytes = new Blob([localStorage.getItem(key) || ""]).size;
      rows.push({ key, size: bytes > 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B` });
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }, [hydrated, storageTick]);
  const staffStore = useMemo(
    () => (hydrated ? parseStore("larsaStaffV8") as Record<string, unknown> | null : null),
    [hydrated, storageTick],
  );
  const pointsRows = useMemo(() => performanceRows(staffStore), [staffStore]);
  const staffFormalRecords = useMemo(() => formalRecords(staffStore), [staffStore]);
  const clockSessions = useMemo(() => buildClockSessions(staffStore, accessUsers), [staffStore, accessUsers]);
  const accountingSnapshot = useMemo(
    () => (hydrated
      ? readAccountingSnapshot()
      : {
        key: "", rate: DEFAULT_IQD_RATE, projects: [], documents: [], commissions: [], payroll: [],
        funding: [], revenue: [], materials: [], labor: [], expenses: [],
      } as AccountingSnapshot),
    [hydrated, storageTick],
  );
  // R1: the directory used to expose every account (and its plaintext password
  // and PIN) to anyone holding Users & Access view, regardless of data scope.
  const directoryUsers = useMemo(() => {
    if (!sessionUser) return [] as StaffUser[];
    if (isAdmin(sessionUser)) return accessUsers;
    const active = accessUsers.filter((user) => user.enabled !== false);
    const inScope = new Set(scopedUsers(sessionUser, active).map((user) => user.id));
    const disabledInScope = accessUsers.filter((user) =>
      user.enabled === false && sessionUser.department
      && user.department?.toLowerCase() === sessionUser.department.toLowerCase());
    disabledInScope.forEach((user) => inScope.add(user.id));
    return accessUsers.filter((user) =>
      user.access !== "Super Admin" && (inScope.has(user.id) || user.id === sessionUser.id));
  }, [accessUsers, sessionUser]);
  const goToItem = useCallback((id: string) => {
    const item = ITEMS.find((row) => row.id === id);
    if (item) choose(item, channelForItem(item));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const myWeek = useMemo(() => {
    const schedule = (staffStore?.schedule || {}) as Record<string, Record<string, { start?: string; end?: string; code?: string; name?: string }[]>>;
    const mine = sessionUser ? schedule[sessionUser.id] || {} : {};
    return OFFICE_WEEK.map((day) => ({
      day,
      codes: (mine[day] || []).map((entry) => String(entry.code || entry.name || "")),
      entries: mine[day] || [],
    }));
  }, [sessionUser, staffStore]);
  const myDevelopment = useMemo(
    () => growthStore.development
      .filter((record) => record.employeeId === sessionUser?.id && record.status !== "Approved")
      .sort((left, right) => String(left.dueDate).localeCompare(String(right.dueDate))),
    [growthStore, sessionUser],
  );
  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => setNotifications(readNotifications()), 0);
    return () => clearTimeout(timer);
  }, [hydrated, storageTick]);

  /* Keep the module-level actor pointed at whoever is signed in, so a
     notification raised from anywhere records who raised it. */
  useEffect(() => { setNotifyActor(sessionUser); }, [sessionUser]);

  /* The counts the bell shows. Re-read on sign-in, on every local change, and
     whenever the Realtime ping says something moved on another device. */
  const refreshCounts = useCallback(() => {
    const actor = sessionUserRef.current;
    if (!actor?.id || !notifyConfigured()) { setNotifyCounts(EMPTY_COUNTS); return; }
    fetchCounts({ id: actor.id, name: actor.name }).then(setNotifyCounts).catch(() => {});
  }, []);

  useEffect(() => {
    if (!hydrated || !sessionUser?.id) return;
    refreshCounts();
  }, [hydrated, sessionUser?.id, notifyTick, storageTick, refreshCounts]);

  /* No drain on load either. The database dispatches the moment a
     notification is raised, and a one-minute cron sweep catches anything that
     slips through — so a push reaches a phone whose app has been closed for
     an hour, which is the only reason push exists. */

  /* Read it on the phone, watch the laptop's badge clear. The broadcast
     carries no content — it only says "go and look again". */
  useEffect(() => {
    if (!sessionUser?.id) return;
    return watchNotifications({ id: sessionUser.id }, () => setNotifyTick((value) => value + 1));
  }, [sessionUser?.id]);

  /* One import per device, ever. The notifications already sitting in this
     browser's localStorage are somebody's history, so they are carried into the
     authoritative store rather than abandoned — and the marker below means
     opening the app twice does not try again. */
  useEffect(() => {
    if (!hydrated || !sessionUser?.id || !notifyConfigured()) return;
    const marker = `larsa-notify-imported-${sessionUser.id}`;
    try { if (localStorage.getItem(marker)) return; } catch { return; }
    const legacy = readNotifications().filter((row) => row.toId === sessionUser.id);
    const finish = () => { try { localStorage.setItem(marker, new Date().toISOString()); } catch { /* private mode */ } };
    if (!legacy.length) { finish(); return; }
    importLegacy({ id: sessionUser.id, name: sessionUser.name }, legacy)
      .then(() => { finish(); setNotifyTick((value) => value + 1); })
      .catch(() => { /* try again next load rather than losing the history */ });
  }, [hydrated, sessionUser?.id, sessionUser?.name]);

  /* Resolve a notification arrived at from outside. Waiting for sessionUser is
     the point: a push tapped on a locked phone must land on the sign-in screen
     and only then open the record, never show it to whoever picked the phone up. */
  useEffect(() => {
    if (!pendingNotification || !sessionUser?.id || !notifyConfigured()) return;
    let cancelled = false;
    fetchFeed({ id: sessionUser.id, name: sessionUser.name }, { scope: "all", limit: 100 })
      .then((feed) => {
        if (cancelled) return;
        const row = feed.items.find((item) => item.id === pendingNotification);
        setPendingNotification(null);
        // The feed read is itself the authorisation check: notify_feed only
        // ever returns this person's rows, so an id belonging to someone else
        // simply is not found and nothing opens.
        if (row) openNotification({ id: row.id, itemId: row.itemId });
        else setBellOpen(true);
      })
      .catch(() => { if (!cancelled) setPendingNotification(null); });
    return () => { cancelled = true; };
    // openNotification closes over stable refs and setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNotification, sessionUser?.id, sessionUser?.name]);

  /* The app-icon badge, so a closed PWA still shows there is something waiting. */
  useEffect(() => {
    if (!hydrated) return;
    const count = notifyConfigured()
      ? notifyCounts.unread
      : notifications.filter((row) => row.toId === sessionUser?.id && !row.read).length;
    setAppBadge(sessionUser ? count : 0);
  }, [hydrated, notifyCounts.unread, notifications, sessionUser]);

  // Writes that only touch the signed-in person's own record.
  const saveOwnProfile = useCallback((patch: Partial<StaffUser>) => {
    const actor = sessionUserRef.current;
    if (!actor) return false;
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.users)) {
      notify("Your account is still loading. Please try again.");
      return false;
    }
    const index = store.users.findIndex((row: StaffUser) => row.id === actor.id);
    if (index < 0) { notify("Your account could not be found."); return false; }
    // Role, access, scope, and permissions are never editable from here.
    const safe: Partial<StaffUser> = {};
    /* "photo" belongs on this list and nowhere else: a person may set their own
       picture and no one else's. It is the same line the password draws. */
    (["email", "phone", "location", "photo", "password", "pin", "notifyPrefs"] as const).forEach((key) => {
      if (patch[key] !== undefined) (safe as Record<string, unknown>)[key] = patch[key];
    });
    /* The change stamps travel WITH their secrets — and only with them. The
       repair_008 database guard refuses a different hash whose stamp is not
       strictly newer, so a password change that arrived without its stamp
       would be healed straight back to the old hash: the change would look
       saved here and quietly not be. (Found by the durability battery.) */
    if (safe.password !== undefined && patch.passwordChangedAt) safe.passwordChangedAt = patch.passwordChangedAt;
    if (safe.pin !== undefined && patch.pinChangedAt) safe.pinChangedAt = patch.pinChangedAt;
    if (safe.email) {
      const taken = store.users.some((row: StaffUser) =>
        row.id !== actor.id && row.email?.trim().toLowerCase() === String(safe.email).trim().toLowerCase());
      if (taken) { notify("That email is already used by another account."); return false; }
    }
    if (safe.pin) {
      const taken = store.users.some((row: StaffUser) => row.id !== actor.id && row.pin === safe.pin);
      if (taken) { notify("That PIN is already used by another account."); return false; }
    }
    const next = { ...store.users[index], ...safe, touchedAt: serverNowIso() };
    store.users[index] = next;
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    sessionUserRef.current = next;
    setSessionUser(next);
    persistSession(next, sessionMethodRef.current || "email", rememberRef.current);
    setStorageTick((value) => value + 1);
    notify("Your settings were saved.");
    return true;
  }, [notify]);

  /* Add a shift type, or correct an existing one. Editing a built-in writes an
     override rather than mutating the constant, so schedules already recorded
     against that code keep resolving. */
  const saveShiftType = useCallback((draft: ShiftType, replacing = "") => {
    const actor = sessionUserRef.current;
    const scheduleItem = ITEMS.find((row) => row.id === "staff-schedule");
    if (!actor || !scheduleItem || !hasItemPermission(actor, scheduleItem, "manage")) {
      notify("Your account cannot change shift types.");
      return false;
    }
    const code = String(draft.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (!code) { notify("Give the shift a short code, such as NIGHT."); return false; }
    if (!draft.label.trim()) { notify("Give the shift a name."); return false; }
    const store = parseStore("larsaStaffV8");
    if (!store) { notify("Staff records are still loading."); return false; }
    const rows: ShiftType[] = Array.isArray(store[SHIFT_TYPES_KEY]) ? store[SHIFT_TYPES_KEY] : [];
    const previous = String(replacing || "").toUpperCase();
    // A new code must not silently overwrite one already in use.
    if (code !== previous && (SHIFT_CODES[code] || rows.some((row) => String(row.code).toUpperCase() === code))) {
      notify(`${code} is already a shift. Edit that one instead.`);
      return false;
    }
    const next: ShiftType = {
      code,
      label: draft.label.trim(),
      start: draft.start || "",
      end: draft.end || "",
      time: draft.start && draft.end ? `${draft.start} – ${draft.end}` : "—",
      tone: draft.tone || "other",
      custom: !SHIFT_CODES[code],
    };
    store[SHIFT_TYPES_KEY] = [...rows.filter((row) => String(row.code).toUpperCase() !== previous
      && String(row.code).toUpperCase() !== code), next];
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    setStorageTick((value) => value + 1);
    notify(previous ? `${code} updated.` : `${code} added to the shift list.`);
    return true;
  }, [notify]);

  const removeShiftType = useCallback((code: string) => {
    const actor = sessionUserRef.current;
    const scheduleItem = ITEMS.find((row) => row.id === "staff-schedule");
    if (!actor || !scheduleItem || !hasItemPermission(actor, scheduleItem, "manage")) {
      notify("Your account cannot change shift types.");
      return false;
    }
    const key = String(code || "").toUpperCase();
    const store = parseStore("larsaStaffV8");
    if (!store) return false;
    const schedule = (store.schedule || {}) as Record<string, Record<string, { code?: string }[]>>;
    // Refuse to remove a shift somebody is actually rostered on.
    const inUse = Object.values(schedule).some((days) => Object.values(days || {})
      .some((entries) => (entries || []).some((entry) => String(entry.code || "").toUpperCase() === key)));
    if (inUse) { notify(`${key} is still on the schedule. Clear it from the roster first.`); return false; }
    const rows: ShiftType[] = Array.isArray(store[SHIFT_TYPES_KEY]) ? store[SHIFT_TYPES_KEY] : [];
    store[SHIFT_TYPES_KEY] = rows.filter((row) => String(row.code).toUpperCase() !== key);
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    setStorageTick((value) => value + 1);
    notify(SHIFT_CODES[key] ? `${key} reset to its original hours.` : `${key} removed.`);
    return true;
  }, [notify]);

  /* The three handlers that used to live here — saveNotifyPrefs,
     markNotificationRead, clearReadNotifications — are gone. Preferences now
     belong to the account rather than to the staff record, and read/archive
     state belongs to the notification row itself, so both are handled by the
     notify_* RPCs from the bell and the settings panel instead of being
     threaded down through props. */

  const homeSummary = useMemo(
    () => buildHomeSummary(
      sessionUser, staffStore, growthStore, pointsRows, clockSessions, accessUsers,
      visibleProjectIds(sessionUser, accountingSnapshot.projects).size,
    ),
    [sessionUser, staffStore, growthStore, pointsRows, clockSessions, accessUsers, accountingSnapshot],
  );
  const homeGroup = GROUPS.find((group) => group.label === "Home")!;
  /* The same question the Engineering Management screen asks itself before it
     draws its management tabs, asked here so the sidebar offers exactly what
     the page will show. */
  const managesOthers = useMemo(
    () => isResponsibleForOthers(effectiveOrg(accessUsers), sessionUser, accessUsers),
    [accessUsers, sessionUser],
  );
  const staffItems = GROUPS.find((group) => group.label === "Timeclock & Performance")!.items;
  const channelGroups: Record<Exclude<NavChannel, "home" | "admin">, Group> = {
    time: {
      label: "Time & Attendance",
      /* Everything about hours, in the order somebody works through them:
         clock, the week you are clocking against, the sheet it adds up to,
         the requests that change it, and who is in right now.

         The native clock and schedule replace the engine's own pages, so those
         are not listed again — one Clock In / Out, one Weekly Schedule. */
      items: [
        QUICK_CLOCK_ITEM,
        WEEK_SCHEDULE_ITEM,
        ...["staff-timesheet"]
          .map((id) => staffItems.find((item) => item.id === id)!)
          .filter(Boolean),
        REQUESTS_ITEM,
        PRESENCE_ITEM,
      ],
    },
    performance: {
      label: "Performance & Workboard",
      /* Dashboard first, then the two things performance actually consists of
         — points and approvals, then reviews and recognition — then reports.
         Nothing about attendance appears here: clocking, schedules, timesheets
         and leave all live in Time & Attendance, and the Development Portal
         moved to HR & Skills.

         staff-dashboard / staff-performance / staff-reports resolve to this
         channel in channelForItem, so they must be listed here or they have no
         sidebar entry at all.

         Add My Points sits second, straight after the Dashboard. It used to be
         reachable only from a Home quick link, which meant somebody who opened
         Performance to add points had to go back out to Home to do it. It is
         not part of the staff group, so it is named directly rather than
         looked up. Access is unchanged — the sidebar filters every entry
         through canOpenInSession, so it appears only for people who may
         submit performance. */
      items: [
        staffItems.find((item) => item.id === "staff-dashboard")!,
        MY_POINTS_ITEM,
        ...["performance-center", "staff-performance", "performance-history", "staff-reports"]
          .map((id) => staffItems.find((item) => item.id === id)!),
      ].filter(Boolean),
    },
    engineering: {
      label: "Engineering Management",
      /* Team Timesheets and Team Performance are only shown to somebody who is
         actually responsible for other people — the same test the screen uses
         to decide whether to draw those tabs at all, so the sidebar and the
         page agree. */
      items: GROUPS.find((group) => group.label === "Engineering Management")!.items
        .filter((item) => !ENGINEERING_MANAGER_ITEMS.has(item.id) || managesOthers),
    },
    hr: GROUPS.find((group) => group.label === "HR & Skills")!,
    accounting: {
      label: "Accounting",
      items: [ACCOUNTING_HUB_ITEM, ...GROUPS.find((group) => group.label === "Accounting")!.items],
    },
  };
  /* Supabase is authoritative when it is there; the local mirror is what the
     bell falls back to on a deployment with no backend configured. Both the
     badge and the panel read the SAME object, so a bell showing two unread
     cannot also claim you are all caught up. */
  const mine = notifications.filter((row) => row.toId === sessionUser?.id);
  const effectiveCounts: NotifyCounts = notifyConfigured() ? notifyCounts : {
    unread: mine.filter((row) => !row.read).length,
    all: mine.length,
    archived: 0,
    byCategory: {},
  };
  const unreadCount = effectiveCounts.unread;
  const adminItem = ITEMS.find((item) => item.id === "admin")!;
  const adminNavItems: Item[] = [
    adminItem,
    ACCESS_ITEM,
    { ...ITEMS.find((item) => item.id === "staff-rules")!, label: "Rules & Constraints" },
    ITEMS.find((item) => item.id === "data")!,
    { ...ITEMS.find((item) => item.id === "staff-backup")!, label: "Staff CSV & Import Tools" }, ITEMS.find((item) => item.id === "platform-settings")!,
  ];
  const quickGroup: Group = {
    label: "Quick Actions",
    items: [QUICK_CLOCK_ITEM, WEEK_SCHEDULE_ITEM, MY_POINTS_ITEM, DEVELOPMENT_ITEM],
  };
  const contextGroup: Group | null =
    navChannel === "home"
      ? null
      : sessionMethod === "pin"
        ? quickGroup
        : navChannel === "admin"
          ? { label: "Administration", items: adminNavItems }
          : channelGroups[navChannel];
  const visibleGroups = [homeGroup, contextGroup]
    .filter((group): group is Group => Boolean(group))
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canOpenInSession(sessionUser, item, sessionMethod)),
    }))
    .filter((group) => group.items.length);
  /* Written straight through rather than in an effect: the sidebar is one
     boolean, and a person who folds it away expects it folded on the next
     visit, not on the render after next. */
  const setNavFolded = (folded: boolean) => {
    setNavCollapsed(folded);
    try { localStorage.setItem("larsa-control-nav-collapsed", folded ? "1" : "0"); } catch { /* private mode */ }
  };

  // A signed-in Viewer never reaches the staff app shell below — not the
  // sidebar, not the engines, not any of the StaffUser-shaped state this
  // component otherwise threads through. It gets its own small, read-only
  // screen fed only by data it is allowed to see, fetched straight from
  // Supabase rather than from the shared, everyone-signed-in-can-read
  // localStorage sync used by the rest of the app.
  if (viewerSession) {
    return <ViewerPortal session={viewerSession} onSignOut={viewerSignOut} />;
  }

  return (
    <div className={[dark ? "unified-app dark" : "unified-app", navCollapsed ? "nav-collapsed" : ""].filter(Boolean).join(" ")}>
      <div
        className={menuOpen ? "scrim open" : "scrim"}
        onClick={() => setMenuOpen(false)}
        aria-hidden="true"
      />
      <aside className={menuOpen ? "sidebar open" : "sidebar"} aria-label="Main navigation">
        <div className="brand">
          <Image src="/icons/larsa-logo.svg" alt="Larsa Engineering" width={176} height={68} priority />
          <button type="button" className="close-menu" onClick={() => setMenuOpen(false)} aria-label="Close navigation">
            <X size={18} />
          </button>
          <button type="button" className="collapse-menu" onClick={() => setNavFolded(true)} aria-label="Hide the sidebar" title="Hide the sidebar">
            <PanelLeftClose size={18} />
          </button>
        </div>
        <div className="product-name">
          <strong>Larsa Control</strong>
          <span>Operations Platform</span>
        </div>
        <nav className="nav-list" id="larsa-main-nav">
          {navChannel === "accounting" && sessionUser && (
            <section className="nav-group">
              <h2>Accounting</h2>
              <button
                type="button"
                className={active.id === "accounting-hub" ? "nav-item active" : "nav-item"}
                onClick={() => choose(ACCOUNTING_HUB_ITEM, "accounting")}
                title={ACCOUNTING_HUB_ITEM.description}
              >
                <span className="nav-code"><BadgeDollarSign size={16} strokeWidth={2.15} /></span>
                <span><b>All areas</b><small>{ACCOUNTING_HUB_ITEM.description}</small></span>
              </button>
              {ACCOUNTING_TREE.map((group) => {
                const entries = group.items
                  .map((id) => ITEMS.find((item) => item.id === id))
                  .filter((item): item is Item => Boolean(item && canOpenInSession(sessionUser, item, sessionMethod)));
                if (!entries.length) return null;
                const holdsActive = entries.some((item) => item.id === active.id);
                const expanded = openAccountingGroup === group.id || holdsActive;
                const GroupIcon = ICONS[group.icon] || BadgeDollarSign;
                return (
                  <div className={expanded ? "nav-sub open" : "nav-sub"} key={group.id}>
                    <button
                      type="button"
                      className="nav-sub-head"
                      onClick={() => setOpenAccountingGroup(expanded && !holdsActive ? "" : group.id)}
                      aria-expanded={expanded}
                    >
                      <span className="nav-code"><GroupIcon size={16} strokeWidth={2.15} /></span>
                      <span><b>{group.label}</b><small>{entries.length} areas</small></span>
                      <ArrowRight size={14} className="nav-sub-arrow" />
                    </button>
                    {expanded && (
                      <div className="nav-sub-items">
                        {entries.map((item) => (
                          <button
                            type="button"
                            key={item.id}
                            className={active.id === item.id ? "nav-child active" : "nav-child"}
                            onClick={() => choose(item, "accounting")}
                            title={item.description}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}
          {(navChannel === "accounting" ? visibleGroups.filter((group) => group.label === "Home") : visibleGroups).map((group) => (
            <section className="nav-group" key={group.label}>
              <h2>{group.label}</h2>
              {group.items.map((item) => {
                const Icon = ICONS[item.id] || ListChecks;
                const isHome = item.id === "overview";
                // Inside a portal the Home entry is the way back out, so it is
                // promoted rather than sitting as one more equal-weight row.
                const leaving = isHome && navChannel !== "home";
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={[
                      "nav-item",
                      active.id === item.id ? "active" : "",
                      // Home is the anchor of the sidebar whether you are
                      // standing on it or heading back to it, so it carries its
                      // own treatment in both states rather than only on the
                      // way out of a portal.
                      isHome ? "nav-home" : "",
                      leaving ? "nav-home-exit" : "",
                    ].filter(Boolean).join(" ")}
                    onClick={() => choose(item, isHome ? "home" : navChannel)}
                    title={item.description}
                  >
                    <span className="nav-code">
                      {isHome ? <span className="larsa-mark" aria-hidden="true" /> : <Icon size={16} strokeWidth={2.15} />}
                    </span>
                    <span>
                      <b>{isHome ? "Home" : item.label}</b>
                      <small>{leaving ? "Main workspace" : item.description}</small>
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </nav>
        {sessionUser && (
          <div className="sidebar-account">
            <button type="button" className="account-open" onClick={() => choose(SETTINGS_ITEM, "home")} title="My settings">
              <PersonAvatar person={sessionUser} />
              <div><b>{sessionUser.name}</b><small>{sessionUser.access || sessionUser.role}</small></div>
              {unreadCount > 0 && <i className="unread-dot" aria-label={`${unreadCount} unread notifications`} />}
            </button>
            <button type="button" onClick={previewOwner ? endAccessPreview : signOut} aria-label={previewOwner ? "Exit preview" : "Sign out"}>
              {previewOwner ? <X size={17} /> : <LogOut size={17} />}
            </button>
          </div>
        )}
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <div className="top-left">
            {/* One button, two jobs: on a phone it opens the drawer, on a wide
                screen it unfolds the column. Both are "show me the navigation". */}
            <button
              type="button"
              className="menu-button"
              onClick={() => { setMenuOpen(true); setNavFolded(false); }}
              aria-label="Show navigation"
              aria-expanded={menuOpen || !navCollapsed}
              aria-controls="larsa-main-nav"
            >
              <PanelLeftOpen size={20} />
            </button>
            {/* Back, on every page that has somewhere to go back to. The
                browser's own Back leaves the app, so this is the only control
                that steps through where you have actually been. */}
            {navHistory.length > 0 && (
              <button
                type="button"
                className="top-back"
                onClick={goBack}
                aria-label={`Back to ${navHistory[navHistory.length - 1].label}`}
                title={`Back to ${navHistory[navHistory.length - 1].label}`}
              >
                <ArrowLeft size={17} />
                <b>Back</b>
              </button>
            )}
            {/* Home must not depend on the sidebar being on screen. It sits in
                the bar itself, next to the title, wherever you are. */}
            {active.id !== "overview" && (
              <button
                type="button"
                className="top-home"
                onClick={() => choose(OVERVIEW_ITEM, "home")}
                aria-label="Go to Home"
                title="Home"
              >
                <span className="larsa-mark" aria-hidden="true" />
                <b>Home</b>
              </button>
            )}
            <div className="page-heading">
              <h1>{active.label}</h1>
              <p>{active.description}</p>
            </div>
          </div>
          <div className="top-right">
            {previewOwner && <div className="preview-mode">
              <Eye size={16} />
              <span>Preview as <b>{sessionUser?.name}</b></span>
              <button type="button" onClick={endAccessPreview}>Exit Preview</button>
            </div>}
            {!previewOwner && <div className="clocks">
              <span><b>Iraq</b>{clock.baghdad}</span>
              <span><b>US Central</b>{clock.texas}</span>
            </div>}
            {sessionUser && active.id !== "my-pay" && (
              <button
                type="button"
                className="theme pay-button"
                onClick={() => choose(MY_PAY_ITEM, "home")}
                aria-label="My Pay — salary, commissions, and payment history"
                title="My Pay"
              >
                <Wallet size={18} />
              </button>
            )}
            {sessionUser && (
              <div className="bell-wrap">
                <button
                  type="button"
                  className={bellOpen ? "theme notif-button open" : "theme notif-button"}
                  onClick={() => setBellOpen((value) => !value)}
                  aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
                  aria-expanded={bellOpen}
                  aria-haspopup="dialog"
                  title="Notifications"
                >
                  <Bell size={18} />
                  {unreadCount > 0 && <span className="notif-count">{unreadCount > 99 ? "99+" : unreadCount}</span>}
                </button>
                {bellOpen && (
                  <NotificationBell
                    user={sessionUser}
                    counts={effectiveCounts}
                    tick={notifyTick}
                    onChanged={() => setNotifyTick((value) => value + 1)}
                    onOpen={openNotification}
                    onClose={() => setBellOpen(false)}
                    onSettings={() => { setBellOpen(false); choose(SETTINGS_ITEM, "home"); }}
                    localFallback={mine}
                  />
                )}
              </div>
            )}
            {!installed && (
              <button type="button" className="primary" onClick={install} disabled={installBusy}>
                {installBusy ? "Opening installer…" : "Install App"}
              </button>
            )}
            <button type="button" className="theme" onClick={() => setDark((value) => !value)} aria-label="Toggle theme">
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            {sessionUser && !previewOwner && <button type="button" className="top-signout" onClick={signOut} aria-label="Sign out"><LogOut size={17} /></button>}
          </div>
        </header>

        <section className="workspace">
          <div className={active.native === "overview" ? "native active" : "native"}>
            <Overview choose={choose} user={sessionUser} method={sessionMethod} recentId={recentId} recentTrail={recentTrail} summary={homeSummary} />
          </div>
          <div className={active.native === "admin" ? "native active" : "native"}>
            <AdminCenter choose={choose} user={sessionUser} />
          </div>
          <div className={active.native === "access" ? "native active" : "native"}>
            <AccessCenter
              users={directoryUsers}
              projects={accountingSnapshot.projects}
              currentUser={sessionUser}
              saveUser={saveAccessUser}
              deleteUser={deleteAccessUser}
              restoreUser={restoreAccessUser}
              recycleUser={recycleAccessUser}
              binRestoreUser={restoreFromRecycleBin}
              purgeUser={purgeAccessUser}
              canPurge={Boolean(sessionUser && sessionUser.access === "Super Admin")}
              sessions={clockSessions}
              store={staffStore}
              previewUser={startAccessPreview}
              canCreate={Boolean(sessionUser && hasItemPermission(sessionUser, ACCESS_ITEM, "add"))}
              canEdit={Boolean(sessionUser && hasItemPermission(sessionUser, ACCESS_ITEM, "edit"))}
              canDelete={Boolean(sessionUser && hasItemPermission(sessionUser, ACCESS_ITEM, "delete"))}
            />
          </div>
          <div className={active.native === "notifications" ? "native active" : "native"}>
            <NotificationsCenter users={directoryUsers} currentUser={sessionUser} />
          </div>
          <div className={active.native === "data" ? "native active" : "native"}>
            <DataCenter
              storage={storage}
              backup={exportBackup}
              restore={() => uploadRef.current?.click()}
              sync={syncStaff}
              openStaffTools={
                canOpenInSession(
                  sessionUser,
                  ITEMS.find((item) => item.id === "staff-backup")!,
                  sessionMethod,
                )
                  ? () => choose(ITEMS.find((item) => item.id === "staff-backup")!, "admin")
                  : undefined
              }
              canExport={Boolean(sessionUser && hasItemPermission(sessionUser, ITEMS.find((item) => item.id === "data")!, "export"))}
              canManage={Boolean(sessionUser && hasItemPermission(sessionUser, ITEMS.find((item) => item.id === "data")!, "manage"))}
              runCheck={runSystemCheck}
            />
          </div>
          <div className={active.native === "quickClock" ? "native active" : "native"}>
            <QuickClock
              user={sessionUser}
              sessions={clockSessions}
              summary={homeSummary}
              punch={punchClock}
              punchBreak={punchBreak}
              submitCorrection={submitCorrection}
              users={accessUsers}
              trimSession={trimSession}
              resetSession={resetSession}
              go={goToItem}
              method={sessionMethod}
              week={myWeek}
              development={myDevelopment}
              store={staffStore}
            />
          </div>
          <div className={active.native === "requests" ? "native active" : "native"}>
            <RequestsCentre
              viewer={sessionUser}
              users={accessUsers}
              store={staffStore}
              submit={submitRequest}
              decide={decideRequest}
            />
          </div>
          <div className={active.native === "approvalFlow" ? "native active" : "native"}>
            <ApprovalFlowCentre
              viewer={sessionUser}
              users={accessUsers}
              store={staffStore}
              save={saveApprovalFlow}
            />
          </div>
          <div className={active.native === "corrections" ? "native active" : "native"}>
            <CorrectionsCentre
              viewer={sessionUser}
              users={accessUsers}
              store={staffStore}
              sessions={clockSessions}
              decide={decideRequest}
              editFlow={editRequestFlow}
              fixRow={fixPerformanceRow}
              fixSession={fixClockSession}
              addSession={addClockSession}
              removeSession={removeClockSession}
            />
          </div>
          <div className={active.native === "orgStructure" ? "native active" : "native"}>
            <EngineeringManagementPortal viewer={sessionUser} users={accessUsers} sessions={clockSessions} rows={pointsRows} targets={growthStore.pointTargets} go={goToItem} onSaved={() => setStorageTick((tick) => tick + 1)} openTab={ENGINEERING_ITEM_TABS[active.id]} />
          </div><div className={active.native === "platformSettings" ? "native active" : "native"}><PlatformSettings viewer={sessionUser} users={accessUsers} /></div><div className={active.native === "presence" ? "native active" : "native"}>
            <LivePresence viewer={sessionUser} users={accessUsers} store={staffStore} sessions={clockSessions} go={goToItem} />
          </div>
          <div className={active.native === "settings" ? "native active" : "native"}>
            <MySettings
              user={sessionUser}
              unread={unreadCount}
              dark={dark}
              setDark={setDark}
              saveProfile={saveOwnProfile}
              openBell={() => setBellOpen(true)}
              sendCode={sendVerificationCode}
              checkCode={checkEmailCode}
            />
          </div>
          <div className={active.native === "accountingHub" ? "native active" : "native"}>
            <AccountingHub user={sessionUser} method={sessionMethod} choose={choose} />
          </div>
          <div className={active.native === "weekSchedule" ? "native active" : "native"}>
            <WeekSchedule
              viewer={sessionUser}
              users={accessUsers}
              store={staffStore}
              go={goToItem}
              saveSchedule={saveSchedule}
              saveColours={saveShiftColours}
              saveShiftType={saveShiftType}
              removeShiftType={removeShiftType}
              autoBuild={autoBuildWeek}
              canManageAll={Boolean(sessionUser && (() => {
                const item = ITEMS.find((row) => row.id === "staff-schedule");
                return item && hasItemPermission(sessionUser, item, "manage");
              })())}
              canEditOwn={Boolean(sessionUser && (() => {
                const item = ITEMS.find((row) => row.id === "staff-schedule");
                return item && hasItemPermission(sessionUser, item, "edit");
              })())}
            />
          </div>
          <div className={active.native === "myPoints" ? "native active" : "native"}>
            <MyPoints user={sessionUser} save={saveMyPoints} store={staffStore} />
          </div>
          <div className={active.native === "performance" ? "native active" : "native"}>
            <PerformanceCenter
              viewer={sessionUser}
              users={accessUsers}
              rows={pointsRows}
              targets={growthStore.pointTargets}
              saveTarget={saveWeeklyTarget}
              reviewRow={reviewPerformanceRow}
              store={staffStore}
              setLock={setWeekLock}
              openWorkboard={() => choose(ITEMS.find((item) => item.id === "staff-performance")!, "performance")}
            />
          </div>
          <div className={active.native === "development" ? "native active" : "native"}>
            <DevelopmentPortal
              viewer={sessionUser}
              users={accessUsers}
              records={growthStore.development}
              createRecord={createDevelopment}
              updateRecord={updateDevelopment}
              reviewRecord={reviewDevelopment}
              deleteRecord={deleteDevelopment}
            />
          </div>
          <div className={active.native === "performanceHistory" ? "native active" : "native"}>
            <PerformanceHistory
              viewer={sessionUser}
              users={accessUsers}
              records={staffFormalRecords}
              saveRecord={saveFormalRecord}
            />
          </div>
          <div className={active.native === "salesCommissions" ? "native active" : "native"}>
            <SalesCommissions
              viewer={sessionUser}
              users={accessUsers}
              commissions={accountingSnapshot.commissions}
              payroll={accountingSnapshot.payroll}
            />
          </div>
          <div className={active.native === "payrollPortal" ? "native active" : "native"}>
            <PayrollPortal viewer={sessionUser} active={active.native === "payrollPortal"} />
          </div>
          <div className={active.native === "myPay" ? "native active" : "native"}>
            <MyPay viewer={sessionUser} active={active.native === "myPay"} />
          </div>
          <div className={active.native === "constructionFinancials" ? "native active" : "native"}>
            <ConstructionFinancials snapshot={accountingSnapshot} viewer={sessionUser} />
          </div>
          <div className={active.native === "projects" ? "native active" : "native"}>
            <ProjectPortal
              viewer={sessionUser}
              projects={accountingSnapshot.projects}
              documents={accountingSnapshot.documents}
              updateProject={updateAccountingProject}
              staff={accessUsers}
              notify={notify}
            />
          </div>
          {(["staff", "hr", "accounting"] as Engine[]).map((engine) => (
            <iframe
              key={engine}
              ref={refs[engine]}
              className={active.engine === engine ? "engine active" : "engine"}
              /* Normally the engine is fetched from /engines. The offline
                 single-file preview has no server to fetch from, so it supplies
                 the markup on window.__LARSA_ENGINE_HTML and the frame is fed
                 directly. In a real deployment that global is absent and this
                 falls straight back to the URL. */
              {...(inlineEngines[engine]
                ? { srcDoc: inlineEngines[engine] }
                : { src: URLS[engine] })}
              title={engine === "staff" ? "Timeclock and Performance" : engine === "hr" ? "Human Resources" : "Accounting"}
              onLoad={() => prepareFrame(engine)}
              sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation"
              allow="clipboard-read; clipboard-write; notifications"
            />
          ))}
        </section>
      </main>

      <input ref={uploadRef} className="hidden-input" type="file" accept=".json,application/json" onChange={restoreBackup} />
      {message && <div className="toast">{message}</div>}
      {installHelp && (
        <div className="modal-layer" onMouseDown={() => setInstallHelp(false)}>
          <section className="install-modal" role="dialog" aria-modal="true" onMouseDown={(event: MouseEvent) => event.stopPropagation()}>
            <div className="modal-head">
              <div><span className="eyebrow">Phone, tablet & computer</span><h2>Install Larsa Control</h2></div>
              <button type="button" onClick={() => setInstallHelp(false)} aria-label="Close"><X size={18} /></button>
            </div>
            {(() => {
              const { wrongBrowser, standalone } = installPlatform();
              if (standalone) {
                return <p className="install-callout ok">Larsa Control is already installed — you are running it now.</p>;
              }
              if (!wrongBrowser) return null;
              return (
                <div className="install-callout">
                  <b>You are in {wrongBrowser}, not Safari.</b>
                  <p>
                    iPhone and iPad can only install an app from Safari. {wrongBrowser} can add a
                    bookmark, but it opens back inside {wrongBrowser} rather than as its own app.
                    Copy the address, open Safari, paste it, then use Share → Add to Home Screen.
                  </p>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(window.location.origin);
                        notify("Address copied. Now paste it into Safari.");
                      } catch {
                        notify(`Open this in Safari: ${window.location.host}`);
                      }
                    }}
                  >Copy address for Safari</button>
                </div>
              );
            })()}
            {(() => {
              /* This panel is now the fallback it was always meant to be: it
                 only appears when the browser has no install to offer. Saying
                 so, and leading with the device the reader is actually holding,
                 beats four sets of steps in a row. */
              const { os, ios, standalone } = installPlatform();
              const steps = [
                { id: "ios", label: "iPhone / iPad", text: "Open in Safari (not Chrome), tap Share, then choose Add to Home Screen." },
                { id: "android", label: "Android", text: "Open in Chrome, open the browser menu, then choose Install app." },
                { id: "mac", label: "Mac", text: "Use Safari Add to Dock, or choose Install from the Chrome address bar." },
                { id: "windows", label: "Windows", text: "Open in Edge or Chrome, then choose Install app from the address bar or browser menu." },
              ];
              const ordered = [...steps].sort((a, b) => Number(b.id === os) - Number(a.id === os));
              return (
                <>
                  {!ios && !standalone && (
                    <p className="install-note lead">
                      Your browser did not offer a one-tap install here — usually because Larsa
                      Control is already installed on this device, or because the page needs one
                      reload before the browser will offer it. These steps always work.
                    </p>
                  )}
                  <div className="install-grid">
                    {ordered.map((step) => (
                      <article key={step.id} className={step.id === os ? "match" : undefined}>
                        <b>{step.label}{step.id === os ? <i>Your device</i> : null}</b>
                        <p>{step.text}</p>
                      </article>
                    ))}
                  </div>
                </>
              );
            })()}
            {/* The sheet itself says the page may need one reload before the
                browser will offer an install, so the reload is offered here
                rather than left as an instruction to follow by hand. */}
            <div className="form-actions" style={{ justifyContent: "flex-start" }}>
              <button type="button" className="primary" onClick={() => window.location.reload()}>
                Reload and try again
              </button>
            </div>
            <p className="install-note">The installed app opens in its own window from your home screen, Dock, Start menu, or desktop. It updates itself — when a new version ships, the app replaces the old one on its own.</p>
          </section>
        </div>
      )}
      {accountingGate && sessionUser && !previewOwner ? (<AccountAccess mode="confirm" currentUser={sessionUser} onCancel={() => setAccountingGate(null)} onConfirmed={() => { const pending = accountingGate; const nextDevices = withDeviceRecorded(sessionUser.devices, getDeviceId(), describeDevice(), { verified: true, accounting: true }); try { const gateStore = parseStore("larsaStaffV8") as { users?: StaffUser[] } | null; if (gateStore && Array.isArray(gateStore.users)) { const seat = gateStore.users.findIndex((row) => row.id === sessionUser.id); if (seat >= 0) { gateStore.users[seat] = { ...gateStore.users[seat], devices: nextDevices }; localStorage.setItem("larsaStaffV8", JSON.stringify(gateStore)); } } } catch { /* The check still passed; only the record of it failed. */ } const refreshedUser = { ...sessionUser, devices: nextDevices }; sessionUserRef.current = refreshedUser; setSessionUser(refreshedUser); setAccountingGate(null); if (pending) choose(pending); }} />) : null}{sessionUser && sessionUser.mustResetPassword && !previewOwner ? (<AccountAccess mode="reset" currentUser={sessionUser} onResetComplete={() => { const refreshed = readStaffUsers().find((row) => row.id === sessionUser.id); if (refreshed) completeSignIn(refreshed, sessionMethod || "email"); else setSessionUser((prev) => (prev ? { ...prev, mustResetPassword: false } : prev)); }} />) : null}{!sessionUser && verifyStage && (
        <div className="auth-layer">
          <section className="auth-card" aria-labelledby="verify-title">
            <div className="auth-brand">
              <Image src="/icons/larsa-logo.svg" alt="Larsa Engineering" width={210} height={82} priority />
              <span><ShieldCheck size={18} /> Secure staff access</span>
            </div>
            <div className="auth-copy">
              <span className="eyebrow">One more step</span>
              <h1 id="verify-title">Verify your email</h1>
              <p>{verifyInfo || `Enter the 6-digit code sent to ${verifyStage.email}.`}</p>
            </div>
            <form onSubmit={(event) => { event.preventDefault(); confirmVerifyCode(); }}>
              <label>Verification Code<input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required value={verifyCode} onChange={(event) => setVerifyCode(event.target.value.replace(/\s/g, ""))} placeholder="123456" autoFocus /></label>
              <div className="auth-error" role="alert">{verifyError}</div>
              <button type="submit" className="auth-submit" disabled={verifyBusy}>{verifyBusy ? "Checking…" : "Verify & Sign In"}</button>
              <div className="rowActions" style={{ justifyContent: "center", marginTop: 10 }}>
                <button type="button" className="btn small" onClick={resendVerifyCode} disabled={verifyBusy}>Resend Code</button>
                <button type="button" className="btn small" onClick={cancelVerify}>Cancel</button>
              </div>
            </form>
          </section>
        </div>
      )}
      {!sessionUser && !verifyStage && (
        <div className="auth-layer">
          <section className="auth-card" aria-labelledby="sign-in-title">
            <div className="auth-brand">
              <Image src="/icons/larsa-logo.svg" alt="Larsa Engineering" width={210} height={82} priority />
              <span><ShieldCheck size={18} /> Secure staff access</span>
            </div>
            <div className="auth-copy">
              <span className="eyebrow">Larsa Engineering</span>
              <h1 id="sign-in-title">Welcome back</h1>
              
            </div>
            <div className="auth-tabs" role="tablist" aria-label="Sign-in method">
              <button
                type="button"
                role="tab"
                id="auth-tab-pin"
                aria-selected={loginMode === "pin"}
                aria-controls="auth-panel"
                tabIndex={loginMode === "pin" ? 0 : -1}
                className={loginMode === "pin" ? "active" : ""}
                onClick={() => { setLoginMode("pin"); setLoginError(""); setAccessMode(null); }}
              >Employee PIN</button>
              <button
                type="button"
                role="tab"
                id="auth-tab-email"
                aria-selected={loginMode === "email"}
                aria-controls="auth-panel"
                tabIndex={loginMode === "email" ? 0 : -1}
                className={loginMode === "email" ? "active" : ""}
                onClick={() => { setLoginMode("email"); setLoginError(""); setAccessMode(null); }}
              >Email</button>
            </div>
            {accessMode ? (<AccountAccess mode={accessMode} onCancel={() => setAccessMode(null)} onSwitchMode={(next, address) => { if (next === "signup" || next === "forgot") setAccessMode(next); if (address) setLoginEmail(address); }} />) : null}<form hidden={Boolean(accessMode)} onSubmit={signIn} id="auth-panel" role="tabpanel" aria-labelledby={loginMode === "pin" ? "auth-tab-pin" : "auth-tab-email"}>
              {loginMode === "email" ? (
                <>
                  {/* type="text", not "email": clients, trainees, and interns sign in
                      with a bare username (no email account at all), and the native
                      email constraint would block anything without an @. */}
                  <label>Email or Username<input type="text" name="email" required value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="name@larsaeng.com or username" /></label>
                  <label>
                    Password
                    <span className="password-field">
                      <input type={showPassword ? "text" : "password"} name="password" required value={loginPass} onChange={(event) => setLoginPass(event.target.value)} autoComplete="current-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                      <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>
                        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </span>
                  </label>
                  <label className="auth-remember">
                    <input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />
                    <span>Keep me signed in</span>
                  </label>
                  
                </>
              ) : (
                <>
                  <label>Employee PIN<input type="text" className="pin-mask" required inputMode="numeric" value={loginPin} onChange={(event) => setLoginPin(event.target.value.replace(/\D/g, ""))} autoComplete="one-time-code" placeholder="Enter your PIN" /></label>
                  <p className="auth-hint">Quick access to your clock and personal performance points.</p>
                  <p className="auth-secondary"><button type="button" onClick={() => { setAccessMode("forgotPin"); setLoginError(""); }}>Forgot PIN?</button></p>
                </>
              )}
              <div className="auth-error" role="alert">{loginError}</div>
              <button type="submit" className="auth-submit">Sign In</button><p className="auth-secondary">{loginMode === "email" ? (<button type="button" onClick={() => { setAccessMode("forgot"); setLoginError(""); }}>Forgot password?</button>) : null}{signupOpen ? (<button type="button" onClick={() => { setAccessMode("signup"); setLoginError(""); }}>Create account</button>) : null}</p>
            </form>
          </section>
        </div>
      )}
      {exitHint && <div className="exit-hint" role="status" aria-live="polite">Press back again to exit</div>}
    </div>
  );
}

function EngineeringManagementPortal({
  viewer, users, sessions, rows, targets, go, onSaved, openTab,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  sessions: ClockSession[];
  rows: PerformanceRow[];
  targets: Record<string, number>;
  go: (id: string) => void;
  onSaved: () => void;
  /* Which section the sidebar entry that opened this asked for. The tabs still
     work on their own — this only decides where you arrive. */
  openTab?: EngineeringTab;
}) {
  const org = effectiveOrg(users);
  const manages = isResponsibleForOthers(org, viewer, users);
  /* The section the sidebar asked for. A management section reached by
     somebody who manages nobody would draw an empty page, so it falls back to
     the Dashboard rather than showing nothing. The sidebar already hides those
     entries; this covers every other way in. */
  const requestedTab: EngineeringTab =
    openTab && (manages || (openTab !== "time" && openTab !== "performance")) ? openTab : "dashboard";
  /* Derived rather than synchronised. The tab is whatever the sidebar asked
     for until somebody clicks a different one, and the click is stamped with
     the entry it was made under -- so arriving from a different sidebar entry
     lands on that entry's section instead of wherever you last clicked. No
     effect, so there is no render where the two disagree. */
  const [picked, setPicked] = useState<{ from: EngineeringTab | undefined; tab: EngineeringTab } | null>(null);
  const tab = picked && picked.from === openTab ? picked.tab : requestedTab;
  const setTab = (next: EngineeringTab) => setPicked({ from: openTab, tab: next });
  const today = dateInputValue(new Date());
  const start = new Date();
  start.setDate(start.getDate() - 6);
  const [from, setFrom] = useState(dateInputValue(start));
  const [to, setTo] = useState(today);
  const visibleIds = manages ? staffIdsVisibleTo(org, viewer, users) : new Set(viewer ? [viewer.id] : []);
  const visibleUsers = users.filter((user) => user.enabled !== false && visibleIds.has(user.id));
  const filteredSessions = sessions.filter((session) => visibleIds.has(session.uid) && withinDates(session.date, from, to));
  const filteredRows = rows.filter((row) => visibleIds.has(rowUserId(row, users)) && withinDates(rowDate(row), from, to));
  const setPeriod = (period: "today" | "week" | "month" | "sixMonths" | "year") => {
    const end = new Date();
    const begin = new Date(end);
    if (period === "week") begin.setDate(begin.getDate() - 6);
    if (period === "month") begin.setDate(begin.getDate() - 29);
    if (period === "sixMonths") begin.setMonth(begin.getMonth() - 6);
    if (period === "year") begin.setFullYear(begin.getFullYear() - 1);
    setFrom(dateInputValue(begin));
    setTo(dateInputValue(end));
  };
  const startMs = new Date(`${from}T00:00:00`).getTime();
  const endMs = new Date(`${to}T23:59:59`).getTime();
  const weeks = Math.max(1, (endMs - startMs + 1) / (7 * 86400000));
  const summaries = visibleUsers.map((user) => {
    const mineSessions = filteredSessions.filter((session) => session.uid === user.id);
    const mineRows = filteredRows.filter((row) => rowUserId(row, users) === user.id);
    const hours = mineSessions.reduce((sum, row) => sum + row.hours, 0);
    const submitted = mineRows.reduce((sum, row) => sum + finiteNumber(row["Submitted Points"]), 0);
    const approved = mineRows.reduce((sum, row) => sum + finiteNumber(row["Approved Points"]), 0);
    const target = Math.round((finiteNumber(targets[user.id]) || 50) * weeks);
    return { user, sessions: mineSessions.length, hours, entries: mineRows.length, submitted, approved, target };
  });

  return (
    <div className="native-scroll org-management-scroll">
      <section className="overview-hero home-hero">
        <span className="home-hero-mark" aria-hidden="true" />
        <div><span className="eyebrow">Teams</span><h2>Engineering Management</h2><p>Structure and team reports in one place.</p></div>
        {manages && <span className="access-pill"><Network size={16} /> Manager view</span>}
      </section>
      <div className="org-tabs" role="tablist" aria-label="Engineering management sections">
        <button type="button" role="tab" aria-selected={tab === "dashboard"} className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}>Dashboard</button>        <button type="button" role="tab" aria-selected={tab === "structure"} className={tab === "structure" ? "active" : ""} onClick={() => setTab("structure")}>Structure</button>
        {manages && <button type="button" role="tab" aria-selected={tab === "time"} className={tab === "time" ? "active" : ""} onClick={() => setTab("time")}>Timesheets</button>}
        {manages && <button type="button" role="tab" aria-selected={tab === "performance"} className={tab === "performance" ? "active" : ""} onClick={() => setTab("performance")}>Performance</button>}
        {manages && <button type="button" onClick={() => go("my-requests")}>Leave & Requests</button>}
      </div>
      {tab === "dashboard" && <HierarchyDashboard viewer={viewer} users={users} summaries={summaries} sessions={sessions} toneOf={modeTone} periodLabel={from + " to " + to} from={from} to={to} onPeriod={setPeriod} onFrom={setFrom} onTo={setTo} />}      {tab === "structure" && <OrgStructure viewer={viewer} users={users} onSaved={onSaved} />}
      {manages && (tab === "time" || tab === "performance") && <><TeamCharts summaries={summaries} mode={tab} />
        <div className="period-presets" aria-label="Team report period">
          <button type="button" onClick={() => setPeriod("today")}>Today</button><button type="button" onClick={() => setPeriod("week")}>7 days</button><button type="button" onClick={() => setPeriod("month")}>30 days</button><button type="button" onClick={() => setPeriod("sixMonths")}>6 months</button><button type="button" onClick={() => setPeriod("year")}>Year</button><span>Custom</span>
        </div>
        <section className="filter-toolbar history-filters">
          <label><span>From</span><input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
          <label><span>To</span><input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
          <span className="filter-summary">{visibleUsers.length} people</span>
        </section>
        <section className="report-panel">
          <div className="section-head"><div><span className="eyebrow">{tab === "time" ? "Team time" : "Team performance"}</span><h3>{from} to {to}</h3></div></div>
          <div className="data-table-wrap"><table className="data-table"><thead>{tab === "time"
            ? <tr><th>Employee</th><th>Department</th><th>Sessions</th><th>Hours</th></tr>
            : <tr><th>Employee</th><th>Department</th><th>Entries</th><th>Submitted</th><th>Approved</th><th>Target</th><th>Progress</th></tr>}
          </thead><tbody>
            {summaries.map((row) => tab === "time"
              ? <tr key={row.user.id}><td><b>{row.user.name}</b></td><td>{row.user.department || "—"}</td><td>{row.sessions}</td><td><b>{formatHours(row.hours)}</b></td></tr>
              : <tr key={row.user.id}><td><b>{row.user.name}</b></td><td>{row.user.department || "—"}</td><td>{row.entries}</td><td>{row.submitted}</td><td><b>{row.approved}</b></td><td>{row.target}</td><td>{row.target ? Math.round((row.approved / row.target) * 100) : 0}%</td></tr>)}
            {!summaries.length && <tr><td colSpan={tab === "time" ? 4 : 7}><div className="empty compact">No team data in this period.</div></td></tr>}
          </tbody></table></div>
        </section>
      </>}
    </div>
  );
}

function Overview({
  choose,
  user,
  method,
  recentId,
  recentTrail,
  summary,
}: {
  choose: (item: Item, channel?: NavChannel) => void;
  user: StaffUser | null;
  method: SignInMethod | null;
  recentId: string;
  recentTrail: string[];
  summary: HomeSummary;
}) {
  const open = (id: string, channel: NavChannel) => {
    const item = ITEMS.find((row) => row.id === id);
    if (item) choose(item, channel);
  };
  /* A work-area card opens that area's Dashboard.
     
     It used to open whichever page in the area the person happened to be
     allowed into first — and for Accounting that was accounting-hub, whose own
     description is "Choose an accounting area": an index page standing between
     someone and the overview they actually wanted. The Dashboard is the point
     of a work area, so it goes first.
     
     The fallback list is the previous behaviour, kept intact: somebody whose
     permissions do not include the Dashboard still lands on the first page
     they can open rather than on a refusal. So this changes where people
     arrive, never what they may reach. */
  const landingFor = (dashboardId: string, fallbacks: (Item | undefined)[]) => {
    const dashboard = ITEMS.find((item) => item.id === dashboardId);
    if (dashboard && canOpenInSession(user, dashboard, method)) return dashboard;
    return fallbacks.find((item): item is Item => Boolean(item && canOpenInSession(user, item, method)));
  };
  const byId = (id: string) => ITEMS.find((item) => item.id === id);

  const accountingLanding = landingFor("acc-dashboard", [
    ACCOUNTING_HUB_ITEM,
    ...(GROUPS.find((group) => group.label === "Accounting")?.items || []),
  ]);
  const hrLanding = landingFor("hr-dashboard",
    GROUPS.find((group) => group.label === "HR & Skills")?.items || []);
  /* Time is the exception, and deliberately so. Clock In / Out is already the
     overview — today's status, this week against the schedule, recent sessions,
     the way into a correction — so a separate Time Dashboard would be a second
     page showing the same figures with an extra click in front of them. It is
     also the thing people open Time to do. */
  const timeLanding = landingFor("quick-clock",
    ["week-schedule", "staff-timesheet", "my-requests", "live-presence"].map(byId));
  const performanceLanding = landingFor("staff-dashboard",
    ["performance-center", "performance-history", "staff-reports"].map(byId));
  const fullModules = [
    { id: timeLanding?.id || "quick-clock", channel: "time" as const, title: "Time & Attendance", text: "Clock, schedule, leave", icon: Timer, color: "green" },
    { id: performanceLanding?.id || "staff-performance", channel: "performance" as const, title: "Performance", text: "Points, targets, approvals", icon: TrendingUp, color: "violet" },
    { id: "org-structure", channel: "engineering" as const, title: "Engineering Management", text: "Departments, teams, reports", icon: Network, color: "blue" },      { id: hrLanding?.id || "hr-dashboard", channel: "hr" as const, title: "HR & Skills", text: "People, skills, records", icon: UserRoundSearch, color: "rose" },
    { id: accountingLanding?.id || "acc-dashboard", channel: "accounting" as const, title: "Accounting", text: "Finance, payroll, projects", icon: BadgeDollarSign, color: "amber" },
    { id: "admin", channel: "admin" as const, title: "Administration", text: "Users, access, data", icon: Settings, color: "slate" },
  ];
  const pinModules = [
    { id: "quick-clock", channel: "time" as const, title: "Clock In / Out", text: "Record your attendance in one tap", icon: Timer, color: "green" },
    { id: "my-points", channel: "performance" as const, title: "Add My Points", text: "Add and submit only your own points", icon: TrendingUp, color: "violet" },
    { id: "staff-development", channel: "performance" as const, title: "Development Portal", text: "Your learning hours, presentations, and evidence", icon: BookOpen, color: "rose" },
  ].filter((module) => {
    const item = ITEMS.find((row) => row.id === module.id);
    return item && canOpenInSession(user, item, method);
  });
  const modules = (method === "pin" ? pinModules : fullModules).filter((module) => {
    const item = ITEMS.find((row) => row.id === module.id);
    return item && canOpenInSession(user, item, method);
  });
  const recentItem = ITEMS.find((item) => item.id === recentId && canOpenInSession(user, item, method));
  /* Only areas this account may actually open are offered back. */
  const recentTrailItems = recentTrail
    .map((id: string) => ITEMS.find((item) => item.id === id && canOpenInSession(user, item, method)))
    .filter((item): item is Item => Boolean(item));
  const scope = DATA_SCOPES.find((row) => row.id === (user?.permissionProfile?.scope || defaultScopeForPreset(user?.access || "Engineer")));
  const quickCandidateIds = [
    "quick-clock",
    "my-pay",
    "my-points",
    "my-requests",
    "performance-center",
    "staff-development",
    hrLanding?.id,
    accountingLanding?.id,
    "access",
  ].filter((id): id is string => Boolean(id));
  const quickActions = (method === "pin" ? ["quick-clock", "my-points", "staff-development"] : quickCandidateIds)
    .map((id) => ITEMS.find((item) => item.id === id))
    .filter((item): item is Item => Boolean(item && canOpenInSession(user, item, method)))
    .slice(0, 4);
  const firstName = user?.name.split(/\s+/)[0] || "there";
  const quickAccess = method === "pin";
  const groupOrder: HomeReminder["group"][] = ["Today", "This week", "Development", "Requests"];
  const reminderGroups = groupOrder
    .map((group) => ({ group, rows: summary.reminders.filter((row) => row.group === group) }))
    .filter((entry) => entry.rows.length);
  const openReminder = (reminder: HomeReminder) => {
    if (!reminder.itemId) return;
    const item = ITEMS.find((row) => row.id === reminder.itemId);
    if (item && canOpenInSession(user, item, method)) choose(item, channelForItem(item));
  };
  const pointsPercent = summary.weekTarget
    ? Math.min(100, Math.round((summary.weekApproved / summary.weekTarget) * 100))
    : 0;

  return (
    <div className="native-scroll home-scroll">
      <section className={quickAccess ? "overview-hero home-hero quick" : "overview-hero home-hero"}>
        <span className="home-hero-mark" aria-hidden="true" />
        <div>
          <span className="eyebrow">{quickAccess ? "Quick access" : "Larsa Engineering"}</span>
          <h2>{greeting()}, {firstName}</h2>
          <p>{quickAccess ? "Attendance, points, and development." : "Your work areas and actions."}</p>
        </div>
        <span className="access-pill"><ShieldCheck size={16} /> {quickAccess ? "PIN access" : user?.access || user?.role}</span>
      </section>

      {summary.roleCards.length > 0 && (
        <section className="role-board" aria-label={summary.roleTitle}>
          <div className="section-head">
            <div><span className="eyebrow">{user?.access || user?.role || "Your role"}</span><h3>{summary.roleTitle}</h3></div>
            <span className="black-badge">{summary.roleBlurb}</span>
          </div>
          <div className="role-grid">
            {summary.roleCards.map((row) => (
              <button
                type="button"
                key={row.id}
                className={`role-card ${row.tone}`}
                onClick={() => {
                  if (!row.itemId) return;
                  const item = ITEMS.find((entry) => entry.id === row.itemId);
                  if (item && canOpenInSession(user, item, method)) choose(item, channelForItem(item));
                }}
                disabled={!row.itemId}
              >
                <small>{row.label}</small>
                <b>{row.value}</b>
                <em>{row.note}</em>
                {row.itemId && <ArrowRight size={15} />}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="home-board" aria-label="Your reminders">
        <div className="section-head">
          <div><span className="eyebrow">Your day</span><h3>Waiting on you</h3></div>
          <span className={summary.dueCount ? "black-badge due" : "black-badge"}>
            {summary.dueCount ? `${summary.dueCount} need attention` : "Nothing overdue"}
          </span>
        </div>
        {/* Today's shift and the weekly points already have their own tiles in
            the role summary above, so repeating them here only added length.
            What belongs here is where to carry on and what this account can
            reach — with Continue Working given the room to be useful. */}
        <div className="home-board-grid home-board-grid-lean">
          <button type="button" className="home-stat home-continue" onClick={() => recentItem && choose(recentItem, channelForItem(recentItem))} disabled={!recentItem}>
            <span><FileClock size={18} /></span>
            <div><small>Continue working</small><b>{recentItem?.label || "No recent area yet"}</b>
              <p>{recentItem ? "Pick up where you left off" : "Your last area appears here"}</p></div>
            <ArrowRight size={17} />
          </button>
          {recentTrailItems.length > 1 && (
            <article className="home-stat home-recent">
              <span><Timer size={18} /></span>
              <div><small>Recent</small>
                <div className="home-recent-list">
                  {recentTrailItems.slice(1, 4).map((entry: Item) => (
                    <button type="button" key={entry.id} onClick={() => choose(entry, channelForItem(entry))}>
                      {entry.label}
                    </button>
                  ))}
                </div>
              </div>
            </article>
          )}
          <article className="home-stat">
            <span><LockKeyhole size={18} /></span>
            <div><small>Data scope</small><b>{quickAccess ? "Own records" : scope?.label || "Assigned access"}</b>
              <p>{modules.length} work areas available</p></div>
          </article>
        </div>
        {reminderGroups.length > 0 && (
          <div className="reminder-columns">
            {reminderGroups.flatMap(({ group, rows }) =>
              rows.map((reminder) => (
                <button
                  type="button"
                  key={reminder.id}
                  className={`reminder-row ${reminder.tone}`}
                  onClick={() => openReminder(reminder)}
                  disabled={!reminder.itemId}
                >
                  <i aria-hidden="true" />
                  <span>
                    <label>{group}</label>
                    <b>{reminder.title}</b>
                    <small>{reminder.detail}</small>
                    {reminder.meta && <em>{reminder.meta}</em>}
                  </span>
                  {reminder.itemId && <ArrowRight size={15} />}
                </button>
              )),
            )}
          </div>
        )}
      </section>
      {/* `modules` is already filtered by canOpenInSession above, so the grid
          only ever receives cards this person may open — nothing unauthorised
          is rendered, and nothing unauthorised occupies a cell. The grid's job
          is only to arrange whatever survived that filter. */}
      <SmartCardGrid
        cards={modules.map((module) => {
          const Icon = module.icon;
          return {
            id: module.id,
            /* Work-area cards are a title, a line of copy and an Open affordance.
               That reads well across a third or a half, and a taller box would
               only add empty space under the text — so no Tall or Large here. */
            sizes: ["standard", "wide", "full"] as CardSize[],
            node: (
              <button type="button" className={`module-bubble ${module.color}`} onClick={() => open(module.id, module.channel)}>
                <span className="module-blob" aria-hidden="true" />
                <span className="module-orb"><Icon size={28} strokeWidth={2} /></span>
                <span className="module-copy"><b>{module.title}</b><small>{module.text}</small></span>
                <span className="module-open">Open</span>
              </button>
            ),
          };
        })}
        pageKey="home"
        userId={user?.id || ""}
        label="Available work areas"
        className={quickAccess ? "quick-grid" : ""}
      />
      {quickActions.length > 0 && <section className="home-quick-actions">
        <div className="section-head">
          <h3>Quick actions</h3>
        </div>
        <div className="quick-action-row">
          {quickActions.map((item) => {
            const Icon = ICONS[item.id] || ListChecks;
            return (
              <button type="button" key={item.id} onClick={() => choose(item, channelForItem(item))}>
                <span><Icon size={18} /></span>
                <b>{item.label}</b>
                <ArrowRight size={16} />
              </button>
            );
          })}
        </div>
      </section>}
    </div>
  );
}

function AdminCenter({
  choose,
  user,
}: {
  choose: (item: Item, channel?: NavChannel) => void;
  user: StaffUser | null;
}) {
  const tools = [
    {
      id: "access",
      title: "Users & Access",
      text: "Add users and set email, PIN, scope, and custom permissions",
      icon: UserCog,
      color: "blue",
    },
    {
      id: "staff-rules",
      title: "Rules & Constraints",
      text: "Manage company rules and employee constraints",
      icon: SlidersHorizontal,
      color: "amber",
    },
    {
      id: "admin-notifications",
      title: "Notifications",
      text: "Send a targeted message to a group or specific people",
      icon: Bell,
      color: "violet",
    },
    {
      id: "data",
      title: "Data Center",
      text: "Synchronize staff and manage backup or restore",
      icon: Database,
      color: "slate",
    },
  ].filter((tool) => {
    const item = ITEMS.find((row) => row.id === tool.id);
    return item && canOpen(user, item);
  });
  const open = (id: string) => {
    const item = ITEMS.find((row) => row.id === id);
    if (item) choose(item, "admin");
  };

  return (
    <div className="native-scroll admin-scroll">
      <section className="overview-hero admin-hero">
        <div>
          <span className="eyebrow">Administration</span>
          <h2>Admin Center</h2>
          <p>Manage users, custom permissions, rules, employee constraints, and protected data tools from one place.</p>
        </div>
        <span className="access-pill"><ShieldCheck size={16} /> Admin only</span>
      </section>
      {/* `tools` is filtered by canOpen just above, so the same guarantee holds
          here: only authorised tools ever reach the grid. */}
      <SmartCardGrid
        cards={tools.map((tool) => {
          const Icon = tool.icon;
          return {
            id: tool.id,
            sizes: ["standard", "wide", "full"] as CardSize[],
            node: (
              <button type="button" className={`module-bubble ${tool.color}`} onClick={() => open(tool.id)}>
                <span className="module-orb"><Icon size={28} strokeWidth={2} /></span>
                <span className="module-copy"><b>{tool.title}</b><small>{tool.text}</small></span>
                <span className="module-open">Open</span>
              </button>
            ),
          };
        })}
        pageKey="admin"
        userId={user?.id || ""}
        label="Administrative tools"
        className="admin-grid"
      />
      <section className="architecture admin-note">
        <span><ShieldCheck size={28} /></span>
        <div>
          <h3>Custom permissions remain active</h3>
          <p>Each administrative account sees only the tools allowed by its assigned permissions. Super Admin retains complete control.</p>
        </div>
      </section>
    </div>
  );
}

type NotifyGroup = "all" | "managers" | "accountants" | "engineers" | "selected";
const NOTIFY_GROUP_MATCH: Partial<Record<NotifyGroup, string[]>> = {
  managers: ["Super Admin", "Manager", "Team Leader"],
  accountants: ["Accountant", "Admin HR"],
  engineers: ["Engineer", "Construction Engineer", "Viewer"],
};

/* How long ago, in the fewest words that stay true. "3m" beats a timestamp in
   a list you are scanning; the full date is still in the title attribute for
   anyone who needs it. */
function notifyAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const NOTIFY_PAGE = 12;
/* Dismissing the "alerts are off here" prompt is per device, and permanent:
   somebody who has decided this laptop should stay quiet should not be asked
   again every time they open the bell. Settings still has the switch. */
const BELL_NUDGE_KEY = "larsa-bell-nudge-dismissed";

/* The bell. The permanent, authoritative notification centre: everything that
   was ever raised for this person is reachable here, from any device they sign
   in on, whatever their alert preferences say. Preferences live in Settings and
   govern only what happens OUTSIDE the app. */
function NotificationBell({
  user, counts, tick, onChanged, onOpen, onClose, onSettings, localFallback,
}: {
  user: StaffUser;
  counts: NotifyCounts;
  tick: number;
  onChanged: () => void;
  onOpen: (row: { id: string; itemId?: string | null }) => void;
  onClose: () => void;
  onSettings: () => void;
  localFallback: AppNotification[];
}) {
  const [scope, setScope] = useState<"all" | "unread" | "archived">("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<NotifyRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(true);
  const [reachable, setReachable] = useState(true);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [anchor, setAnchor] = useState<{ top: number; end: number } | null>(null);
  /* Whether THIS browser will ever receive an alert. A working bell and a
     silent phone look identical from here, which is exactly why somebody
     concludes "notifications don't work" — the records are arriving fine and
     nothing ever told them the device was never subscribed. */
  const [deviceState, setDeviceState] = useState<"checking" | "on" | "off" | "denied" | "home-screen" | "unsupported">("checking");
  const [enabling, setEnabling] = useState(false);
  /* Read once, lazily. The panel only ever mounts after a click, so there is
     no server render to disagree with — and reading it here rather than in an
     effect means the prompt never flashes up before being hidden again. */
  const [nudgeHidden, setNudgeHidden] = useState(() => {
    try { return localStorage.getItem(BELL_NUDGE_KEY) === "1"; } catch { return false; }
  });
  const offline = !notifyConfigured();

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      if (!pushSupported()) { if (!cancelled) setDeviceState("unsupported"); return; }
      if (pushNeedsHomeScreen()) { if (!cancelled) setDeviceState("home-screen"); return; }
      if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        if (!cancelled) setDeviceState("denied");
        return;
      }
      const has = await thisDeviceSubscribed();
      if (!cancelled) setDeviceState(has ? "on" : "off");
    };
    void read();
    return () => { cancelled = true; };
  }, [tick]);

  const enableHere = async () => {
    setEnabling(true);
    const outcome = await subscribeToPush(user.id, user.name);
    setEnabling(false);
    setDeviceState(outcome.ok ? "on"
      : outcome.state === "denied" ? "denied"
      : outcome.state === "needs-home-screen" ? "home-screen"
      : outcome.state === "unsupported" ? "unsupported" : "off");
  };

  const hideNudge = () => {
    setNudgeHidden(true);
    try { localStorage.setItem(BELL_NUDGE_KEY, "1"); } catch { /* private mode */ }
  };

  /* The panel is rendered into <body>, not next to the bell.
     The topbar carries backdrop-filter, and a filtered element becomes the
     containing block for its fixed-position descendants — so a sheet asking to
     sit at the bottom of the screen would instead sit at the bottom of the
     topbar. Portalling out sidesteps that, and the anchor is then measured
     from the button rather than assumed from the bar's height, which also
     keeps it right under an installed window's title-bar inset. */
  useEffect(() => {
    const place = () => {
      const button = document.querySelector(".notif-button");
      if (!button) return;
      const box = button.getBoundingClientRect();
      setAnchor({ top: Math.round(box.bottom + 10), end: Math.round(window.innerWidth - box.right) });
    };
    const timer = window.setTimeout(place, 0);
    window.addEventListener("resize", place);
    return () => { clearTimeout(timer); window.removeEventListener("resize", place); };
  }, []);

  // Typing in the search box should not fire a query per keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => { setQuery(search); setPage(0); }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  /* With no backend configured there is nothing to fetch: this device's own
     copy IS the feed, so it is derived during render rather than pushed into
     state by an effect. */
  /* This device's own copy, shaped like a feed. Used when there is no backend
     at all, and again when there is one that cannot be reached. */
  const mirrorRows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const mine = localFallback
      .filter((row) => (scope === "unread" ? !row.read : scope === "archived" ? false : true))
      .filter((row) => !needle || `${row.title} ${row.body}`.toLowerCase().includes(needle));
    return {
      total: mine.length,
      items: mine.slice(0, (page + 1) * NOTIFY_PAGE).map((row): NotifyRow => ({
        id: row.id, event: row.event, category: "system", title: row.title, body: row.body,
        itemId: row.itemId || null, actorName: row.fromName, createdAt: row.at,
        readAt: row.read ? row.at : null, archivedAt: null,
      })),
    };
  }, [localFallback, scope, query, page]);

  const localRows = useMemo(() => (offline ? mirrorRows : null), [offline, mirrorRows]);

  useEffect(() => {
    if (offline) return;
    let cancelled = false;
    // "Show older" asks for a longer page rather than a second one, so the list
    // you are already reading stays put instead of being replaced under you.
    const wanted = NOTIFY_PAGE * (page + 1);
    fetchFeed({ id: user.id, name: user.name }, { scope, search: query, limit: wanted, offset: 0 })
      .then((feed) => {
        if (cancelled) return;
        setRows(feed.items);
        setTotal(feed.total);
        setReachable(feed.reachable);
        setBusy(false);
      })
      .catch(() => { if (!cancelled) { setReachable(false); setBusy(false); } });
    return () => { cancelled = true; };
  }, [user.id, user.name, scope, query, page, tick, offline]);

  // Click-away and Escape, the two ways anyone expects a panel like this to close.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    // Typed against the DOM MouseEvent explicitly: React's synthetic MouseEvent
    // is in scope here and would otherwise win the name.
    const onDown = (event: globalThis.MouseEvent) => {
      const node = panelRef.current;
      if (!node) return;
      const target = event.target as Node;
      if (!node.contains(target) && !(target as HTMLElement)?.closest?.(".notif-button")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const act = async (ids: string[], action: "read" | "unread" | "archive" | "unarchive") => {
    if (usingLocal || !ids.length) return;
    await markNotifications({ id: user.id, name: user.name }, ids, action);
    onChanged();
  };

  const allRead = async () => {
    if (usingLocal) return;
    await markAllRead({ id: user.id, name: user.name });
    onChanged();
  };

  /* Unreachable is not the same as empty. If the server could not be asked,
     fall back to this device's own copy and say so, rather than showing a
     confidently empty bell — or worse, a spinner that never stops, which is
     the most convincing way an app has of looking broken. */
  const usingLocal = Boolean(localRows) || (!offline && !reachable);
  const feedRows = localRows ? localRows.items : (!reachable ? mirrorRows.items : rows);
  const feedTotal = localRows ? localRows.total : (!reachable ? mirrorRows.total : total);
  const shown = feedRows.length;

  const panel = (
    <div
      className="bell-panel"
      ref={panelRef}
      role="dialog"
      aria-label="Notifications"
      style={anchor
        ? ({ "--bell-top": `${anchor.top}px`, "--bell-end": `${anchor.end}px` } as CSSProperties)
        : undefined}
    >
      <header className="bell-head">
        <div>
          <b>Notifications</b>
          <small>{counts.unread ? `${counts.unread} unread` : "All caught up"}</small>
        </div>
        <div className="bell-head-actions">
          {counts.unread > 0 && (
            <button type="button" onClick={allRead} title="Mark everything as read">
              <CheckCircle2 size={15} /> Mark all read
            </button>
          )}
          <button type="button" onClick={onSettings} title="Notification settings" aria-label="Notification settings">
            <Settings size={15} />
          </button>
          <button type="button" onClick={onClose} aria-label="Close notifications"><X size={15} /></button>
        </div>
      </header>

      <div className="bell-filters" role="tablist" aria-label="Filter notifications">
        {([["all", "All", counts.all], ["unread", "Unread", counts.unread], ["archived", "Archived", counts.archived]] as const)
          .map(([id, label, count]) => (
            <button
              key={id} type="button" role="tab" aria-selected={scope === id}
              className={scope === id ? "active" : ""}
              onClick={() => { setScope(id); setPage(0); }}
            >
              {label}{count > 0 && <i>{count}</i>}
            </button>
          ))}
      </div>

      <label className="bell-search">
        <Search size={14} aria-hidden="true" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search notifications"
          aria-label="Search notifications"
        />
        {search && <button type="button" onClick={() => setSearch("")} aria-label="Clear search"><X size={13} /></button>}
      </label>

      {!offline && !nudgeHidden && deviceState !== "checking" && deviceState !== "on" && (
        <div className={deviceState === "off" ? "bell-nudge" : "bell-nudge warn"}>
          <BellOff size={15} aria-hidden="true" />
          <span>
            <b>
              {deviceState === "off" ? "Alerts are off on this device"
                : deviceState === "denied" ? "Notifications are blocked here"
                : deviceState === "home-screen" ? "Add Larsa Control to your Home Screen"
                : "This browser cannot show alerts"}
            </b>
            <small>
              {deviceState === "off" ? "Notifications land here either way. Turn them on to be told when the app is closed."
                : deviceState === "denied" ? "Allow notifications for this site in your browser settings, then reopen this panel."
                : deviceState === "home-screen" ? "Tap Share, then Add to Home Screen. iPhone and iPad only deliver alerts to the installed app."
                : "Notifications still arrive here. Try Chrome, Edge, Firefox or Safari to also be alerted outside the app."}
            </small>
          </span>
          {deviceState === "off" && (
            <button type="button" className="primary" disabled={enabling} onClick={enableHere}>
              {enabling ? "Turning on…" : "Turn on"}
            </button>
          )}
          <button type="button" className="bell-nudge-close" onClick={hideNudge} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      )}

      <div className="bell-list">
        {busy && !shown && !usingLocal && <div className="bell-empty">Loading…</div>}
        {(!busy || usingLocal) && !shown && (
          <div className="bell-empty">
            {query ? `Nothing matches “${query}”.`
              : scope === "unread" ? "Nothing unread. You are all caught up."
              : scope === "archived" ? "Nothing archived yet."
              : "No notifications yet. They appear here as work happens."}
          </div>
        )}
        {feedRows.map((row) => (
          <article key={row.id} className={row.readAt ? "bell-row" : "bell-row unread"}>
            <button type="button" className="bell-open" onClick={() => onOpen({ id: row.id, itemId: row.itemId })}>
              <i aria-hidden="true" className={`bell-dot cat-${row.category}`} />
              <span>
                <b>{row.title}</b>
                {row.body && <small>{row.body}</small>}
                <em title={new Date(row.createdAt).toLocaleString()}>
                  {row.actorName} · {notifyAgo(row.createdAt)}
                </em>
              </span>
            </button>
            <div className="bell-row-actions">
              {!usingLocal && (
                <button
                  type="button"
                  onClick={() => act([row.id], row.readAt ? "unread" : "read")}
                  aria-label={row.readAt ? "Mark as unread" : "Mark as read"}
                  title={row.readAt ? "Mark as unread" : "Mark as read"}
                >
                  {row.readAt ? <Circle size={14} /> : <CheckCircle2 size={14} />}
                </button>
              )}
              {!usingLocal && (
                <button
                  type="button"
                  onClick={() => act([row.id], row.archivedAt ? "unarchive" : "archive")}
                  aria-label={row.archivedAt ? "Restore from archive" : "Archive"}
                  title={row.archivedAt ? "Restore" : "Archive"}
                >
                  {row.archivedAt ? <ArrowLeft size={14} /> : <Archive size={14} />}
                </button>
              )}
            </div>
          </article>
        ))}
        {shown < feedTotal && (
          <button type="button" className="bell-more" onClick={() => setPage((value) => value + 1)}>
            Show older ({feedTotal - shown} more)
          </button>
        )}
      </div>

      <footer className="bell-foot">
        {offline
          ? "Showing this device only — no account storage is configured, so notifications are not shared between devices."
          : !reachable
            ? "Offline — showing what this device already had. Your notifications are safe and will reappear when the connection returns."
            : "Every notification stays here permanently, on every device you sign in on."}
      </footer>
    </div>
  );

  // Measure first: rendering at the wrong place and then jumping is worse
  // than appearing a frame later in the right one.
  if (!anchor || typeof document === "undefined") return null;
  /* Into the shell root, not <body>. Far enough out to escape the topbar's
     backdrop-filter, but still inside .unified-app — so `.unified-app.dark
     .bell-panel` keeps matching and the panel is not a white rectangle in a
     dark app. The shell root is a plain grid with no transform or filter of
     its own, so fixed positioning still resolves against the viewport. */
  const host = document.querySelector(".unified-app") || document.body;
  return createPortal(panel, host);
}

function NotificationsCenter({
  users,
  currentUser,
}: {
  users: StaffUser[];
  currentUser: StaffUser | null;
}) {
  const [group, setGroup] = useState<NotifyGroup>("all");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [pushToo, setPushToo] = useState(true);
  const [log, setLog] = useState<AppNotification[]>([]);
  const [status, setStatus] = useState("");

  useEffect(() => { setLog(readNotifications()); }, []);

  const active = useMemo(() => users.filter((person) => person.enabled !== false), [users]);
  const recipients = useMemo(() => {
    if (group === "selected") return active.filter((person) => selected[person.id]);
    const allow = NOTIFY_GROUP_MATCH[group];
    return allow ? active.filter((person) => allow.includes(person.access || "")) : active;
  }, [active, group, selected]);

  const send = () => {
    if (!subject.trim() && !message.trim()) { setStatus("Add a subject or a message first."); return; }
    if (!recipients.length) { setStatus("No recipients matched that group."); return; }
    // Push defaults on for admin.broadcast (see DEFAULT_NOTIFY_PREFS), but the
    // sender can turn it off per-send for an in-app-only heads-up; the
    // in-app item is always written so it shows up in the bell either way.
    const targets = pushToo
      ? recipients
      : recipients.map((person) => ({
        ...person,
        notifyPrefs: { ...person.notifyPrefs, "admin.broadcast": { ...person.notifyPrefs?.["admin.broadcast"], push: false } },
      }));
    raiseNotification({
      event: "admin.broadcast",
      title: subject.trim() || "Notification",
      body: message.trim(),
      fromName: currentUser?.name || "Larsa Control",
      itemId: "admin-notifications",
      recipients: targets,
    });
    setLog(readNotifications());
    setStatus(`Sent to ${recipients.length} ${recipients.length === 1 ? "person" : "people"}.`);
    setSubject("");
    setMessage("");
  };

  return (
    <div className="native-scroll">
      <section className="overview-hero">
        <div>
          <span className="eyebrow">Administration</span>
          <h2>Notifications</h2>
          <p>Send a message to a group or to specific people. It lands in their notification bell, and reaches their devices with push if they have it enabled.</p>
        </div>
        <span className="access-pill"><Bell size={16} /> {active.length} staff on record</span>
      </section>

      <section className="settings-panel">
        <div className="settings-fields">
          <label>
            Target group
            <select value={group} onChange={(event) => setGroup(event.target.value as NotifyGroup)}>
              <option value="all">All staff</option>
              <option value="managers">Managers</option>
              <option value="accountants">Accountants</option>
              <option value="engineers">Engineers &amp; staff</option>
              <option value="selected">Specific people</option>
            </select>
          </label>
          <label>
            Subject
            <input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="e.g. Office closed Friday" />
          </label>
        </div>
        <div className="settings-fields">
          <label style={{ gridColumn: "1 / -1" }}>
            Message
            <textarea rows={4} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Write the message..." />
          </label>
        </div>

        {group === "selected" && (
          <div className="project-check-list" aria-label="Choose recipients">
            {active.map((person) => (
              <label key={person.id}>
                <input
                  type="checkbox"
                  checked={Boolean(selected[person.id])}
                  onChange={() => setSelected((prev) => ({ ...prev, [person.id]: !prev[person.id] }))}
                />
                <span><b>{person.name}</b><small>{person.access || "Engineer"}</small></span>
              </label>
            ))}
            {!active.length && <span className="muted">No staff on record yet.</span>}
          </div>
        )}

        <label className="notify-push">
          <input type="checkbox" checked={pushToo} onChange={(event) => setPushToo(event.target.checked)} />
          Also push to their devices, not just the in-app bell
        </label>

        <div className="notify-send-row">
          <button type="button" className="primary" onClick={send}>
            Send to {recipients.length} {recipients.length === 1 ? "person" : "people"}
          </button>
          {status && <span className="status">{status}</span>}
        </div>
      </section>

      <section className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>To</th><th>Subject</th><th>From</th></tr></thead>
          <tbody>
            {log.slice(0, 40).map((item) => (
              <tr key={item.id}>
                <td>{new Date(item.at).toLocaleString()}</td>
                <td>{active.find((person) => person.id === item.toId)?.name || item.toId}</td>
                <td><b>{item.title}</b>{item.body && <div className="muted">{item.body}</div>}</td>
                <td>{item.fromName}</td>
              </tr>
            ))}
            {!log.length && <tr><td colSpan={4} className="muted">Nothing sent from this device yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function accessProfileForUser(user: StaffUser): PermissionProfile {
  if (user.permissionProfile) {
    return {
      ...user.permissionProfile,
      grants: Object.fromEntries(
        Object.entries(user.permissionProfile.grants).map(([id, actions]) => [id, { ...actions }]),
      ),
    };
  }
  const profile = presetPermissionProfile(user.access || "Engineer");
  ACCESS_GROUPS.forEach((group) => {
    group.items.forEach((item) => {
      permissionActionsFor(item).forEach((action) => {
        profile.grants[item.id][action] = hasItemPermission(user, item, action);
      });
    });
  });
  return profile;
}

function PerformanceCenter({
  viewer,
  users,
  rows,
  targets,
  saveTarget,
  reviewRow,
  openWorkboard,
  store,
  setLock,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  rows: PerformanceRow[];
  targets: Record<string, number>;
  saveTarget: (userId: string, target: number) => boolean;
  reviewRow: (rowId: string, status: "Approved" | "Returned", approvedPoints?: number) => boolean;
  openWorkboard: () => void;
  store: Record<string, unknown> | null;
  setLock: (week: string, locked: boolean, note?: string) => boolean;
}) {
  const [week, setWeek] = useState(isoWeekLabel());
  const [approvalDrafts, setApprovalDrafts] = useState<Record<string, string>>({});
  const [lockNote, setLockNote] = useState("");
  const visibleUsers = scopedUsers(viewer, users);
  const visibleIds = new Set(visibleUsers.map((user) => user.id));
  const weeks = [...new Set([
    isoWeekLabel(),
    ...rows.map((row) => {
      if (row.Week) return String(row.Week);
      const date = rowDate(row);
      return date ? isoWeekLabel(new Date(`${date}T12:00:00`)) : "";
    }).filter(Boolean),
  ])].sort().reverse();
  const weekRows = rows.filter((row) => {
    const userId = rowUserId(row, users);
    const date = rowDate(row);
    const rowWeek = String(row.Week || (date ? isoWeekLabel(new Date(`${date}T12:00:00`)) : ""));
    return visibleIds.has(userId) && rowWeek === week;
  });
  const summaries = visibleUsers.map((user) => {
    const employeeRows = weekRows.filter((row) => rowUserId(row, users) === user.id);
    const submitted = employeeRows.reduce((sum, row) => sum + finiteNumber(row["Submitted Points"]), 0);
    const approved = employeeRows.reduce((sum, row) => sum + finiteNumber(row["Approved Points"]), 0);
    const target = Math.max(1, finiteNumber(targets[user.id]) || 50);
    return {
      user,
      target,
      submitted,
      approved,
      entries: employeeRows.length,
      pending: employeeRows.filter((row) => !["Approved", "Returned"].includes(String(row.Status || ""))).length,
      completion: Math.max(0, Math.round((approved / target) * 100)),
    };
  });
  const totalTarget = summaries.reduce((sum, row) => sum + row.target, 0);
  const totalSubmitted = summaries.reduce((sum, row) => sum + row.submitted, 0);
  const totalApproved = summaries.reduce((sum, row) => sum + row.approved, 0);
  const peopleOnTarget = summaries.filter((row) => row.approved >= row.target).length;
  const canManageTargets = Boolean(
    viewer
    && (
      hasItemPermission(viewer, PERFORMANCE_TARGETS_ITEM, "manage")
      || hasItemPermission(viewer, PERFORMANCE_CENTER_ITEM, "manage")
    ),
  );
  const canApprove = Boolean(viewer && hasItemPermission(viewer, PERFORMANCE_REVIEW_ITEM, "approve"));
  const canExport = Boolean(viewer && hasItemPermission(viewer, PERFORMANCE_CENTER_ITEM, "export"));
  /* Locking rides on the same permission as setting targets: whoever owns the
     weekly numbers decides when they stop moving. */
  const lock = weekLocks(store)[week] || null;
  /* Entries filled in for this week while it was closed, still waiting on a
     decision. Shown here because this is the screen the person closing the week
     is already looking at; the decision itself is made in Leave & Requests,
     which owns the approval permission. */
  const lateWaiting = (Array.isArray(store?.approvals) ? store.approvals as LeaveRequest[] : [])
    .filter((row) => row.type === "Points Unlock" && row.week === week && row.status === "Pending"
      && visibleIds.has(row.uid));
  const canOpenWorkboard = Boolean(
    viewer && canOpen(viewer, ITEMS.find((item) => item.id === "staff-performance")!),
  );
  const exportSummary = () => {
    downloadRows(`larsa-weekly-points-${week}.csv`, [
      ["Week", "Employee", "Department", "Target", "Submitted", "Approved", "Completion %", "Entries"],
      ...summaries.map((row) => [
        week,
        row.user.name,
        row.user.department || "",
        row.target,
        row.submitted,
        row.approved,
        row.completion,
        row.entries,
      ]),
    ]);
  };

  return (
    <div className="native-scroll performance-scroll">
      <section className="overview-hero performance-hero">
        <div>
          <span className="eyebrow">Weekly performance</span>
          <h2>Performance</h2>
          <p>Weekly points, targets, and approvals.</p>
        </div>
        <div className="hero-actions">
          {canExport && <button type="button" onClick={exportSummary}><FileSpreadsheet size={16} /> Export Week</button>}
          {canOpenWorkboard && <button type="button" className="primary" onClick={openWorkboard}>Detailed Workboard <ArrowRight size={16} /></button>}
        </div>
      </section>

      {/* Weeks with entries used to be the only ones reachable, because the
          picker was built from performance rows -- so a week nobody had
          submitted to yet, which is exactly the kind of week someone wants to
          pre-lock, could never be selected at all. This now walks any week,
          forward or backward, and jumps straight to one by date. */}
      <section className="filter-toolbar week-nav">
        <div className="week-nav-controls">
          <button type="button" aria-label="Previous week" onClick={() => setWeek(shiftWeek(week, -1))}><ChevronLeft size={16} /></button>
          <div className="week-nav-current">
            <b>{week}</b>
            <small>{weekBounds(week).from} → {weekBounds(week).to}</small>
          </div>
          <button type="button" aria-label="Next week" onClick={() => setWeek(shiftWeek(week, 1))}><ChevronRight size={16} /></button>
        </div>
        {week !== isoWeekLabel() && (
          <button type="button" className="secondary" onClick={() => setWeek(isoWeekLabel())}>This week</button>
        )}
        <label className="week-nav-jump">
          <span>Jump to date</span>
          <input type="date" value={weekBounds(week).from} onChange={(event) => { if (event.target.value) setWeek(weekOfDate(event.target.value)); }} />
        </label>
        {weeks.length > 1 && (
          <label className="week-nav-jump">
            <span>Weeks with entries</span>
            <select value={weeks.includes(week) ? week : ""} onChange={(event) => { if (event.target.value) setWeek(event.target.value); }}>
              <option value="">Choose…</option>
              {weeks.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        )}
        <span className={lock ? "filter-summary locked" : "filter-summary"}>
          {lock ? <><Lock size={14} /> Closed</> : <><LockOpen size={14} /> Open for entry</>}
        </span>
        <span className="filter-summary">{visibleUsers.length} employee{visibleUsers.length === 1 ? "" : "s"} in this view</span>
      </section>

      {/* Closing the week is a deliberate weekly act, not a schedule -- so it is
          a button somebody presses, and it says plainly what it stops. Review is
          untouched by it: approving points is exactly what a closed week is for. */}
      {canManageTargets && (
        <section className={lock ? "week-lock closed" : "week-lock"}>
          <div className="section-head">
            <div>
              <span className="eyebrow">Week {week}</span>
              <h3>{lock ? "Entry is closed" : "Entry is open"}</h3>
            </div>
            <span className="black-badge">{lock ? <Lock size={14} /> : <LockOpen size={14} />}</span>
          </div>
          <p className="week-lock-note">
            {lock
              ? `Locked by ${lock.lockedBy} on ${(lock.lockedAt || "").slice(0, 10)}. Employees cannot add points to this week unless you approve their request. Reviewing and approving what is already in it still works normally.`
              : "Employees can add and submit points for this week. Lock it once the week's work is final — usually Saturday."}
          </p>
          {lock?.note && <p className="week-lock-note quoted">“{lock.note}”</p>}
          {!lock && (
            <label className="week-lock-field">
              Note for the team <small>Optional — shown with the lock</small>
              <input value={lockNote} onChange={(event) => setLockNote(event.target.value)} placeholder="Example: week closed, payroll cut-off" />
            </label>
          )}
          <div className="form-actions">
            {lock ? (
              <button type="button" onClick={() => setLock(week, false)}><LockOpen size={15} /> Reopen week {week}</button>
            ) : (
              <button type="button" className="primary" onClick={() => { if (setLock(week, true, lockNote)) setLockNote(""); }}>
                <Lock size={15} /> Lock week {week}
              </button>
            )}
          </div>
          {Boolean(lateWaiting.length) && (
            <div className="lock-exceptions">
              <span className="eyebrow">Late entries waiting for a decision</span>
              <ul>
                {lateWaiting.map((row) => (
                  <li key={row.id}>
                    <div>
                      <b>{users.find((user) => user.id === row.uid)?.name || row.uid} — {entryLine(row.entry)}</b>
                      <small>{row.date} · {row.reason}</small>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="week-lock-note">Approve or decline these in Leave &amp; Requests. Approving adds the entry to this week and sends it on for the normal points review.</p>
            </div>
          )}
        </section>
      )}

      <section className="focus-grid">
        <article className="focus-card">
          <div className="section-head"><div><span className="eyebrow">This week</span><h3>Approved against target</h3></div></div>
          <div className="focus-ring">
            <Ring value={totalApproved} target={totalTarget} caption="points" />
            <ul className="focus-legend">
              <li><i className="dot-blue" /><span>Approved</span><b>{totalApproved.toLocaleString()}</b></li>
              <li><i className="dot-soft" /><span>Submitted</span><b>{totalSubmitted.toLocaleString()}</b></li>
              <li><i className="dot-line" /><span>Team target</span><b>{totalTarget.toLocaleString()}</b></li>
              <li><i className="dot-ok" /><span>On target</span><b>{peopleOnTarget} / {summaries.length}</b></li>
            </ul>
          </div>
        </article>
        <article className="focus-card">
          <div className="section-head"><div><span className="eyebrow">Per employee</span><h3>Approved points</h3></div>
            <span className="black-badge">{week}</span></div>
          {/* Rows have room for the whole name; the column chart did not. */}
          <MiniBars ariaLabel="Approved points by employee"
            data={summaries.map((row) => ({ label: row.user.name, value: row.approved }))} />
        </article>
      </section>

      <section className="metric-grid" aria-label="Weekly points summary">
        <article><span><Target size={19} /></span><small>Team target</small><b>{totalTarget.toLocaleString()}</b><p>points this week</p></article>
        <article><span><TrendingUp size={19} /></span><small>Submitted</small><b>{totalSubmitted.toLocaleString()}</b><p>before review</p></article>
        <article><span><Award size={19} /></span><small>Approved</small><b>{totalApproved.toLocaleString()}</b><p>{totalTarget ? Math.round((totalApproved / totalTarget) * 100) : 0}% of target</p></article>
        <article><span><CheckCircle2 size={19} /></span><small>On target</small><b>{peopleOnTarget} / {summaries.length}</b><p>employees at 100%+</p></article>
      </section>

      <section className="report-panel">
        <div className="section-head">
          <div><span className="eyebrow">Employee comparison</span><h3>Weekly target progress</h3></div>
          {canManageTargets && <span className="black-badge">Targets are editable</span>}
        </div>
        <div className="data-table-wrap">
          <table className="data-table target-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Weekly Target</th>
                <th>Total</th>
                <th>Approved</th>
                <th>Progress</th>
                <th>Entries</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((row) => (
                <tr key={row.user.id}>
                  <td><b>{row.user.name}</b><small>{row.user.department || row.user.role || "Employee"}</small></td>
                  <td>
                    {canManageTargets ? (
                      <div className="target-control">
                        <select
                          value={[30, 50, 100].includes(row.target) ? row.target : "custom"}
                          onChange={(event) => {
                            if (event.target.value !== "custom") saveTarget(row.user.id, Number(event.target.value));
                          }}
                          aria-label={`Weekly target preset for ${row.user.name}`}
                        >
                          <option value={30}>30 points</option>
                          <option value={50}>50 points</option>
                          <option value={100}>100 points</option>
                          <option value="custom">Custom</option>
                        </select>
                        <input
                          key={`${row.user.id}-${row.target}`}
                          type="number"
                          min="1"
                          defaultValue={row.target}
                          aria-label={`Custom weekly target for ${row.user.name}`}
                          onBlur={(event) => {
                            const next = finiteNumber(event.target.value);
                            if (next > 0 && next !== row.target) saveTarget(row.user.id, next);
                          }}
                        />
                      </div>
                    ) : <b>{row.target}</b>}
                  </td>
                  <td>{row.submitted.toLocaleString()}</td>
                  <td><b>{row.approved.toLocaleString()}</b></td>
                  <td>
                    <div className="progress-cell">
                      <div role="progressbar" aria-valuenow={row.completion} aria-valuemin={0} aria-valuemax={100} aria-label={`${row.user.name} weekly target progress`}>
                        <span style={{ width: `${Math.min(100, row.completion)}%` }} />
                      </div>
                      <b className={row.completion >= 100 ? "positive" : ""}>{row.completion}%</b>
                    </div>
                  </td>
                  <td>{row.entries}<small>{row.pending ? `${row.pending} awaiting review` : "No pending review"}</small></td>
                </tr>
              ))}
              {!summaries.length && <tr><td colSpan={6}><div className="empty compact">No employees are available in your current scope.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="report-panel">
        <div className="section-head">
          <div><span className="eyebrow">Point entries</span><h3>{week} review queue and history</h3></div>
          <span className="black-badge">{weekRows.length} records</span>
        </div>
        <div className="data-table-wrap">
          <table className="data-table points-review-table">
            <thead>
              <tr><th>Date</th><th>Employee</th><th>Job</th><th>Assigned</th><th>Total</th><th>Approved</th><th>Status</th>{canApprove && <th>Review</th>}</tr>
            </thead>
            <tbody>
              {weekRows.map((row) => {
                const submitted = finiteNumber(row["Submitted Points"]);
                const status = String(row.Status || "Draft");
                return (
                  <tr key={row.id}>
                    <td>{rowDate(row) || "—"}</td>
                    <td><b>{row.Engineer || ""}</b><small>{row.Department || ""}</small></td>
                    <td><b>{String(row["Job Number"] || row.Project || "General")}</b><small>{String(row["Work Category"] || "")}</small></td>
                    <td>{finiteNumber(row["Assigned Points"] ?? row["Estimated Points"]) || "—"}</td>
                    <td>{submitted}</td>
                    <td>{finiteNumber(row["Approved Points"])}</td>
                    <td><span className={`record-status ${status.toLowerCase().replace(/\s+/g, "-")}`}>{status}</span></td>
                    {canApprove && <td>
                      {status === "Approved" ? <span className="review-complete"><CheckCircle2 size={15} /> Reviewed</span> : (
                        <div className="review-actions">
                          <input
                            type="number"
                            min="0"
                            value={approvalDrafts[row.id] ?? String(submitted)}
                            onChange={(event) => setApprovalDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
                            aria-label={`Approved points for ${row.Engineer || "employee"}`}
                          />
                          <button type="button" className="approve" onClick={() => {
                            const entered = approvalDrafts[row.id];
                            const points = entered === undefined || entered.trim() === ""
                              ? submitted
                              : finiteNumber(entered);
                            reviewRow(row.id, "Approved", points);
                          }}>Approve</button>
                          <button type="button" onClick={() => reviewRow(row.id, "Returned")}>Return</button>
                        </div>
                      )}
                    </td>}
                  </tr>
                );
              })}
              {!weekRows.length && <tr><td colSpan={canApprove ? 8 : 7}><div className="empty compact">No point entries were recorded for this week.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function DevelopmentPortal({
  viewer,
  users,
  records,
  createRecord,
  updateRecord,
  reviewRecord,
  deleteRecord,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  records: DevelopmentRecord[];
  createRecord: (draft: DevelopmentDraft) => boolean;
  updateRecord: (
    recordId: string,
    patch: Partial<Pick<DevelopmentRecord,
      "completedHours" | "completedPresentations" | "evidenceUrl" | "notes" | "status">>,
    action?: string,
    note?: string,
  ) => boolean;
  reviewRecord: (recordId: string, status: "Approved" | "Returned", note?: string) => boolean;
  deleteRecord: (recordId: string) => boolean | Promise<boolean>;
}) {
  const dialog = useDialog();
  const availableScopes = useMemo(() => scopesAvailableTo(viewer, users), [viewer, users]);
  /* Opens at the widest scope the viewer has, which is what "all visible
     employees" used to mean — so managers land on the same population as
     before and nobody has to hunt for people who appear to have vanished. */
  /* Left empty until the person actually picks one. Writing a default into
     state on mount froze the choice made before the staff list had loaded,
     which pinned managers to "Mine" for the rest of the session. */
  const [scope, setScope] = useState<DataScope | "">("");
  useEffect(() => {
    if (scope && !availableScopes.includes(scope as DataScope)) setScope("");
  }, [availableScopes, scope]);
  const activeScope: DataScope = (scope || availableScopes[availableScopes.length - 1] || "own") as DataScope;
  const visibleUsers = useMemo(() => usersInScope(viewer, users, activeScope), [viewer, users, activeScope]);
  const visibleIds = new Set(visibleUsers.map((user) => user.id));
  const [month, setMonth] = useState(currentMonthKey());
  const [status, setStatus] = useState("all");
  const [employeeId, setEmployeeId] = useState("all");
  const [showAssignment, setShowAssignment] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [progressDraft, setProgressDraft] = useState({
    hours: "",
    presentations: "",
    evidence: "",
    notes: "",
  });
  const [draft, setDraft] = useState<DevelopmentDraft>({
    employeeId: "",
    title: "",
    activityType: "Online Course",
    skill: "",
    month: currentMonthKey(),
    dueDate: monthEnd(currentMonthKey()),
    targetHours: 6,
    targetPresentations: 1,
    notes: "",
  });
  const canAdd = Boolean(viewer && hasItemPermission(viewer, DEVELOPMENT_ITEM, "add"));
  const canEdit = Boolean(viewer && hasItemPermission(viewer, DEVELOPMENT_ITEM, "edit"));
  const canApprove = Boolean(viewer && hasItemPermission(viewer, DEVELOPMENT_ITEM, "approve"));
  const canDelete = Boolean(viewer && hasItemPermission(viewer, DEVELOPMENT_ITEM, "delete"));
  const canExport = Boolean(viewer && hasItemPermission(viewer, DEVELOPMENT_ITEM, "export"));

  useEffect(() => {
    if (!visibleUsers.length || visibleUsers.some((user) => user.id === draft.employeeId)) return;
    const timer = window.setTimeout(() => {
      setDraft((current) => ({ ...current, employeeId: visibleUsers[0]?.id || "" }));
    }, 0);
    return () => clearTimeout(timer);
  }, [draft.employeeId, visibleUsers]);

  const visibleRecords = records
    .filter((record) => visibleIds.has(record.employeeId))
    .filter((record) => month === "all" || record.month === month)
    .filter((record) => status === "all" || record.status === status)
    .filter((record) => employeeId === "all" || record.employeeId === employeeId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const currentMonthRecords = records.filter((record) =>
    visibleIds.has(record.employeeId) && record.month === currentMonthKey());
  const dueCount = currentMonthRecords.filter((record) =>
    !["Approved"].includes(record.status) && record.dueDate && record.dueDate <= dateInputValue(new Date())).length;
  const completedHours = visibleRecords.reduce((sum, record) => sum + record.completedHours, 0);
  const assignedHours = visibleRecords.reduce((sum, record) => sum + record.targetHours, 0);
  const approvedCount = visibleRecords.filter((record) => record.status === "Approved").length;

  const submitAssignment = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.employeeId || !draft.title.trim() || (!draft.targetHours && !draft.targetPresentations)) return;
    if (createRecord(draft)) {
      setShowAssignment(false);
      setDraft((current) => ({
        ...current,
        title: "",
        skill: "",
        notes: "",
        targetHours: 6,
        targetPresentations: 1,
      }));
    }
  };
  const beginProgress = (record: DevelopmentRecord) => {
    setEditingId(record.id);
    setProgressDraft({
      hours: String(record.completedHours),
      presentations: String(record.completedPresentations),
      evidence: record.evidenceUrl,
      notes: record.notes,
    });
  };
  const saveProgress = (record: DevelopmentRecord, submit: boolean) => {
    const nextStatus: DevelopmentStatus = submit ? "Submitted" : "In Progress";
    if (updateRecord(
      record.id,
      {
        completedHours: finiteNumber(progressDraft.hours),
        completedPresentations: finiteNumber(progressDraft.presentations),
        evidenceUrl: progressDraft.evidence.trim(),
        notes: progressDraft.notes.trim(),
        status: nextStatus,
      },
      submit ? "Submitted for review" : "Progress updated",
      progressDraft.notes.trim(),
    )) setEditingId("");
  };
  const exportDevelopment = () => {
    downloadRows(`larsa-development-${month}.csv`, [
      ["Month", "Employee", "Activity", "Type", "Skill", "Target Hours", "Completed Hours", "Target Presentations", "Completed Presentations", "Due Date", "Status", "Assigned By", "Evidence"],
      ...visibleRecords.map((record) => [
        record.month,
        record.employeeName,
        record.title,
        record.activityType,
        record.skill,
        record.targetHours,
        record.completedHours,
        record.targetPresentations,
        record.completedPresentations,
        record.dueDate,
        record.status,
        record.assignedByName,
        record.evidenceUrl,
      ]),
    ]);
  };

  return (
    <div className="native-scroll development-scroll">
      <section className="overview-hero development-hero">
        <div>
          <span className="eyebrow">Employee growth</span>
          <h2>Development Portal</h2>
          <p>Assign monthly learning goals, record course hours and presentations, submit evidence, and keep the full history visible.</p>
        </div>
        <div className="hero-actions">
          {canExport && <button type="button" onClick={exportDevelopment}><FileSpreadsheet size={16} /> Export</button>}
          {canAdd && <button type="button" className="primary" onClick={() => setShowAssignment((value) => !value)}><Plus size={16} /> Assign Activity</button>}
        </div>
      </section>

      <section className="metric-grid" aria-label="Development summary">
        <article><span><BookOpen size={19} /></span><small>Visible activities</small><b>{visibleRecords.length}</b><p>in selected filters</p></article>
        <article><span><Timer size={19} /></span><small>Learning hours</small><b>{completedHours.toFixed(1)} / {assignedHours.toFixed(1)}</b><p>completed vs target</p></article>
        <article><span><Presentation size={19} /></span><small>Approved</small><b>{approvedCount}</b><p>completed activities</p></article>
        <article><span><CalendarDays size={19} /></span><small>Due now</small><b>{dueCount}</b><p>current month items</p></article>
      </section>

      {showAssignment && canAdd && (
        <form className="assignment-form" onSubmit={submitAssignment}>
          <div className="section-head">
            <div><span className="eyebrow">New monthly target</span><h3>Assign a development activity</h3></div>
            <button type="button" className="icon-button" onClick={() => setShowAssignment(false)} aria-label="Close assignment form"><X size={17} /></button>
          </div>
          <div className="form-grid">
            <label>Employee<select value={draft.employeeId} onChange={(event) => setDraft({ ...draft, employeeId: event.target.value })}>{visibleUsers.map((user) => <option key={user.id} value={user.id}>{user.name} · {user.department || user.role}</option>)}</select></label>
            <label>Activity Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Revit learning plan" required /></label>
            <label>Activity Type<select value={draft.activityType} onChange={(event) => setDraft({ ...draft, activityType: event.target.value })}><option>Online Course</option><option>Workshop</option><option>Reading / Research</option><option>Mentoring</option><option>Internal Training</option><option>Presentation</option><option>Certification</option></select></label>
            <label>Skill / Topic<input value={draft.skill} onChange={(event) => setDraft({ ...draft, skill: event.target.value })} placeholder="Revit, BIM coordination, leadership..." /></label>
            <label>Target Month<input type="month" value={draft.month} onChange={(event) => setDraft({ ...draft, month: event.target.value, dueDate: monthEnd(event.target.value) })} /></label>
            <label>Due Date<input type="date" value={draft.dueDate} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value })} /></label>
            <label>Learning Hours<input type="number" min="0" step="0.5" value={draft.targetHours} onChange={(event) => setDraft({ ...draft, targetHours: finiteNumber(event.target.value) })} /></label>
            <label>Presentations<input type="number" min="0" value={draft.targetPresentations} onChange={(event) => setDraft({ ...draft, targetPresentations: finiteNumber(event.target.value) })} /></label>
            <label className="wide">Instructions / Expected Result<textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Example: complete 6 hours of Revit learning and deliver two short presentations to the team." /></label>
          </div>
          <div className="form-actions"><button type="button" onClick={() => setShowAssignment(false)}>Cancel</button><button type="submit" className="primary"><Target size={16} /> Assign Target</button></div>
        </form>
      )}

      <ScopeSwitch scopes={availableScopes} value={activeScope} onChange={(next) => { setScope(next); setEmployeeId("all"); }} />

      <section className="filter-toolbar development-filters">
        <label><span>Month</span><select value={month} onChange={(event) => setMonth(event.target.value)}><option value="all">All history</option>{[...new Set([currentMonthKey(), ...records.map((record) => record.month)])].sort().reverse().map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        {visibleUsers.length > 1 && (
          <label><span>Employee</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="all">Everyone in this view</option>{visibleUsers.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        )}
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{["Assigned", "In Progress", "Submitted", "Approved", "Returned"].map((value) => <option key={value}>{value}</option>)}</select></label>
        <span className="filter-summary">{visibleRecords.length} matching activities</span>
      </section>

      <section className="development-list">
        {visibleRecords.map((record) => {
          const hourProgress = record.targetHours ? record.completedHours / record.targetHours : 1;
          const presentationProgress = record.targetPresentations
            ? record.completedPresentations / record.targetPresentations
            : 1;
          const progressParts = [
            ...(record.targetHours ? [hourProgress] : []),
            ...(record.targetPresentations ? [presentationProgress] : []),
          ];
          const progress = progressParts.length
            ? Math.max(0, Math.round((progressParts.reduce((sum, value) => sum + value, 0) / progressParts.length) * 100))
            : 0;
          const editing = editingId === record.id;
          return (
            <article className="development-card" key={record.id}>
              <div className="development-card-head">
                <div className="development-title">
                  <span><BookOpen size={19} /></span>
                  <div><small>{record.month} · {record.activityType}</small><h3>{record.title}</h3><p>{record.employeeName} · assigned by {record.assignedByName}</p></div>
                </div>
                <span className={`record-status ${record.status.toLowerCase().replace(/\s+/g, "-")}`}>{record.status}</span>
              </div>
              <div className="development-targets">
                <div><small>Skill / topic</small><b>{record.skill || "General development"}</b></div>
                <div><small>Learning hours</small><b>{record.completedHours.toFixed(1)} / {record.targetHours.toFixed(1)}</b></div>
                <div><small>Presentations</small><b>{record.completedPresentations} / {record.targetPresentations}</b></div>
                <div><small>Due date</small><b>{record.dueDate || "Not set"}</b></div>
              </div>
              <div className="development-progress">
                <div role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${record.title} progress`}>
                  <span style={{ width: `${Math.min(100, progress)}%` }} />
                </div><b>{progress}% complete</b>
              </div>
              {record.notes && !editing && <p className="development-note">{record.notes}</p>}
              {record.evidenceUrl && !editing && <a className="evidence-link" href={record.evidenceUrl} target="_blank" rel="noreferrer"><FolderKanban size={15} /> Open evidence or course link</a>}
              {editing && (
                <div className="progress-editor">
                  <label>Completed Hours<input type="number" min="0" step="0.5" value={progressDraft.hours} onChange={(event) => setProgressDraft({ ...progressDraft, hours: event.target.value })} /></label>
                  <label>Presentations Done<input type="number" min="0" value={progressDraft.presentations} onChange={(event) => setProgressDraft({ ...progressDraft, presentations: event.target.value })} /></label>
                  <label className="wide">Evidence / Course Link<input type="url" value={progressDraft.evidence} onChange={(event) => setProgressDraft({ ...progressDraft, evidence: event.target.value })} placeholder="https://..." /></label>
                  <label className="wide">Progress Notes<textarea value={progressDraft.notes} onChange={(event) => setProgressDraft({ ...progressDraft, notes: event.target.value })} /></label>
                  <div className="progress-actions"><button type="button" onClick={() => setEditingId("")}>Cancel</button><button type="button" onClick={() => saveProgress(record, false)}>Save Progress</button><button type="button" className="primary" onClick={() => saveProgress(record, true)}>Submit for Review</button></div>
                </div>
              )}
              <div className="development-actions">
                {canEdit && record.status !== "Approved" && !editing && <button type="button" onClick={() => beginProgress(record)}><Pencil size={15} /> Update Progress</button>}
                {canApprove && record.status !== "Approved" && <button type="button" className="approve" onClick={() => reviewRecord(record.id, "Approved")}><CheckCircle2 size={15} /> Approve</button>}
                {canApprove && record.status !== "Approved" && <button type="button" onClick={async () => reviewRecord(record.id, "Returned", (await dialog.prompt("Feedback for the employee (optional):")) || "")}><RotateCcw size={15} /> Return</button>}
                {canDelete && <button type="button" className="danger" onClick={() => deleteRecord(record.id)}><Trash2 size={15} /> Delete</button>}
              </div>
              <details className="record-history">
                <summary><History size={15} /> Full history ({record.history.length})</summary>
                <div>
                  {record.history.map((entry, index) => (
                    <article key={`${entry.at}-${index}`}>
                      <span />
                      <div><b>{entry.action}</b><small>{entry.byName} · {new Date(entry.at).toLocaleString()}</small>{entry.note && <p>{entry.note}</p>}</div>
                    </article>
                  ))}
                </div>
              </details>
            </article>
          );
        })}
        {!visibleRecords.length && <div className="empty">No development activities match these filters.</div>}
      </section>
    </div>
  );
}

/* An employee's formal record.
 *
 * This page used to be two dashboards in a trench coat: a Timesheets tab
 * totalling hours out of store.logs, and a Performance tab totalling points
 * out of store.performance. Both sets of figures already had a home —
 * attendance and the timesheet own hours, Points & Weekly Targets owns points
 * — so this was a third rendering of numbers that existed twice already, and
 * the one thing an employee file is actually for, the formal record, had
 * nowhere to live at all.
 *
 * Now it holds only that: evaluations, feedback, recognition, warnings,
 * corrective actions, promotions, role and department changes, training and
 * certifications. Nothing here reads store.logs or store.performance. Those
 * arrays are untouched and every module that legitimately consumes them —
 * Points & Weekly Targets, Quick Clock, Live Presence, the Overview cards,
 * Engineering Management and the timesheet/reports pages in the engine —
 * keeps working exactly as before. */
function PerformanceHistory({
  viewer,
  users,
  records,
  saveRecord,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  records: FormalRecord[];
  saveRecord: (record: FormalRecord) => boolean;
}) {
  const today = dateInputValue(new Date());
  const yearAgo = new Date();
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  const [from, setFrom] = useState(dateInputValue(yearAgo));
  const [to, setTo] = useState(today);
  const [employeeId, setEmployeeId] = useState("all");
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<FormalRecord | null>(null);
  const [formError, setFormError] = useState("");

  const canAdd = Boolean(viewer && hasItemPermission(viewer, PERFORMANCE_HISTORY_ITEM, "add"));
  const canExport = Boolean(viewer && hasItemPermission(viewer, PERFORMANCE_HISTORY_ITEM, "export"));

  /* Same scope rule as everywhere else: what you may read about other people
     is decided by your data scope, not by this page. Somebody with "own"
     scope sees their own file and nobody else's — which is the sensitive
     case here, because a warning is not a figure, it is a personnel matter. */
  const availableScopes = useMemo(() => scopesAvailableTo(viewer, users), [viewer, users]);
  const [scope, setScope] = useState<DataScope | "">("");
  useEffect(() => {
    if (scope || !availableScopes.length) return;
    const timer = window.setTimeout(() => setScope(availableScopes[availableScopes.length - 1]), 0);
    return () => clearTimeout(timer);
  }, [availableScopes, scope]);
  const visibleUsers = useMemo(
    () => (scope ? usersInScope(viewer, users, scope) : users.filter((user) => user.id === viewer?.id)),
    [scope, users, viewer],
  );
  const visibleIds = useMemo(() => new Set(visibleUsers.map((user) => user.id)), [visibleUsers]);
  const nameFor = (uid: string) => users.find((user) => user.id === uid)?.name || "";

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records
      .filter((row) => visibleIds.has(row.uid))
      .filter((row) => (employeeId === "all" ? true : row.uid === employeeId))
      .filter((row) => (kind === "all" ? true : row.kind === kind))
      .filter((row) => {
        const at = String(row.date || "").slice(0, 10);
        return (!from || at >= from) && (!to || at <= to);
      })
      .filter((row) => !needle || [row.title, row.detail, row.outcome, nameFor(row.uid)]
        .some((value) => String(value || "").toLowerCase().includes(needle)))
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    // nameFor reads `users`, which is already a dependency through visibleIds.
  }, [records, visibleIds, employeeId, kind, from, to, query, users]);

  const counts = useMemo(() => {
    const concerns = filtered.filter((row) => FORMAL_CONCERN_KINDS.includes(String(row.kind))).length;
    const people = new Set(filtered.map((row) => row.uid)).size;
    return { total: filtered.length, concerns, people };
  }, [filtered]);

  const startNew = () => {
    if (!canAdd) return;
    setFormError("");
    setDraft({
      id: `fr${Date.now()}`,
      uid: employeeId !== "all" ? employeeId : (visibleUsers[0]?.id || viewer?.id || ""),
      kind: "Evaluation",
      title: "",
      detail: "",
      date: today,
      outcome: "",
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    if (!draft.uid) { setFormError("Choose the employee this record is about."); return; }
    if (!draft.title.trim()) { setFormError("Give the record a short title."); return; }
    if (!draft.date) { setFormError("Give the record a date."); return; }
    const saved = saveRecord({
      ...draft,
      title: draft.title.trim(),
      detail: (draft.detail || "").trim(),
      outcome: (draft.outcome || "").trim(),
      recordedBy: viewer?.name || "",
      recordedAt: new Date().toISOString(),
    });
    if (!saved) { setFormError("Your account cannot add to an employee record."); return; }
    setDraft(null);
    setFormError("");
  };

  const exportCsv = () => {
    const header = ["Date", "Employee", "Kind", "Title", "Outcome", "Detail", "Recorded by"];
    const body = filtered.map((row) => [
      String(row.date || "").slice(0, 10), nameFor(row.uid), String(row.kind || ""),
      row.title || "", row.outcome || "", (row.detail || "").replace(/\s+/g, " "), row.recordedBy || "",
    ]);
    downloadRows("larsa-performance-history.csv", [header, ...body]);
  };

  return (
    <div className="native-scroll">
      <section className="overview-hero">
        <div>
          <span className="eyebrow">People</span>
          <h2>Performance History</h2>
          <p>The formal record: evaluations, recognition, warnings, promotions, training, and certifications.</p>
        </div>
        <div className="hero-actions">
          {canExport && <button type="button" onClick={exportCsv} disabled={!filtered.length}>Export Records</button>}
          {canAdd && <button type="button" className="primary" onClick={startNew}><Plus size={16} /> Add Record</button>}
        </div>
      </section>

      {/* Hours and points are deliberately absent, and saying where they went
          is kinder than leaving somebody to hunt for figures that used to be
          on this page. */}
      <p className="builder-note">
        Working hours live in Attendance and the Timesheet. Points live in Points &amp; Weekly Targets.
        This page is only the formal record.
      </p>

      {availableScopes.length > 1 && (
        <ScopeSwitch scopes={availableScopes} value={(scope || availableScopes[availableScopes.length - 1]) as DataScope}
          onChange={(next) => setScope(next)} />
      )}

      <section className="filter-toolbar">
        <label><span>Employee</span>
          <select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}>
            <option value="all">All visible</option>
            {visibleUsers.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </label>
        <label><span>Record type</span>
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="all">All types</option>
            {FORMAL_RECORD_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label><span>From</span>
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>To</span>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label><span>Search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, outcome, person" /></label>
        <span className="filter-summary">{counts.total} record{counts.total === 1 ? "" : "s"} · {counts.people} people</span>
      </section>

      <section className="home-board-grid home-board-grid-lean">
        <article className="home-stat">
          <span><History size={18} /></span>
          <div><small>Records in this period</small><b>{counts.total}</b><p>{counts.people} people</p></div>
        </article>
        <article className="home-stat">
          <span><ShieldCheck size={18} /></span>
          <div><small>Recognition and growth</small><b>{counts.total - counts.concerns}</b>
            <p>Evaluations, achievements, training</p></div>
        </article>
        <article className="home-stat">
          <span><Target size={18} /></span>
          <div><small>Concerns raised</small><b>{counts.concerns}</b>
            <p>Warnings and corrective actions</p></div>
        </article>
      </section>

      {draft && (
        <form className="report-panel" onSubmit={submit}>
          <div className="section-head">
            <div><span className="eyebrow">New entry</span><h3>Add to an employee record</h3></div>
          </div>
          <div className="access-fields">
            <label>Employee
              <select value={draft.uid} onChange={(event) => setDraft({ ...draft, uid: event.target.value })}>
                {visibleUsers.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
              </select>
            </label>
            <label>Record type
              <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
                {FORMAL_RECORD_KINDS.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>Date
              <input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label>
            <label>Title
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                placeholder="Annual review 2026, Site safety certification…" /></label>
            <label>Outcome (optional)
              <input value={draft.outcome || ""} onChange={(event) => setDraft({ ...draft, outcome: event.target.value })}
                placeholder="Exceeds expectations, Promoted to Team Leader…" /></label>
            <label className="full">Detail (optional)
              <textarea rows={3} value={draft.detail || ""}
                onChange={(event) => setDraft({ ...draft, detail: event.target.value })} /></label>
          </div>
          <div className="form-actions">
            <span className="auth-error">{formError}</span>
            <button type="button" onClick={() => { setDraft(null); setFormError(""); }}>Cancel</button>
            <button type="submit" className="primary"><Save size={15} /> Save record</button>
          </div>
        </form>
      )}

      <section className="report-panel">
        <div className="section-head">
          <div><span className="eyebrow">Record</span><h3>Employee history</h3></div>
        </div>
        <div className="data-table-wrap">
          <table className="data-table compact-table">
            <thead><tr>
              <th>Date</th><th>Employee</th><th>Type</th><th>Title</th><th>Outcome</th><th>Recorded by</th>
            </tr></thead>
            <tbody>
              {filtered.slice(0, 250).map((row) => (
                <tr key={row.id}>
                  <td>{String(row.date || "").slice(0, 10)}</td>
                  <td><b>{nameFor(row.uid)}</b></td>
                  <td>
                    <span className={FORMAL_CONCERN_KINDS.includes(String(row.kind))
                      ? "record-status returned" : "record-status approved"}>{row.kind}</span>
                  </td>
                  <td>{row.title}{row.detail ? <small style={{ display: "block", opacity: .7 }}>{row.detail}</small> : null}</td>
                  <td>{row.outcome || "—"}</td>
                  <td>{row.recordedBy || "—"}</td>
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={6}>
                  <div className="empty compact">
                    No formal records in this period. Evaluations, recognition, training and
                    certifications added here build up an employee&apos;s history over time.
                  </div>
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/* The authoritative per-project money picture, fetched straight from the
 * accounting backend (acct_project_summary — the same numbers the accounting
 * engine shows), so clients can always see their project's calculations from
 * the portal without an email account or any accounting access. Read-only.
 * Visible to admins, Managers, Accountants, Team Leaders — and Clients, who
 * only ever reach their own projects here. */
function PortalFinancialSummary({ project, viewer }: { project: AccountingProject; viewer: StaffUser | null }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Record<string, unknown> | null>(null);
  const [note, setNote] = useState("");
  const canSeeMoney = Boolean(viewer && (isAdmin(viewer)
    || ["Manager", "Accountant", "Team Leader", "Client"].includes(viewer.access || "")));
  useEffect(() => {
    if (!open || rows) return;
    // Deferred a tick (the codebase's hydrate pattern) so no state is set
    // synchronously inside the effect itself.
    const timer = window.setTimeout(() => {
      const client = supabaseConfigured() ? getSupabaseClient() : null;
      if (!client) { setNote("Financial figures appear when the shared accounting database is connected."); return; }
      setNote("Loading the shared ledger…");
      client.rpc("acct_project_summary", { p_project_id: project.id }).then(({ data, error }) => {
        if (error || !data) { setNote("This project has no records in the shared accounting ledger yet."); return; }
        setRows(data as Record<string, unknown>); setNote("");
      }, () => setNote("Could not reach the accounting ledger. Try again."));
    }, 0);
    return () => clearTimeout(timer);
  }, [open, rows, project.id]);
  if (!canSeeMoney) return null;
  const iqd = (key: string) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
    .format(finiteNumber(rows?.[key])) + " IQD";
  const money = (value: number, currency: string) => new Intl.NumberFormat("en-US", { maximumFractionDigits: currency === "IQD" ? 0 : 2 }).format(value) + " " + currency;
  const costProgress = () => {
    const pct = rows?.["cost_progress_pct"];
    if (pct == null) return "Not Available (no approved budget)";
    const cur = String(rows?.["budget_currency"] || "IQD");
    const cost = finiteNumber(cur === "IQD" ? rows?.["actual_construction_cost_iqd"] : rows?.["actual_construction_cost_usd"]);
    return `${finiteNumber(pct)}% — ${money(cost, cur)} of ${money(finiteNumber(rows?.["approved_budget"]), cur)}`;
  };
  const schedule = () => {
    const pct = rows?.["schedule_progress_pct"];
    if (pct == null) return `${project.progress}% (portal)`;
    return `${finiteNumber(pct)}%${rows?.["schedule_progress_date"] ? ` · ${String(rows["schedule_progress_date"])}` : ""}`;
  };
  const LINES: [string, string][] = [
    ["Gross Funding Received", "gross_funding_iqd"],
    ["Initial Consultancy Fee", "initial_fee_iqd"],
    ["Net Construction Funding", "net_construction_funding_iqd"],
    ["Materials", "materials_iqd"],
    ["Labor", "labor_iqd"],
    ["Other Project Expenses", "other_expenses_iqd"],
    ["Actual Construction Cost", "actual_construction_cost_iqd"],
    ["Total Used", "total_used_iqd"],
    ["Remaining Unused Balance", "remaining_unused_iqd"],
    ["Refundable Consultancy Fee", "refundable_fee_iqd"],
    ["Total Refund Due to Client", "total_refund_due_iqd"],
    ["Final Consultancy Fee Retained", "final_fee_retained_iqd"],
    ["Pending Commitments", "pending_commitments_iqd"],
  ];
  return (
    <div className="project-financials" style={{ marginTop: 10 }}>
      <button type="button" className="project-room-button ghost" onClick={() => setOpen(!open)}>
        <Wallet size={15} /> {open ? "Hide financial summary" : "Financial summary"}
      </button>
      {open ? (
        rows ? (
          <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.9 }}>
            {project.contractValue ? (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span>Contract Value</span><b>{money(project.contractValue, String(rows["currency"] || "IQD"))}</b></div>
            ) : null}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span>Approved Project Budget</span><b>{rows["approved_budget"] == null ? "Not Available" : money(finiteNumber(rows["approved_budget"]), String(rows["budget_currency"] || "IQD"))}</b></div>
            {LINES.map(([label, key]) => (
              <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span>{label}</span><b>{iqd(key)}</b></div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span>Cost Progress</span><b>{costProgress()}</b></div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><span>Schedule / Physical Progress</span><b>{schedule()}</b></div>
            <p className="project-room-none" style={{ marginTop: 6 }}>Figures come from the shared accounting ledger with each entry&apos;s recorded exchange rate — they never change when today&apos;s rate changes.</p>
          </div>
        ) : (
          <p className="project-room-none" style={{ marginTop: 8 }}>{note || "Loading…"}</p>
        )
      ) : null}
    </div>
  );
}

function ProjectPortal({
  viewer,
  projects,
  documents,
  updateProject,
  staff,
  notify,
}: {
  viewer: StaffUser | null;
  projects: AccountingProject[];
  documents: AccountingDocument[];
  updateProject: (
    projectId: string,
    patch: Partial<Pick<AccountingProject, "progress" | "status" | "phase">>,
  ) => boolean;
  staff: StaffUser[];
  notify: (text: string) => void;
}) {
  const allowedIds = visibleProjectIds(viewer, projects);
  const allowedProjects = projects.filter((project) => allowedIds.has(project.id));
  const [roomId, setRoomId] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [editingId, setEditingId] = useState("");
  const [edit, setEdit] = useState({ progress: "0", status: "Active", phase: "" });
  const statuses = [...new Set(["Active", "On Hold", "Completed", ...allowedProjects.map((project) => project.status).filter(Boolean)])];
  const filtered = allowedProjects.filter((project) =>
    (status === "all" || project.status === status)
    && [project.code, project.name, project.clientName, project.responsibleEngineer, project.projectManager, project.teamLeader]
      .some((value) => value.toLowerCase().includes(query.trim().toLowerCase())));
  const canEdit = Boolean(viewer && hasItemPermission(viewer, PROJECT_PORTAL_ITEM, "edit"));
  const canExport = Boolean(viewer && hasItemPermission(viewer, PROJECT_PORTAL_ITEM, "export"));
  const accessMode = viewer
    ? isAdmin(viewer)
      ? "all"
      : viewer.projectAccessMode || projectAccessForPreset(viewer.access || "Engineer")
    : "none";
  const beginEdit = (project: AccountingProject) => {
    setEditingId(project.id);
    setEdit({
      progress: String(project.progress),
      status: project.status || "Active",
      phase: project.phase,
    });
  };
  const exportProjects = () => {
    downloadRows("larsa-assigned-projects.csv", [
      ["Code", "Project", "Client", "Region", "Type", "Phase", "Status", "Progress %", "Responsible Engineer", "Project Manager", "Team Leader", "Start Date", "Due Date"],
      ...filtered.map((project) => [
        project.code,
        project.name,
        project.clientName,
        project.region,
        project.type,
        project.phase,
        project.status,
        project.progress,
        project.responsibleEngineer,
        project.projectManager,
        project.teamLeader,
        project.startDate,
        project.dueDate,
      ]),
    ]);
  };

  const [chatTick, setChatTick] = useState(0);
  const [creatingFor, setCreatingFor] = useState<AccountingProject | null>(null);
  const [groupDraft, setGroupDraft] = useState({ name: "", purpose: "" });
  const canManageGroups = Boolean(viewer && isAdmin(viewer));

  // Which projects already have a group, and how much conversation each holds.
  const { rooms, roomCounts } = useMemo(() => {
    const store = readChatStore();
    const counts: Record<string, number> = {};
    store.messages.forEach((row) => {
      if (!row.deleted) counts[row.projectId] = (counts[row.projectId] || 0) + 1;
    });
    const byProject: Record<string, ChatRoom> = {};
    store.rooms.forEach((room) => { byProject[room.projectId] = room; });
    return { rooms: byProject, roomCounts: counts };
  }, [roomId, chatTick]);

  const beginGroup = (project: AccountingProject) => {
    setCreatingFor(project);
    setGroupDraft({
      name: `${project.code ? `${project.code} — ` : ""}${project.name}`.slice(0, 80),
      purpose: project.clientName ? `Site updates and questions with ${project.clientName}.` : "Site updates, photos, and questions.",
    });
  };

  const createGroup = () => {
    if (!viewer || !creatingFor || !canManageGroups) return;
    const name = groupDraft.name.trim();
    if (!name) { notify("Give the group a name first."); return; }
    const store = readChatStore();
    if (store.rooms.some((room) => room.projectId === creatingFor.id)) {
      notify("This project already has a group.");
      setCreatingFor(null);
      return;
    }
    const room: ChatRoom = {
      projectId: creatingFor.id,
      name,
      purpose: groupDraft.purpose.trim(),
      createdBy: viewer.name,
      createdById: viewer.id,
      createdAt: new Date().toISOString(),
    };
    const next = chatAudit({ ...store, rooms: [...store.rooms, room] }, {
      projectId: creatingFor.id,
      actorId: viewer.id,
      actorName: viewer.name,
      action: "created",
      detail: `Group "${name}" opened for ${roomMembers(creatingFor.id, staff, projects).length} member(s)`,
    });
    try {
      writeChatStore(next);
    } catch {
      notify("This device is out of storage for the project rooms.");
      return;
    }
    setChatTick((value) => value + 1);
    setCreatingFor(null);
    notify(`Group created. Everyone with access to ${creatingFor.name} can post.`);
    setRoomId(creatingFor.id);
  };

  const openRoom = allowedProjects.find((project) => project.id === roomId);
  const openRoomRecord = openRoom ? rooms[openRoom.id] : undefined;
  if (openRoom && openRoomRecord) {
    return (
      <div className="native-scroll projects-scroll">
        <ProjectRoom
          project={openRoom}
          room={openRoomRecord}
          viewer={viewer}
          members={roomMembers(openRoom.id, staff, projects)}
          onBack={() => setRoomId("")}
          notify={notify}
        />
      </div>
    );
  }

  return (
    <div className="native-scroll projects-scroll">
      <section className="overview-hero projects-hero">
        <div>
          <span className="eyebrow">Construction delivery</span>
          <h2>Assigned Projects</h2>
          <p>Project details, progress, responsible people, files, and links are limited to the projects available to this account.</p>
        </div>
        <div className="hero-actions">
          {canExport && <button type="button" onClick={exportProjects}><FileSpreadsheet size={16} /> Export Visible</button>}
          <span className="access-pill"><FolderLock size={16} /> {accessMode === "all" ? "All projects" : `${allowedProjects.length} assigned`}</span>
        </div>
      </section>
      <section className="filter-toolbar">
        <label className="search-filter"><span>Search projects</span><div><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Project, client, engineer, or lead" /></div></label>
        <label><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{statuses.map((value) => <option key={value}>{value}</option>)}</select></label>
        <span className="filter-summary">{filtered.length} visible projects</span>
      </section>
      <section className="project-grid">
        {filtered.map((project) => {
          const projectDocuments = documents.filter((document) => document.projectId === project.id);
          const editing = editingId === project.id;
          return (
            <article className="project-card" key={project.id}>
              <div className="project-card-head">
                <div><small>{project.code || "Construction project"} · {project.region || "Shared"}</small><h3>{project.name}</h3><p>{project.clientName || "No client recorded"}</p></div>
                <span className={`record-status ${project.status.toLowerCase().replace(/\s+/g, "-")}`}>{project.status || "Active"}</span>
              </div>
              <div className="project-progress-head"><span>{project.phase || "Current phase"}</span><b>{project.progress}%</b></div>
              <div className="project-progress" role="progressbar" aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`${project.name} progress`}><span style={{ width: `${project.progress}%` }} /></div>
              <div className="project-people">
                <div><small>Responsible Engineer</small><b>{project.responsibleEngineer || "Not assigned"}</b></div>
                <div><small>Project Manager</small><b>{project.projectManager || "Not assigned"}</b></div>
                <div><small>Team Leader</small><b>{project.teamLeader || "Not assigned"}</b></div>
              </div>
              <div className="project-meta">
                <span><CalendarDays size={15} /> {project.startDate || "No start date"} to {project.dueDate || "No due date"}</span>
                {project.projectAddress && <span><HardHat size={15} /> {project.projectAddress}</span>}
              </div>
              {(project.googleDriveLink || project.clickUpLink || projectDocuments.length > 0) && (
                <div className="project-links">
                  {project.googleDriveLink && <a href={project.googleDriveLink} target="_blank" rel="noreferrer"><FolderKanban size={15} /> Project Files</a>}
                  {project.clickUpLink && <a href={project.clickUpLink} target="_blank" rel="noreferrer"><ListChecks size={15} /> Project Tasks</a>}
                  {projectDocuments.filter((document) => document.url).slice(0, 4).map((document) => <a key={document.id || document.url} href={document.url} target="_blank" rel="noreferrer"><FileClock size={15} /> {document.title || document.type || "Document"}</a>)}
                </div>
              )}
              {editing && (
                <div className="project-editor">
                  <label>Progress %<input type="number" min="0" max="100" value={edit.progress} onChange={(event) => setEdit({ ...edit, progress: event.target.value })} /></label>
                  <label>Status<select value={edit.status} onChange={(event) => setEdit({ ...edit, status: event.target.value })}>{statuses.map((value) => <option key={value}>{value}</option>)}</select></label>
                  <label>Phase<input value={edit.phase} onChange={(event) => setEdit({ ...edit, phase: event.target.value })} /></label>
                  <div><button type="button" onClick={() => setEditingId("")}>Cancel</button><button type="button" className="primary" onClick={() => { if (updateProject(project.id, { progress: finiteNumber(edit.progress), status: edit.status, phase: edit.phase })) setEditingId(""); }}><Save size={15} /> Save Progress</button></div>
                </div>
              )}
              {rooms[project.id] ? (
                <button type="button" className="project-room-button" onClick={() => setRoomId(project.id)}>
                  <MessagesSquare size={15} /> Open project group
                  {roomCounts[project.id] ? <span className="project-room-count">{roomCounts[project.id]}</span> : null}
                </button>
              ) : canManageGroups ? (
                <button type="button" className="project-room-button ghost" onClick={() => beginGroup(project)}>
                  <Plus size={15} /> Create project group
                </button>
              ) : (
                <p className="project-room-none">No group has been opened for this project yet.</p>
              )}
              {canEdit && !editing && <button type="button" className="project-edit-button" onClick={() => beginEdit(project)}><Pencil size={15} /> Update project progress</button>}
              <PortalFinancialSummary project={project} viewer={viewer} />
            </article>
          );
        })}
        {!filtered.length && <div className="empty project-empty">{accessMode === "none" ? "No construction projects are available to this account." : "No assigned projects match these filters."}</div>}
      </section>

      {creatingFor && (
        <div className="group-dialog-layer" role="dialog" aria-modal="true" aria-labelledby="group-dialog-title">
          <div className="group-dialog">
            <div className="group-dialog-head">
              <div>
                <span className="eyebrow">{creatingFor.code || "Construction project"}</span>
                <h3 id="group-dialog-title">Create the project group</h3>
                <p>{creatingFor.name}</p>
              </div>
              <button type="button" onClick={() => setCreatingFor(null)} aria-label="Cancel"><X size={17} /></button>
            </div>
            <label>Group name
              <input value={groupDraft.name} maxLength={80}
                onChange={(event) => setGroupDraft({ ...groupDraft, name: event.target.value })} />
            </label>
            <label>What this group is for
              <input value={groupDraft.purpose} maxLength={140}
                onChange={(event) => setGroupDraft({ ...groupDraft, purpose: event.target.value })} />
            </label>
            <p className="group-dialog-note">
              <UsersRound size={14} /> {roomMembers(creatingFor.id, staff, projects).length} people already have access to this
              project and will be in the group{creatingFor.clientName ? `, including ${creatingFor.clientName}` : ""}.
            </p>
            <div className="group-dialog-actions">
              <button type="button" onClick={() => setCreatingFor(null)}>Cancel</button>
              <button type="button" className="primary" onClick={createGroup}><MessagesSquare size={15} /> Create group</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* What each person costs and earns over a period, in one place: commission
   from the revenue they closed, plus payroll. The accounting engine stays the
   system of record — nothing is written here, only totalled. */
/* ===========================================================================
   My Pay — an employee's own salary, commissions and payment history.

   Everything on this screen comes from one server call, pay_my_statement,
   which scopes itself to the signed-in person before it reads a row. There is
   no client-side filtering of somebody else's data, because none of somebody
   else's data ever arrives. Nothing is computed here that the payroll run did
   not already approve: this screen formats authoritative figures, it does not
   invent salary, tax or deduction arithmetic.

   Money is never mixed. Amounts carry the historical exchange-rate snapshot
   taken when they were recorded, so a later change to the platform rate
   cannot move a figure on this page, and USD and IQD are reported side by
   side rather than added together.
   =========================================================================== */
type PayStatement = {
  ok?: boolean;
  found?: boolean;
  employee?: {
    email?: string; employee_no?: string | null; full_name?: string;
    position?: string | null; department?: string | null; region?: string | null;
    employment_start?: string | null; employment_type?: string | null;
    pay_schedule?: string | null; salary_currency?: string | null;
    base_salary?: number | null; payment_method?: string | null;
    payment_ref_masked?: string | null; show_pending_commissions?: boolean;
  };
  range?: { from?: string | null; to?: string | null; note?: string | null };
  totals?: Record<string, number | string | null>;
  by_currency?: Record<string, { net?: number }>;
  periods?: PayPeriodRow[];
  months?: { month: string; base_iqd: number; commission_iqd: number; bonus_iqd: number; net_iqd: number }[];
  commissions?: PayCommissionRow[];
  note?: string;
};
type PayPeriodRow = {
  period_id: string; period_no: string; label?: string | null;
  period_start: string; period_end: string; pay_date?: string | null;
  currency: string; status: string; published_at?: string | null;
  base_salary_iqd: number; commission_iqd: number; bonus_iqd: number;
  deduction_iqd: number; advance_repayment_iqd: number; reimbursement_iqd: number;
  net_iqd: number; net_usd: number; paid_iqd: number; last_paid_on?: string | null;
  currencies?: string[];
  items?: { id: string; item_type: string; description?: string | null;
    original_amount: number; original_currency: string; exchange_rate: number;
    rate_date?: string | null; rate_source?: string | null;
    amount_iqd: number; amount_usd: number; sign: number; status: string }[];
};
type PayCommissionRow = {
  id: string; commission_no: string; title: string;
  project_id?: string | null; client?: string | null;
  earning_start?: string | null; earning_end?: string | null;
  basis: string; rate?: number | null; base_amount?: number | null; base_currency?: string | null;
  rule_snapshot?: Record<string, unknown>;
  original_amount: number; original_currency: string; exchange_rate: number;
  rate_date?: string | null; rate_source?: string | null;
  amount_iqd: number; amount_usd: number; status: string;
  submitted_at?: string | null; approved_at?: string | null; approved_by?: string | null;
  paid_at?: string | null; period_no?: string | null; reverses_id?: string | null;
  created_at?: string | null;
};

/* Written status, an icon and a colour — never colour alone, and never a
   word that implies money has moved when it has not. */
const PAY_STATUS: Record<string, { label: string; tone: string; icon: LucideIcon }> = {
  draft: { label: "Draft", tone: "draft", icon: FileText },
  pending_review: { label: "Pending review", tone: "pending", icon: Clock },
  pending_approval: { label: "Pending approval", tone: "pending", icon: Clock },
  approved: { label: "Approved — not yet paid", tone: "approved", icon: CheckCircle2 },
  scheduled: { label: "Scheduled for payment", tone: "approved", icon: CalendarDays },
  partially_paid: { label: "Partially paid", tone: "partial", icon: CircleDollarSign },
  paid: { label: "Paid", tone: "paid", icon: CheckCircle2 },
  rejected: { label: "Rejected", tone: "rejected", icon: X },
  reversed: { label: "Reversed", tone: "rejected", icon: RotateCcw },
  void: { label: "Void", tone: "rejected", icon: X },
  estimated: { label: "Expected", tone: "draft", icon: Clock },
};
function payStatus(key: string) {
  return PAY_STATUS[key] || { label: key.replace(/_/g, " "), tone: "draft", icon: FileText };
}

/* IQD is whole; USD keeps its cents, because a commission of $12.50 is a real
   amount somebody is owed. Neither is ever added to the other. */
function payMoney(amount: number, currency: string) {
  const value = Number(amount) || 0;
  if (currency === "USD") {
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${Math.round(value).toLocaleString("en-US")} IQD`;
}
function payDate(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value).slice(0, 10);
  return parsed.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function payMonthLabel(key: string) {
  const [year, month] = key.split("-");
  const parsed = new Date(Number(year), Number(month) - 1, 1);
  return Number.isNaN(parsed.getTime()) ? key : parsed.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
}
function payNumber(source: Record<string, number | string | null> | undefined, key: string) {
  const raw = source?.[key];
  const value = typeof raw === "string" ? Number(raw) : raw;
  return Number.isFinite(value as number) ? (value as number) : 0;
}

const PAY_RANGES = [
  { id: "this-month", label: "This month" },
  { id: "last-month", label: "Last month" },
  { id: "3m", label: "Last 3 months" },
  { id: "6m", label: "Last 6 months" },
  { id: "ytd", label: "Year to date" },
  { id: "year", label: "This calendar year" },
  { id: "joining", label: "Since joining Larsa" },
  { id: "all", label: "All history" },
  { id: "custom", label: "Custom range" },
];

function payRangeDates(id: string, joined?: string | null, customFrom?: string, customTo?: string) {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const startOfMonth = (offset: number) => new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const endOfMonth = (offset: number) => new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  switch (id) {
    case "this-month": return { from: iso(startOfMonth(0)), to: iso(endOfMonth(0)) };
    case "last-month": return { from: iso(startOfMonth(-1)), to: iso(endOfMonth(-1)) };
    case "3m": return { from: iso(startOfMonth(-2)), to: iso(endOfMonth(0)) };
    case "6m": return { from: iso(startOfMonth(-5)), to: iso(endOfMonth(0)) };
    case "ytd": return { from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(now) };
    case "year": return { from: iso(new Date(now.getFullYear(), 0, 1)), to: iso(new Date(now.getFullYear(), 11, 31)) };
    /* The official start date, and only that. When HR has not recorded one the
       server opens the range up and says so, rather than guessing a date. */
    case "joining": return { from: joined || null, to: iso(now) };
    case "all": return { from: null, to: iso(now) };
    case "custom": return { from: customFrom || null, to: customTo || iso(now) };
    default: return { from: null, to: iso(now) };
  }
}

/* Payroll events happen on the server, hours or days before the employee
   opens the app. Rather than pretend there is a push channel that does not
   exist, this compares what the ledger now says against what this device was
   last told, and raises the difference. Amounts stay out of the message. */
const PAY_SEEN_KEY = "larsa-control-pay-seen";
function announcePayChanges(statement: PayStatement, viewer: StaffUser | null) {
  if (!viewer) return;
  try {
    const seen = JSON.parse(localStorage.getItem(PAY_SEEN_KEY) || "{}") as Record<string, string>;
    const next: Record<string, string> = { ...seen };
    const raise = (event: string, title: string, body: string) =>
      raiseNotification({ event, title, body, itemId: "my-pay", fromName: "Payroll", recipients: [viewer] });

    (statement.periods || []).forEach((period) => {
      const key = `p:${period.period_id}`;
      const stamp = `${period.published_at || ""}|${period.status}|${period.paid_iqd}`;
      if (seen[key] === stamp) { next[key] = stamp; return; }
      if (!seen[key]) {
        raise("pay.published", "Payslip available", `Your payslip for ${period.label || period.period_no} is ready to view.`);
      } else if (period.status === "paid" || period.status === "partially_paid") {
        raise("pay.paid", "Payment recorded", `A payment was recorded against ${period.label || period.period_no}.`);
      }
      next[key] = stamp;
    });

    (statement.commissions || []).forEach((row) => {
      const key = `c:${row.id}`;
      if (seen[key] === row.status) { next[key] = row.status; return; }
      if (seen[key] && ["approved", "scheduled", "paid", "rejected"].includes(row.status)) {
        raise("pay.commission", "Commission updated", `"${row.title}" is now ${payStatus(row.status).label.toLowerCase()}.`);
      }
      next[key] = row.status;
    });

    localStorage.setItem(PAY_SEEN_KEY, JSON.stringify(next));
  } catch { /* a device that cannot remember simply does not repeat itself */ }
}

/* ===========================================================================
   Payroll & People — one portal for the whole payroll cycle.

   Payroll used to be four scattered places: a payroll screen, a commissions
   screen, an employee list, and a paystub print buried inside the first one.
   This is all of it in one page, in the order the work actually happens:
   people, then a run, then approval, then payment, then publication.

   It reads and writes the same rows My Pay reads. One payroll truth, two
   lenses: this one for whoever runs payroll, My Pay for the person being
   paid. Every figure here is the figure the employee will see, because it is
   literally the same record.
   =========================================================================== */
type PortalEmployee = {
  id: string; email: string; employee_no?: string | null; full_name: string;
  position?: string | null; department?: string | null; base_salary?: number | null;
  salary_currency?: string | null; employment_start?: string | null; active?: boolean;
};
type PortalPeriod = {
  id: string; period_no: string; label?: string | null;
  period_start: string; period_end: string; pay_date?: string | null;
  currency: string; status: string; published_at?: string | null;
  submitted_by?: string | null; approved_by?: string | null; created_by_email?: string | null;
};
type PortalCommission = {
  id: string; commission_no: string; employee_email: string; title: string;
  original_amount: number; original_currency: string; status: string;
  earning_start?: string | null; earning_end?: string | null; period_id?: string | null;
};
type PortalMapping = {
  id: string; txn_id: string; txn_no?: string; description?: string | null;
  category?: string | null; amount: number; currency: string; txn_date?: string | null;
  suggested_email?: string | null;
};
type PortalData = {
  ok?: boolean;
  employees?: PortalEmployee[];
  periods?: PortalPeriod[];
  commissions?: PortalCommission[];
  mapping_queue?: PortalMapping[];
  hr_queue?: { employee_email: string; gap: string }[];
};
type PortalLine = {
  employee_email: string; full_name: string; employee_no?: string | null; position?: string | null;
  base_salary_iqd: number; commission_iqd: number; bonus_iqd: number;
  deduction_iqd: number; advance_repayment_iqd: number; reimbursement_iqd: number;
  net_iqd: number; paid_iqd: number; posted_items: number;
  items: { id: string; item_type: string; description?: string | null; original_amount: number;
    original_currency: string; exchange_rate: number; sign: number; amount_iqd: number;
    status: string; txn_id?: string | null }[];
};
type PortalDetail = {
  ok?: boolean; period?: PortalPeriod; lines?: PortalLine[];
  payments?: { id: string; employee_email: string; paid_on: string; amount: number;
    currency: string; amount_iqd: number; status: string; method?: string | null;
    reversal_reason?: string | null }[];
  net_iqd?: number; paid_iqd?: number; outstanding_iqd?: number;
  by_currency?: Record<string, { net?: number }>;
  employees_in_run?: number;
};

const PAY_ITEM_TYPES = [
  { id: "base_salary", label: "Base salary" },
  { id: "commission", label: "Commission" },
  { id: "bonus", label: "Bonus" },
  { id: "allowance", label: "Allowance" },
  { id: "deduction", label: "Deduction" },
  { id: "advance_repayment", label: "Advance repayment" },
  { id: "reimbursement", label: "Reimbursement" },
];

function PayrollPortal({ viewer, active }: { viewer: StaffUser | null; active: boolean }) {
  const dialog = useDialog();
  const [tab, setTab] = useState<"runs" | "people" | "commissions">("runs");
  const [data, setData] = useState<PortalData | null>(null);
  const [detail, setDetail] = useState<PortalDetail | null>(null);
  const [openRun, setOpenRun] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [draft, setDraft] = useState({ employee_email: "", item_type: "base_salary", amount: "", currency: "IQD", description: "" });
  const [newRun, setNewRun] = useState({ period_start: "", period_end: "", pay_date: "", label: "", currency: "IQD" });
  const [newPerson, setNewPerson] = useState({ email: "", full_name: "", position: "", department: "", employment_start: "", base_salary: "", salary_currency: "IQD" });
  const [payDraft, setPayDraft] = useState({ employee_email: "", amount: "", currency: "IQD", paid_on: "", reference: "" });

  const actor = useMemo(() => (viewer ? {
    email: viewer.email || "", name: viewer.name || "", role: accountingRole(viewer),
  } : null), [viewer]);

  const client = () => (supabaseConfigured() ? getSupabaseClient() : null);

  /* Every action goes through here: call, report plainly what the server
     said, reload. Server errors are shown as written — they explain the rule
     that was broken, which is more use than "something went wrong". */
  const run = (name: string, args: Record<string, unknown>, ok?: string) => {
    const sb = client();
    if (!sb || !actor) { setNote("The payroll ledger is not connected on this device."); return; }
    setBusy(true);
    sb.rpc(name, { actor, ...args }).then(({ error }) => {
      setBusy(false);
      if (error) { setNote(String(error.message || "That could not be completed.").replace(/^ACCT_[A-Z]+: /, "")); return; }
      setNote(ok || "");
      setTick((n) => n + 1);
    }, () => { setBusy(false); setNote("Could not reach the payroll ledger."); });
  };

  useEffect(() => {
    if (!active || !actor) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const sb = client();
      if (!sb) { setNote("The payroll ledger is not connected on this device."); return; }
      sb.rpc("pay_admin_overview", { actor, p_limit: 200 }).then(({ data: payload, error }) => {
        if (cancelled) return;
        if (error) { setNote(String(error.message || "").replace(/^ACCT_[A-Z]+: /, "") || "You do not have confidential payroll access."); setData(null); return; }
        setData(payload as PortalData);
      }, () => { if (!cancelled) setNote("Could not reach the payroll ledger."); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, actor, tick]);

  useEffect(() => {
    if (!openRun || !actor) { setDetail(null); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const sb = client();
      if (!sb) return;
      sb.rpc("pay_period_detail", { actor, p_period_id: openRun }).then(({ data: payload, error }) => {
        if (cancelled || error) return;
        setDetail(payload as PortalDetail);
      }, () => undefined);
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRun, actor, tick]);

  if (!viewer) return <div className="native-scroll" />;
  const employees = data?.employees || [];
  const periods = data?.periods || [];
  const commissions = data?.commissions || [];
  const mapping = data?.mapping_queue || [];
  const hrGaps = data?.hr_queue || [];
  const openPeriods = periods.filter((p) => ["draft", "pending_review"].includes(p.status));

  return (
    <div className="native-scroll pay-scroll">
      <section className="overview-hero pay-hero">
        <div>
          <span className="eyebrow">Accounting</span>
          <h2>Payroll &amp; People</h2>
          <p>Employees, pay runs, commissions and payslips — the same records your team sees in My Pay.</p>
        </div>
        <dl className="pay-identity">
          <div><dt>People</dt><dd>{employees.length}</dd></div>
          <div><dt>Pay runs</dt><dd>{periods.length}</dd></div>
          <div><dt>Commissions awaiting a decision</dt><dd>{commissions.filter((c) => ["pending_review", "estimated"].includes(c.status)).length}</dd></div>
          <div><dt>Unlinked salary entries</dt><dd>{mapping.length}</dd></div>
        </dl>
      </section>

      {note && <p className="pay-note" role="status">{note}</p>}
      {hrGaps.length > 0 && (
        <p className="pay-note soft" role="status">
          {hrGaps.length} employment start {hrGaps.length === 1 ? "date is" : "dates are"} missing
          ({hrGaps.map((g) => g.employee_email).join(", ")}). Until HR records them, &ldquo;Since joining&rdquo; shows all
          available history for those people rather than guessing a date.
        </p>
      )}

      <section className="pay-controls">
        <div className="pay-range" role="tablist" aria-label="Payroll section">
          {([["runs", "Pay runs"], ["people", "People"], ["commissions", "Commissions"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id}
              className={tab === id ? "is-on" : ""} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <button type="button" className="btn small" onClick={() => setTick((n) => n + 1)} disabled={busy}>
          <RotateCcw size={14} /> {busy ? "Working…" : "Refresh"}
        </button>
        <button type="button" className="btn small" onClick={() => run("pay_scan_unlinked_salary", {}, "Scanned the ledger for unlinked salary entries.")} disabled={busy}>
          <Search size={14} /> Scan the ledger
        </button>
      </section>

      {tab === "runs" && (
        <>
          <section className="pay-block">
            <div className="section-head"><h3>Open a pay run</h3></div>
            <div className="pay-form">
              <label>From<input type="date" value={newRun.period_start} onChange={(e) => setNewRun({ ...newRun, period_start: e.target.value })} /></label>
              <label>To<input type="date" value={newRun.period_end} onChange={(e) => setNewRun({ ...newRun, period_end: e.target.value })} /></label>
              <label>Pay date<input type="date" value={newRun.pay_date} onChange={(e) => setNewRun({ ...newRun, pay_date: e.target.value })} /></label>
              <label>Name<input value={newRun.label} placeholder="June 2026" onChange={(e) => setNewRun({ ...newRun, label: e.target.value })} /></label>
              <label>Currency<select value={newRun.currency} onChange={(e) => setNewRun({ ...newRun, currency: e.target.value })}><option>IQD</option><option>USD</option></select></label>
              <button type="button" className="primary" disabled={busy || !newRun.period_start || !newRun.period_end}
                onClick={() => run("pay_open_period", { payload: newRun }, "Pay run opened.")}>Open run</button>
            </div>
          </section>

          <section className="pay-block">
            <div className="section-head"><h3>Pay runs</h3></div>
            {periods.length === 0 ? <div className="empty compact">No pay runs yet.</div> : (
              <div className="pay-periods">
                {periods.map((p) => {
                  const meta = payStatus(p.status);
                  const Icon = meta.icon;
                  const isOpen = openRun === p.id;
                  return (
                    <article key={p.id} className={isOpen ? "pay-period is-open" : "pay-period"}>
                      <button type="button" className="pay-period-head" aria-expanded={isOpen}
                        onClick={() => setOpenRun(isOpen ? "" : p.id)}>
                        <span className="pay-period-when">
                          <b>{p.label || `${payDate(p.period_start)} – ${payDate(p.period_end)}`}</b>
                          <small>{p.period_no}{p.published_at ? " · published" : " · not published to employees"}</small>
                        </span>
                        <span className="pay-period-figs">
                          <span><small>Pay date</small><b>{payDate(p.pay_date)}</b></span>
                        </span>
                        <span className={`pay-status is-${meta.tone}`}><Icon size={13} />{meta.label}</span>
                        <ChevronRight size={16} className="pay-chev" />
                      </button>
                      {isOpen && detail?.period?.id === p.id && (
                        <div className="pay-period-body">
                          <div className="pay-run-figs">
                            <span><small>Net</small><b>{payMoney(detail.net_iqd || 0, "IQD")}</b></span>
                            <span><small>Paid</small><b>{payMoney(detail.paid_iqd || 0, "IQD")}</b></span>
                            <span><small>Outstanding</small><b>{payMoney(detail.outstanding_iqd || 0, "IQD")}</b></span>
                            <span><small>People</small><b>{detail.employees_in_run || 0}</b></span>
                          </div>
                          {Object.keys(detail.by_currency || {}).length > 1 && (
                            <p className="pay-note soft">This run mixes currencies: {Object.entries(detail.by_currency || {})
                              .map(([code, v]) => payMoney(Number(v?.net || 0), code)).join(" and ")} — reported apart, never added.</p>
                          )}

                          <table className="data-table pay-table">
                            <thead><tr>
                              <th>Employee</th><th className="right">Base</th><th className="right">Commission</th>
                              <th className="right">Bonus</th><th className="right">Deductions</th>
                              <th className="right">Reimbursed</th><th className="right">Net</th>
                              <th className="right">Paid</th><th>In ledger</th>
                            </tr></thead>
                            <tbody>
                              {(detail.lines || []).map((line) => (
                                <tr key={line.employee_email}>
                                  <td><b>{line.full_name}</b><br /><small className="muted">{line.employee_email}</small></td>
                                  <td className="right">{payMoney(line.base_salary_iqd, "IQD")}</td>
                                  <td className="right">{payMoney(line.commission_iqd, "IQD")}</td>
                                  <td className="right">{payMoney(line.bonus_iqd, "IQD")}</td>
                                  <td className="right">{line.deduction_iqd ? `−${payMoney(line.deduction_iqd, "IQD")}` : "—"}</td>
                                  <td className="right">{payMoney(line.reimbursement_iqd, "IQD")}</td>
                                  <td className="right"><b>{payMoney(line.net_iqd, "IQD")}</b></td>
                                  <td className="right">{payMoney(line.paid_iqd, "IQD")}</td>
                                  {/* The one-entry rule, visible: how many of this
                                      person's costed items reached the ledger. */}
                                  <td>{line.posted_items > 0
                                    ? <span className="pay-status is-paid"><CheckCircle2 size={12} />{line.posted_items} posted</span>
                                    : <span className="pay-status is-draft"><Clock size={12} />not posted</span>}</td>
                                </tr>
                              ))}
                              {(detail.lines || []).length === 0 && (
                                <tr><td colSpan={9}>Nothing in this run yet — add a line below.</td></tr>
                              )}
                            </tbody>
                          </table>

                          {["draft", "pending_review"].includes(p.status) && (
                            <div className="pay-form">
                              <label>Employee<select value={draft.employee_email} onChange={(e) => setDraft({ ...draft, employee_email: e.target.value })}>
                                <option value="">Choose…</option>
                                {employees.map((emp) => <option key={emp.email} value={emp.email}>{emp.full_name}</option>)}
                              </select></label>
                              <label>Component<select value={draft.item_type} onChange={(e) => setDraft({ ...draft, item_type: e.target.value })}>
                                {PAY_ITEM_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                              </select></label>
                              <label>Amount<input type="number" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} /></label>
                              <label>Currency<select value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}><option>IQD</option><option>USD</option></select></label>
                              <label>Detail<input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
                              <button type="button" className="btn" disabled={busy || !draft.employee_email || !draft.amount}
                                onClick={() => run("pay_add_item", { payload: { ...draft, period_id: p.id } }, "Added to the run.")}>Add line</button>
                            </div>
                          )}

                          {p.status === "approved" || p.status === "partially_paid" || p.status === "paid" ? (
                            <div className="pay-form">
                              <label>Pay<select value={payDraft.employee_email} onChange={(e) => setPayDraft({ ...payDraft, employee_email: e.target.value })}>
                                <option value="">Choose…</option>
                                {(detail.lines || []).map((l) => <option key={l.employee_email} value={l.employee_email}>{l.full_name}</option>)}
                              </select></label>
                              <label>Amount<input type="number" value={payDraft.amount} onChange={(e) => setPayDraft({ ...payDraft, amount: e.target.value })} /></label>
                              <label>Currency<select value={payDraft.currency} onChange={(e) => setPayDraft({ ...payDraft, currency: e.target.value })}><option>IQD</option><option>USD</option></select></label>
                              <label>Paid on<input type="date" value={payDraft.paid_on} onChange={(e) => setPayDraft({ ...payDraft, paid_on: e.target.value })} /></label>
                              <label>Reference<input value={payDraft.reference} onChange={(e) => setPayDraft({ ...payDraft, reference: e.target.value })} /></label>
                              <button type="button" className="btn" disabled={busy || !payDraft.employee_email || !payDraft.amount}
                                onClick={() => run("pay_record_payment", { payload: { ...payDraft, period_id: p.id } }, "Payment recorded.")}>Record payment</button>
                            </div>
                          ) : null}

                          {(detail.payments || []).length > 0 && (
                            <table className="data-table pay-table">
                              <thead><tr><th>Payment</th><th>Employee</th><th>Method</th><th className="right">Amount</th><th>Status</th></tr></thead>
                              <tbody>
                                {(detail.payments || []).map((row) => (
                                  <tr key={row.id}>
                                    <td>{payDate(row.paid_on)}</td>
                                    <td>{row.employee_email}</td>
                                    <td>{row.method || "—"}</td>
                                    <td className="right">{payMoney(row.amount, row.currency)}</td>
                                    <td>{row.status === "reversed"
                                      ? <span className="pay-status is-rejected"><RotateCcw size={12} />Reversed{row.reversal_reason ? ` · ${row.reversal_reason}` : ""}</span>
                                      : <span className="pay-status is-paid"><CheckCircle2 size={12} />Paid</span>}
                                      {row.status === "paid" && (
                                        <button type="button" className="btn small" style={{ marginInlineStart: 8 }} disabled={busy}
                                          onClick={async () => {
                                            const why = await dialog.prompt("Why is this payment being reversed?");
                                            if (why) run("pay_reverse_payment", { p_payment_id: row.id, p_reason: why }, "Payment reversed — the original stays in history.");
                                          }}>Reverse</button>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}

                          {/* The lifecycle, as buttons, in order. Whether you may
                              press one is the server's decision, not this
                              screen's: it explains the rule if you may not. */}
                          <div className="rowActions">
                            {["draft", "pending_review"].includes(p.status) && (
                              <button type="button" className="primary" disabled={busy}
                                onClick={() => run("pay_submit_period", { p_period_id: p.id, p_note: null }, "Submitted for approval.")}>
                                Submit for approval
                              </button>
                            )}
                            {p.status === "pending_approval" && (
                              <>
                                <button type="button" className="primary" disabled={busy}
                                  onClick={() => run("pay_decide_period", { p_period_id: p.id, p_decision: "approve", p_reason: null },
                                    "Approved — each costed line posted one accounting expense.")}>Approve</button>
                                <button type="button" className="btn" disabled={busy}
                                  onClick={async () => {
                                    const why = await dialog.prompt("Why is this run being rejected?");
                                    if (why) run("pay_decide_period", { p_period_id: p.id, p_decision: "reject", p_reason: why }, "Rejected.");
                                  }}>Reject</button>
                              </>
                            )}
                            {["approved", "scheduled", "partially_paid", "paid"].includes(p.status) && !p.published_at && (
                              <button type="button" className="primary" disabled={busy}
                                onClick={() => run("pay_publish_period", { p_period_id: p.id }, "Published — payslips are now visible in My Pay.")}>
                                Publish payslips
                              </button>
                            )}
                            {p.published_at && <span className="pay-status is-paid"><CheckCircle2 size={13} />Visible in My Pay</span>}
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {mapping.length > 0 && (
            <section className="pay-block">
              <div className="section-head"><h3>Unlinked salary entries</h3></div>
              <p className="pay-note soft">
                Salary already in the ledger with no payroll record behind it. Linking records the missing
                relationship — the original entry keeps its own amount, rate and history, and is never duplicated.
              </p>
              <table className="data-table pay-table">
                <thead><tr><th>Entry</th><th>Description</th><th className="right">Amount</th><th>Employee</th><th>Pay run</th><th /></tr></thead>
                <tbody>
                  {mapping.map((m) => (
                    <tr key={m.id}>
                      <td>{m.txn_no}</td>
                      <td>{m.description || m.category || "—"}</td>
                      <td className="right">{payMoney(m.amount, m.currency)}</td>
                      <td><select id={`map-e-${m.id}`} defaultValue={m.suggested_email || ""}>
                        <option value="">Choose…</option>
                        {employees.map((e) => <option key={e.email} value={e.email}>{e.full_name}</option>)}
                      </select></td>
                      <td><select id={`map-p-${m.id}`} defaultValue={openPeriods[0]?.id || ""}>
                        <option value="">Choose…</option>
                        {periods.map((p) => <option key={p.id} value={p.id}>{p.period_no}</option>)}
                      </select></td>
                      <td><button type="button" className="btn small" disabled={busy} onClick={() => {
                        const email = (document.getElementById(`map-e-${m.id}`) as HTMLSelectElement)?.value;
                        const period = (document.getElementById(`map-p-${m.id}`) as HTMLSelectElement)?.value;
                        if (!email || !period) { setNote("Choose an employee and a pay run first."); return; }
                        run("pay_link_transaction", { p_txn_id: m.txn_id, p_employee_email: email, p_period_id: period, p_note: "Linked from the payroll portal" },
                          "Linked. The original accounting entry is unchanged.");
                      }}>Link</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {tab === "people" && (
        <>
          <section className="pay-block">
            <div className="section-head"><h3>Add or update a person</h3></div>
            <div className="pay-form">
              <label>Email<input value={newPerson.email} onChange={(e) => setNewPerson({ ...newPerson, email: e.target.value })} placeholder="name@larsaeng.com" /></label>
              <label>Name<input value={newPerson.full_name} onChange={(e) => setNewPerson({ ...newPerson, full_name: e.target.value })} /></label>
              <label>Position<input value={newPerson.position} onChange={(e) => setNewPerson({ ...newPerson, position: e.target.value })} /></label>
              <label>Department<input value={newPerson.department} onChange={(e) => setNewPerson({ ...newPerson, department: e.target.value })} /></label>
              <label>Started<input type="date" value={newPerson.employment_start} onChange={(e) => setNewPerson({ ...newPerson, employment_start: e.target.value })} /></label>
              <label>Base salary<input type="number" value={newPerson.base_salary} onChange={(e) => setNewPerson({ ...newPerson, base_salary: e.target.value })} /></label>
              <label>Currency<select value={newPerson.salary_currency} onChange={(e) => setNewPerson({ ...newPerson, salary_currency: e.target.value })}><option>IQD</option><option>USD</option></select></label>
              <button type="button" className="primary" disabled={busy || !newPerson.email}
                onClick={() => run("pay_upsert_employee", { payload: newPerson }, "Employee record saved.")}>Save person</button>
            </div>
          </section>
          <section className="pay-block">
            <div className="section-head"><h3>People</h3></div>
            {employees.length === 0 ? <div className="empty compact">No employee records yet.</div> : (
              <table className="data-table pay-table">
                <thead><tr><th>Name</th><th>ID</th><th>Position</th><th>Department</th><th>Started</th><th className="right">Base salary</th></tr></thead>
                <tbody>
                  {employees.map((e) => (
                    <tr key={e.email}>
                      <td><b>{e.full_name}</b><br /><small className="muted">{e.email}</small></td>
                      <td>{e.employee_no || "—"}</td>
                      <td>{e.position || "—"}</td>
                      <td>{e.department || "—"}</td>
                      <td>{e.employment_start ? payDate(e.employment_start)
                        : <span className="pay-status is-pending"><Clock size={12} />Not recorded</span>}</td>
                      <td className="right">{e.base_salary ? payMoney(e.base_salary, e.salary_currency || "IQD") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {tab === "commissions" && (
        <section className="pay-block">
          <div className="section-head"><h3>Commissions</h3></div>
          {commissions.length === 0 ? <div className="empty compact">No commissions recorded yet.</div> : (
            <table className="data-table pay-table">
              <thead><tr><th>Reference</th><th>Employee</th><th>Reason</th><th className="right">Amount</th><th>Status</th><th /></tr></thead>
              <tbody>
                {commissions.map((c) => {
                  const meta = payStatus(c.status);
                  const Icon = meta.icon;
                  return (
                    <tr key={c.id}>
                      <td>{c.commission_no}</td>
                      <td>{c.employee_email}</td>
                      <td>{c.title}</td>
                      <td className="right">{payMoney(c.original_amount, c.original_currency)}</td>
                      <td><span className={`pay-status is-${meta.tone}`}><Icon size={12} />{meta.label}</span></td>
                      <td>
                        {["pending_review", "estimated"].includes(c.status) && (
                          <>
                            <button type="button" className="btn small" disabled={busy}
                              onClick={() => run("pay_decide_commission", { p_commission_id: c.id, p_decision: "approve", p_reason: null }, "Commission approved.")}>Approve</button>
                            <button type="button" className="btn small" style={{ marginInlineStart: 6 }} disabled={busy}
                              onClick={async () => {
                                const why = await dialog.prompt("Why is this commission being rejected?");
                                if (why) run("pay_decide_commission", { p_commission_id: c.id, p_decision: "reject", p_reason: why }, "Commission rejected.");
                              }}>Reject</button>
                          </>
                        )}
                        {c.status === "approved" && openPeriods.length > 0 && (
                          <select defaultValue="" disabled={busy} onChange={(event) => {
                            if (event.target.value) run("pay_schedule_commission", { p_commission_id: c.id, p_period_id: event.target.value },
                              "Scheduled into the run — it will be costed once, through payroll.");
                          }}>
                            <option value="">Schedule into…</option>
                            {openPeriods.map((p) => <option key={p.id} value={p.id}>{p.period_no}</option>)}
                          </select>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function MyPay({ viewer, active }: { viewer: StaffUser | null; active: boolean }) {
  const [rangeId, setRangeId] = useState("6m");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [data, setData] = useState<PayStatement | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [openPeriod, setOpenPeriod] = useState<string>("");
  const [slip, setSlip] = useState<Record<string, unknown> | null>(null);
  const [slipBusy, setSlipBusy] = useState(false);
  const [loadKey, setLoadKey] = useState(0);

  const joined = data?.employee?.employment_start || null;
  const range = payRangeDates(rangeId, joined, customFrom, customTo);

  const actor = useMemo(() => (viewer ? {
    email: viewer.email || "",
    name: viewer.name || "",
    role: accountingRole(viewer),
  } : null), [viewer]);

  useEffect(() => {
    if (!active || !actor) return;
    if (rangeId === "custom" && !customFrom) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const client = supabaseConfigured() ? getSupabaseClient() : null;
      if (!client) {
        setNote("My Pay reads the shared payroll ledger, which is not connected on this device.");
        setData(null);
        return;
      }
      if (!actor.email) {
        setNote("This account has no email address, so it cannot be matched to a payroll record. Ask an administrator to add one.");
        setData(null);
        return;
      }
      setBusy(true);
      client.rpc("pay_my_statement", {
        actor,
        p_from: range.from,
        p_to: range.to,
        p_employee_email: null,
      }).then(({ data: payload, error }) => {
        if (cancelled) return;
        setBusy(false);
        if (error || !payload) {
          setNote("Could not reach the payroll ledger just now. No figures are shown rather than stale ones.");
          setData(null);
          return;
        }
        setNote("");
        const next = payload as PayStatement;
        setData(next);
        announcePayChanges(next, viewer);
      }, () => {
        if (cancelled) return;
        setBusy(false);
        setNote("Could not reach the payroll ledger just now. No figures are shown rather than stale ones.");
        setData(null);
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // range is derived from these three, and actor from the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, actor, rangeId, customFrom, customTo, loadKey]);

  const totals = data?.totals;
  const periods = data?.periods || [];
  const months = data?.months || [];
  const commissions = data?.commissions || [];
  const employee = data?.employee;
  const byCurrency = data?.by_currency || {};
  const currencies = Object.keys(byCurrency);

  const netIqd = payNumber(totals, "net_iqd");
  const paidIqd = payNumber(totals, "paid_iqd");
  const outstanding = payNumber(totals, "outstanding_iqd");
  const latestStatus = periods[0]?.status || (paidIqd > 0 ? "partially_paid" : periods.length ? "approved" : "");

  const openSlip = (periodId: string) => {
    if (!actor) return;
    const client = supabaseConfigured() ? getSupabaseClient() : null;
    if (!client) return;
    setSlipBusy(true);
    client.rpc("pay_payslip", { actor, p_period_id: periodId, p_employee_email: null })
      .then(({ data: payload, error }) => {
        setSlipBusy(false);
        if (error || !payload) { setNote("That payslip could not be opened."); return; }
        setSlip(payload as Record<string, unknown>);
      }, () => { setSlipBusy(false); setNote("That payslip could not be opened."); });
  };

  if (!viewer) return <div className="native-scroll" />;

  return (
    <div className="native-scroll pay-scroll">
      <section className="overview-hero pay-hero">
        <div>
          <span className="eyebrow">My Pay</span>
          <h2>{employee?.full_name || viewer.name}</h2>
          <p>Salary, commissions, and payment history — visible only to you.</p>
        </div>
        {employee && (
          <dl className="pay-identity">
            {employee.employee_no && <div><dt>Employee ID</dt><dd>{employee.employee_no}</dd></div>}
            {employee.position && <div><dt>Position</dt><dd>{employee.position}</dd></div>}
            {employee.department && <div><dt>Department</dt><dd>{employee.department}</dd></div>}
            <div><dt>Started</dt><dd>{employee.employment_start ? payDate(employee.employment_start) : "Not recorded"}</dd></div>
            <div><dt>Period shown</dt><dd>{range.from ? payDate(range.from) : "All history"} → {payDate(range.to)}</dd></div>
            <div><dt>Last payment</dt><dd>{payDate(totals?.last_paid_on as string)}</dd></div>
          </dl>
        )}
      </section>

      <section className="pay-controls">
        <div className="pay-range" role="group" aria-label="Reporting period">
          {PAY_RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={rangeId === option.id ? "is-on" : ""}
              aria-pressed={rangeId === option.id}
              onClick={() => setRangeId(option.id)}
            >{option.label}</button>
          ))}
        </div>
        {rangeId === "custom" && (
          <div className="pay-custom">
            <label>From<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} /></label>
            <label>To<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} /></label>
          </div>
        )}
        {latestStatus && (
          <span className={`pay-status is-${payStatus(latestStatus).tone}`}>
            {(() => { const Icon = payStatus(latestStatus).icon; return <Icon size={14} />; })()}
            {payStatus(latestStatus).label}
          </span>
        )}
        <button type="button" className="btn small" onClick={() => setLoadKey((n) => n + 1)} disabled={busy}>
          <RotateCcw size={14} /> {busy ? "Loading…" : "Refresh"}
        </button>
      </section>

      {note && <p className="pay-note" role="status">{note}</p>}
      {data?.range?.note && <p className="pay-note soft" role="status">{data.range.note}</p>}
      {data && data.found === false && (
        <div className="empty">No payroll record is set up for this account yet. Your accountant sets one up when your first pay period is prepared.</div>
      )}

      {data?.found && (
        <>
          <section className="pay-cards" aria-label="Earnings summary">
            <PayCard label="Base salary" value={payNumber(totals, "base_salary_iqd")} />
            <PayCard label="Approved commissions" value={payNumber(totals, "approved_commission_iqd")} tone="good" />
            <PayCard label="Pending commissions" value={payNumber(totals, "pending_commission_iqd")} tone="pending"
              hint="Not yet approved — not money you have been paid." />
            <PayCard label="Bonuses" value={payNumber(totals, "bonus_iqd")} />
            <PayCard label="Deductions" value={payNumber(totals, "deduction_iqd")} tone="minus" />
            <PayCard label="Advance repayments" value={payNumber(totals, "advance_repayment_iqd")} tone="minus" />
            <PayCard label="Reimbursements" value={payNumber(totals, "reimbursement_iqd")}
              hint="Expenses paid back to you — not part of salary." />
            <PayCard label="Net earnings" value={netIqd} tone="strong" />
            <PayCard label="Amount paid" value={paidIqd} tone="good" />
            <PayCard label="Approved, not yet paid" value={outstanding} tone={outstanding > 0 ? "pending" : "good"} />
          </section>

          <section className="pay-meta">
            <span><b>{payNumber(totals, "periods")}</b> pay periods</span>
            <span><b>{payMoney(payNumber(totals, "average_month_iqd"), "IQD")}</b> average per period</span>
            {currencies.length > 1 && (
              <span className="pay-split">
                Paid in {currencies.map((code) => (
                  <b key={code}>{payMoney(Number(byCurrency[code]?.net || 0), code)}</b>
                )).reduce((all, node, index) => index === 0 ? [node] : [...all, <i key={`sep${index}`}> and </i>, node], [] as React.ReactNode[])}
                {" "}— shown separately, never added together.
              </span>
            )}
          </section>

          <PayCharts months={months} paid={paidIqd} outstanding={outstanding} />

          <section className="pay-block">
            <div className="section-head"><h3>Pay periods</h3></div>
            {periods.length === 0 ? (
              <div className="empty compact">No published pay periods fall inside this range.</div>
            ) : (
              <div className="pay-periods">
                {periods.map((row) => {
                  const meta = payStatus(row.status);
                  const Icon = meta.icon;
                  const isOpen = openPeriod === row.period_id;
                  return (
                    <article key={row.period_id} className={isOpen ? "pay-period is-open" : "pay-period"}>
                      <button type="button" className="pay-period-head" onClick={() => setOpenPeriod(isOpen ? "" : row.period_id)} aria-expanded={isOpen}>
                        <span className="pay-period-when">
                          <b>{row.label || `${payDate(row.period_start)} – ${payDate(row.period_end)}`}</b>
                          <small>{row.period_no} · paid {payDate(row.pay_date)}</small>
                        </span>
                        <span className="pay-period-figs">
                          <span><small>Net</small><b>{payMoney(row.net_iqd, "IQD")}</b></span>
                          <span><small>Paid</small><b>{payMoney(row.paid_iqd, "IQD")}</b></span>
                        </span>
                        <span className={`pay-status is-${meta.tone}`}><Icon size={13} />{meta.label}</span>
                        <ChevronRight size={16} className="pay-chev" />
                      </button>
                      {isOpen && (
                        <div className="pay-period-body">
                          <table className="data-table pay-table">
                            <thead>
                              <tr><th>Component</th><th>Detail</th><th className="right">Amount</th><th>Rate used</th><th className="right">IQD equivalent</th></tr>
                            </thead>
                            <tbody>
                              {(row.items || []).map((item) => (
                                <tr key={item.id}>
                                  <td>{item.item_type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</td>
                                  <td>{item.description || "—"}</td>
                                  <td className="right">{item.sign < 0 ? "−" : ""}{payMoney(item.original_amount, item.original_currency)}</td>
                                  <td>{item.original_currency === "IQD" ? "—" : `1 USD = ${Number(item.exchange_rate).toLocaleString("en-US")} IQD`}</td>
                                  <td className="right">{item.sign < 0 ? "−" : ""}{payMoney(item.amount_iqd, "IQD")}</td>
                                </tr>
                              ))}
                              <tr className="pay-total-row">
                                <td colSpan={4}><b>Net pay</b></td>
                                <td className="right"><b>{payMoney(row.net_iqd, "IQD")}</b></td>
                              </tr>
                            </tbody>
                          </table>
                          <div className="rowActions">
                            <button type="button" className="btn small" onClick={() => openSlip(row.period_id)} disabled={slipBusy}>
                              <FileText size={14} /> {slipBusy ? "Opening…" : "Payslip"}
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <section className="pay-block">
            <div className="section-head"><h3>Commissions</h3></div>
            {commissions.length === 0 ? (
              <div className="empty compact">No commissions in this range.</div>
            ) : (
              <div className="pay-commissions">
                {commissions.map((row) => {
                  const meta = payStatus(row.status);
                  const Icon = meta.icon;
                  return (
                    <article key={row.id} className="pay-commission">
                      <header>
                        <b>{row.title}</b>
                        <span className={`pay-status is-${meta.tone}`}><Icon size={13} />{meta.label}</span>
                      </header>
                      <p className="pay-commission-amount">{payMoney(row.original_amount, row.original_currency)}</p>
                      <dl>
                        {row.client && <div><dt>Client</dt><dd>{row.client}</dd></div>}
                        <div><dt>Earned</dt><dd>{payDate(row.earning_start)} – {payDate(row.earning_end)}</dd></div>
                        <div><dt>Basis</dt><dd>{row.basis === "percent"
                          ? `${((Number(row.rate) || 0) * 100).toFixed(2)}% of ${payMoney(Number(row.base_amount) || 0, row.base_currency || row.original_currency)}`
                          : "Fixed amount"}</dd></div>
                        {row.original_currency !== "IQD" && (
                          <div><dt>Rate used</dt><dd>1 USD = {Number(row.exchange_rate).toLocaleString("en-US")} IQD · {payDate(row.rate_date)}</dd></div>
                        )}
                        <div><dt>Submitted</dt><dd>{payDate(row.submitted_at || row.created_at)}</dd></div>
                        <div><dt>Approved</dt><dd>{row.approved_at ? `${payDate(row.approved_at)}${row.approved_by ? ` · ${row.approved_by}` : ""}` : "—"}</dd></div>
                        <div><dt>In payroll</dt><dd>{row.period_no || "Not yet scheduled"}</dd></div>
                        <div><dt>Paid</dt><dd>{row.paid_at ? payDate(row.paid_at) : "Not yet paid"}</dd></div>
                        {row.reverses_id && <div><dt>Correction</dt><dd>Reverses an earlier commission</dd></div>}
                      </dl>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {slip && <PaySlip slip={slip} onClose={() => setSlip(null)} />}
    </div>
  );
}

function PayCard({ label, value, tone, hint }: { label: string; value: number; tone?: string; hint?: string }) {
  return (
    <article className={`pay-card${tone ? ` is-${tone}` : ""}${value === 0 ? " is-empty" : ""}`} title={hint}>
      <small>{label}</small>
      <b>{payMoney(value, "IQD")}</b>
      {hint && <em>{hint}</em>}
    </article>
  );
}

/* Charts, hand-drawn to match the rest of the app and to stay honest:
   the stack shows the parts of gross earnings and never includes the total
   it adds up to, and an empty range draws nothing rather than an empty grid. */
function PayCharts({ months, paid, outstanding }: {
  months: { month: string; base_iqd: number; commission_iqd: number; bonus_iqd: number; net_iqd: number }[];
  paid: number; outstanding: number;
}) {
  if (!months.length) {
    return (
      <section className="pay-block">
        <div className="section-head"><h3>Earnings over time</h3></div>
        <div className="empty compact">Nothing to chart for this period yet. Charts appear once a pay period has been published.</div>
      </section>
    );
  }
  const peak = Math.max(...months.map((m) => m.base_iqd + m.commission_iqd + m.bonus_iqd), 1);
  const netPeak = Math.max(...months.map((m) => Math.abs(m.net_iqd)), 1);
  const cumulative = months.reduce((sum, m) => sum + m.net_iqd, 0);
  const settled = paid + Math.max(outstanding, 0);
  return (
    <section className="pay-block">
      <div className="section-head">
        <h3>Earnings over time</h3>
        <span className="pay-cumulative">Cumulative net for this range: <b>{payMoney(cumulative, "IQD")}</b></span>
      </div>
      <div className="pay-chart-grid">
        <figure className="pay-chart">
          <figcaption>Monthly earnings, by component</figcaption>
          <ul className="pay-legend">
            <li><i className="is-base" />Base salary</li>
            <li><i className="is-comm" />Commission</li>
            <li><i className="is-bonus" />Bonus</li>
          </ul>
          <div className="pay-columns" role="img"
            aria-label={months.map((m) => `${payMonthLabel(m.month)}: base ${Math.round(m.base_iqd)}, commission ${Math.round(m.commission_iqd)}, bonus ${Math.round(m.bonus_iqd)} IQD`).join("; ")}>
            {months.map((m) => {
              const gross = m.base_iqd + m.commission_iqd + m.bonus_iqd;
              return (
                <div className="pay-column" key={m.month} title={`${payMonthLabel(m.month)} — ${payMoney(gross, "IQD")}`}>
                  <span className="pay-stack">
                    <i className="is-bonus" style={{ height: `${(m.bonus_iqd / peak) * 100}%` }} />
                    <i className="is-comm" style={{ height: `${(m.commission_iqd / peak) * 100}%` }} />
                    <i className="is-base" style={{ height: `${(m.base_iqd / peak) * 100}%` }} />
                  </span>
                  <small>{payMonthLabel(m.month)}</small>
                  <b>{payMoney(gross, "IQD")}</b>
                </div>
              );
            })}
          </div>
        </figure>

        <figure className="pay-chart">
          <figcaption>Net earnings trend</figcaption>
          <div className="pay-columns is-trend" role="img"
            aria-label={months.map((m) => `${payMonthLabel(m.month)}: net ${Math.round(m.net_iqd)} IQD`).join("; ")}>
            {months.map((m) => (
              <div className="pay-column" key={m.month} title={`${payMonthLabel(m.month)} — ${payMoney(m.net_iqd, "IQD")}`}>
                <span className="pay-stack">
                  <i className="is-net" style={{ height: `${(Math.abs(m.net_iqd) / netPeak) * 100}%` }} />
                </span>
                <small>{payMonthLabel(m.month)}</small>
                <b>{payMoney(m.net_iqd, "IQD")}</b>
              </div>
            ))}
          </div>
        </figure>

        <figure className="pay-chart pay-chart-wide">
          <figcaption>Paid against approved</figcaption>
          <div className="pay-splitbar" role="img"
            aria-label={`Paid ${Math.round(paid)} IQD of ${Math.round(settled)} IQD approved`}>
            <i className="is-paid" style={{ width: `${settled > 0 ? (paid / settled) * 100 : 0}%` }} />
            <i className="is-due" style={{ width: `${settled > 0 ? (Math.max(outstanding, 0) / settled) * 100 : 0}%` }} />
          </div>
          <ul className="pay-legend">
            <li><i className="is-paid" />Paid {payMoney(paid, "IQD")}</li>
            <li><i className="is-due" />Approved, not yet paid {payMoney(Math.max(outstanding, 0), "IQD")}</li>
          </ul>
        </figure>
      </div>
    </section>
  );
}

/* The payslip. A4, printed white whatever theme the app is in, and it never
   says "paid" before a payment has been recorded. */
function PaySlip({ slip, onClose }: { slip: Record<string, unknown>; onClose: () => void }) {
  const get = (path: string[]): unknown => path.reduce<unknown>((node, key) =>
    node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, slip);
  const text = (path: string[]) => { const value = get(path); return value == null ? "" : String(value); };
  const money = (path: string[]) => payMoney(Number(get(path)) || 0, "IQD");
  const items = (get(["items"]) as { item_type: string; description?: string; original_amount: number;
    original_currency: string; exchange_rate: number; amount_iqd: number; sign: number }[]) || [];
  const payments = (get(["payments"]) as { paid_on: string; amount: number; currency: string;
    status: string; method?: string; reference_masked?: string }[]) || [];
  const state = text(["payment_state"]);
  const stateLabel = state === "paid" ? "Paid"
    : state === "partially_paid" ? "Partially paid — balance outstanding"
    : "Approved — Not Yet Paid";
  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <section className="pay-slip-shell" role="dialog" aria-modal="true" aria-label="Payslip"
        onMouseDown={(event: MouseEvent) => event.stopPropagation()}>
        <div className="modal-head no-print">
          <div><span className="eyebrow">Payslip</span><h2>{text(["period", "period_no"])}</h2></div>
          <div className="rowActions">
            <button type="button" className="btn small" onClick={() => window.print()}><FileText size={14} /> Print / PDF</button>
            <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
          </div>
        </div>
        <article className="pay-slip" id="larsa-payslip">
          <header className="pay-slip-head">
            <Image src="/icons/larsa-logo.svg" alt="Larsa Engineering" width={190} height={74} />
            <div>
              <h1>Payslip</h1>
              <p>{text(["slip_no"])}</p>
            </div>
          </header>
          <div className="pay-slip-grid">
            <dl>
              <div><dt>Employee</dt><dd>{text(["employee", "full_name"])}</dd></div>
              <div><dt>Employee ID</dt><dd>{text(["employee", "employee_no"]) || "—"}</dd></div>
              <div><dt>Position</dt><dd>{text(["employee", "position"]) || "—"}</dd></div>
              <div><dt>Department</dt><dd>{text(["employee", "department"]) || "—"}</dd></div>
            </dl>
            <dl>
              <div><dt>Pay period</dt><dd>{payDate(text(["period", "period_start"]))} – {payDate(text(["period", "period_end"]))}</dd></div>
              <div><dt>Payment date</dt><dd>{payDate(text(["period", "pay_date"]))}</dd></div>
              <div><dt>Status</dt><dd><b>{stateLabel}</b></dd></div>
              <div><dt>Approved by</dt><dd>{text(["period", "approved_by"]) || "—"}</dd></div>
            </dl>
          </div>
          <table className="pay-slip-table">
            <thead><tr><th>Component</th><th>Detail</th><th className="right">Amount</th><th className="right">IQD equivalent</th></tr></thead>
            <tbody>
              {items.map((item, index) => (
                <tr key={index}>
                  <td>{item.item_type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</td>
                  <td>{item.description || "—"}
                    {item.original_currency !== "IQD" && <small> · 1 USD = {Number(item.exchange_rate).toLocaleString("en-US")} IQD</small>}
                  </td>
                  <td className="right">{item.sign < 0 ? "−" : ""}{payMoney(item.original_amount, item.original_currency)}</td>
                  <td className="right">{item.sign < 0 ? "−" : ""}{payMoney(item.amount_iqd, "IQD")}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td colSpan={3}>Gross earnings</td><td className="right">{money(["gross_iqd"])}</td></tr>
              <tr className="pay-slip-net"><td colSpan={3}><b>Net pay</b></td><td className="right"><b>{money(["net_iqd"])}</b></td></tr>
              <tr><td colSpan={3}>Amount paid</td><td className="right">{money(["paid_iqd"])}</td></tr>
              <tr><td colSpan={3}>Outstanding</td><td className="right">{money(["outstanding_iqd"])}</td></tr>
            </tfoot>
          </table>
          {payments.length > 0 && (
            <table className="pay-slip-table">
              <thead><tr><th>Payment</th><th>Method</th><th>Reference</th><th className="right">Amount</th></tr></thead>
              <tbody>
                {payments.map((row, index) => (
                  <tr key={index}>
                    <td>{payDate(row.paid_on)}{row.status === "reversed" ? " · reversed" : ""}</td>
                    <td>{row.method || "—"}</td>
                    <td>{row.reference_masked || "—"}</td>
                    <td className="right">{payMoney(row.amount, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <footer className="pay-slip-foot">
            <p><b>Larsa Engineering</b> · {text(["employee", "payment_method"]) || "Payment method not recorded"}
              {text(["employee", "payment_ref_masked"]) ? ` · ${text(["employee", "payment_ref_masked"])}` : ""}</p>
            <p className="pay-slip-ref">Verification {text(["verification"]).slice(0, 16)}</p>
          </footer>
        </article>
      </section>
    </div>
  );
}

function SalesCommissions({
  viewer,
  users,
  commissions,
  payroll,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  commissions: CommissionRow[];
  payroll: PayrollRow[];
}) {
  const today = dateInputValue(new Date());
  const start = new Date();
  start.setMonth(start.getMonth() - 11);
  start.setDate(1);
  const [from, setFrom] = useState(dateInputValue(start));
  const [to, setTo] = useState(today);
  const [query, setQuery] = useState("");
  const [onlyPaid, setOnlyPaid] = useState("all");

  const scope = scopedUsers(viewer, users);
  const scopeNames = new Set(scope.map((person) => person.name.toLowerCase()));
  const wideScope = Boolean(viewer && (isAdmin(viewer) || maxScopeOf(viewer) === "company"));

  const periodCommissions = commissions.filter((row) =>
    withinDates(row.date, from, to)
    && (wideScope || scopeNames.has(row.person.toLowerCase()))
    && (onlyPaid === "all"
      || (onlyPaid === "due" && row.due - row.paid > 0.005)
      || (onlyPaid === "paid" && row.paid > 0)));
  const periodPayroll = payroll.filter((row) =>
    withinDates(row.payDate, from, to)
    && !["Void", "Rejected"].includes(row.status)
    && (wideScope || scopeNames.has(row.employee.toLowerCase())));

  // Every person who appears on either side of the ledger for this period.
  const names = [...new Set([
    ...periodCommissions.map((row) => row.person),
    ...periodPayroll.map((row) => row.employee),
  ].filter(Boolean))].sort();

  const rows = names.map((name) => {
    const key = name.toLowerCase();
    const mine = periodCommissions.filter((row) => row.person.toLowerCase() === key);
    const pay = periodPayroll.filter((row) => row.employee.toLowerCase() === key);
    const due = mine.reduce((sum, row) => sum + row.due, 0);
    const paid = mine.reduce((sum, row) => sum + row.paid, 0);
    const salary = pay.reduce((sum, row) => sum + row.totalCompanyCost, 0);
    const staff = users.find((person) => person.name.toLowerCase() === key);
    return {
      name, staff, deals: mine.length, due, paid, outstanding: due - paid,
      salary, payslips: pay.length, total: salary + due,
    };
  }).filter((row) => !query.trim()
    || row.name.toLowerCase().includes(query.trim().toLowerCase())
    || (row.staff?.department || "").toLowerCase().includes(query.trim().toLowerCase()));

  const sum = (pick: (row: typeof rows[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const money = (value: number) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const canExport = Boolean(viewer && hasItemPermission(viewer, SALES_ITEM, "export"));

  const exportRows = () => {
    downloadRows(`larsa-sales-commissions-${from}-to-${to}.csv`, [
      ["Person", "Department", "Deals", "Commission Due", "Commission Paid", "Outstanding", "Payslips", "Salary Cost", "Total Cost"],
      ...rows.map((row) => [
        row.name, row.staff?.department || "", row.deals,
        row.due.toFixed(2), row.paid.toFixed(2), row.outstanding.toFixed(2),
        row.payslips, row.salary.toFixed(2), row.total.toFixed(2),
      ]),
      ["TOTAL", "", sum((row) => row.deals), sum((row) => row.due).toFixed(2),
        sum((row) => row.paid).toFixed(2), sum((row) => row.outstanding).toFixed(2),
        sum((row) => row.payslips), sum((row) => row.salary).toFixed(2), sum((row) => row.total).toFixed(2)],
    ]);
  };

  return (
    <div className="native-scroll history-scroll">
      <section className="overview-hero history-hero">
        <div>
          <span className="eyebrow">Finance</span>
          <h2>Sales &amp; Commissions</h2>
          <p>Commission earned against revenue closed, beside payroll, so the full cost of each person is visible for any period.</p>
        </div>
        <div className="hero-actions">
          {canExport && <button type="button" onClick={exportRows}><FileSpreadsheet size={16} /> Export</button>}
          <button type="button" className="primary" onClick={() => window.print()}>Print / PDF</button>
        </div>
      </section>

      <section className="filter-toolbar history-filters">
        <label><span>From</span><input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>To</span><input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
        <label><span>Commission</span><select value={onlyPaid} onChange={(event) => setOnlyPaid(event.target.value)}>
          <option value="all">All commission</option>
          <option value="due">Still outstanding</option>
          <option value="paid">Already paid</option>
        </select></label>
        <label className="search-filter"><span>Search</span><div><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Person or department" /></div></label>
      </section>

      <section className="metric-grid">
        <article><span><CircleDollarSign size={19} /></span><small>Commission due</small><b>{money(sum((row) => row.due))}</b><p>{sum((row) => row.deals)} deals</p></article>
        <article><span><CheckCircle2 size={19} /></span><small>Commission paid</small><b>{money(sum((row) => row.paid))}</b><p>{money(sum((row) => row.outstanding))} outstanding</p></article>
        <article><span><WalletCards size={19} /></span><small>Salary cost</small><b>{money(sum((row) => row.salary))}</b><p>{sum((row) => row.payslips)} payslips</p></article>
        <article><span><BadgeDollarSign size={19} /></span><small>Total people cost</small><b>{money(sum((row) => row.total))}</b><p>{rows.length} people</p></article>
      </section>

      <section className="report-panel">
        <div className="section-head">
          <div><span className="eyebrow">Per person</span><h3>Commission and salary together</h3></div>
          <span className="black-badge">{from} to {to}</span>
        </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Person</th><th>Department</th><th>Deals</th><th>Commission due</th><th>Paid</th><th>Outstanding</th><th>Salary cost</th><th>Total</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td><b>{row.name}</b>{!row.staff && <small className="row-note"> not a current user</small>}</td>
                  <td>{row.staff?.department || "—"}</td>
                  <td>{row.deals || "—"}</td>
                  <td>{row.due ? money(row.due) : "—"}</td>
                  <td>{row.paid ? money(row.paid) : "—"}</td>
                  <td>{row.outstanding > 0.005 ? <b>{money(row.outstanding)}</b> : "—"}</td>
                  <td>{row.salary ? money(row.salary) : "—"}</td>
                  <td><b>{money(row.total)}</b></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={8}><div className="empty compact">No commission or payroll records fall in this period.</div></td></tr>}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr>
                  <td><b>Total</b></td><td />
                  <td><b>{sum((row) => row.deals)}</b></td>
                  <td><b>{money(sum((row) => row.due))}</b></td>
                  <td><b>{money(sum((row) => row.paid))}</b></td>
                  <td><b>{money(sum((row) => row.outstanding))}</b></td>
                  <td><b>{money(sum((row) => row.salary))}</b></td>
                  <td><b>{money(sum((row) => row.total))}</b></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>
    </div>
  );
}

function ProjectRoom({
  project,
  room,
  viewer,
  members,
  onBack,
  notify,
}: {
  project: AccountingProject;
  room: ChatRoom;
  viewer: StaffUser | null;
  members: StaffUser[];
  onBack: () => void;
  notify: (text: string) => void;
}) {
  const dialog = useDialog();
  const [store, setStore] = useState<ChatStore>({ version: 1, rooms: [], messages: [], audit: [] });
  const [tab, setTab] = useState<"chat" | "files" | "members" | "audit">("chat");
  const [query, setQuery] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<ChatAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const feedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { setStore(readChatStore()); }, [project.id]);

  const moderator = Boolean(viewer && isAdmin(viewer));
  const messages = useMemo(
    () => store.messages
      .filter((row) => row.projectId === project.id)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()),
    [store.messages, project.id],
  );
  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => (!needle ? messages : messages.filter((row) =>
    row.body.toLowerCase().includes(needle)
    || row.authorName.toLowerCase().includes(needle)
    || row.attachments.some((file) => file.name.toLowerCase().includes(needle)))),
  [messages, needle]);
  const files = useMemo(
    () => messages.filter((row) => !row.deleted).flatMap((row) => row.attachments.map((file) => ({ file, row }))),
    [messages],
  );
  const audit = useMemo(
    () => store.audit.filter((row) => row.projectId === project.id),
    [store.audit, project.id],
  );

  // Follow the conversation, but never yank the view while someone is searching.
  useEffect(() => {
    if (tab === "chat" && !needle && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [visible.length, tab, needle]);

  const commit = (next: ChatStore, message: string) => {
    try {
      writeChatStore(next);
    } catch {
      notify("This device is out of storage for the project rooms. Remove some large attachments first.");
      return false;
    }
    setStore(next);
    if (message) notify(message);
    return true;
  };

  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    const ready: ChatAttachment[] = [];
    for (const file of Array.from(list)) {
      try {
        ready.push(await prepareAttachment(file));
      } catch (error) {
        notify((error as Error).message === "too-large"
          ? `"${file.name}" is too large to store. Photos are shrunk automatically; long videos need a file link instead.`
          : `"${file.name}" could not be read.`);
      }
    }
    setPending((current) => [...current, ...ready]);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const send = () => {
    if (!viewer) return;
    const text = body.trim();
    if (!text && !pending.length) return;
    const message: ChatMessage = {
      id: `cm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      projectId: project.id,
      authorId: viewer.id,
      authorName: viewer.name,
      authorRole: viewer.role || viewer.access || "",
      body: text,
      at: new Date().toISOString(),
      attachments: pending,
    };
    const next = chatAudit({ ...store, messages: [...store.messages, message] }, {
      projectId: project.id,
      actorId: viewer.id,
      actorName: viewer.name,
      action: "posted",
      detail: pending.length ? `${pending.length} attachment(s)${text ? " with a note" : ""}` : "Message",
    });
    if (!commit(next, "")) return;
    setBody("");
    setPending([]);
    if (chatStoreBytes() > CHAT_STORE_SOFT_LIMIT) {
      notify("Project rooms are near this device's storage limit. Consider archiving older photo threads.");
    }
  };

  const remove = async (row: ChatMessage) => {
    if (!viewer || !moderator) return;
    if (row.locked) { notify("This message is locked as a permanent record. Unlock it first."); return; }
    if (!(await dialog.confirm("Remove this message for everyone? The record of the removal is kept."))) return;
    const next = chatAudit({
      ...store,
      // A redaction must actually remove the content, not just hide it — the
      // body and the media are dropped and only the tombstone remains.
      messages: store.messages.map((item) => (item.id === row.id
        ? { ...item, body: "", attachments: [], deleted: true, deletedBy: viewer.name, deletedAt: new Date().toISOString() }
        : item)),
    }, {
      projectId: project.id,
      actorId: viewer.id,
      actorName: viewer.name,
      action: "removed",
      detail: `Message from ${row.authorName} of ${new Date(row.at).toLocaleString()}`,
    });
    commit(next, "Message removed. The audit trail keeps the record.");
  };

  /* Reacting is not an audited event: it is a lightweight signal, and logging
     every tap would bury the removals and locks that actually matter. */
  const react = (row: ChatMessage, emoji: string) => {
    if (!viewer || row.deleted) return;
    const next = {
      ...store,
      messages: store.messages.map((item) => {
        if (item.id !== row.id) return item;
        const current = item.reactions || {};
        const people = current[emoji] || [];
        const mine = people.includes(viewer.id);
        const updated = mine ? people.filter((id) => id !== viewer.id) : [...people, viewer.id];
        const reactions = { ...current, [emoji]: updated };
        if (!updated.length) delete reactions[emoji];
        return { ...item, reactions };
      }),
    };
    commit(next, "");
  };

  const nameFor = (id: string) => members.find((person) => person.id === id)?.name
    || (id === viewer?.id ? "You" : "Someone");

  const toggleLock = (row: ChatMessage) => {
    if (!viewer || !moderator) return;
    const locking = !row.locked;
    const next = chatAudit({
      ...store,
      messages: store.messages.map((item) => (item.id === row.id ? { ...item, locked: locking } : item)),
    }, {
      projectId: project.id,
      actorId: viewer.id,
      actorName: viewer.name,
      action: locking ? "locked" : "unlocked",
      detail: `Message from ${row.authorName} of ${new Date(row.at).toLocaleString()}`,
    });
    commit(next, locking ? "Locked as a permanent record." : "Lock removed.");
  };

  const exportTranscript = () => {
    downloadRows(`larsa-room-${(project.code || project.id).replace(/\W+/g, "-").toLowerCase()}.csv`, [
      ["When", "Author", "Role", "Message", "Attachments", "Status"],
      ...messages.map((row) => [
        new Date(row.at).toLocaleString(),
        row.authorName,
        row.authorRole,
        row.deleted ? "(removed)" : row.body,
        row.deleted ? "" : row.attachments.map((file) => file.name).join(" | "),
        row.deleted ? `Removed by ${row.deletedBy || "an administrator"}` : row.locked ? "Locked record" : "Posted",
      ]),
    ]);
  };

  const dayOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  let lastDay = "";

  return (
    <div className="room-shell">
      <section className="room-head">
        <button type="button" className="room-back" onClick={onBack} aria-label="Back to projects"><ArrowLeft size={17} /></button>
        <div className="room-title">
          <small>{project.code || "Construction project"} · {members.length} member{members.length === 1 ? "" : "s"}</small>
          <h2>{room.name}</h2>
          <p>{room.purpose || (project.clientName ? `Client: ${project.clientName}` : "No client recorded")}</p>
          <p className="room-origin">Opened by {room.createdBy} on {new Date(room.createdAt).toLocaleDateString()}</p>
        </div>
        <div className="room-head-actions">
          <button type="button" onClick={exportTranscript}><FileSpreadsheet size={15} /> Export</button>
        </div>
      </section>

      <div className="room-tabs settings-tabs" role="tablist" aria-label="Project room sections">
        {([["chat", `Messages (${messages.length})`], ["files", `Files (${files.length})`], ["members", `Members (${members.length})`], ["audit", `Record (${audit.length})`]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id}
            className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      <label className="room-search search-filter">
        <span>Search this group</span>
        <div><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Message text, a person's name, or a file name" /></div>
      </label>

      {tab === "chat" && (
        <>
          <div className="room-feed" ref={feedRef}>
            {visible.map((row) => {
              const own = row.authorId === viewer?.id;
              const day = dayOf(row.at);
              const showDay = day !== lastDay;
              lastDay = day;
              return (
                <div key={row.id}>
                  {showDay && !needle && <div className="room-day"><span>{day}</span></div>}
                  <article className={`room-msg${own ? " own" : ""}${row.deleted ? " gone" : ""}`}>
                    {!own && <b className="room-author">{row.authorName}<small>{row.authorRole}</small></b>}
                    {row.deleted ? (
                      <p className="room-removed"><Trash2 size={14} /> Removed by {row.deletedBy || "an administrator"} on {row.deletedAt ? new Date(row.deletedAt).toLocaleString() : "an earlier date"}</p>
                    ) : (
                      <>
                        {row.body && <p className="room-body">{row.body}</p>}
                        {row.attachments.length > 0 && (
                          <div className="room-media">
                            {row.attachments.map((file) => (
                              file.kind === "image" ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <a key={file.id} href={file.data} target="_blank" rel="noreferrer" className="room-shot"><img src={file.data} alt={file.name} /></a>
                              ) : file.kind === "video" ? (
                                <video key={file.id} src={file.data} controls preload="metadata" />
                              ) : (
                                <a key={file.id} href={file.data} download={file.name} className="room-file"><Paperclip size={15} /> {file.name}</a>
                              )
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {!row.deleted && (() => {
                      const chosen = Object.entries(row.reactions || {}).filter(([, ids]) => ids.length);
                      return (
                        <div className="room-reactions">
                          {chosen.map(([emoji, ids]) => (
                            <button
                              key={emoji}
                              type="button"
                              className={ids.includes(viewer?.id || "") ? "room-reaction mine" : "room-reaction"}
                              onClick={() => react(row, emoji)}
                              title={ids.map(nameFor).join(", ")}
                              aria-label={`${emoji} from ${ids.map(nameFor).join(", ")}`}
                            >
                              <span aria-hidden="true">{emoji}</span> {ids.length}
                            </button>
                          ))}
                          <span className="room-react-menu">
                            <button type="button" className="room-reaction add" aria-label="Add a reaction">+</button>
                            <span className="room-react-pop" role="group" aria-label="Choose a reaction">
                              {CHAT_REACTIONS.map((emoji) => (
                                <button key={emoji} type="button" onClick={() => react(row, emoji)} aria-label={`React ${emoji}`}>{emoji}</button>
                              ))}
                            </span>
                          </span>
                        </div>
                      );
                    })()}
                    <footer>
                      <time dateTime={row.at}>{new Date(row.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                      {row.locked && <span className="room-lock"><LockKeyhole size={12} /> Permanent</span>}
                      {moderator && !row.deleted && (
                        <>
                          <button type="button" onClick={() => toggleLock(row)}>{row.locked ? "Unlock" : "Keep forever"}</button>
                          {!row.locked && <button type="button" className="danger" onClick={() => remove(row)}>Remove</button>}
                        </>
                      )}
                    </footer>
                  </article>
                </div>
              );
            })}
            {!visible.length && (
              <div className="empty room-empty">
                {needle ? "Nothing in this group matches that search." : "No messages yet. Start the conversation with the client and the team."}
              </div>
            )}
          </div>

          <div className="room-composer">
            {pending.length > 0 && (
              <div className="room-pending">
                {pending.map((file) => (
                  <span key={file.id}>
                    {file.kind === "image" ? <ImageIcon size={13} /> : file.kind === "video" ? <Video size={13} /> : <Paperclip size={13} />}
                    {file.name}
                    <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setPending((current) => current.filter((item) => item.id !== file.id))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="room-composer-row">
              <button type="button" className="room-attach" onClick={() => fileRef.current?.click()} disabled={busy} aria-label="Attach photos, video, or a file">
                <Paperclip size={18} />
              </button>
              <input ref={fileRef} type="file" multiple accept="image/*,video/*,.pdf,.dwg,.doc,.docx,.xls,.xlsx"
                onChange={(event) => attach(event.target.files)} hidden />
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }}
                placeholder={busy ? "Preparing attachments…" : "Write to the client and the team…"}
                rows={1}
              />
              <button type="button" className="room-send primary" onClick={send} disabled={busy || (!body.trim() && !pending.length)}>
                <Send size={17} /> Send
              </button>
            </div>
            <p className="room-note">Everyone in this group sees every message. Removals are recorded and never erase the trail.</p>
          </div>
        </>
      )}

      {tab === "files" && (
        <div className="room-panel">
          <div className="room-gallery">
            {files.filter(({ file }) => !needle || file.name.toLowerCase().includes(needle)).map(({ file, row }) => (
              <a key={file.id} href={file.data} target="_blank" rel="noreferrer" download={file.kind === "file" ? file.name : undefined} className="room-gallery-item">
                {file.kind === "image"
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={file.data} alt={file.name} />
                  : <span className="room-gallery-icon">{file.kind === "video" ? <Video size={22} /> : <Paperclip size={22} />}</span>}
                <small>{file.name}</small>
                <em>{row.authorName} · {new Date(row.at).toLocaleDateString()}</em>
              </a>
            ))}
          </div>
          {!files.length && <div className="empty">No photos, videos, or files have been shared in this group yet.</div>}
        </div>
      )}

      {tab === "members" && (
        <div className="room-panel">
          <table className="data-table">
            <thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Access</th></tr></thead>
            <tbody>
              {members
                .filter((person) => !needle || person.name.toLowerCase().includes(needle))
                .map((person) => (
                  <tr key={person.id}>
                    <td>{person.name}{person.id === viewer?.id ? " (you)" : ""}</td>
                    <td>{person.role || "—"}</td>
                    <td>{person.department || "—"}</td>
                    <td>{isAdmin(person) ? "Can moderate" : "Can post"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="room-note">Membership follows project access. Add or remove people in Users &amp; Access, and this group follows.</p>
        </div>
      )}

      {tab === "audit" && (
        <div className="room-panel">
          <table className="data-table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>
              {audit
                .filter((row) => !needle || `${row.actorName} ${row.action} ${row.detail}`.toLowerCase().includes(needle))
                .map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.at).toLocaleString()}</td>
                    <td>{row.actorName}</td>
                    <td><span className={`record-status ${row.action === "removed" ? "on-hold" : "active"}`}>{row.action}</span></td>
                    <td>{row.detail}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {!audit.length && <div className="empty">Nothing has happened in this group yet.</div>}
        </div>
      )}
    </div>
  );
}

/* An admin-managed, project-scoped, read-only client account. Lives in
   Supabase's viewer_accounts table with a real Supabase Auth identity —
   never in the larsaStaffV8 users[] array — so it is a distinct shape,
   not a StaffUser variant. */
type ViewerAccountRow = {
  id: string;
  auth_user_id: string;
  username: string;
  display_name: string;
  project_access_mode: "all" | "assigned" | "none";
  allowed_project_ids: string[];
  enabled: boolean;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
};
type ViewerDraft = {
  id: string;
  username: string;
  displayName: string;
  projectAccessMode: "all" | "assigned" | "none";
  allowedProjectIds: string[];
  enabled: boolean;
  expiresAt: string;
};

/* Fire-and-forget audit entries for the account-lifecycle actions that
   stay client/localStorage-driven (role changes, permission changes,
   activate/deactivate, approve/reject). Viewer-account actions are
   logged server-side by the viewer-admin Edge Function instead. Never
   includes a password, PIN, or hash. */
function logAccountEvent(actor: StaffUser | null, action: string, targetId: string, targetLabel: string, details: Record<string, unknown> = {}) {
  const client = getSupabaseClient();
  const email = actor?.email?.trim().toLowerCase();
  if (!client || !email) return;
  void client.rpc("account_audit_log", {
    actor: { email, access: actor?.access || "" },
    p_action: action,
    p_target_type: "staff_user",
    p_target_id: targetId,
    p_target_label: targetLabel,
    p_details: details,
  }).then(({ error }: { error: unknown }) => { if (error) console.warn("[audit]", action, error); });
}

function logAccountChanges(actor: StaffUser | null, previous: StaffUser | undefined, next: StaffUser, isNew: boolean) {
  if (isNew) {
    logAccountEvent(actor, "account.created", next.id, next.name, { access: next.access || "" });
    return;
  }
  if (!previous) return;
  if (previous.pendingApproval && !next.pendingApproval && next.enabled !== false) {
    logAccountEvent(actor, "account.approved", next.id, next.name, { access: next.access || "" });
  }
  if ((previous.access || "") !== (next.access || "")) {
    logAccountEvent(actor, "account.role_changed", next.id, next.name, { from: previous.access || "", to: next.access || "" });
  }
  if ((previous.enabled !== false) !== (next.enabled !== false)) {
    logAccountEvent(actor, next.enabled === false ? "account.deactivated" : "account.activated", next.id, next.name, {});
  }
  const prevGrants = JSON.stringify(previous.permissionProfile?.grants || {});
  const nextGrants = JSON.stringify(next.permissionProfile?.grants || {});
  if (prevGrants !== nextGrants) {
    logAccountEvent(actor, "account.permissions_changed", next.id, next.name, { preset: next.permissionProfile?.preset || "" });
  }
}

type ViewerProjectRow = {
  id: string; code: string; name: string; client: string; region: string;
  type: string; status: string; contract_value: number | null; currency: string; created_at: string;
};
type ViewerProgressRow = { id: string; percent: number | null; update_date: string | null; note: string | null; created_at: string };
type ViewerSummary = Record<string, unknown> | null;

function fmtIQD(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " IQD" : "—";
}
function fmtUSD(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—";
}
function fmtPct(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) + "%" : "—";
}

/* What a Viewer sees after signing in: a fixed, minimal, read-only screen —
   never the staff app shell. Every fetch here goes straight to Supabase and
   is scoped by the RESTRICTIVE policies and viewer_project_summary's own
   check in 20260803_acct_016/018_*.sql; nothing is loaded first and hidden
   second. If a project is not this Viewer's, the query simply never returns
   it — there is no client-side filter here doing that job. */
function ViewerPortal({ session, onSignOut }: { session: ViewerSession; onSignOut: () => void }) {
  const [projects, setProjects] = useState<ViewerProjectRow[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [summary, setSummary] = useState<ViewerSummary>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [progress, setProgress] = useState<ViewerProgressRow[]>([]);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const client = getSupabaseClient();
    if (!client) { setProjectsError("This deployment is not connected to Supabase."); setProjectsLoading(false); return; }
    if (session.projectAccessMode === "none") { setProjectsLoading(false); return; }
    client
      .from("acct_projects")
      .select("id, code, name, client, region, type, status, contract_value, currency, created_at")
      .order("code", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        setProjectsLoading(false);
        if (error) { setProjectsError("Could not load your projects. Try reloading the page."); return; }
        const rows = (data || []) as ViewerProjectRow[];
        setProjects(rows);
        if (rows.length) setSelectedId(rows[0].id);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedId) { setSummary(null); setProgress([]); return; }
    let cancelled = false;
    const client = getSupabaseClient();
    if (!client) return;
    setSummaryLoading(true);
    client.rpc("viewer_project_summary", { p_project_id: selectedId }).then(({ data }) => {
      if (cancelled) return;
      setSummaryLoading(false);
      setSummary((data as ViewerSummary) || null);
    });
    client
      .from("acct_progress_updates")
      .select("id, percent, update_date, note, created_at")
      .eq("project_id", selectedId)
      .order("update_date", { ascending: false })
      .limit(25)
      .then(({ data }) => {
        if (cancelled) return;
        setProgress((data || []) as ViewerProgressRow[]);
      });
    return () => { cancelled = true; };
  }, [selectedId]);

  const selectedProject = projects.find((row) => row.id === selectedId) || null;

  const handleSignOut = async () => {
    setSigningOut(true);
    await onSignOut();
  };

  return (
    <div className="viewer-portal">
      <header className="viewer-portal-header">
        <div className="viewer-portal-brand">
          <Image src="/icons/larsa-logo.svg" alt="Larsa Engineering" width={140} height={54} priority />
          <div>
            <span className="eyebrow">Client Access</span>
            <h1>{session.displayName}</h1>
          </div>
        </div>
        <button type="button" className="btn icon-label" onClick={handleSignOut} disabled={signingOut}>
          <LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </header>

      <main className="viewer-portal-body">
        {session.projectAccessMode === "none" ? (
          <div className="viewer-portal-empty">
            <FolderLock size={28} />
            <p>No projects are shared with your account yet. Contact your Larsa Engineering representative if you believe this is a mistake.</p>
          </div>
        ) : projectsLoading ? (
          <div className="viewer-portal-empty"><p>Loading your projects…</p></div>
        ) : projectsError ? (
          <div className="viewer-portal-empty"><p>{projectsError}</p></div>
        ) : !projects.length ? (
          <div className="viewer-portal-empty">
            <FolderLock size={28} />
            <p>No projects are shared with your account yet. Contact your Larsa Engineering representative if you believe this is a mistake.</p>
          </div>
        ) : (
          <>
            <aside className="viewer-portal-list" aria-label="Your projects">
              {projects.map((project) => (
                <button
                  type="button"
                  key={project.id}
                  className={project.id === selectedId ? "viewer-project-row active" : "viewer-project-row"}
                  onClick={() => setSelectedId(project.id)}
                >
                  <b>{project.code || project.name}</b>
                  <span>{project.name}</span>
                  <small>{project.status || "Active"}</small>
                </button>
              ))}
            </aside>

            <section className="viewer-portal-detail">
              {selectedProject && (
                <>
                  <div className="viewer-portal-detail-head">
                    <div>
                      <span className="eyebrow">{selectedProject.code}</span>
                      <h2>{selectedProject.name}</h2>
                      <small>{[selectedProject.region, selectedProject.type].filter(Boolean).join(" · ")}</small>
                    </div>
                    <span className="black-badge">{selectedProject.status || "Active"}</span>
                  </div>

                  {summaryLoading ? (
                    <p className="viewer-portal-hint">Loading numbers…</p>
                  ) : !summary ? (
                    <p className="viewer-portal-hint">Numbers are not available for this project right now.</p>
                  ) : (
                    <div className="viewer-summary-grid">
                      <div className="viewer-summary-card">
                        <Wallet size={18} />
                        <span className="eyebrow">Funded</span>
                        <b>{fmtIQD(summary.gross_funding_iqd)}</b>
                        <small>{fmtUSD(summary.gross_funding_usd)}</small>
                      </div>
                      <div className="viewer-summary-card">
                        <CircleDollarSign size={18} />
                        <span className="eyebrow">Spent to date</span>
                        <b>{fmtIQD(summary.total_used_iqd)}</b>
                        <small>{fmtUSD(summary.total_used_usd)}</small>
                      </div>
                      <div className="viewer-summary-card">
                        <HardHat size={18} />
                        <span className="eyebrow">Construction cost</span>
                        <b>{fmtIQD(summary.actual_construction_cost_iqd)}</b>
                        <small>Materials {fmtIQD(summary.materials_iqd)} · Labor {fmtIQD(summary.labor_iqd)}</small>
                      </div>
                      <div className="viewer-summary-card">
                        <TrendingUp size={18} />
                        <span className="eyebrow">Remaining balance</span>
                        <b>{fmtIQD(summary.approved_remaining_balance_iqd)}</b>
                      </div>
                      <div className="viewer-summary-card">
                        <Gauge size={18} />
                        <span className="eyebrow">Cost progress</span>
                        <b>{fmtPct(summary.cost_progress_pct)}</b>
                      </div>
                      <div className="viewer-summary-card">
                        <CalendarDays size={18} />
                        <span className="eyebrow">Schedule progress</span>
                        <b>{fmtPct(summary.schedule_progress_pct)}</b>
                        <small>{String(summary.schedule_progress_date || "")}</small>
                      </div>
                    </div>
                  )}

                  <h3 className="viewer-portal-subhead">Progress updates</h3>
                  {progress.length ? (
                    <ul className="viewer-progress-list">
                      {progress.map((row) => (
                        <li key={row.id}>
                          <b>{fmtPct(row.percent)}</b>
                          <span>{row.update_date || ""}</span>
                          <small>{row.note || ""}</small>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="viewer-portal-hint">No progress updates have been posted yet.</p>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function AccessCenter({
  users,
  projects,
  currentUser,
  saveUser,
  deleteUser,
  restoreUser,
  recycleUser,
  binRestoreUser,
  purgeUser,
  canPurge,
  sessions,
  store,
  previewUser,
  canCreate,
  canEdit,
  canDelete,
}: {
  users: StaffUser[];
  projects: AccountingProject[];
  currentUser: StaffUser | null;
  saveUser: (user: StaffUser, isNew: boolean) => boolean;
  deleteUser: (user: StaffUser) => boolean | Promise<boolean>;
  restoreUser: (user: StaffUser, historyMode?: "all" | "current" | "from", historyFrom?: string) => boolean | Promise<boolean>;
  recycleUser: (user: StaffUser) => boolean | Promise<boolean>;
  binRestoreUser: (user: StaffUser) => boolean | Promise<boolean>;
  purgeUser: (user: StaffUser) => boolean | Promise<boolean>;
  canPurge: boolean;
  sessions: ClockSession[];
  store: Record<string, unknown> | null;
  previewUser: (user: StaffUser) => void;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const dialog = useDialog();
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<StaffUser | null>(null);
  const [isNew, setIsNew] = useState(false); const [skipInitialVerify, setSkipInitialVerify] = useState(false);
  const [query, setQuery] = useState("");
  const [permissionQuery, setPermissionQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [formError, setFormError] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  /* The company's departments, read from the Engineering Management chart —
     the same source the structure page edits, so the two can never drift
     apart. When no chart has been saved yet this falls back to the departments
     implied by the staff list, which is what the rest of the app already does.

     Typing this field free-hand is what produced "Structural", "structural"
     and "Struct." as three separate departments, and a report that counted
     them as three. */
  const orgDepartments = useMemo(
    () => effectiveOrg(users).departments.map((row) => String(row.name || "").trim()).filter(Boolean),
    [users],
  );
  /* A value already on somebody's record stays in the list even when it is not
     in the chart. Dropping it would mean opening an account to change a phone
     number and silently clearing their department on save. */
  const departmentChoices = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    [...orgDepartments, String(draft?.department || "").trim()].forEach((name) => {
      const key = name.toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      list.push(name);
    });
    return list.sort((left, right) => left.localeCompare(right));
  }, [orgDepartments, draft?.department]);
  /* Three tabs, one directory each: requests waiting on a decision,
     existing email-based staff, and admin-managed Viewer accounts. Viewer
     accounts are never in `users` — they live in Supabase's viewer_accounts
     table with a real auth identity, so this tab keeps its own state and
     talks to the viewer-admin Edge Function rather than saveUser/deleteUser. */
  const [tab, setTab] = useState<"pending" | "active" | "viewers" | "offboarded" | "recycled">("active");
  /* Reactivation dialog state: which offboarded person, and the history
     handling the admin picked (Part 16: include all / current period only /
     from a chosen date — no option deletes stored history). */
  const [reactivating, setReactivating] = useState<StaffUser | null>(null);
  const [reactivateMode, setReactivateMode] = useState<"all" | "current" | "from">("all");
  const [reactivateFrom, setReactivateFrom] = useState("");
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [viewers, setViewers] = useState<ViewerAccountRow[]>([]);
  const [viewersLoading, setViewersLoading] = useState(false);
  const [viewersError, setViewersError] = useState("");
  const [viewerSelectedId, setViewerSelectedId] = useState("");
  const [viewerDraft, setViewerDraft] = useState<ViewerDraft | null>(null);
  const [viewerIsNew, setViewerIsNew] = useState(false);
  const [viewerBusy, setViewerBusy] = useState(false);
  const [viewerError, setViewerError] = useState("");
  const [viewerResetting, setViewerResetting] = useState(false);
  const [viewerNewPassword, setViewerNewPassword] = useState("");
  const [viewerNewPasswordConfirm, setViewerNewPasswordConfirm] = useState("");
  const [viewerProjectQuery, setViewerProjectQuery] = useState("");

  /* The sync layer signs this browser in anonymously during boot, and that is
     what turns the request's role from `anon` into `authenticated` — the role
     the viewer_accounts read policy is written for. This panel mounts first,
     so firing the query straight away raced that sign-in and came back with a
     permission error, which is why the screen showed "Could not load Viewer
     accounts" and "No Viewer accounts yet" one above the other: an error from
     a request that was simply too early, next to an empty list.

     So it waits for the session rather than reporting a failure it caused. */
  const reloadViewers = useCallback(async () => {
    const client = getSupabaseClient();
    if (!client) return;
    setViewersLoading(true);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { data: session } = await client.auth.getSession();
      if (!session.session) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      const { data, error } = await client
        .from("viewer_accounts").select("*").order("created_at", { ascending: false });
      if (!error) {
        setViewers((data || []) as ViewerAccountRow[]);
        setViewersError("");
        setViewersLoading(false);
        return;
      }
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    setViewersLoading(false);
    // Only now is it a real failure rather than an early one.
    setViewersError(lastError
      ? "Could not load Viewer accounts. Check your connection and try again."
      : "Still connecting to the account service — reopen this tab in a moment.");
  }, []);

  useEffect(() => { void reloadViewers(); }, [reloadViewers]);

  const selectUser = useCallback((user: StaffUser) => {
    setSelectedId(user.id);
    setDraft({
      ...user,
      permissionProfile: accessProfileForUser(user),
      projectAccessMode: user.projectAccessMode || projectAccessForPreset(user.access || "Engineer"),
      projectIds: [...(user.projectIds || [])],
    });
    setIsNew(false);
    setFormError("");
  }, []);

  useEffect(() => {
    if (isNew || !users.length) return;
    // Only (re)select when nothing is loaded or the selected account disappeared.
    // Re-running on every users[] identity change wiped unsaved permission edits.
    if (selectedId && users.some((user) => user.id === selectedId)) return;
    const selected = users.find((user) => user.id === currentUser?.id) || users[0];
    const timer = window.setTimeout(() => selectUser(selected), 0);
    return () => clearTimeout(timer);
  }, [currentUser?.id, isNew, selectUser, selectedId, users]);

  const startNewUser = () => {
    if (!canCreate) return;
    const profile = presetPermissionProfile("Engineer");
    const id = `u${Date.now()}`;
    setSelectedId(id);
    setDraft({
      id,
      name: "",
      email: "",
      password: "",
      pin: "",
      access: "Engineer",
      role: "Engineer",
      department: "",
      enabled: true,
      permissionProfile: profile,
      permissions: [],
      constraints: [],
      projectAccessMode: "assigned",
      projectIds: [],
    });
    setIsNew(true);
    setFormError("");
  };

  const updateDraft = (field: keyof StaffUser, value: string | boolean) => {
    setDraft((current) => current ? { ...current, [field]: value } : current);
  };

  const applyPreset = (preset: string) => {
    if (!draft || draft.access === "Super Admin") return;
    setDraft({
      ...draft,
      access: preset,
      permissionProfile: presetPermissionProfile(preset),
      projectAccessMode: projectAccessForPreset(preset),
    });
  };

  const updateProjectMode = (mode: ProjectAccessMode) => {
    if (!draft || draft.access === "Super Admin") return;
    setDraft({ ...draft, projectAccessMode: mode });
  };

  const toggleProject = (projectId: string, checked: boolean) => {
    if (!draft || draft.access === "Super Admin") return;
    const selected = new Set(draft.projectIds || []);
    if (checked) selected.add(projectId);
    else selected.delete(projectId);
    setDraft({
      ...draft,
      projectAccessMode: "assigned",
      projectIds: [...selected],
    });
  };

  const updateScope = (scope: DataScope) => {
    if (!draft?.permissionProfile || draft.access === "Super Admin") return;
    setDraft({
      ...draft,
      permissionProfile: { ...draft.permissionProfile, preset: "Custom", scope },
    });
  };

  const setPermission = (item: Item, action: PermissionAction, checked: boolean) => {
    if (!draft?.permissionProfile || draft.access === "Super Admin") return;
    const grants = {
      ...draft.permissionProfile.grants,
      [item.id]: { ...draft.permissionProfile.grants[item.id], [action]: checked },
    };
    if (action !== "view" && checked) grants[item.id].view = true;
    if (action === "view" && !checked) {
      permissionActionsFor(item).forEach((rowAction) => {
        grants[item.id][rowAction] = false;
      });
    }
    setDraft({
      ...draft,
      permissionProfile: { ...draft.permissionProfile, preset: "Custom", grants },
    });
  };

  const setRowPermissions = (item: Item, checked: boolean) => {
    if (!draft?.permissionProfile || draft.access === "Super Admin") return;
    const grants = {
      ...draft.permissionProfile.grants,
      [item.id]: { ...draft.permissionProfile.grants[item.id] },
    };
    permissionActionsFor(item).forEach((action) => {
      grants[item.id][action] = checked;
    });
    setDraft({
      ...draft,
      permissionProfile: { ...draft.permissionProfile, preset: "Custom", grants },
    });
  };

  const setGroupMode = (group: { label: string; items: Item[] }, mode: "view" | "full" | "clear") => {
    if (!draft?.permissionProfile || draft.access === "Super Admin") return;
    const grants = { ...draft.permissionProfile.grants };
    group.items.forEach((item) => {
      grants[item.id] = { ...grants[item.id] };
      permissionActionsFor(item).forEach((action) => {
        grants[item.id][action] = mode === "full" || (mode === "view" && action === "view");
      });
    });
    setDraft({
      ...draft,
      permissionProfile: { ...draft.permissionProfile, preset: "Custom", grants },
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isNew ? !canCreate : !canEdit) {
      setFormError("Your account has view-only access to this user.");
      return;
    }
    if (!draft?.permissionProfile) return;
    const email = draft.email?.trim().toLowerCase() || "";
    const pinAlreadyStored = isHashed(draft.pin); const pin = pinAlreadyStored ? String(draft.pin) : (draft.pin?.replace(/\D/g, "") || "");
    /* Clients, trainees, and interns are username-and-password accounts an
       admin sets up: no email address is required (so no email verification
       ever applies), and the PIN is optional for them. Everyone else keeps
       the full requirement. */
    const usernameOnly = USERNAME_ONLY_PRESETS.includes(draft.access || "");
    /* Email-based (non-username-only) accounts are self-registered by the
       person via Create Account — the account owner chooses their own
       password, an admin only approves/assigns role and access afterward.
       A brand-new email-based record has no such registration behind it,
       so this form no longer originates one; only username-only roles
       (an admin-managed account with no email) can still be created here. */
    if (isNew && !usernameOnly) {
      setFormError("New email-based accounts are created by the person themselves via Create Account. Approve their request from Pending Requests once they've signed up, or choose a username-only role for an account an admin fully manages.");
      return;
    }
    /* Passwords and PINs belong to the person, not the administrator: an
       email-based account chose both at Create Account, and only its owner can
       change them (My Settings → Security, behind an email code). So editing
       someone's ACCESS must never demand — or touch — their secrets; a legacy
       record with no PIN yet must still be editable. Only a brand-new
       username-only account, which an admin fully manages by design, still
       needs a starting password here. */
    if (!draft.name.trim() || (isNew && !draft.password) || (!usernameOnly && !email)) {
      setFormError(usernameOnly
        ? (isNew ? "Name and a starting password are required." : "Name is required.")
        : "Name and work email are required.");
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError("Enter a valid work email.");
      return;
    }
    if (pin && !pinAlreadyStored && (pin.length < 4 || pin.length > 8)) {
      setFormError("PIN must contain 4 to 8 digits.");
      return;
    }
    const duplicate = users.find((user) =>
      user.id !== draft.id &&
      user.recycled !== true &&
      Boolean(email) &&
      (user.email?.trim().toLowerCase() === email),
    );
    const pinClash = !pin || pinAlreadyStored ? false : await pinTakenByOther(users, pin, draft.id); if (duplicate || pinClash) {
      setFormError("That email or PIN is already assigned to another user.");
      return;
    }
    /* Username-only accounts sign in with the username alone, so it must
       exist and be unique. Derived from the email's local part when there is
       one, otherwise from the person's name. */
    const usernameBase = (draft.username?.trim() || email.split("@")[0] || draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "user");
    let uniqueUsername = usernameBase.toLowerCase();
    let usernameSuffix = 1;
    while (users.some((user) => user.id !== draft.id && (user.username || "").trim().toLowerCase() === uniqueUsername)) {
      usernameSuffix += 1;
      uniqueUsername = `${usernameBase.toLowerCase()}${usernameSuffix}`;
    }
    const nextUser: StaffUser = {
      ...draft,
      email,
      pin,
      username: uniqueUsername,
      enabled: draft.enabled !== false,
      projectAccessMode: protectedAccount
        ? "all"
        : draft.projectAccessMode || projectAccessForPreset(draft.access || "Engineer"),
      projectIds: protectedAccount ? [] : draft.projectIds || [],
      permissions: staffPermissionsForUser(draft),
    };
    const previousUser = users.find((user) => user.id === draft.id);
    const securedUser: StaffUser = { ...nextUser, password: !nextUser.password ? "" : isHashed(nextUser.password) ? nextUser.password : await hashPassword(String(nextUser.password)), pin: !pin ? "" : pinAlreadyStored ? pin : await hashPin(pin), ...(!nextUser.password || isHashed(nextUser.password) ? {} : { passwordChangedAt: serverNowIso() }), ...(!pin || pinAlreadyStored ? {} : { pinChangedAt: serverNowIso() }) }; if (saveUser(securedUser, isNew)) {
      logAccountChanges(currentUser, previousUser, securedUser, isNew);
      if (skipInitialVerify && currentUser && currentUser.email) { void (async () => { const client = getSupabaseClient(); if (!client) return; try { await client.functions.invoke("auth-code", { body: { op: "send", email: currentUser.email, purpose: "verify", name: currentUser.name } }); const code = await dialog.prompt("Skipping email verification is a platform change. Enter the code just sent to " + currentUser.email + " to confirm."); if (!code) { setFormError("Not confirmed - " + nextUser.name + " will verify their own email at first sign-in."); return; } const { data } = await client.functions.invoke("auth-policy", { body: { op: "approveUser", actorEmail: currentUser.email, code: code.trim(), userId: nextUser.id, userEmail: nextUser.email, role: nextUser.access } }); if (!data || !(data as { ok?: boolean }).ok) { setFormError("That code was not accepted - " + nextUser.name + " will verify their own email at first sign-in."); } } catch { setFormError("Could not confirm the skip. " + nextUser.name + " will verify their own email at first sign-in."); } })(); } setSkipInitialVerify(false);      setSelectedId(nextUser.id);
      setDraft(securedUser);
      setIsNew(false);
      setFormError("");
    }
  };

  /* Approve/reject a pending self-registered request. Deliberately not
     routed through submit(): this never touches password/PIN, and a
     rejected account is disabled and logged, not deleted — an admin who
     genuinely wants it gone can still use Delete Account afterward. */
  const decidePending = async (approve: boolean) => {
    if (!draft || !canChangeDraft) return;
    const nextUser: StaffUser = {
      ...draft,
      enabled: approve,
      pendingApproval: false,
      projectAccessMode: draft.projectAccessMode || projectAccessForPreset(draft.access || "Engineer"),
      permissions: staffPermissionsForUser(draft),
    };
    if (saveUser(nextUser, false)) {
      logAccountEvent(currentUser, approve ? "account.approved" : "account.rejected", nextUser.id, nextUser.name, { access: nextUser.access || "" });
      setSelectedId(nextUser.id);
      setDraft(nextUser);
      setFormError("");
    }
  };

  const pendingUsers = users.filter((user) => user.pendingApproval === true && user.offboarded !== true);
  const activeUsers = users.filter((user) => user.pendingApproval !== true && user.access !== "Client" && user.offboarded !== true);
  const offboardedUsers = users.filter((user) => user.offboarded === true && user.recycled !== true);
  const recycledUsers = users.filter((user) => user.recycled === true);
  const tabUsers = tab === "pending" ? pendingUsers : tab === "active" ? activeUsers : [];
  const filteredUsers = tabUsers.filter((user) =>
    [user.name, user.email, user.department, user.access]
      .some((value) => String(value || "").toLowerCase().includes(query.trim().toLowerCase())),
  );
  const filteredPermissionGroups = ACCESS_GROUPS
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        `${item.label} ${item.description}`.toLowerCase().includes(permissionQuery.trim().toLowerCase()),
      ),
    }))
    .filter((group) => group.items.length);
  const filteredProjects = projects.filter((project) =>
    [
      project.code,
      project.name,
      project.clientName,
      project.responsibleEngineer,
      project.projectManager,
      project.teamLeader,
    ].some((value) => value.toLowerCase().includes(projectQuery.trim().toLowerCase())),
  );
  const protectedAccount = draft?.access === "Super Admin";
  /* Accounting: closed for every role, opened one person at a time, and only
     by the Developer or a Super Admin. Super Admins and Accountants already
     hold it through their role, so for them the switch is shown satisfied and
     inert rather than pretending to be the thing granting it. */
  const canGrantAccounting = currentUser?.platformAdmin === true || currentUser?.access === "Super Admin";
  const accountingByRole = draft?.access === "Super Admin" || draft?.access === "Accountant";
  const accountingOpen = accountingByRole || draft?.accountingAccess === true;
  const enabledPermissionCount = draft?.permissionProfile
    ? Object.values(draft.permissionProfile.grants)
        .flatMap((actions) => Object.values(actions))
        .filter(Boolean).length
    : 0;
  const canChangeDraft = isNew ? canCreate : canEdit;
  const removeDraft = async () => {
    if (!draft || isNew || !canDelete || protectedAccount) return;
    if (await deleteUser(draft)) {
      setSelectedId("");
      setDraft(null);
      setIsNew(false);
      setFormError("");
    }
  };

  return (
    <div className="native-scroll access-scroll">
      <section className="overview-hero access-hero">
        <div>
          <span className="eyebrow">Administration</span>
          <h2>Users & Access</h2>
          <p>Set the job role, then choose every area and action this person can use.</p>
        </div>
        <span className="access-pill"><LockKeyhole size={16} /> Detailed custom access</span>
      </section>

      <div className="scope-switch" role="group" aria-label="Users & Access view">
        <span className="scope-switch-label">View</span>
        <div className="scope-switch-track">
          <button type="button" className={tab === "pending" ? "active" : ""} aria-pressed={tab === "pending"} onClick={() => setTab("pending")}>
            Pending Requests{pendingUsers.length ? ` (${pendingUsers.length})` : ""}
          </button>
          <button type="button" className={tab === "active" ? "active" : ""} aria-pressed={tab === "active"} onClick={() => setTab("active")}>Active Users</button>
          <button type="button" className={tab === "viewers" ? "active" : ""} aria-pressed={tab === "viewers"} onClick={() => setTab("viewers")}>Viewer Accounts</button>
          <button type="button" className={tab === "offboarded" ? "active" : ""} aria-pressed={tab === "offboarded"} onClick={() => setTab("offboarded")}>
            Offboarded{offboardedUsers.length ? ` (${offboardedUsers.length})` : ""}
          </button>
          <button type="button" className={tab === "recycled" ? "active" : ""} aria-pressed={tab === "recycled"} onClick={() => setTab("recycled")}>
            Recycling Bin{recycledUsers.length ? ` (${recycledUsers.length})` : ""}
          </button>
        </div>
      </div>

      {tab !== "viewers" && tab !== "offboarded" && tab !== "recycled" && (
      <section className="access-layout">
        <aside className="access-directory">
          <div className="access-directory-head">
            <div><span className="eyebrow">Directory</span><h3>{tabUsers.length} {tab === "pending" ? "pending" : "active"}</h3></div>
            {tab === "active" && <button type="button" className="primary icon-label" onClick={startNewUser} disabled={!canCreate}><Plus size={16} /> New User</button>}
          </div>
          {tab === "pending" && <p className="org-note">Username-only roles (Trainee, Intern) are still created directly — use Active Users. New email-based accounts only ever arrive here, from the person&apos;s own Create Account request.</p>}
          <label className="access-search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search users" />
          </label>
          <div className="access-user-list">
            {!filteredUsers.length && <div className="empty compact">{tab === "pending" ? "No pending requests." : "No matching users."}</div>}
            {filteredUsers.map((user) => (
              <button
                type="button"
                key={user.id}
                className={selectedId === user.id && !isNew ? "access-user active" : "access-user"}
                onClick={() => selectUser(user)}
              >
                <PersonAvatar person={user} />
                <span><b>{user.name}</b><small>{user.access || user.role} · {user.department || "No department"}</small></span>
                <i className={user.enabled === false ? "off" : ""} />
              </button>
            ))}
          </div>
        </aside>

        {draft ? (
          <form className="access-editor" onSubmit={submit}>
            <div className="access-editor-head">
              <div>
                <span className="eyebrow">{isNew ? "New account" : "Selected user"}</span>
                <h3>{draft.name || "New Larsa user"}</h3>
                <p>{enabledPermissionCount} permission choices enabled</p>
              </div>
              <div className="editor-badges">
                <button type="button" className="preview-user-button" onClick={() => previewUser(draft)} disabled={isNew}>
                  <Eye size={15} /> Preview as User
                </button>
                {!protectedAccount && !isNew && canDelete && (
                  <button type="button" className="delete-user-button" onClick={removeDraft}>
                    <Trash2 size={14} /> Offboard Account
                  </button>
                )}
                {protectedAccount && <span className="protected-badge"><ShieldCheck size={14} /> Protected owner</span>}
                <span className={draft.enabled === false ? "status-badge off" : "status-badge"}>{draft.enabled === false ? "Disabled" : "Active"}</span>
              </div>
            </div>

            <fieldset className="access-edit-fields" disabled={!canChangeDraft}>
            {draft.pendingApproval ? (
              <section className="access-section">
                <div className="access-section-title">
                  <div><ShieldCheck size={18} /><span><b>Pending request</b><small>Review the name and email below, then approve or reject — no password or PIN is ever shown here.</small></span></div>
                </div>
                <div className="access-fields">
                  <div className="rowActions">
                    <button type="button" className="primary icon-label" onClick={() => void decidePending(true)} disabled={!canChangeDraft}>Approve</button>
                    <button type="button" className="icon-label" onClick={() => void decidePending(false)} disabled={!canChangeDraft}>Reject</button>
                  </div>
                </div>
              </section>
            ) : null}
            <section className="access-section">
              <div className="access-section-title">
                <div><KeyRound size={18} /><span><b>Sign-in & identity</b><small>{USERNAME_ONLY_PRESETS.includes(draft.access || "") ? "Username and password, set by an admin" : "Email address only — the account owner controls their own password and PIN"}</small></span></div>
              </div>
              <div className="access-fields">
                <label>Full Name<input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
                <label>{USERNAME_ONLY_PRESETS.includes(draft.access || "") ? "Email (optional)" : "Work Email"}<input type="email" value={draft.email || ""} onChange={(event) => updateDraft("email", event.target.value)} /></label>
                {USERNAME_ONLY_PRESETS.includes(draft.access || "") ? (
                  <>
                    <p className="org-note">This account signs in with a username and password only — no email or verification codes. Username: <b>{(draft.username?.trim() || draft.email?.split("@")[0]?.trim() || draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "user")}</b> (PIN optional).</p>
                    <label>
                      Password
                      <span className="password-field access-password">
                        <input type={showSecret ? "text" : "password"} value={isHashed(draft.password) ? "" : (draft.password || "")} onChange={(event) => updateDraft("password", event.target.value)} />
                        <button type="button" onClick={() => setShowSecret((value) => !value)} aria-label={showSecret ? "Hide password" : "Show password"}>
                          {showSecret ? <EyeOff size={17} /> : <Eye size={17} />}
                        </button>
                      </span>
                    </label>
                    <label>Employee PIN<input inputMode="numeric" value={isHashed(draft.pin) ? "" : (draft.pin || "")} onChange={(event) => updateDraft("pin", event.target.value.replace(/\D/g, ""))} /></label>
                  </>
                ) : (
                  <p className="org-note">Password and PIN are never shown or set here — {draft.name || "this person"} chooses and changes their own from My Settings, or resets it themselves by email if forgotten.</p>
                )}
                {/* Take down, never put up. Somebody has to be able to remove
                    an unsuitable picture, but an administrator choosing what
                    face appears next to another person's name is a different
                    thing entirely -- the same reason they cannot set a
                    password here. */}
                {draft.photo && (
                  <div className="photo-row compact">
                    <PersonAvatar person={draft} className="photo-preview" />
                    <div className="photo-copy">
                      <b>Profile photo</b>
                      <small>Set by {draft.name || "this person"}. You can take it down; only they can choose a new one.</small>
                    </div>
                    <div className="photo-actions">
                      <button type="button" onClick={() => updateDraft("photo", "")}>Remove photo</button>
                    </div>
                  </div>
                )}
                <label>Job Role<input value={draft.role || ""} onChange={(event) => updateDraft("role", event.target.value)} placeholder="Accountant, Engineer, HR…" /></label>
                <label>
                  Department
                  <select value={draft.department || ""} onChange={(event) => updateDraft("department", event.target.value)}>
                    <option value="">No department selected</option>
                    {departmentChoices.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  {orgDepartments.length
                    ? <small>From the Engineering Management structure.</small>
                    : <small>No departments defined yet — add them in Engineering Management, under Structure.</small>}
                </label>
                <label>
                  Reports To
                  <select value={draft.manager || ""} onChange={(event) => updateDraft("manager", event.target.value)}>
                    <option value="">No manager selected</option>
                    {users.filter((user) => user.id !== draft.id && user.enabled !== false).map((user) => (
                      <option key={user.id} value={user.name}>{user.name}</option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="access-section access-setup">
              <div className="access-section-title">
                <div><Sparkles size={18} /><span><b>Access setup</b><small>The preset starts the checkboxes; every choice remains editable.</small></span></div>
              </div>
              <div className="access-setup-grid">
                <label>
                  Role Preset
                  <select value={draft.access || "Engineer"} onChange={(event) => applyPreset(event.target.value)} disabled={protectedAccount}>
                    {/* Read-only client accounts belong to the Viewer Accounts tab,
                        where they get a real auth identity and RLS scoping, so
                        neither name is offered here — a staff record can never be
                        turned into one. An account created before the split keeps
                        its own name listed, or this select would quietly show the
                        wrong role for it. */}
                    {[
                      ...ROLE_PRESETS.filter((role) => !LEGACY_CLIENT_PRESETS.includes(role)),
                      ...(draft.access && LEGACY_CLIENT_PRESETS.includes(draft.access) ? [draft.access] : []),
                    ].map((role) => <option key={role} value={role} disabled={role === "Super Admin" && !protectedAccount && currentUser?.platformAdmin !== true}>{role}</option>)}
                  </select>
                </label>
                <label>
                  Data Scope
                  <select value={draft.permissionProfile?.scope || "own"} onChange={(event) => updateScope(event.target.value as DataScope)} disabled={protectedAccount}>
                    {DATA_SCOPES.map((scope) => <option key={scope.id} value={scope.id}>{scope.label}</option>)}
                  </select>
                </label>
                <label className="enable-user">
                  <input type="checkbox" checked={draft.enabled !== false} onChange={(event) => updateDraft("enabled", event.target.checked)} disabled={protectedAccount} />
                  <span><b>Account enabled</b><small>Disable sign-in without deleting records.</small></span>
                </label>
              </div>
              <div className="scope-note">
                {DATA_SCOPES.find((scope) => scope.id === draft.permissionProfile?.scope)?.description}
              </div>
            </section>

            {/* Accounting is shut for every role. This switch is the only thing
                that opens it, and only the Developer or a Super Admin may
                touch it — an Admin sees it locked, and saveAccessUser refuses
                the change even if the control itself were bypassed. */}
            <section className="access-section">
              <div className="access-section-title">
                <div><BadgeDollarSign size={18} /><span><b>Accounting access</b><small>Closed for every role unless it is switched on here. My Pay stays open to everyone either way.</small></span></div>
                <span className="black-badge">{accountingOpen ? "Open" : "Closed"}</span>
              </div>
              <label className="enable-user">
                <input
                  type="checkbox"
                  checked={accountingOpen}
                  onChange={(event) => updateDraft("accountingAccess", event.target.checked)}
                  disabled={!canGrantAccounting || accountingByRole}
                />
                <span>
                  <b>Let this account into Accounting</b>
                  <small>
                    {accountingByRole
                      ? `${draft.access} accounts hold Accounting through their role, so this switch is not needed.`
                      : canGrantAccounting
                        ? "Opens the Accounting area — dashboard, ledgers, payroll, reports. Every change here is audited."
                        : "Only the Developer or a Super Admin can change Accounting access."}
                  </small>
                </span>
              </label>
              {accountingOpen && !accountingByRole && draft.accountingAccessAt && (
                <div className="scope-note">
                  Granted {new Date(draft.accountingAccessAt).toLocaleString()}
                  {draft.accountingAccessBy ? ` by ${draft.accountingAccessBy}` : ""}.
                </div>
              )}
            </section>

            <section className="access-section project-access-section">
              <div className="access-section-title">
                <div><FolderLock size={18} /><span><b>Construction project visibility</b><small>Limit project pages, linked records, files, and selectors to assigned work.</small></span></div>
                <span className="black-badge">
                  {draft.projectAccessMode === "all"
                    ? "All projects"
                    : draft.projectAccessMode === "none"
                      ? "No projects"
                      : `${draft.projectIds?.length || 0} selected`}
                </span>
              </div>
              <div className="project-access-modes" role="group" aria-label="Project visibility">
                {([
                  ["assigned", "Assigned only", "Choose projects below"],
                  ["all", "All projects", "Company-wide visibility"],
                  ["none", "No projects", "Hide all project records"],
                ] as [ProjectAccessMode, string, string][]).map(([mode, label, description]) => (
                  <button
                    type="button"
                    key={mode}
                    className={draft.projectAccessMode === mode ? "active" : ""}
                    onClick={() => updateProjectMode(mode)}
                    disabled={protectedAccount}
                  >
                    <span>{mode === "assigned" ? <FolderKanban size={17} /> : mode === "all" ? <Eye size={17} /> : <FolderLock size={17} />}</span>
                    <b>{label}</b>
                    <small>{description}</small>
                  </button>
                ))}
              </div>
              {draft.projectAccessMode === "assigned" && (
                <div className="project-picker">
                  <label className="access-search">
                    <Search size={16} />
                    <input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="Find project, client, or lead" />
                  </label>
                  <div className="project-check-list">
                    {filteredProjects.length ? filteredProjects.map((project) => (
                      <label key={project.id}>
                        <input
                          type="checkbox"
                          checked={Boolean(draft.projectIds?.includes(project.id))}
                          onChange={(event) => toggleProject(project.id, event.target.checked)}
                          disabled={protectedAccount}
                        />
                        <span>
                          <b>{project.code || "Project"} · {project.name}</b>
                          <small>{project.clientName || "No client"} · {project.responsibleEngineer || project.projectManager || "No lead assigned"}</small>
                        </span>
                      </label>
                    )) : <div className="empty compact">No matching construction projects.</div>}
                  </div>
                </div>
              )}
              {draft.projectAccessMode === "all" && (
                <p className="project-access-note">This account can view every construction project and its linked operational records.</p>
              )}
              {draft.projectAccessMode === "none" && (
                <p className="project-access-note">Project pages and project-linked records remain hidden for this account.</p>
              )}
            </section>

            <section className="permission-area">
              <div className="permission-area-head">
                <div><span className="eyebrow">Custom permissions</span><h3>Choose only what this user needs</h3></div>
                <label className="permission-search"><Search size={15} /><input value={permissionQuery} onChange={(event) => setPermissionQuery(event.target.value)} placeholder="Find an area" /></label>
                <span className="black-badge">
                  {draft.permissionProfile?.preset === "Custom" ? "Custom access" : `${draft.access || "Custom"} preset`}
                </span>
              </div>
              {filteredPermissionGroups.map((group) => (
                <section className="permission-group" key={group.label}>
                  <div className="permission-group-head">
                    <div><b>{group.label}</b><small>{group.items.length} detailed areas</small></div>
                    <div className="permission-group-actions">
                      <button type="button" onClick={() => setGroupMode(group, "view")} disabled={protectedAccount}>View only</button>
                      <button type="button" onClick={() => setGroupMode(group, "full")} disabled={protectedAccount}>Full access</button>
                      <button type="button" onClick={() => setGroupMode(group, "clear")} disabled={protectedAccount}>Clear</button>
                    </div>
                  </div>
                  <div className="permission-table-wrap">
                    <div className="permission-table">
                      <div className="permission-head permission-module">Area</div>
                      {PERMISSION_ACTIONS.map((action) => <div className="permission-head" key={action.id}>{action.label}</div>)}
                      {group.items.map((item) => {
                        const supported = permissionActionsFor(item);
                        const rowIsFull = supported.every((action) => Boolean(draft.permissionProfile?.grants[item.id]?.[action]));
                        return (
                          <div className="permission-row" key={item.id}>
                            <div className="permission-module">
                              <span><b>{item.label}</b><small>{item.description}</small></span>
                              <button type="button" onClick={() => setRowPermissions(item, !rowIsFull)} disabled={protectedAccount}>{rowIsFull ? "Clear" : "All"}</button>
                            </div>
                            {PERMISSION_ACTIONS.map((action) => (
                              <div className="permission-cell" key={action.id}>
                                {supported.includes(action.id) ? (
                                  <input
                                    type="checkbox"
                                    aria-label={`${item.label}: ${action.label}`}
                                    checked={Boolean(draft.permissionProfile?.grants[item.id]?.[action.id])}
                                    onChange={(event) => setPermission(item, action.id, event.target.checked)}
                                    disabled={protectedAccount}
                                  />
                                ) : <span>—</span>}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              ))}
            </section>
            </fieldset>

            {isNew && currentUser && currentUser.platformAdmin ? (<label className="ps-row" style={{ margin: "0 0 10px" }}><input type="checkbox" checked={skipInitialVerify} onChange={(event) => setSkipInitialVerify(event.target.checked)} /><span><b>Skip initial email verification</b><small>You confirm this address instead. They still follow the periodic policy.</small></span></label>) : null}
            {!isNew && (
              <div className="settings-panel" style={{ margin: "0 0 10px" }}>
                <div className="section-head"><div><span className="eyebrow">Reporting window</span><h3>History Mode</h3></div></div>
                <p className="builder-note" style={{ marginTop: 0 }}>
                  Controls how much of this person&apos;s attendance current reports include. Changing it never deletes
                  anything — every session stays permanently stored, whatever mode is chosen.
                </p>
                <div className="correction-fields">
                  <label>Mode
                    <select
                      value={draft.historyMode || "all"}
                      onChange={(event) => setDraft({ ...draft, historyMode: event.target.value as "all" | "current" | "from" })}
                    >
                      <option value="all">All history</option>
                      <option value="current">Current employment period only</option>
                      <option value="from">From a selected date</option>
                    </select>
                  </label>
                  {(draft.historyMode || "all") === "from" && (
                    <label>History start date
                      <input
                        type="date"
                        value={draft.historyFrom ? draft.historyFrom.slice(0, 10) : ""}
                        onChange={(event) => setDraft({ ...draft, historyFrom: event.target.value ? new Date(`${event.target.value}T00:00:00`).toISOString() : undefined })}
                      />
                    </label>
                  )}
                </div>
              </div>
            )}
            <div className="access-savebar">
              <div><span className="auth-error">{formError}</span><small>{canChangeDraft ? "Changes apply to menus and actions after saving." : "View-only access: preview is available, but changes are disabled."}</small></div>
              <button type="submit" className="primary icon-label" disabled={!canChangeDraft}><Save size={16} /> Save Access</button>
            </div>
          </form>
        ) : <div className="empty">{tab === "pending" ? "Select a request to review." : "Select a user to edit access."}</div>}
      </section>
      )}

      {tab === "viewers" && (
        <ViewerAccountsPanel
          viewers={viewers}
          viewersLoading={viewersLoading}
          viewersError={viewersError}
          reloadViewers={reloadViewers}
          projects={projects}
          currentUser={currentUser}
          canCreate={canCreate}
          canEdit={canEdit}
          canDelete={canDelete}
          selectedId={viewerSelectedId}
          setSelectedId={setViewerSelectedId}
          draft={viewerDraft}
          setDraft={setViewerDraft}
          isNew={viewerIsNew}
          setIsNew={setViewerIsNew}
          busy={viewerBusy}
          setBusy={setViewerBusy}
          error={viewerError}
          setError={setViewerError}
          resetting={viewerResetting}
          setResetting={setViewerResetting}
          newPassword={viewerNewPassword}
          setNewPassword={setViewerNewPassword}
          newPasswordConfirm={viewerNewPasswordConfirm}
          setNewPasswordConfirm={setViewerNewPasswordConfirm}
          projectQuery={viewerProjectQuery}
          setProjectQuery={setViewerProjectQuery}
        />
      )}

      {tab === "offboarded" && (
        <section className="report-panel">
          <div className="section-head">
            <div><span className="eyebrow">Former colleagues</span><h3>Offboarded accounts</h3></div>
            <span className="black-badge">{offboardedUsers.length}</span>
          </div>
          <p className="builder-note">
            Offboarding blocks sign-in but removes nothing: every timesheet, points entry, and request stays
            on record here, and restoring the account brings the person back exactly as they were.
          </p>
          {offboardedUsers.length === 0 ? (
            <div className="empty compact">Nobody is offboarded. Offboarding a user from Active Users moves them here.</div>
          ) : offboardedUsers.map((person) => {
            const open = historyId === person.id;
            const mine = sessions.filter((session) => session.uid === person.id);
            const hours = mine.reduce((sum, session) => sum + session.hours, 0);
            const rows = (Array.isArray(store?.performance) ? (store.performance as PerformanceRow[]) : [])
              .filter((row) => rowUserId(row, users) === person.id);
            const submitted = rows.reduce((sum, row) => sum + finiteNumber(row["Submitted Points"]), 0);
            const approved = rows.reduce((sum, row) => sum + finiteNumber(row["Approved Points"]), 0);
            const requests = (Array.isArray(store?.approvals) ? (store.approvals as LeaveRequest[]) : [])
              .filter((row) => row.uid === person.id);
            return (
              <div className="settings-panel" key={person.id} style={{ marginTop: 10 }}>
                <div className="section-head">
                  <div>
                    <span className="eyebrow">{person.department || "No department"} · {person.access || "Engineer"}</span>
                    <h3>{person.name}</h3>
                    <p>Offboarded {person.offboardedAt ? new Date(person.offboardedAt).toLocaleDateString() : ""}{person.offboardedBy ? ` by ${person.offboardedBy}` : ""}</p>
                  </div>
                  <div className="review-actions">
                    <button type="button" className="btn small" onClick={() => setHistoryId(open ? null : person.id)}>
                      {open ? "Hide history" : "View history"}
                    </button>
                    {canDelete && (
                      <button type="button" className="btn small danger" onClick={() => void recycleUser(person)}>
                        Move to Recycling Bin
                      </button>
                    )}
                    {canEdit && (
                      <button type="button" className="primary" onClick={() => {
                        setReactivating(person);
                        setReactivateMode("all");
                        setReactivateFrom(dateInputValue(new Date()));
                      }}>
                        Reactivate account
                      </button>
                    )}
                  </div>
                </div>
                {open && (
                  <>
                    <div className="request-summary" style={{ marginTop: 6 }}>
                      <span><b>{mine.length}</b> sessions · <b>{formatHours(hours)}</b></span>
                      <span><b>{rows.length}</b> points entries · {submitted} submitted · <b>{approved}</b> approved</span>
                      <span><b>{requests.length}</b> requests</span>
                    </div>
                    <div className="data-table-wrap" style={{ marginTop: 8 }}>
                      <table className="data-table"><thead><tr>
                        <th>Date</th><th>Record</th><th>Detail</th><th>Outcome</th>
                      </tr></thead><tbody>
                        {mine.slice(-6).reverse().map((session) => (
                          <tr key={`s-${session.clockIn}`}>
                            <td>{session.date}</td>
                            <td><b>Session</b><small>{session.mode}</small></td>
                            <td>{new Date(session.clockIn).toLocaleTimeString()} → {session.open ? "open" : new Date(session.clockOut).toLocaleTimeString()}</td>
                            <td>{formatHours(session.hours)}</td>
                          </tr>
                        ))}
                        {rows.slice(0, 6).map((row) => (
                          <tr key={`p-${String(row.id)}`}>
                            <td>{String(row.Date || "")}</td>
                            <td><b>Points</b><small>{String(row.Week || "")}</small></td>
                            <td>{String(row.Project || row.Deliverable || "")}</td>
                            <td>{finiteNumber(row["Approved Points"]) || finiteNumber(row["Submitted Points"])} pts · {String(row.Status || "")}</td>
                          </tr>
                        ))}
                        {requests.slice(-4).reverse().map((row) => (
                          <tr key={`r-${row.id}`}>
                            <td>{(row.createdAt || row.date || "").slice(0, 10)}</td>
                            <td><b>Request</b><small>{row.entry ? "Late points" : row.type}</small></td>
                            <td>{row.reason || row.requestType || ""}</td>
                            <td>{row.status}{row.decidedBy ? ` · ${row.decidedBy}` : ""}</td>
                          </tr>
                        ))}
                        {!mine.length && !rows.length && !requests.length && (
                          <tr><td colSpan={4}><div className="empty compact">No records for this person.</div></td></tr>
                        )}
                      </tbody></table>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* Reactivation dialog: how much history should current reporting
          include? (Part 16.) Whatever the choice, stored history is
          permanent — the mode only shapes reports and can be changed later
          in this same screen. */}
      {reactivating && (
        <section className="report-panel">
          <div className="section-head">
            <div><span className="eyebrow">Reactivate</span><h3>Bring {reactivating.name} back</h3></div>
            <button type="button" className="btn small" onClick={() => setReactivating(null)}>Cancel</button>
          </div>
          <div className="correction-types">
            {([
              ["all", "Include all previous history", "Reports include every employment period"],
              ["current", "Current employment period only", "Reports start from today; older records stay stored"],
              ["from", "Include history from a date", "Reports start from the date you pick below"],
            ] as const).map(([mode, label, blurb]) => (
              <button
                type="button"
                key={mode}
                className={reactivateMode === mode ? "on" : ""}
                onClick={() => setReactivateMode(mode)}
              ><b>{label}</b><small>{blurb}</small></button>
            ))}
          </div>
          {reactivateMode === "from" && (
            <div className="correction-fields" style={{ marginTop: 8 }}>
              <label>History start date<input type="date" value={reactivateFrom} onChange={(event) => setReactivateFrom(event.target.value)} /></label>
            </div>
          )}
          <div className="review-actions" style={{ marginTop: 10 }}>
            <button type="button" className="primary" onClick={async () => {
              const fromIso = reactivateMode === "from" && reactivateFrom ? new Date(`${reactivateFrom}T00:00:00`).toISOString() : undefined;
              if (await restoreUser(reactivating, reactivateMode, fromIso)) setReactivating(null);
            }}>Reactivate now</button>
          </div>
          <p className="panel-footnote">No option deletes anything: all periods stay stored, and History Mode can be changed later while editing the user.</p>
        </section>
      )}

      {tab === "recycled" && (
        <section className="report-panel">
          <div className="section-head">
            <div><span className="eyebrow">Soft-deleted accounts</span><h3>Recycling Bin</h3></div>
            <span className="black-badge">{recycledUsers.length}</span>
          </div>
          <p className="builder-note">
            Accounts here are deleted but not destroyed: sign-in is blocked, their email is free for a new
            Create Account, and every timesheet, points entry, request and audit record stays stored. Restore
            returns the account to Offboarded — unless its email has been reused, in which case the conflict is
            explained and nothing is overwritten. Permanent deletion is a separate Super-Admin-only act, and even
            it keeps attendance and audit history.
          </p>
          {recycledUsers.length === 0 ? (
            <div className="empty compact">The Recycling Bin is empty. From Offboarded, &quot;Move to Recycling Bin&quot; places an account here and frees its email.</div>
          ) : recycledUsers.map((person) => {
            const open = historyId === person.id;
            const mine = sessions.filter((session) => session.uid === person.id);
            const hours = mine.reduce((sum, session) => sum + session.hours, 0);
            const requests = (Array.isArray(store?.approvals) ? (store.approvals as LeaveRequest[]) : [])
              .filter((row) => row.uid === person.id);
            return (
              <div className="settings-panel" key={person.id} style={{ marginTop: 10 }}>
                <div className="section-head">
                  <div>
                    <span className="eyebrow">{person.department || "No department"} · {person.access || "Engineer"}</span>
                    <h3>{person.name}</h3>
                    <p>
                      {person.email ? `${person.email} · ` : ""}
                      In the bin since {person.recycledAt ? new Date(person.recycledAt).toLocaleDateString() : "—"}
                      {person.recycledBy ? ` (moved by ${person.recycledBy})` : ""}
                    </p>
                  </div>
                  <div className="review-actions">
                    <button type="button" className="btn small" onClick={() => setHistoryId(open ? null : person.id)}>
                      {open ? "Hide history" : "View history"}
                    </button>
                    {canEdit && (
                      <button type="button" className="primary" onClick={() => void binRestoreUser(person)}>
                        Restore
                      </button>
                    )}
                    {canPurge && (
                      <button type="button" className="btn small danger" onClick={() => void purgeUser(person)}>
                        Permanently delete
                      </button>
                    )}
                  </div>
                </div>
                {open && (
                  <div className="request-summary" style={{ marginTop: 6 }}>
                    <span><b>{mine.length}</b> sessions · <b>{formatHours(hours)}</b></span>
                    <span><b>{requests.length}</b> requests</span>
                    <span>Full records stay in reports and the audit history.</span>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

/* Admin-only management of Viewer accounts — the client/read-only role.
   Deliberately never touches saveUser/deleteUser/users[]: every mutation
   goes through the viewer-admin Edge Function, which is what actually
   creates/edits/resets/deletes the real Supabase Auth identity and the
   viewer_accounts row that the restrictive RLS policies key off. This
   component only ever reads/writes that one Edge Function and the
   read-only viewer_accounts table. */
function ViewerAccountsPanel({
  viewers, viewersLoading, viewersError, reloadViewers, projects, currentUser,
  canCreate, canEdit, canDelete,
  selectedId, setSelectedId, draft, setDraft, isNew, setIsNew,
  busy, setBusy, error, setError,
  resetting, setResetting, newPassword, setNewPassword, newPasswordConfirm, setNewPasswordConfirm,
  projectQuery, setProjectQuery,
}: {
  viewers: ViewerAccountRow[]; viewersLoading: boolean; viewersError: string; reloadViewers: () => Promise<void>;
  projects: AccountingProject[]; currentUser: StaffUser | null;
  canCreate: boolean; canEdit: boolean; canDelete: boolean;
  selectedId: string; setSelectedId: (id: string) => void;
  draft: ViewerDraft | null; setDraft: (draft: ViewerDraft | ((current: ViewerDraft | null) => ViewerDraft | null) | null) => void;
  isNew: boolean; setIsNew: (value: boolean) => void;
  busy: boolean; setBusy: (value: boolean) => void;
  error: string; setError: (value: string) => void;
  resetting: boolean; setResetting: (value: boolean) => void;
  newPassword: string; setNewPassword: (value: string) => void;
  newPasswordConfirm: string; setNewPasswordConfirm: (value: string) => void;
  projectQuery: string; setProjectQuery: (value: string) => void;
}) {
  const dialog = useDialog();
  const [query, setQuery] = useState("");
  const canChangeDraft = isNew ? canCreate : canEdit;
  const actor = { email: currentUser?.email || "", access: currentUser?.access || "" };

  const selectViewer = (row: ViewerAccountRow) => {
    setSelectedId(row.id);
    setDraft({
      id: row.id, username: row.username, displayName: row.display_name,
      projectAccessMode: row.project_access_mode, allowedProjectIds: [...row.allowed_project_ids],
      enabled: row.enabled, expiresAt: row.expires_at ? row.expires_at.slice(0, 10) : "",
    });
    setIsNew(false);
    setResetting(false);
    setError("");
  };

  const startNewViewer = () => {
    if (!canCreate) return;
    setSelectedId("");
    setDraft({ id: "", username: "", displayName: "", projectAccessMode: "assigned", allowedProjectIds: [], enabled: true, expiresAt: "" });
    setIsNew(true);
    setResetting(false);
    setError("");
    setNewPassword("");
    setNewPasswordConfirm("");
  };

  const updateDraft = (patch: Partial<ViewerDraft>) => setDraft((current) => current ? { ...current, ...patch } : current);

  const toggleProject = (projectId: string, checked: boolean) => {
    if (!draft) return;
    const selected = new Set(draft.allowedProjectIds);
    if (checked) selected.add(projectId); else selected.delete(projectId);
    updateDraft({ allowedProjectIds: [...selected] });
  };

  const callViewerAdmin = async (body: Record<string, unknown>) => {
    const client = getSupabaseClient();
    if (!client) return { ok: false, error: "Supabase is not configured on this deployment." };
    try {
      const { data, error: fnError } = await client.functions.invoke("viewer-admin", { body });
      if (fnError) return { ok: false, error: "Could not reach the Viewer account service." };
      return (data || { ok: false, error: "No response." }) as { ok: boolean; error?: string; viewer?: ViewerAccountRow; droppedProjectIds?: string[] };
    } catch {
      return { ok: false, error: "Could not reach the Viewer account service." };
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !canChangeDraft) return;
    if (!draft.displayName.trim()) { setError("Enter a client/display name."); return; }
    if (isNew && (!newPassword || newPassword.length < 8 || newPassword !== newPasswordConfirm)) {
      setError("Enter a password of at least 8 characters, and confirm it.");
      return;
    }
    setBusy(true);
    setError("");
    const result = isNew
      ? await callViewerAdmin({
          op: "create", actor,
          username: draft.username, displayName: draft.displayName,
          password: newPassword, confirmPassword: newPasswordConfirm,
          projectAccessMode: draft.projectAccessMode, allowedProjectIds: draft.allowedProjectIds,
          enabled: draft.enabled, expiresAt: draft.expiresAt || null,
        })
      : await callViewerAdmin({
          op: "update", actor, id: draft.id,
          username: draft.username, displayName: draft.displayName,
          projectAccessMode: draft.projectAccessMode, allowedProjectIds: draft.allowedProjectIds,
          enabled: draft.enabled, expiresAt: draft.expiresAt || null,
        });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not save the Viewer account."); return; }
    await reloadViewers();
    if (result.viewer) selectViewer(result.viewer);
    setIsNew(false);
    setNewPassword("");
    setNewPasswordConfirm("");
    if (result.droppedProjectIds?.length) {
      setError(`Saved. ${result.droppedProjectIds.length} project id(s) did not match a real project and were dropped.`);
    }
  };

  const submitReset = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!draft || !canChangeDraft) return;
    if (!newPassword || newPassword.length < 8 || newPassword !== newPasswordConfirm) {
      setError("Enter a password of at least 8 characters, and confirm it.");
      return;
    }
    setBusy(true);
    setError("");
    const result = await callViewerAdmin({ op: "resetPassword", actor, id: draft.id, password: newPassword, confirmPassword: newPasswordConfirm });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not reset the password."); return; }
    setNewPassword(""); setNewPasswordConfirm(""); setResetting(false);
    setError("Password reset.");
  };

  const removeDraft = async () => {
    if (!draft || isNew || !canDelete) return;
    if (!(await dialog.confirm(`Delete the Viewer account for ${draft.displayName || draft.username}? They will immediately lose access, and this cannot be undone.`))) return;
    setBusy(true);
    const result = await callViewerAdmin({ op: "delete", actor, id: draft.id });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not delete the Viewer account."); return; }
    await reloadViewers();
    setSelectedId(""); setDraft(null); setIsNew(false); setError("");
  };

  const filteredViewers = viewers.filter((row) =>
    [row.display_name, row.username].some((value) => value.toLowerCase().includes(query.trim().toLowerCase())));
  const filteredProjects = projects.filter((project) =>
    [project.code, project.name, project.clientName].some((value) => String(value || "").toLowerCase().includes(projectQuery.trim().toLowerCase())));

  return (
    <section className="access-layout">
      <aside className="access-directory">
        <div className="access-directory-head viewer-head">
          <div><span className="eyebrow">Directory</span><h3>{viewers.length} {viewers.length === 1 ? "viewer" : "viewers"}</h3></div>
          <button type="button" className="primary icon-label" onClick={startNewViewer} disabled={!canCreate}><Plus size={16} /> Create Viewer</button>
        </div>
        <p className="org-note">Read-only, project-scoped client accounts. No email, no email verification, no company password reset — an admin sets the username and password directly.</p>
        <label className="access-search">
          <Search size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Viewer accounts" />
        </label>
        {/* Exactly one of these at a time. Showing a failure and an empty list
            together says two different things about the same moment and leaves
            nobody sure which is true. */}
        <div className="access-user-list">
          {viewersLoading
            ? <div className="empty compact">Loading…</div>
            : viewersError
              ? <div className="empty compact">{viewersError}</div>
              : !filteredViewers.length
                ? <div className="empty compact">
                    {query.trim()
                      ? "No Viewer account matches that search."
                      : "No Viewer accounts yet. Create one to give a client read-only access to their project."}
                  </div>
                : null}
          {!viewersLoading && !viewersError && filteredViewers.map((row) => (
            <button
              type="button"
              key={row.id}
              className={selectedId === row.id && !isNew ? "access-user active" : "access-user"}
              onClick={() => selectViewer(row)}
            >
              <span>{initials(row.display_name || row.username)}</span>
              <span><b>{row.display_name}</b><small>@{row.username} · {row.project_access_mode === "all" ? "All projects" : row.project_access_mode === "none" ? "No projects" : `${row.allowed_project_ids.length} project(s)`}</small></span>
              <i className={row.enabled === false ? "off" : ""} />
            </button>
          ))}
        </div>
      </aside>

      {draft ? (
        <form className="access-editor" onSubmit={submit}>
          <div className="access-editor-head">
            <div>
              <span className="eyebrow">{isNew ? "New Viewer account" : "Selected Viewer"}</span>
              <h3>{draft.displayName || "New Viewer"}</h3>
              <p>{draft.projectAccessMode === "all" ? "Sees every project" : draft.projectAccessMode === "none" ? "Sees no projects" : `${draft.allowedProjectIds.length} project(s) assigned`}</p>
            </div>
            <div className="editor-badges">
              {!isNew && canDelete && (
                <button type="button" className="delete-user-button" onClick={() => void removeDraft()}>
                  <Trash2 size={14} /> Delete Account
                </button>
              )}
              <span className={draft.enabled === false ? "status-badge off" : "status-badge"}>{draft.enabled === false ? "Disabled" : "Active"}</span>
            </div>
          </div>

          <fieldset className="access-edit-fields" disabled={!canChangeDraft}>
            <section className="access-section">
              <div className="access-section-title">
                <div><KeyRound size={18} /><span><b>Client identity</b><small>Username + password only — no email is ever required</small></span></div>
              </div>
              <div className="access-fields">
                <label>Client / display name<input value={draft.displayName} onChange={(event) => updateDraft({ displayName: event.target.value })} /></label>
                <label>Username<input value={draft.username} onChange={(event) => updateDraft({ username: event.target.value.trim().toLowerCase() })} placeholder="e.g. alnoor-client" disabled={!isNew} /></label>
                {!isNew && <p className="org-note">Username changes are supported by the service, but are left fixed here to avoid confusing a client mid-engagement. Ask if you need it changed.</p>}
                {isNew ? (
                  <>
                    <label>
                      Password
                      <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" />
                    </label>
                    <label>
                      Confirm Password
                      <input type="password" value={newPasswordConfirm} onChange={(event) => setNewPasswordConfirm(event.target.value)} autoComplete="new-password" />
                    </label>
                  </>
                ) : resetting ? (
                  <>
                    <label>New Password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" /></label>
                    <label>Confirm New Password<input type="password" value={newPasswordConfirm} onChange={(event) => setNewPasswordConfirm(event.target.value)} autoComplete="new-password" /></label>
                    <div className="rowActions">
                      <button type="button" className="primary" onClick={() => void submitReset()} disabled={busy}>Save new password</button>
                      <button type="button" onClick={() => { setResetting(false); setNewPassword(""); setNewPasswordConfirm(""); }}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <button type="button" className="icon-label" onClick={() => { setResetting(true); setError(""); }} disabled={!canChangeDraft}><KeyRound size={14} /> Reset password</button>
                )}
                <label className="enable-user">
                  <input type="checkbox" checked={draft.enabled !== false} onChange={(event) => updateDraft({ enabled: event.target.checked })} />
                  <span><b>Account enabled</b><small>Disable sign-in without deleting the account.</small></span>
                </label>
                <label>Expires (optional)<input type="date" value={draft.expiresAt} onChange={(event) => updateDraft({ expiresAt: event.target.value })} /></label>
              </div>
            </section>

            <section className="access-section project-access-section">
              <div className="access-section-title">
                <div><FolderLock size={18} /><span><b>Project visibility</b><small>Enforced in the database — a Viewer&apos;s session can only ever read these projects, regardless of what the app requests.</small></span></div>
                <span className="black-badge">
                  {draft.projectAccessMode === "all" ? "All projects" : draft.projectAccessMode === "none" ? "No projects" : `${draft.allowedProjectIds.length} selected`}
                </span>
              </div>
              <div className="project-access-modes" role="group" aria-label="Viewer project visibility">
                {([
                  ["assigned", "Assigned only", "Choose projects below"],
                  ["all", "All projects", "Company-wide visibility"],
                  ["none", "No projects", "Hide all project records"],
                ] as [ViewerDraft["projectAccessMode"], string, string][]).map(([mode, label, description]) => (
                  <button
                    type="button"
                    key={mode}
                    className={draft.projectAccessMode === mode ? "active" : ""}
                    onClick={() => updateDraft({ projectAccessMode: mode })}
                  >
                    <span>{mode === "assigned" ? <FolderKanban size={17} /> : mode === "all" ? <Eye size={17} /> : <FolderLock size={17} />}</span>
                    <b>{label}</b>
                    <small>{description}</small>
                  </button>
                ))}
              </div>
              {draft.projectAccessMode === "assigned" && (
                <div className="project-picker">
                  <label className="access-search">
                    <Search size={16} />
                    <input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="Find project, client, or lead" />
                  </label>
                  <div className="project-check-list">
                    {filteredProjects.length ? filteredProjects.map((project) => (
                      <label key={project.id}>
                        <input
                          type="checkbox"
                          checked={draft.allowedProjectIds.includes(project.id)}
                          onChange={(event) => toggleProject(project.id, event.target.checked)}
                        />
                        <span>
                          <b>{project.code || "Project"} · {project.name}</b>
                          <small>{project.clientName || "No client"}</small>
                        </span>
                      </label>
                    )) : <div className="empty compact">No matching construction projects.</div>}
                  </div>
                </div>
              )}
            </section>
          </fieldset>

          <div className="access-savebar">
            <div><span className="auth-error">{error}</span><small>{canChangeDraft ? "Changes take effect immediately." : "View-only access."}</small></div>
            <button type="submit" className="primary icon-label" disabled={!canChangeDraft || busy}><Save size={16} /> {busy ? "Saving…" : "Save Viewer"}</button>
          </div>
        </form>
      ) : (
        <div className="empty viewer-empty-pane">
          <b>No Viewer selected</b>
          <p>Pick a client from the list to set their password, project access and
            what they may see — or create one to get started.</p>
        </div>
      )}
    </section>
  );
}

function LivePresence({
  viewer, users, store, sessions, go,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  store: Record<string, unknown> | null;
  sessions: ClockSession[];
  go: (id: string) => void;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  void tick;

  const roster = users.filter((user) => user.enabled !== false);
  const logs = Array.isArray(store?.logs) ? (store.logs as ClockLog[]) : [];
  const todayName = WEEKDAY_NAMES[new Date().getDay()];
  const schedule = (store?.schedule || {}) as Record<string, Record<string, { code?: string }[]>>;

  const state = roster.map((user) => {
    const latest = logs
      .filter((log) => log.uid === user.id && log.time)
      .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())[0];
    const openSession = sessions.find((session) => session.uid === user.id && session.open);
    const isIn = Boolean(openSession) || latest?.status === "In";
    const mode = openSession?.mode || latest?.type || "";
    const planned = (schedule[user.id]?.[todayName] || [])
      .map((entry) => String(entry.code || "").toUpperCase()).find(Boolean) || "OFF";
    return {
      user,
      isIn,
      tone: isIn ? modeTone(mode) : "off",
      mode: mode || "—",
      since: openSession?.clockIn || latest?.time || "",
      // Presence, not worked time -- someone on their lunch break is still here.
      hours: openSession?.presenceHours || 0,
      stale: Boolean(openSession?.stale),
      planned,
    };
  });

  const GROUPS_LIVE = [
    { id: "office", label: "In the office", tone: "office", hint: "Clocked in from the office" },
    { id: "online", label: "Online", tone: "online", hint: "Working remotely or on USA hours" },
    { id: "site", label: "On site", tone: "site", hint: "Working on a project site" },
    { id: "off", label: "Not clocked in", tone: "off", hint: "No open session right now" },
  ];
  const counts = Object.fromEntries(GROUPS_LIVE.map((group) => [group.id, state.filter((row) => row.tone === group.id).length]));
  const activeNow = state.filter((row) => row.isIn).length;
  const expectedToday = state.filter((row) => !["OFF", "STB"].includes(row.planned)).length;
  const renderPresenceGroup = (group: (typeof GROUPS_LIVE)[number]) => {
    const rows = state.filter((row) => row.tone === group.id)
      .sort((a, b) => a.user.name.localeCompare(b.user.name));
    return (
      <article className="report-panel presence-column" key={group.id}>
        <div className="section-head">
          <h3>{group.label}</h3>
          <span className={`presence-count tone-${group.tone}`}>{rows.length}</span>
        </div>
        <div className="presence-list">
          {rows.map((row) => (
            <div className={`presence-row${row.user.id === viewer?.id ? " is-me" : ""}`} key={row.user.id}>
              <i className={`presence-dot tone-${row.tone}`} aria-hidden="true" />
              <span>
                <b>{row.user.name}{row.user.id === viewer?.id ? " (you)" : ""}</b>
                <small>{row.user.department || row.user.role || ""}</small>
              </span>
              <span className="presence-meta"><em>{row.stale ? "Open too long — needs correction" : group.id === "off" ? "Not clocked in" : group.label.replace(/^In the |^On /, "")}</em></span>
            </div>
          ))}
          {!rows.length && <div className="empty compact">Nobody right now.</div>}
        </div>
      </article>
    );
  };

  return (
    <div className="native-scroll presence-scroll">
      <section className="overview-hero home-hero">
        <span className="home-hero-mark" aria-hidden="true" />
        <div>
          <span className="eyebrow">Right now</span>
          <h2>Live Presence</h2>
          <p>Office, online, and site status at a glance.</p>
        </div>
        <div className="hero-actions">
          <button type="button" onClick={() => go("quick-clock")}>Clock In / Out</button>
        </div>
      </section>

      <section className="presence-summary">
        {GROUPS_LIVE.map((group) => (
          <article className={`presence-stat tone-${group.tone}`} key={group.id}>
            <i aria-hidden="true" />
            <div><small>{group.label}</small><b>{counts[group.id] || 0}</b></div>
          </article>
        ))}
        <article className="presence-stat tone-total">
          <i aria-hidden="true" />
          <div><small>Active now</small><b>{activeNow} / {expectedToday}</b></div>
        </article>
      </section>

      <section className="presence-groups">
        <div className="presence-stack">{renderPresenceGroup(GROUPS_LIVE[0])}{renderPresenceGroup(GROUPS_LIVE[2])}</div>
        <div className="presence-stack">{renderPresenceGroup(GROUPS_LIVE[1])}{renderPresenceGroup(GROUPS_LIVE[3])}</div>
      </section>
    </div>
  );
}

function RequestsCentre({
  viewer, users, store, submit, decide,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  store: Record<string, unknown> | null;
  submit: (draft: { type: string; requestType: string; from: string; to: string; reason: string }) => boolean;
  decide: (id: string, status: "Approved" | "Rejected", note?: string) => boolean;
}) {
  const dialog = useDialog();
  const today = dateInputValue(new Date());
  const monthStart = new Date(); monthStart.setDate(1);
  const [tab, setTab] = useState<"mine" | "queue" | "report">("mine");
  const [draft, setDraft] = useState({ type: "Leave", requestType: "Annual", from: today, to: today, reason: "" });
  const [from, setFrom] = useState(dateInputValue(monthStart));
  const [to, setTo] = useState(today);

  const all = Array.isArray(store?.approvals) ? (store.approvals as LeaveRequest[]) : [];
  const scope = scopedUsers(viewer, users);
  const scopeIds = new Set(scope.map((user) => user.id));
  const approvalsItem = ITEMS.find((item) => item.id === "staff-approvals");
  const canApprove = Boolean(viewer && approvalsItem && hasItemPermission(viewer, approvalsItem, "approve"));

  const mine = all.filter((row) => row.uid === viewer?.id);
  const queue = !viewer ? [] : all.filter((row) => row.status === "Pending" && row.uid !== viewer.id
    && (isAdmin(viewer) || (row.flow || []).includes(viewer.id) || scopeIds.has(row.uid)));
  const inPeriod = all.filter((row) => withinDates(row.from || row.date || "", from, to));
  const reportUsers = (canApprove ? scope : scope.filter((user) => user.id === viewer?.id));
  const report = reportUsers.map((user) => {
    const rows = inPeriod.filter((row) => row.uid === user.id);
    const byType = Object.fromEntries(LEAVE_TYPES.map((type) => [type,
      rows.filter((row) => row.requestType === type && row.status === "Approved")
        .reduce((sum, row) => sum + requestDays(row), 0)]));
    return {
      user,
      requests: rows.length,
      approvedDays: rows.filter((row) => row.status === "Approved").reduce((sum, row) => sum + requestDays(row), 0),
      pending: rows.filter((row) => row.status === "Pending").length,
      rejected: rows.filter((row) => row.status === "Rejected").length,
      byType,
    };
  }).sort((a, b) => b.approvedDays - a.approvedDays);
  const totalDays = report.reduce((sum, row) => sum + row.approvedDays, 0);

  const statusChip = (status: string) => (
    <span className={`record-status ${status.toLowerCase()}`}>{status}</span>
  );
  const nameOfUser = (id: string) => users.find((user) => user.id === id)?.name || id;
  const stateLabel: Record<ChainStep["state"], string> = {
    approved: "Approved", rejected: "Rejected", pending: "With them now", waiting: "Waiting", skipped: "—",
  };
  const stateMark: Record<ChainStep["state"], string> = {
    approved: "✓", rejected: "✗", pending: "•", waiting: "·", skipped: "·",
  };
  /* The decision trail for one request: each approver and where they stand, so
     a person can see exactly who has acted and who is still to come. */
  const chainStrip = (row: LeaveRequest) => {
    const steps = approvalSteps(row, nameOfUser);
    if (!steps.length) return null;
    return (
      <div className="chain-strip">
        {steps.map((s, i) => (
          <div key={`${s.id}-${i}`} className={`chain-step is-${s.state}`} title={s.note || undefined}>
            <span className="chain-badge" aria-hidden="true">{stateMark[s.state]}</span>
            <span className="chain-name">{s.name}</span>
            <span className="chain-state">{stateLabel[s.state]}{s.at ? ` · ${new Date(s.at).toLocaleDateString()}` : ""}</span>
          </div>
        ))}
      </div>
    );
  };
  /* A late points entry is decided on its contents, so the contents have to be
     on screen. Every other request type is fully described by its dates and
     reason, and renders as before. */
  const detailCell = (row: LeaveRequest) => (
    row.entry ? (
      <div className="request-entry">
        <b>{entryLine(row.entry)}</b>
        {/* PerformanceRow carries an index signature, so anything not named in
            the type is `unknown` and cannot be rendered directly. */}
        {Boolean(row.entry.Notes) && <small>{String(row.entry.Notes || "")}</small>}
        <span>Worked {row.entry.Date} · week {row.week}</span>
        <em>{row.reason}</em>
      </div>
    ) : <>{row.reason}</>
  );
  const exportReport = () => {
    downloadRows(`larsa-leave-${from}-to-${to}.csv`, [
      ["Employee", "Department", "Requests", "Approved days", "Pending", "Rejected", ...LEAVE_TYPES],
      ...report.map((row) => [
        row.user.name, row.user.department || "", row.requests, row.approvedDays, row.pending, row.rejected,
        ...LEAVE_TYPES.map((type) => row.byType[type] || 0),
      ]),
    ]);
  };

  return (
    <div className="native-scroll requests-scroll">
      <section className="overview-hero home-hero">
        <span className="home-hero-mark" aria-hidden="true" />
        <div>
          <span className="eyebrow">Time off</span>
          <h2>Leave &amp; Requests</h2>
          <p>Submit leave or a schedule change, follow the decision, and see the record for any period.</p>
        </div>
        <span className="access-pill"><ClipboardCheck size={16} /> {mine.filter((row) => row.status === "Pending").length} of yours pending</span>
      </section>

      <div className="settings-tabs" role="tablist" aria-label="Request sections">
        <button type="button" role="tab" aria-selected={tab === "mine"} className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>
          <ClipboardList size={16} /> My requests
        </button>
        {canApprove && (
          <button type="button" role="tab" aria-selected={tab === "queue"} className={tab === "queue" ? "active" : ""} onClick={() => setTab("queue")}>
            <CheckCircle2 size={16} /> To approve{queue.length ? ` (${queue.length})` : ""}
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === "report"} className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>
          <FileBarChart size={16} /> Leave record
        </button>
      </div>

      {tab === "mine" && (
        <>
          <section className="settings-panel">
            <div className="section-head"><div><span className="eyebrow">New request</span><h3>Submit a request</h3></div></div>
            <div className="settings-fields">
              <label>Request
                <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
                  <option value="Leave">Leave</option>
                  <option value="Schedule">Schedule change</option>
                </select></label>
              <label>{draft.type === "Leave" ? "Leave type" : "Change type"}
                <select value={draft.requestType} onChange={(event) => setDraft({ ...draft, requestType: event.target.value })}>
                  {(draft.type === "Leave" ? LEAVE_TYPES : ["Shift swap", "Different hours", "Work from home", "Site day"])
                    .map((value) => <option key={value}>{value}</option>)}
                </select></label>
              <label>From<input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value, to: event.target.value > draft.to ? event.target.value : draft.to })} /></label>
              <label>To<input type="date" value={draft.to} min={draft.from} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
              <label className="wide">Reason<input value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} placeholder="Short explanation for your approver" /></label>
            </div>
            <div className="request-summary">
              <span><b>{requestDays(draft)}</b> day{requestDays(draft) === 1 ? "" : "s"}</span>
              <span>Goes to {viewer?.manager || "administration"}</span>
            </div>
            <div className="form-actions">
              <button type="button" className="primary" onClick={() => {
                if (submit(draft)) setDraft({ ...draft, reason: "" });
              }}><Plus size={15} /> Submit request</button>
            </div>
          </section>

          <section className="report-panel">
            <div className="section-head"><div><span className="eyebrow">History</span><h3>Your requests</h3></div>
              <span className="black-badge">{mine.length}</span></div>
            <div className="data-table-wrap">
              <table className="data-table"><thead><tr>
                <th>Submitted</th><th>Type</th><th>Date</th><th>Days / points</th><th>Detail</th><th>Status</th><th>Approval progress</th>
              </tr></thead><tbody>
                {mine.map((row) => (
                  <tr key={row.id}>
                    <td>{(row.createdAt || row.date || "").slice(0, 10)}</td>
                    <td><b>{row.entry ? "Late points" : row.type}</b><small>{row.requestType || ""}</small></td>
                    <td>{row.entry ? row.entry.Date : `${row.from} → ${row.to}`}</td>
                    <td>{row.entry ? `${finiteNumber(row.entry["Submitted Points"])} pts` : requestQuantity(row)}</td>
                    <td>{detailCell(row)}</td>
                    <td>{statusChip(row.status)}</td>
                    <td>{chainStrip(row) || <span className="chain-none">{row.decidedBy || "—"}</span>}</td>
                  </tr>
                ))}
                {!mine.length && <tr><td colSpan={7}><div className="empty compact">You have not submitted a request yet.</div></td></tr>}
              </tbody></table>
            </div>
          </section>
        </>
      )}

      {tab === "queue" && canApprove && (
        <section className="report-panel">
          <div className="section-head"><div><span className="eyebrow">Approval queue</span><h3>Waiting for your decision</h3></div>
            <span className="black-badge">{queue.length}</span></div>
          <div className="data-table-wrap">
            <table className="data-table"><thead><tr>
              <th>Employee</th><th>Type</th><th>Date</th><th>Days / points</th><th>Detail</th><th>Decision</th>
            </tr></thead><tbody>
              {queue.map((row) => {
                const person = users.find((user) => user.id === row.uid);
                return (
                  <tr key={row.id}>
                    <td><b>{person?.name || row.uid}</b><small>{person?.department || ""}</small></td>
                    <td><b>{row.entry ? "Late points" : row.type}</b><small>{row.requestType || ""}</small></td>
                    <td>{row.entry ? row.entry.Date : `${row.from} → ${row.to}`}</td>
                    <td>{row.entry ? `${finiteNumber(row.entry["Submitted Points"])} pts` : requestQuantity(row)}</td>
                    <td>{detailCell(row)}</td>
                    {/* Only the person the request is actually with gets the
                        buttons. Everyone else sees whose desk it is on, which
                        is the useful thing to know and saves a click that
                        would only be refused. An administrator can still act,
                        because a chain containing somebody who has left would
                        otherwise never move. */}
                    <td><div className="review-actions">
                      {(() => {
                        const { holder, step, total } = requestStage(row);
                        const mine = !holder || holder === viewer?.id;
                        if (!mine && !(viewer && isAdmin(viewer))) {
                          const who = users.find((user) => user.id === holder);
                          return <small>With {who?.name || "another approver"}{total > 1 ? ` · step ${step + 1} of ${total}` : ""}</small>;
                        }
                        return (
                          <>
                            <button type="button" className="approve" onClick={() => decide(row.id, "Approved")}>
                              {total > 1 && step + 1 < total ? "Approve · next step" : "Approve"}
                            </button>
                            <button type="button" onClick={async () => decide(row.id, "Rejected", (await dialog.prompt("Reason for rejecting (optional):")) || "")}>Reject</button>
                          </>
                        );
                      })()}
                    </div>{chainStrip(row)}</td>
                  </tr>
                );
              })}
              {!queue.length && <tr><td colSpan={6}><div className="empty compact">Nothing is waiting for you.</div></td></tr>}
            </tbody></table>
          </div>
        </section>
      )}

      {tab === "report" && (
        <>
          <section className="filter-toolbar">
            <label><span>From</span><input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
            <label><span>To</span><input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
            <span className="filter-summary">{totalDays} approved day{totalDays === 1 ? "" : "s"} across {report.length} {report.length === 1 ? "person" : "people"}</span>
            <button type="button" className="secondary" onClick={exportReport}><FileSpreadsheet size={15} /> Export</button>
          </section>
          <section className="report-panel">
            <div className="section-head"><div><span className="eyebrow">Leave record</span><h3>{from} to {to}</h3></div></div>
            <div className="data-table-wrap">
              <table className="data-table"><thead><tr>
                <th>Employee</th><th>Requests</th><th>Approved days</th><th>Pending</th><th>Rejected</th>
                {LEAVE_TYPES.map((type) => <th key={type}>{type}</th>)}
              </tr></thead><tbody>
                {report.map((row) => (
                  <tr key={row.user.id}>
                    <td><b>{row.user.name}</b><small>{row.user.department || ""}</small></td>
                    <td>{row.requests}</td>
                    <td><b>{row.approvedDays}</b></td>
                    <td>{row.pending || "—"}</td>
                    <td>{row.rejected || "—"}</td>
                    {LEAVE_TYPES.map((type) => <td key={type}>{row.byType[type] || "—"}</td>)}
                  </tr>
                ))}
                {!report.length && <tr><td colSpan={5 + LEAVE_TYPES.length}><div className="empty compact">No requests in this period.</div></td></tr>}
              </tbody></table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/* HR & Skills → Approval Flow. Who approves one person's requests, in order.
 *
 * The chain lived only inside the Timeclock engine's Leave & Requests page,
 * which is why people could not find it — and it could only be set, never
 * really rearranged: three fixed dropdowns and no way to move a step. This is
 * the same flowConfig, edited where the people are, with steps you can add,
 * remove, and move up or down — so A → B → C becomes A → D → B in the order
 * you actually want, rather than by retyping every box. */
const FLOW_TYPES = ["Leave", "Schedule", "Performance"] as const;

function ApprovalFlowCentre({
  viewer, users, store, save,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  store: Record<string, unknown> | null;
  save: (employeeId: string, type: string, steps: string[]) => boolean;
}) {
  const item = ITEMS.find((row) => row.id === "hr-approval-flow");
  const canEdit = Boolean(viewer && item && hasItemPermission(viewer, item, "edit"));
  const scope = scopedUsers(viewer, users).filter((user) => user.offboarded !== true);
  const flowConfig = (store?.flowConfig || {}) as Record<string, Record<string, string[]>>;

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>("");
  const [type, setType] = useState<string>("Leave");
  const [draft, setDraft] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);

  const person = scope.find((user) => user.id === selectedId) || scope[0] || null;
  /* Read straight from the store rather than memoised: it is a lookup and a
     filter over at most three ids, and the store object is rebuilt on every
     sync tick anyway, so caching it would cost more than it saves. */
  const saved = person ? (flowConfig[person.id]?.[type] || []).filter(Boolean) : [];
  /* The editor follows the person and the request type until somebody starts
     changing it; only then does it hold its own state. */
  const steps = touched ? draft : saved;
  const dirty = touched && JSON.stringify(draft) !== JSON.stringify(saved);
  const nameOf = (id: string) => users.find((user) => user.id === id)?.name || id;

  const change = (next: string[]) => { setDraft(next); setTouched(true); };
  const move = (at: number, by: number) => {
    const next = [...steps];
    const to = at + by;
    if (to < 0 || to >= next.length) return;
    [next[at], next[to]] = [next[to], next[at]];
    change(next);
  };
  const reset = () => { setDraft([]); setTouched(false); };

  const candidates = users.filter((user) =>
    user.enabled !== false && user.offboarded !== true && user.id !== person?.id);
  const listed = scope.filter((user) =>
    `${user.name} ${user.department || ""} ${user.access || ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div className="native-scroll requests-scroll">
      <section className="overview-hero home-hero">
        <span className="home-hero-mark" aria-hidden="true" />
        <div>
          <span className="eyebrow">HR &amp; Skills</span>
          <h2>Approval Flow</h2>
          <p>Who approves each person&apos;s requests, and in what order. Requests already waiting keep the chain they were raised with.</p>
        </div>
        <span className="access-pill"><CheckCircle2 size={16} /> {canEdit ? "Can edit" : "Read only"}</span>
      </section>

      <section className="report-panel">
        <div className="section-head">
          <div><span className="eyebrow">Employee</span><h3>Choose whose chain to set</h3></div>
          <span className="black-badge">{listed.length}</span>
        </div>
        <div className="settings-fields">
          <label className="wide">Find someone
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, department, or role" />
          </label>
        </div>
        <div className="data-table-wrap">
          <table className="data-table"><thead><tr>
            <th>Employee</th><th>Department</th><th>Leave chain</th><th></th>
          </tr></thead><tbody>
            {listed.slice(0, 60).map((user) => {
              const chain = (flowConfig[user.id]?.Leave || []).filter(Boolean);
              return (
                <tr key={user.id}>
                  <td><b>{user.name}</b><small>{user.access || ""}</small></td>
                  <td>{user.department || "—"}</td>
                  <td>{chain.length ? chain.map(nameOf).join(" → ") : <span className="chain-none">No flow set</span>}</td>
                  <td><button type="button" className="btn small" onClick={() => { setSelectedId(user.id); reset(); }}>
                    {person?.id === user.id ? "Editing" : "Edit"}
                  </button></td>
                </tr>
              );
            })}
            {!listed.length && <tr><td colSpan={4}><div className="empty compact">Nobody matches that search.</div></td></tr>}
          </tbody></table>
        </div>
      </section>

      {person && (
        <section className="settings-panel">
          <div className="section-head">
            <div>
              <span className="eyebrow">{person.department || "No department"}</span>
              <h3>{person.name}</h3>
              <p>Set the order approvals travel in. Each step waits for the one before it.</p>
            </div>
          </div>

          <div className="settings-tabs" role="tablist" aria-label="Request type">
            {FLOW_TYPES.map((value) => (
              <button key={value} type="button" role="tab" aria-selected={type === value}
                className={type === value ? "active" : ""}
                onClick={() => { setType(value); reset(); }}>{value}</button>
            ))}
          </div>

          {/* What the chain does today, as the person will experience it. */}
          <div className="chain-strip" style={{ margin: "10px 0 4px" }}>
            <div className="chain-step is-approved">
              <span className="chain-badge" aria-hidden="true">1</span>
              <span className="chain-name">{person.name}</span>
              <span className="chain-state">raises the request</span>
            </div>
            {steps.map((id, index) => (
              <div key={`${id}-${index}`} className="chain-step is-waiting">
                <span className="chain-badge" aria-hidden="true">{index + 2}</span>
                <span className="chain-name">{nameOf(id)}</span>
                <span className="chain-state">approves {index === steps.length - 1 ? "last" : `step ${index + 1}`}</span>
              </div>
            ))}
            {!steps.length && <span className="chain-none">No approvers yet — add one below.</span>}
          </div>

          {steps.map((id, index) => (
            <div className="settings-fields" key={`row-${index}`}>
              <label>Step {index + 1}
                <select value={id} disabled={!canEdit} onChange={(event) => {
                  const next = [...steps]; next[index] = event.target.value; change(next);
                }}>
                  {candidates.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                </select>
              </label>
              {canEdit && (
                <div className="review-actions" style={{ alignSelf: "end" }}>
                  <button type="button" onClick={() => move(index, -1)} disabled={index === 0}>Move up</button>
                  <button type="button" onClick={() => move(index, 1)} disabled={index === steps.length - 1}>Move down</button>
                  <button type="button" className="danger" onClick={() => change(steps.filter((_, at) => at !== index))}>Remove</button>
                </div>
              )}
            </div>
          ))}

          {canEdit && (
            <div className="form-actions">
              {steps.length < 3 && (
                <button type="button" className="secondary" onClick={() => {
                  const next = candidates.find((user) => !steps.includes(user.id));
                  if (next) change([...steps, next.id]);
                }}><Plus size={15} /> Add approver</button>
              )}
              <button type="button" className="primary" disabled={!dirty} onClick={() => {
                if (save(person.id, type, steps)) reset();
              }}>Save {type} flow</button>
              {dirty && <button type="button" onClick={reset}>Cancel</button>}
            </div>
          )}
          <p className="builder-note">
            Up to three approvers. A person can never approve their own request, and the same
            person cannot appear twice. Changing this affects requests raised from now on —
            anything already waiting keeps its own chain, which Corrections can reroute.
          </p>
        </section>
      )}
    </div>
  );
}

/* Administration → Corrections. One screen for putting wrong records right:
 * reroute a pending request's approval flow, fix the figures on a points
 * entry, and fix or add clock sessions. Every write goes through the gated
 * handlers in Home() — this component only collects the change — and the
 * whole screen is closed to anyone without the admin-corrections grant. */
function CorrectionsCentre({
  viewer, users, store, sessions, decide, editFlow, fixRow, fixSession, addSession, removeSession,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  store: Record<string, unknown> | null;
  sessions: ClockSession[];
  decide: (id: string, status: "Approved" | "Rejected", note?: string) => boolean;
  editFlow: (id: string, flow: string[]) => boolean;
  fixRow: (id: string, patch: { date?: string; hours?: number; submitted?: number; approved?: number; status?: string; notes?: string }) => boolean;
  fixSession: (uid: string, clockIn: string, newIn: string, newOut: string | null) => boolean;
  addSession: (uid: string, date: string, from: string, to: string, mode: string) => boolean;
  removeSession: (uid: string, clockIn: string) => boolean;
}) {
  const dialog = useDialog();
  const item = ITEMS.find((row) => row.id === "admin-corrections");
  const canEdit = Boolean(viewer && item && hasItemPermission(viewer, item, "edit"));
  const canDelete = Boolean(viewer && item && hasItemPermission(viewer, item, "delete"));
  const approvalsItem = ITEMS.find((row) => row.id === "staff-approvals");
  const canDecide = Boolean(viewer && approvalsItem && hasItemPermission(viewer, approvalsItem, "approve"));
  const scope = scopedUsers(viewer, users);
  const scopeIds = new Set(scope.map((user) => user.id));
  const nameOfUser = (id: string) => users.find((user) => user.id === id)?.name || id;

  const [tab, setTab] = useState<"requests" | "points" | "time">("requests");

  /* datetime-local reads local wall time with no zone, so the stored ISO stamp
     is converted to the device's own clock for editing — the same convention
     the QuickClock trim panel uses. */
  const toLocalInput = (iso: string) => {
    const when = new Date(iso);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
  };

  /* -------- Requests -------- */
  const allRequests = Array.isArray(store?.approvals) ? (store.approvals as LeaveRequest[]) : [];
  const [pendingOnly, setPendingOnly] = useState(true);
  const requests = allRequests
    .filter((row) => scopeIds.has(row.uid) || row.uid === viewer?.id)
    .filter((row) => !pendingOnly || row.status === "Pending")
    .slice()
    .reverse()
    .slice(0, 80);
  const [flowEditId, setFlowEditId] = useState<string | null>(null);
  const [flowDraft, setFlowDraft] = useState<string[]>(["", "", ""]);
  const startFlowEdit = (row: LeaveRequest) => {
    const flow = Array.isArray(row.flow) ? row.flow.filter(Boolean) : [];
    setFlowDraft([flow[0] || "", flow[1] || "", flow[2] || ""]);
    setFlowEditId(row.id);
  };
  const chainOf = (row: LeaveRequest) => {
    const steps = approvalSteps(row, nameOfUser);
    if (!steps.length) return <span className="chain-none">No flow recorded</span>;
    return (
      <div className="chain-strip">
        {steps.map((s, i) => (
          <div key={`${s.id}-${i}`} className={`chain-step is-${s.state}`} title={s.note || undefined}>
            <span className="chain-badge" aria-hidden="true">{s.state === "approved" ? "✓" : s.state === "rejected" ? "✗" : s.state === "pending" ? "•" : "·"}</span>
            <span className="chain-name">{s.name}</span>
            <span className="chain-state">{s.state === "approved" ? "Approved" : s.state === "rejected" ? "Rejected" : s.state === "pending" ? "With them now" : s.state === "waiting" ? "Waiting" : "—"}{s.at ? ` · ${new Date(s.at).toLocaleDateString()}` : ""}</span>
          </div>
        ))}
      </div>
    );
  };

  /* -------- Points -------- */
  const allRows = Array.isArray(store?.performance) ? (store.performance as PerformanceRow[]) : [];
  const [pointsUser, setPointsUser] = useState("");
  const [pointsSearch, setPointsSearch] = useState("");
  const pointsRows = allRows
    .filter((row) => scopeIds.has(rowUserId(row, users)))
    .filter((row) => !pointsUser || rowUserId(row, users) === pointsUser)
    .filter((row) => {
      if (!pointsSearch.trim()) return true;
      const hay = `${row.Engineer || ""} ${row.Project || ""} ${row.Deliverable || ""} ${row.Week || ""} ${row.Date || ""}`.toLowerCase();
      return hay.includes(pointsSearch.trim().toLowerCase());
    })
    .slice()
    .sort((a, b) => String(b.Date || "").localeCompare(String(a.Date || "")))
    .slice(0, 100);
  const [rowEditId, setRowEditId] = useState<string | null>(null);
  const [rowDraft, setRowDraft] = useState({ date: "", hours: "", submitted: "", approved: "", status: "", notes: "" });
  const startRowEdit = (row: PerformanceRow) => {
    setRowDraft({
      date: String(row.Date || ""),
      hours: String(finiteNumber(row["Hours Spent"])),
      submitted: String(finiteNumber(row["Submitted Points"])),
      approved: String(finiteNumber(row["Approved Points"])),
      status: String(row.Status || "Submitted"),
      notes: String(row.Notes || ""),
    });
    setRowEditId(String(row.id));
  };

  /* -------- Timesheets -------- */
  const twoWeeksAgo = new Date(); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const [timeUser, setTimeUser] = useState("");
  const [timeFrom, setTimeFrom] = useState(dateInputValue(twoWeeksAgo));
  const [timeTo, setTimeTo] = useState(dateInputValue(new Date()));
  const timeRows = sessions
    .filter((session) => scopeIds.has(session.uid))
    .filter((session) => !timeUser || session.uid === timeUser)
    .filter((session) => session.date >= timeFrom && session.date <= timeTo)
    .slice()
    .sort((a, b) => b.clockIn.localeCompare(a.clockIn))
    .slice(0, 60);
  const [sessionEditKey, setSessionEditKey] = useState<string | null>(null);
  const [sessionDraft, setSessionDraft] = useState({ in: "", out: "" });
  const [addDraft, setAddDraft] = useState({ date: dateInputValue(new Date()), from: "09:00", to: "17:00", mode: "Office" });

  return (
    <div className="native-scroll requests-scroll">
      <section className="overview-hero home-hero">
        <span className="home-hero-mark" aria-hidden="true" />
        <div>
          <span className="eyebrow">Administration</span>
          <h2>Corrections</h2>
          <p>Put wrong records right: reroute request approvals, fix points figures, and fix clock sessions. Every change is stamped with who made it.</p>
        </div>
        <span className="access-pill"><SlidersHorizontal size={16} /> {canEdit ? "Edit access" : "Read only"}</span>
      </section>

      <div className="settings-tabs" role="tablist" aria-label="Correction sections">
        <button type="button" role="tab" aria-selected={tab === "requests"} className={tab === "requests" ? "active" : ""} onClick={() => setTab("requests")}>
          <ClipboardCheck size={16} /> Requests &amp; flows
        </button>
        <button type="button" role="tab" aria-selected={tab === "points"} className={tab === "points" ? "active" : ""} onClick={() => setTab("points")}>
          <TrendingUp size={16} /> Points
        </button>
        <button type="button" role="tab" aria-selected={tab === "time"} className={tab === "time" ? "active" : ""} onClick={() => setTab("time")}>
          <Timer size={16} /> Timesheets
        </button>
      </div>

      {tab === "requests" && (
        <section className="report-panel">
          <div className="section-head">
            <div><span className="eyebrow">Approval routing</span><h3>Requests and their flows</h3></div>
            <label className="auth-remember" style={{ margin: 0 }}>
              <input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />
              <span>Pending only</span>
            </label>
          </div>
          <div className="data-table-wrap">
            <table className="data-table"><thead><tr>
              <th>Employee</th><th>Type</th><th>Date</th><th>Status</th><th>Approval flow</th><th>Actions</th>
            </tr></thead><tbody>
              {requests.map((row) => {
                const person = users.find((user) => user.id === row.uid);
                const editing = flowEditId === row.id;
                return (
                  <tr key={row.id}>
                    <td><b>{person?.name || row.uid}</b><small>{person?.department || ""}</small></td>
                    <td><b>{row.entry ? "Late points" : row.type}</b><small>{row.requestType || ""}</small></td>
                    <td>{row.entry ? row.entry.Date : `${row.from || row.date || ""}${row.to ? ` → ${row.to}` : ""}`}</td>
                    <td><span className={`record-status ${String(row.status || "").toLowerCase()}`}>{row.status}</span></td>
                    <td>
                      {chainOf(row)}
                      {editing && (
                        <div className="settings-fields" style={{ marginTop: 8 }}>
                          {[0, 1, 2].map((slot) => (
                            <label key={slot}>Step {slot + 1}{slot === 0 ? "" : " (optional)"}
                              <select value={flowDraft[slot]} onChange={(event) => {
                                const next = [...flowDraft]; next[slot] = event.target.value; setFlowDraft(next);
                              }}>
                                <option value="">—</option>
                                {users.filter((user) => user.enabled !== false && user.id !== row.uid).map((user) => (
                                  <option key={user.id} value={user.id}>{user.name}</option>
                                ))}
                              </select>
                            </label>
                          ))}
                        </div>
                      )}
                    </td>
                    <td><div className="review-actions">
                      {editing ? (
                        <>
                          <button type="button" className="approve" onClick={() => { if (editFlow(row.id, flowDraft)) setFlowEditId(null); }}>Save flow</button>
                          <button type="button" onClick={() => setFlowEditId(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          {canEdit && row.status === "Pending" && (
                            <button type="button" onClick={() => startFlowEdit(row)}>Edit flow</button>
                          )}
                          {canDecide && row.status === "Pending" && (
                            <>
                              <button type="button" className="approve" onClick={() => decide(row.id, "Approved")}>Approve</button>
                              <button type="button" onClick={async () => decide(row.id, "Rejected", (await dialog.prompt("Reason for rejecting (optional):")) || "")}>Reject</button>
                            </>
                          )}
                        </>
                      )}
                    </div></td>
                  </tr>
                );
              })}
              {!requests.length && <tr><td colSpan={6}><div className="empty compact">No requests in this view.</div></td></tr>}
            </tbody></table>
          </div>
        </section>
      )}

      {tab === "points" && (
        <section className="report-panel">
          <div className="section-head">
            <div><span className="eyebrow">Performance</span><h3>Points entries</h3></div>
          </div>
          <div className="settings-fields">
            <label>Employee
              <select value={pointsUser} onChange={(event) => setPointsUser(event.target.value)}>
                <option value="">Everyone in your scope</option>
                {scope.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
              </select>
            </label>
            <label>Search
              <input value={pointsSearch} onChange={(event) => setPointsSearch(event.target.value)} placeholder="Project, deliverable, week, date" />
            </label>
          </div>
          <div className="data-table-wrap">
            <table className="data-table"><thead><tr>
              <th>Date</th><th>Employee</th><th>Work</th><th>Hours</th><th>Submitted</th><th>Approved</th><th>Status</th><th>Fix</th>
            </tr></thead><tbody>
              {pointsRows.map((row) => {
                const editing = rowEditId === String(row.id);
                return (
                  <tr key={String(row.id)}>
                    <td>{String(row.Date || "")}<small>{String(row.Week || "")}</small></td>
                    <td><b>{String(row.Engineer || nameOfUser(rowUserId(row, users)))}</b></td>
                    <td>{String(row.Project || "")}<small>{String(row.Deliverable || "")}</small></td>
                    <td>{finiteNumber(row["Hours Spent"])}</td>
                    <td>{finiteNumber(row["Submitted Points"])}</td>
                    <td><b>{finiteNumber(row["Approved Points"])}</b></td>
                    <td><span className={`record-status ${String(row.Status || "").toLowerCase()}`}>{String(row.Status || "")}</span>
                      {Boolean(row["Corrected By"]) && <small>fixed by {String(row["Corrected By"])}</small>}</td>
                    <td>
                      {editing ? (
                        <div className="settings-fields">
                          <label>Date<input type="date" value={rowDraft.date} onChange={(event) => setRowDraft({ ...rowDraft, date: event.target.value })} /></label>
                          <label>Hours<input type="number" min="0" step="0.25" value={rowDraft.hours} onChange={(event) => setRowDraft({ ...rowDraft, hours: event.target.value })} /></label>
                          <label>Submitted<input type="number" min="0" step="0.5" value={rowDraft.submitted} onChange={(event) => setRowDraft({ ...rowDraft, submitted: event.target.value })} /></label>
                          <label>Approved<input type="number" min="0" step="0.5" value={rowDraft.approved} onChange={(event) => setRowDraft({ ...rowDraft, approved: event.target.value })} /></label>
                          <label>Status
                            <select value={rowDraft.status} onChange={(event) => setRowDraft({ ...rowDraft, status: event.target.value })}>
                              {["Draft", "Submitted", "Approved", "Returned"].map((value) => <option key={value}>{value}</option>)}
                            </select>
                          </label>
                          <label className="wide">Note<input value={rowDraft.notes} onChange={(event) => setRowDraft({ ...rowDraft, notes: event.target.value })} placeholder="Why this was corrected" /></label>
                          <div className="review-actions">
                            <button type="button" className="approve" onClick={() => {
                              const saved = fixRow(String(row.id), {
                                date: rowDraft.date || undefined,
                                hours: Number(rowDraft.hours),
                                submitted: Number(rowDraft.submitted),
                                approved: Number(rowDraft.approved),
                                status: rowDraft.status || undefined,
                                notes: rowDraft.notes,
                              });
                              if (saved) setRowEditId(null);
                            }}>Save fix</button>
                            <button type="button" onClick={() => setRowEditId(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        canEdit ? <button type="button" className="btn small" onClick={() => startRowEdit(row)}>Fix</button> : <span className="chain-none">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!pointsRows.length && <tr><td colSpan={8}><div className="empty compact">No points entries match.</div></td></tr>}
            </tbody></table>
          </div>
        </section>
      )}

      {tab === "time" && (
        <>
          <section className="report-panel">
            <div className="section-head">
              <div><span className="eyebrow">Attendance</span><h3>Clock sessions</h3></div>
            </div>
            <div className="settings-fields">
              <label>Employee
                <select value={timeUser} onChange={(event) => setTimeUser(event.target.value)}>
                  <option value="">Everyone in your scope</option>
                  {scope.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                </select>
              </label>
              <label>From<input type="date" value={timeFrom} max={timeTo} onChange={(event) => setTimeFrom(event.target.value)} /></label>
              <label>To<input type="date" value={timeTo} min={timeFrom} onChange={(event) => setTimeTo(event.target.value)} /></label>
            </div>
            <div className="data-table-wrap">
              <table className="data-table"><thead><tr>
                <th>Employee</th><th>Date</th><th>Mode</th><th>Clock in → out (your local time)</th><th>Hours</th><th>Fix</th>
              </tr></thead><tbody>
                {timeRows.map((session) => {
                  const key = `${session.uid}|${session.clockIn}`;
                  const editing = sessionEditKey === key;
                  return (
                    <tr key={key}>
                      <td><b>{session.employee}</b></td>
                      <td>{session.date}</td>
                      <td>{session.mode}</td>
                      <td>
                        {new Date(session.clockIn).toLocaleString()} → {session.open ? "still clocked in" : new Date(session.clockOut).toLocaleString()}
                        {editing && (
                          <div className="settings-fields" style={{ marginTop: 8 }}>
                            <label>Clock in<input type="datetime-local" value={sessionDraft.in} max={toLocalInput(new Date().toISOString())} onChange={(event) => setSessionDraft({ ...sessionDraft, in: event.target.value })} /></label>
                            <label>Clock out<input type="datetime-local" value={sessionDraft.out} max={toLocalInput(new Date().toISOString())} onChange={(event) => setSessionDraft({ ...sessionDraft, out: event.target.value })} /></label>
                          </div>
                        )}
                      </td>
                      <td>{formatHours(session.hours)}</td>
                      <td><div className="review-actions">
                        {editing ? (
                          <>
                            <button type="button" className="approve" onClick={() => {
                              if (fixSession(session.uid, session.clockIn, sessionDraft.in, sessionDraft.out || null)) setSessionEditKey(null);
                            }}>Save fix</button>
                            <button type="button" onClick={() => setSessionEditKey(null)}>Cancel</button>
                          </>
                        ) : (
                          <>
                            {canEdit && (
                              <button type="button" className="btn small" onClick={() => {
                                setSessionDraft({ in: toLocalInput(session.clockIn), out: session.open ? "" : toLocalInput(session.clockOut) });
                                setSessionEditKey(key);
                              }}>Fix times</button>
                            )}
                            {canDelete && (
                              <button type="button" className="danger" onClick={async () => {
                                if (await dialog.confirm({ message: `Remove ${session.employee}'s session on ${session.date}? This cannot be undone.`, danger: true, confirmLabel: "Remove" })) removeSession(session.uid, session.clockIn);
                              }}>Remove</button>
                            )}
                          </>
                        )}
                      </div></td>
                    </tr>
                  );
                })}
                {!timeRows.length && <tr><td colSpan={6}><div className="empty compact">No sessions in this period.</div></td></tr>}
              </tbody></table>
            </div>
          </section>

          {canEdit && (
            <section className="settings-panel">
              <div className="section-head"><div><span className="eyebrow">Missing punch</span><h3>Add a session that was never recorded</h3></div></div>
              <div className="settings-fields">
                <label>Employee
                  <select value={timeUser} onChange={(event) => setTimeUser(event.target.value)}>
                    <option value="">Choose…</option>
                    {scope.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
                  </select>
                </label>
                <label>Date<input type="date" value={addDraft.date} max={dateInputValue(new Date())} onChange={(event) => setAddDraft({ ...addDraft, date: event.target.value })} /></label>
                <label>From<input type="time" value={addDraft.from} onChange={(event) => setAddDraft({ ...addDraft, from: event.target.value })} /></label>
                <label>To<input type="time" value={addDraft.to} onChange={(event) => setAddDraft({ ...addDraft, to: event.target.value })} /></label>
                <label>Mode
                  <select value={addDraft.mode} onChange={(event) => setAddDraft({ ...addDraft, mode: event.target.value })}>
                    {["Office", "Remote", "Site"].map((value) => <option key={value}>{value}</option>)}
                  </select>
                </label>
              </div>
              <div className="form-actions">
                <button type="button" className="primary" onClick={() => addSession(timeUser, addDraft.date, addDraft.from, addDraft.to, addDraft.mode)}>
                  <Plus size={15} /> Add session
                </button>
              </div>
              <p className="ps-note">Added sessions are stamped as a manual entry with your name, exactly like an approved correction.</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/* Settings → Notifications.
 *
 * Everything on this screen governs alerts OUTSIDE the app. Nothing here can
 * stop a notification being created, and nothing here can remove one from the
 * bell — which is why the panel says so in as many words rather than leaving
 * people to guess whether turning something off loses them the record. */
function NotifySettings({ user, openBell }: { user: StaffUser | null; openBell: () => void }) {
  const [setup, setSetup] = useState<NotifySetup | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [subscribed, setSubscribed] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [channelError, setChannelError] = useState("");
  const [channelSaved, setChannelSaved] = useState("");
  const configured = notifyConfigured();
  const supported = pushSupported();
  const needsHomeScreen = pushNeedsHomeScreen();
  /* Email alerts are queued only for people with an address on file, and most
     of the directory signs in by username. Saying so up front beats leaving
     somebody to wonder why a switch they turned on changed nothing. */
  const viewerHasEmail = Boolean(user?.email && user.email.includes("@"));

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
    }, 0);
    void thisDeviceSubscribed().then(setSubscribed);
    return () => clearTimeout(timer);
  }, [tick]);

  useEffect(() => {
    if (!user?.id || !configured) return;
    let cancelled = false;
    fetchSetup({ id: user.id, name: user.name }).then((data) => { if (!cancelled) setSetup(data); });
    return () => { cancelled = true; };
  }, [user?.id, user?.name, configured, tick]);

  const enable = async () => {
    if (!user?.id) { setMessage("Sign in again before turning alerts on."); return; }
    setBusy(true);
    const outcome = await subscribeToPush(user.id, user.name);
    setBusy(false);
    setMessage(outcome.message);
    setTick((value) => value + 1);
  };

  const disable = async () => {
    if (!user?.id) return;
    setBusy(true);
    await unsubscribeFromPush(user.id);
    setBusy(false);
    setMessage("Alerts are off on this device. Notifications still arrive in the bell.");
    setTick((value) => value + 1);
  };

  const testAlert = async () => {
    if (!user?.id) return;
    setBusy(true);
    // A real notification through the real path — raised, queued, and pushed by
    // the sender — because a fake local banner would prove only that this tab
    // can draw one, which is not the thing anybody is trying to find out.
    await raiseNotifications({ id: user.id, name: user.name }, [{
      userUid: user.id,
      event: "account.test",
      title: "Test notification",
      body: "If this reached your device outside the app, alerts are working.",
      dedupeKey: `test:${Date.now()}`,
    }]);
    /* Permission granted is not the same as "this device will show it". When
       the operating system suppresses the browser's notifications, every call
       still succeeds and the banner is silently discarded — so telling someone
       the test was sent would be technically true and completely useless. */
    const visible = await canDisplayNotifications();
    setBusy(false);
    setMessage(visible
      ? "Sent. It is in your bell now, and the device alert should appear within a few seconds."
      : "Sent to your bell — but this device discarded it without showing anything. That is your operating system, not Larsa Control: check Do Not Disturb, and that your browser is allowed to show notifications in your system notification settings.");
  };

  /* Optimistic, because a switch that waits for a round trip before it moves
     feels broken. But a save that does not land has to put the switch back
     where it was and say so — otherwise the screen quietly disagrees with the
     server, and the person believes they turned email on when they did not. */
  const setPref = async (category: string, push: boolean, mail: boolean) => {
    if (!user?.id || !setup) return;
    const previous = setup.categories.find((row) => row.id === category);
    setChannelError("");
    setSetup({
      ...setup,
      categories: setup.categories.map((row) => (row.id === category ? { ...row, push, mail } : row)),
    });
    const saved = await setCategoryPref({ id: user.id, name: user.name }, category, push, mail);
    if (!saved) {
      setSetup((current) => (current ? {
        ...current,
        categories: current.categories.map((row) => (row.id === category && previous ? previous : row)),
      } : current));
      setChannelError("That change could not be saved. Your previous setting has been put back — check your connection and try again.");
      return;
    }
    setChannelSaved(`${previous?.label || "Notification"} updated.`);
    window.setTimeout(() => setChannelSaved(""), 2600);
  };

  const saveSettings = async (patch: Partial<NonNullable<NotifySetup>["settings"]>) => {
    if (!user?.id || !setup) return;
    const next = { ...setup.settings, ...patch };
    setSetup({ ...setup, settings: next });
    await setNotifySettings({ id: user.id, name: user.name }, next);
  };

  const deviceAction = async (id: string, patch: { enabled?: boolean } | "remove") => {
    if (!user?.id) return;
    if (patch === "remove") await removeDevice({ id: user.id, name: user.name }, id);
    else await updateDevice({ id: user.id, name: user.name }, id, patch);
    setTick((value) => value + 1);
  };

  const quietOn = setup?.settings.quietFrom !== null && setup?.settings.quietFrom !== undefined;

  return (
    <section className="settings-panel notify-settings">
      <div className="section-head">
        <div>
          <span className="eyebrow">Notifications</span>
          <h3>Alerts outside the app</h3>
        </div>
        <button type="button" className="secondary" onClick={openBell}>
          <Bell size={15} /> Open notification centre
        </button>
      </div>

      {/* The one sentence this whole screen depends on people believing. */}
      <p className="notify-promise">
        All Larsa Control notifications always remain available in the notification bell.
        These settings control only alerts outside the app.
      </p>

      {message && <div className="settings-note">{message}</div>}

      <div className="notify-device-state">
        {!configured && (
          <div className="notify-state warn">
            <BellOff size={18} />
            <span><b>Not configured for this deployment</b>
              <small>Account storage is not set up, so alerts outside the app are unavailable. The bell still works on this device.</small></span>
          </div>
        )}
        {configured && !supported && (
          <div className="notify-state warn">
            <BellOff size={18} />
            <span><b>This browser cannot deliver alerts</b>
              <small>Notifications still arrive in the bell. Try Chrome, Edge, Firefox, or Safari on a supported device.</small></span>
          </div>
        )}
        {configured && supported && needsHomeScreen && (
          <div className="notify-state warn">
            <Smartphone size={18} />
            <span><b>Add to Home Screen first</b>
              <small>On iPhone and iPad, tap Share then “Add to Home Screen”, and open Larsa Control from the icon. Safari only delivers alerts to the installed app.</small></span>
          </div>
        )}
        {configured && supported && !needsHomeScreen && permission === "denied" && (
          <div className="notify-state warn">
            <BellOff size={18} />
            <span><b>Blocked in this browser</b>
              <small>Allow notifications for this site in your browser&apos;s site settings, then come back and turn them on.</small></span>
          </div>
        )}
        {configured && supported && !needsHomeScreen && permission !== "denied" && (
          <div className={subscribed ? "notify-state on" : "notify-state"}>
            <Bell size={18} />
            <span>
              <b>{subscribed ? "Alerts are on for this device" : "Alerts are off on this device"}</b>
              <small>{describeThisDevice().label}</small>
            </span>
            <div className="notify-state-actions">
              {subscribed
                ? <button type="button" className="secondary" disabled={busy} onClick={disable}>Turn off here</button>
                : <button type="button" className="primary" disabled={busy} onClick={enable}>Turn on here</button>}
              {subscribed && <button type="button" className="secondary" disabled={busy} onClick={testAlert}>Send a test</button>}
            </div>
          </div>
        )}
      </div>

      {configured && setup && (
        <>
          <div className="section-head sub">
            <div><h4>Notification channels</h4>
              <small>Turned off here, it still arrives in the bell — it just will not interrupt you.</small></div>
          </div>
          <div className="notify-cats">
            {setup.categories.map((category) => (
              <div key={category.id} className="notify-cat">
                <span>
                  <b>{category.label}</b>
                  <small>{category.description}</small>
                  {category.sensitive && (
                    <em title="Amounts are never shown in a device alert">
                      Alerts for this never show figures on a lock screen
                    </em>
                  )}
                </span>
                {/* Two channels, side by side on a wide screen and stacked on a
                    narrow one. They are genuinely independent: each sends only
                    its own value, and passes the other through untouched, so
                    switching one can never move the other. */}
                <div className="notify-channels">
                  <label className="notify-switch stacked">
                    <input
                      type="checkbox"
                      checked={category.push}
                      aria-label={`Push notifications for ${category.label}`}
                      onChange={(event) => setPref(category.id, event.target.checked, category.mail)}
                    />
                    <i aria-hidden="true" />
                    <span><Smartphone size={13} aria-hidden="true" /> Push</span>
                  </label>
                  <label className="notify-switch stacked">
                    <input
                      type="checkbox"
                      checked={category.mail}
                      aria-label={`Email notifications for ${category.label}`}
                      onChange={(event) => setPref(category.id, category.push, event.target.checked)}
                    />
                    <i aria-hidden="true" />
                    <span><Mail size={13} aria-hidden="true" /> Email</span>
                  </label>
                </div>
              </div>
            ))}
          </div>
          {!viewerHasEmail && (
            <p className="notify-hint">
              Email alerts need an address on your account. Add one under Profile and they will start arriving.
            </p>
          )}
          {channelError && <p className="notify-hint bad" role="alert">{channelError}</p>}
          {channelSaved && <p className="notify-hint good" role="status">{channelSaved}</p>}

          <div className="section-head sub">
            <div><h4>Quiet hours</h4>
              <small>Alerts are held during these hours. Notifications still arrive in the bell straight away.</small></div>
          </div>
          <div className="notify-quiet">
            <label className="notify-switch inline">
              <input
                type="checkbox"
                checked={Boolean(quietOn)}
                aria-label="Use quiet hours"
                onChange={(event) => saveSettings(event.target.checked
                  ? { quietFrom: 22, quietTo: 7 }
                  : { quietFrom: null, quietTo: null })}
              />
              <i aria-hidden="true" />
              <span>Use quiet hours</span>
            </label>
            {quietOn && (
              <div className="notify-quiet-range">
                <label>From
                  <select value={String(setup.settings.quietFrom ?? 22)}
                    onChange={(event) => saveSettings({ quietFrom: Number(event.target.value) })}>
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
                    ))}
                  </select>
                </label>
                <label>Until
                  <select value={String(setup.settings.quietTo ?? 7)}
                    onChange={(event) => saveSettings({ quietTo: Number(event.target.value) })}>
                    {Array.from({ length: 24 }, (_, hour) => (
                      <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <label className="notify-switch inline">
              <input
                type="checkbox"
                checked={setup.settings.badge}
                aria-label="Show a count on the app icon"
                onChange={(event) => saveSettings({ badge: event.target.checked })}
              />
              <i aria-hidden="true" />
              <span>Show the unread count on the app icon</span>
            </label>
          </div>

          <div className="section-head sub">
            <div><h4>Your devices</h4>
              <small>Every browser and installed app you have turned alerts on for.</small></div>
          </div>
          <div className="notify-devices">
            {setup.devices.map((device) => (
              <div key={device.id} className="notify-device">
                <span>
                  {device.platform === "iPhone" || device.platform === "iPad" || device.platform === "Android"
                    ? <Smartphone size={16} /> : <Monitor size={16} />}
                  <b>{device.label}</b>
                  <small>Last used {notifyAgo(device.lastSeen)}</small>
                </span>
                <div className="notify-device-actions">
                  <label className="notify-switch">
                    <input
                      type="checkbox"
                      checked={device.enabled}
                      aria-label={`Alerts on ${device.label}`}
                      onChange={(event) => deviceAction(device.id, { enabled: event.target.checked })}
                    />
                    <i aria-hidden="true" />
                  </label>
                  <button type="button" aria-label={`Remove ${device.label}`} title="Remove this device"
                    onClick={() => deviceAction(device.id, "remove")}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
            {!setup.devices.length && (
              <div className="empty compact">No devices yet. Turn alerts on above to add this one.</div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function MySettings({
  user, unread, dark, setDark, saveProfile, openBell, sendCode, checkCode,
}: {
  user: StaffUser | null;
  unread: number;
  dark: boolean;
  setDark: (value: boolean) => void;
  saveProfile: (patch: Partial<StaffUser>) => boolean;
  openBell: () => void;
  sendCode: (email: string) => Promise<string>;
  checkCode: (email: string, code: string) => Promise<string>;
}) {
  /* Anything that changes how you get in -- password, PIN, or the email
     address itself -- is held here until a code sent to the address on file
     is entered. Someone who walks up to an unlocked screen can then still
     not lock the real owner out of their own account. The code always goes
     to the CURRENT address, never the new one.

     This only protects a person changing their OWN sign-in details. Someone
     with Users & Access management already has the standing authority to set
     anyone's password, PIN, or email from that screen with no code at all --
     gating their own account the same way would just be a second click on the
     same authority, not an extra check on it. */
  const mayManageAccess = Boolean(user && (isAdmin(user) || hasItemPermission(user, ACCESS_ITEM, "manage")));
  const [pending, setPending] = useState<{ patch: Partial<StaffUser>; label: string } | null>(null);
  const [guardCode, setGuardCode] = useState("");
  const [guardBusy, setGuardBusy] = useState(false);

  const guardedSave = async (patch: Partial<StaffUser>, label: string, done: () => void) => { if (patch.password) patch = { ...patch, password: await hashPassword(patch.password), passwordChangedAt: serverNowIso() }; if (patch.pin) patch = { ...patch, pin: await hashPin(patch.pin), pinChangedAt: serverNowIso() };
    const address = user?.email?.trim();
    if (!supabaseConfigured() || !address || mayManageAccess) {
      if (saveProfile(patch)) { setMessage(`${label} updated.`); done(); }
      return;
    }
    setGuardBusy(true);
    setMessage(`Sending a verification code to ${address}…`);
    const problem = await sendCode(address);
    setGuardBusy(false);
    if (problem) { setMessage(problem); return; }
    setPending({ patch, label });
    setGuardCode("");
    setMessage(`Enter the code sent to ${address} to confirm this change.`);
  };

  const confirmGuard = async () => {
    if (!pending || !user?.email) return;
    setGuardBusy(true);
    const problem = await checkCode(user.email, guardCode);
    setGuardBusy(false);
    if (problem) { setMessage(problem); return; }
    if (saveProfile(pending.patch)) {
      setMessage(`${pending.label} updated.`);
      if (pending.patch.password || pending.patch.pin) setSecret({ password: "", confirm: "", pin: "" });
    }
    setPending(null);
    setGuardCode("");
  };
  const [tab, setTab] = useState<"profile" | "security" | "notifications">("profile");
  const [profile, setProfile] = useState({
    email: user?.email || "", phone: user?.phone || "",
    location: user?.location || "", department: user?.department || "",
  });
  const [secret, setSecret] = useState({ password: "", confirm: "", pin: "" });
  const [message, setMessage] = useState("");
  /* The photo saves on choosing rather than on a separate Save, so it needs a
     line of its own to report into -- the shared `message` belongs to the form
     below and would read as though the fields had been saved too. */
  const photoInput = useRef<HTMLInputElement | null>(null);
  const [photoNote, setPhotoNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    setProfile({
      email: user?.email || "", phone: user?.phone || "",
      location: user?.location || "", department: user?.department || "",
    });
  }, [user]);

  return (
    <div className="native-scroll settings-scroll">
      <section className="overview-hero home-hero">
        <span className="home-hero-mark" aria-hidden="true" />
        <div>
          <span className="eyebrow">Your account</span>
          <h2>{user?.name || "Settings"}</h2>
          <p>{user?.access || user?.role} · {user?.department || "No department"}</p>
        </div>
        <span className="access-pill"><Settings size={16} /> {unread ? `${unread} unread` : "All caught up"}</span>
      </section>

      <div className="settings-tabs" role="tablist" aria-label="Settings sections">
        {([["profile", "Profile", IdCard], ["security", "Sign-in", KeyRound],
           ["notifications", "Notifications", Bell]] as const)
          .map(([id, label, Icon]) => (
            <button type="button" key={id} role="tab" aria-selected={tab === id}
              className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              <Icon size={16} /> {label}
            </button>
          ))}
      </div>

      {message && <div className="settings-note">{message}</div>}

      {tab === "profile" && (
        <section className="settings-panel">
          <div className="section-head"><div><span className="eyebrow">Profile</span><h3>How you appear to the team</h3></div></div>
          {/* Your own picture, set by you. An administrator can take one down
              but cannot put one up, which is the same line the password draws:
              the things that represent you personally are yours to set. */}
          <div className="photo-row">
            <PersonAvatar person={user} className="photo-preview" />
            <div className="photo-copy">
              <b>Profile photo</b>
              <small>{user?.photo
                ? "Shown beside your name across the app."
                : "Optional. Without one your initials are shown instead."}</small>
              {photoNote && <em className={photoNote.bad ? "photo-note bad" : "photo-note"}>{photoNote.text}</em>}
            </div>
            <div className="photo-actions">
              <input ref={photoInput} type="file" accept="image/*" hidden onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setPhotoNote({ text: "Preparing…", bad: false });
                prepareAvatar(file)
                  .then((photo) => {
                    if (saveProfile({ photo })) setPhotoNote({ text: "Photo updated.", bad: false });
                    else setPhotoNote({ text: "That could not be saved. Please try again.", bad: true });
                  })
                  .catch((error: Error) => setPhotoNote({
                    bad: true,
                    text: error.message === "not-an-image"
                      ? "That file is not a picture. Choose a JPEG or PNG."
                      : error.message === "too-large"
                        ? "That picture would not compress small enough. Try a different one."
                        : "That picture could not be read. Try a different one.",
                  }));
              }} />
              <button type="button" className="primary" onClick={() => photoInput.current?.click()}>
                <ImagePlus size={15} /> {user?.photo ? "Change photo" : "Add photo"}
              </button>
              {user?.photo && (
                <button type="button" onClick={() => {
                  if (saveProfile({ photo: "" })) setPhotoNote({ text: "Photo removed.", bad: false });
                }}>Remove</button>
              )}
            </div>
          </div>
          <div className="settings-fields">
            <label>Full name<input value={user?.name || ""} disabled /><small>Ask an administrator to change your name</small></label>
            <label>Work email<input type="email" value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} /></label>
            <label>Phone<input value={profile.phone} onChange={(event) => setProfile({ ...profile, phone: event.target.value })} /></label>
            <label>Location<input value={profile.location} onChange={(event) => setProfile({ ...profile, location: event.target.value })} /></label>
            <label>Department<input value={profile.department} disabled /><small>Set by administration</small></label>
          </div>
          <div className="section-head"><div><span className="eyebrow">Appearance</span><h3>Theme</h3></div></div>
          <div className="theme-choice" role="group" aria-label="Theme">
            <button type="button" className={dark ? "" : "active"} onClick={() => setDark(false)}><Sun size={17} /> Light</button>
            <button type="button" className={dark ? "active" : ""} onClick={() => setDark(true)}><Moon size={17} /> Dark</button>
          </div>
          <p className="builder-note">The theme applies to every area, including the embedded Timeclock, HR, and Accounting modules.</p>
          <div className="form-actions">
            <button type="button" className="primary" disabled={guardBusy} onClick={() => {
              const patch = { email: profile.email.trim(), phone: profile.phone.trim(), location: profile.location.trim() };
              // Only the email address is sensitive here -- phone and location
              // cannot be used to take an account over, so they save directly.
              if (patch.email.toLowerCase() !== (user?.email || "").trim().toLowerCase()) {
                guardedSave(patch, "Profile", () => {});
                return;
              }
              if (saveProfile(patch)) setMessage("Profile saved.");
            }}><Save size={15} /> Save profile</button>
            {pending && (
              <div className="guard-box">
                <label>Verification code<input inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={guardCode} onChange={(event) => setGuardCode(event.target.value.replace(/\s/g, ""))} placeholder="123456" autoFocus /></label>
                <div className="guard-actions">
                  <button type="button" className="primary" disabled={guardBusy} onClick={confirmGuard}>{guardBusy ? "Checking…" : "Confirm change"}</button>
                  <button type="button" onClick={() => { setPending(null); setGuardCode(""); setMessage(""); }}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {tab === "security" && (
        <section className="settings-panel">
          <div className="section-head"><div><span className="eyebrow">Sign-in</span><h3>Password and PIN</h3></div></div>
          <div className="settings-fields">
            <label>New password<input type="password" value={secret.password} onChange={(event) => setSecret({ ...secret, password: event.target.value })} autoComplete="new-password" /></label>
            <label>Confirm password<input type="password" value={secret.confirm} onChange={(event) => setSecret({ ...secret, confirm: event.target.value })} autoComplete="new-password" /></label>
            <label>Employee PIN<input inputMode="numeric" value={secret.pin} onChange={(event) => setSecret({ ...secret, pin: event.target.value.replace(/\D/g, "") })} placeholder="4 to 8 digits" /></label>
          </div>
          <div className="form-actions">
            <button type="button" className="primary" onClick={async () => {
              const patch: Partial<StaffUser> = {};
              if (secret.password || secret.confirm) {
                if (secret.password.length < 6) { setMessage("Use at least 6 characters for a password."); return; }
                if (secret.password !== secret.confirm) { setMessage("The two passwords do not match."); return; }
                patch.password = secret.password;
              }
              if (secret.pin) {
                if (secret.pin.length < 4 || secret.pin.length > 8) { setMessage("A PIN must be 4 to 8 digits."); return; }
                /* PIN sign-in identifies the person BY the pin alone, so a
                   duplicate would sign one person in as another. Checked here
                   exactly as at Create Account and in Users & Access. */
                const everyone = ((parseStore("larsaStaffV8") as { users?: StaffUser[] } | null)?.users) || [];
                if (await pinTakenByOther(everyone, secret.pin, user?.id)) {
                  setMessage("That PIN is already in use by another account. Choose a different one.");
                  return;
                }
                patch.pin = secret.pin;
              }
              if (!Object.keys(patch).length) { setMessage("Nothing to change."); return; }
              guardedSave(patch, "Sign-in details", () => setSecret({ password: "", confirm: "", pin: "" }));
            }} disabled={guardBusy}><Save size={15} /> Update sign-in</button>{(() => { const rows = (((parseStore("larsaStaffV8") as { users?: StaffUser[] } | null)?.users || []).find((row) => row.id === user?.id)?.devices) || []; return (<div className="device-list"><h4>Signed-in devices</h4><p className="builder-note">Verification renews every {verificationWindowHours(user)} hours.</p>{rows.map((device) => (<div className="device-row" key={device.id}><span><b>{device.label}</b>{device.id === getDeviceId() ? " — this device" : ""}<small>Used {describeWhen(device.lastSeen)} · Verified {describeWhen(device.lastVerified)}</small></span><button type="button" className="btn small" onClick={() => { try { const deviceStore = parseStore("larsaStaffV8") as { users?: StaffUser[] } | null; if (deviceStore && Array.isArray(deviceStore.users) && user) { const seat = deviceStore.users.findIndex((row) => row.id === user.id); if (seat >= 0) { deviceStore.users[seat] = { ...deviceStore.users[seat], devices: withDeviceRemoved(deviceStore.users[seat].devices, device.id) }; localStorage.setItem("larsaStaffV8", JSON.stringify(deviceStore)); setMessage("Device removed. It will ask for an email code next time."); } } } catch { setMessage("Could not remove that device."); } }}>Remove</button></div>))}{!rows.length && <div className="empty compact">No verified devices yet.</div>}</div>); })()}
          </div>
          {pending && (
            <div className="guard-box">
              <label>Verification code<input inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={guardCode} onChange={(event) => setGuardCode(event.target.value.replace(/\s/g, ""))} placeholder="123456" autoFocus /></label>
              <div className="guard-actions">
                <button type="button" className="primary" disabled={guardBusy} onClick={confirmGuard}>{guardBusy ? "Checking…" : "Confirm change"}</button>
                <button type="button" onClick={() => { setPending(null); setGuardCode(""); setMessage(""); }}>Cancel</button>
              </div>
            </div>
          )}
          <p className="builder-note">
            Credentials are stored on this device with the rest of the application data. Treat exported backups as confidential.
          </p>
        </section>
      )}

      {tab === "notifications" && <NotifySettings user={user} openBell={openBell} />}

    </div>
  );
}

function AccountingHub({
  user, method, choose,
}: {
  user: StaffUser | null;
  method: SignInMethod | null;
  choose: (item: Item, channel?: NavChannel) => void;
}) {
  const groups = ACCOUNTING_TREE
    .map((group) => ({
      ...group,
      entries: group.items
        .map((id) => ITEMS.find((item) => item.id === id))
        .filter((item): item is Item => Boolean(item && canOpenInSession(user, item, method))),
    }))
    .filter((group) => group.entries.length);
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0);

  return (
    <div className="native-scroll accounting-scroll">
      <section className="overview-hero home-hero">
        <span className="home-hero-mark" aria-hidden="true" />
        <div>
          <span className="eyebrow">Finance</span>
          <h2>Accounting</h2>
          <p>Six areas, everything inside. Open a card to jump straight in, or pick a page underneath it.</p>
        </div>
        <span className="access-pill"><BadgeDollarSign size={16} /> {total} pages available</span>
      </section>

      <section className="module-grid accounting-grid" aria-label="Accounting areas">
        {groups.map((group) => {
          const Icon = ICONS[group.icon] || BadgeDollarSign;
          const lead = group.entries[0];
          return (
            <div className={`module-bubble ${group.tone} accounting-card`} key={group.id}>
              <span className="module-blob" aria-hidden="true" />
              <button type="button" className="accounting-card-open" onClick={() => lead && choose(lead, "accounting")}>
                <span className="module-orb"><Icon size={26} strokeWidth={2} /></span>
                <span className="module-copy"><b>{group.label}</b><small>{group.description}</small></span>
              </button>
              <div className="accounting-links">
                {group.entries.map((item) => (
                  <button type="button" key={item.id} onClick={() => choose(item, "accounting")}>
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!groups.length && <div className="empty">No accounting areas are enabled for this account.</div>}
      </section>
    </div>
  );
}

function WeekSchedule({
  viewer, users, store, go, saveSchedule, saveColours, saveShiftType, removeShiftType,
  autoBuild, canManageAll, canEditOwn,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  store: Record<string, unknown> | null;
  go: (id: string) => void;
  saveSchedule: (userId: string, day: string, entries: { start?: string; end?: string; code?: string; name?: string }[]) => boolean;
  saveColours: (colours: Record<string, string>) => boolean;
  saveShiftType: (draft: ShiftType, replacing?: string) => boolean;
  removeShiftType: (code: string) => boolean;
  autoBuild: (settings: BuildSettings) => boolean | Promise<boolean>;
  canManageAll: boolean;
  canEditOwn: boolean;
}) {
  // Rearranging the whole office needs Manage. Plain Edit only moves your own row.
  const canEdit = canManageAll || canEditOwn;
  const mayEditRow = (userId: string) => canManageAll || (canEditOwn && userId === viewer?.id);
  const [dragCode, setDragCode] = useState("");
  const dragRef = useRef("");
  const [hover, setHover] = useState("");
  const [team, setTeam] = useState("all");
  const [picker, setPicker] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [build, setBuild] = useState<BuildSettings>(DEFAULT_BUILD);
  const beginDrag = (code: string) => { dragRef.current = code; setDragCode(code); };
  const endDrag = () => { dragRef.current = ""; setDragCode(""); setHover(""); };

  const schedule = (store?.schedule || {}) as Record<string, Record<string, { start?: string; end?: string; code?: string; name?: string }[]>>;
  const colours = (store?.shiftColours || {}) as Record<string, string>;
  // Built-ins merged with whatever the office has added or corrected.
  const catalogue = useMemo(() => shiftCatalogue(store), [store]);
  const savedTypes = useMemo(
    () => (Array.isArray(store?.[SHIFT_TYPES_KEY]) ? store[SHIFT_TYPES_KEY] as ShiftType[] : []),
    [store],
  );
  /* Build Rules opens on the hours the office actually runs the meeting —
     the MON shift's own — and only shows something different once this panel
     has been used to change them. Reading it live rather than seeding a copy
     means the panel cannot drift from the catalogue behind it. */
  const savedMeetingHours = shiftTimesFor("MON", store);
  const meetingStart = build.teamMeetingStart || savedMeetingHours[0] || "16:00";
  const meetingEnd = build.teamMeetingEnd || savedMeetingHours[1] || "18:00";
  // "HH:MM" is zero-padded and 24-hour, so it compares correctly as text.
  const meetingHoursBackwards = Boolean(meetingStart && meetingEnd && meetingEnd <= meetingStart);
  const buildSettings: BuildSettings = { ...build, teamMeetingStart: meetingStart, teamMeetingEnd: meetingEnd };
  const [showTypes, setShowTypes] = useState(false);
  const [typeDraft, setTypeDraft] = useState<ShiftType>({
    code: "", label: "", start: "", end: "", time: "", tone: "office",
  });
  const [editingCode, setEditingCode] = useState("");
  const roster = users.filter((user) => user.enabled !== false);
  const today = WEEKDAY_NAMES[new Date().getDay()];
  const teams = [...new Set(roster.map((user) => user.department || "Unassigned"))].sort();

  const entriesFor = (userId: string, day: string) =>
    (Array.isArray(schedule[userId]?.[day]) ? schedule[userId][day] : []);

  // Everyone is listed. The signed-in person is pinned to the top so their own
  // week reads inside the same grid instead of a separate page.
  const filtered = roster.filter((user) => team === "all" || (user.department || "Unassigned") === team);
  const rows = viewer
    ? [...filtered.filter((user) => user.id === viewer.id), ...filtered.filter((user) => user.id !== viewer.id)]
    : filtered;

  const drop = (userId: string, day: string) => {
    const code = dragRef.current || dragCode;
    setHover("");
    if (!mayEditRow(userId) || !code) return;
    const meta = catalogue[code];
    const times = shiftTimesFor(code, store);
    const current = entriesFor(userId, day);
    if (code === "OFF") { saveSchedule(userId, day, []); endDrag(); return; }
    if (current.some((entry) => String(entry.code || "").toUpperCase() === code)) { endDrag(); return; }
    saveSchedule(userId, day, [...current, { code, name: meta?.label || code, start: times[0], end: times[1] }]);
    endDrag();
  };
  const removeShift = (userId: string, day: string, index: number) => {
    if (!mayEditRow(userId)) return;
    saveSchedule(userId, day, entriesFor(userId, day).filter((_, i) => i !== index));
  };
  // Clicking a day and choosing a code is the keyboard and touch friendly path.
  const setShift = (userId: string, day: string, code: string) => {
    if (!mayEditRow(userId)) return;
    if (code === "OFF") { saveSchedule(userId, day, []); return; }
    const current = entriesFor(userId, day);
    if (current.some((entry) => String(entry.code || "").toUpperCase() === code)) {
      saveSchedule(userId, day, current.filter((entry) => String(entry.code || "").toUpperCase() !== code));
      return;
    }
    const times = shiftTimesFor(code, store);
    saveSchedule(userId, day, [...current, {
      code, name: catalogue[code]?.label || code, start: times[0], end: times[1],
    }]);
  };

  const chip = (entry: { start?: string; end?: string; code?: string; name?: string }, key: number, onRemove?: () => void) => {
    const code = String(entry.code || entry.name || "").toUpperCase();
    const meta = catalogue[code];
    const background = shiftColour(code, colours);
    return (
      <span className="shift-chip custom" key={key} style={{ background, color: readableInk(background) }}
        title={meta ? `${meta.label} · ${meta.time}` : entry.name || code}>
        <b>{code || "Shift"}</b>
        <em>{entry.start && entry.end ? `${entry.start}–${entry.end}` : meta?.time || ""}</em>
        {onRemove && <button type="button" onClick={onRemove} aria-label={`Remove ${code}`}>×</button>}
      </span>
    );
  };

  // my own week, summarised above the shared grid
  const myDays = OFFICE_WEEK.map((day) => {
    const entries = viewer ? entriesFor(viewer.id, day) : [];
    return { day, entries, hours: shiftHours(entries) };
  });
  const myHours = myDays.reduce((sum, row) => sum + row.hours, 0);
  const myDaysIn = myDays.filter((row) => row.entries.length).length;
  const nextShift = myDays.find((row) => row.entries.length && OFFICE_WEEK.indexOf(row.day) >= OFFICE_WEEK.indexOf(today));

  const coverage = OFFICE_WEEK.map((day) => {
    const people = roster.filter((user) => entriesFor(user.id, day).length);
    return { day, count: people.length, names: people.map((user) => user.name) };
  });
  const peak = Math.max(1, ...coverage.map((row) => row.count));
  const todayIn = coverage.find((row) => row.day === today);

  return (
    <div className="native-scroll schedule-scroll">
      <section className="overview-hero home-hero">
        <span className="home-hero-mark" aria-hidden="true" />
        <div>
          <span className="eyebrow">Attendance planning</span>
          <h2>Weekly Schedule</h2>
          <p>Everyone&rsquo;s week in one grid so the team can see who is available. Your own days are pinned at the top.</p>
        </div>
        <div className="hero-actions">
          {canManageAll && <button type="button" onClick={() => setShowSettings((value) => !value)}><SlidersHorizontal size={16} /> Build Rules</button>}
          {canManageAll && <button type="button" onClick={() => autoBuild(buildSettings)}><Sparkles size={16} /> Auto Build</button>}
          <button type="button" onClick={() => go("quick-clock")}>Clock In / Out</button>
        </div>
      </section>

      <section className="schedule-summary">
        <article className="home-stat">
          <span><CalendarDays size={18} /></span>
          <div><small>Your week</small><b>{formatHours(myHours)} · {myDaysIn} day{myDaysIn === 1 ? "" : "s"}</b>
            <p>{nextShift ? `Next: ${nextShift.day} ${nextShift.entries[0]?.start || ""}` : "No upcoming shift"}</p></div>
        </article>
        <article className="home-stat">
          <span><UsersRound size={18} /></span>
          <div><small>In today</small><b>{todayIn?.count || 0} of {roster.length}</b>
            <p>{today}</p></div>
        </article>
        <article className="home-stat">
          <span><Radio size={18} /></span>
          <div><small>Office roster</small><b>{roster.length} people</b>
            <p>{teams.length} teams</p></div>
        </article>
        <article className="home-stat">
          <span><Target size={18} /></span>
          <div><small>Quietest day</small>
            <b>{[...coverage].sort((a, b) => a.count - b.count)[0]?.day || "—"}</b>
            <p>{[...coverage].sort((a, b) => a.count - b.count)[0]?.count || 0} people in</p></div>
        </article>
      </section>

      {showSettings && canManageAll && (
        <section className="build-rules">
          <div className="section-head">
            <div><span className="eyebrow">Auto build</span><h3>Rules and targets</h3></div>
            <button type="button" className="icon-button" onClick={() => setShowSettings(false)} aria-label="Close"><X size={17} /></button>
          </div>
          <div className="rules-grid">
            <label>Office days per person
              <input type="number" min="0" max="7" value={build.officeDaysPerPerson}
                onChange={(event) => setBuild({ ...build, officeDaysPerPerson: Math.max(0, Math.min(7, finiteNumber(event.target.value))) })} /></label>
            <label>Target people in office
              <input type="number" min="1" max="30" value={build.targetInOffice}
                onChange={(event) => setBuild({ ...build, targetInOffice: Math.max(1, finiteNumber(event.target.value)) })} /></label>
            <label>Minimum acceptable
              <input type="number" min="1" max="30" value={build.minInOffice}
                onChange={(event) => setBuild({ ...build, minInOffice: Math.max(1, finiteNumber(event.target.value)) })} /></label>
            <label>Office hours target / week
              <input type="number" min="0" value={build.officeHoursTarget}
                onChange={(event) => setBuild({ ...build, officeHoursTarget: Math.max(0, finiteNumber(event.target.value)) })} /></label>
            <label>Online hours target / week
              <input type="number" min="0" value={build.onlineHoursTarget}
                onChange={(event) => setBuild({ ...build, onlineHoursTarget: Math.max(0, finiteNumber(event.target.value)) })} /></label>
            <label className="rule-check">
              <input type="checkbox" checked={build.respectConstraints}
                onChange={(event) => setBuild({ ...build, respectConstraints: event.target.checked })} />
              <span><b>Respect employee constraints</b><small>Keep government duty, site work, and recorded rest days</small></span></label>
            <label className="rule-check">
              <input type="checkbox" checked={Boolean(build.teamMeetingDay)}
                onChange={(event) => setBuild({ ...build, teamMeetingDay: event.target.checked ? (build.teamMeetingDay || "Monday") : "" })} />
              <span><b>Team meeting for everyone</b><small>{build.teamMeetingDay
                ? `Mandatory for everyone on ${build.teamMeetingDay}, ${meetingStart} to ${meetingEnd}`
                : "A mandatory meeting on the day and time you choose"}</small></span></label>
            {build.teamMeetingDay && (
              <>
                <label>Meeting day
                  <select value={build.teamMeetingDay} onChange={(event) => setBuild({ ...build, teamMeetingDay: event.target.value })}>
                    {OFFICE_WEEK.map((day) => <option key={day} value={day}>{day}</option>)}
                  </select>
                </label>
                <label>Meeting starts
                  <input type="time" value={meetingStart}
                    onChange={(event) => setBuild({ ...build, teamMeetingStart: event.target.value })} />
                </label>
                <label>Meeting ends
                  <input type="time" value={meetingEnd}
                    onChange={(event) => setBuild({ ...build, teamMeetingEnd: event.target.value })} />
                </label>
              </>
            )}
          </div>
          {build.teamMeetingDay && meetingHoursBackwards && (
            <p className="builder-note">The meeting ends before it starts. Set an end time later than {meetingStart}.</p>
          )}
          <div className="form-actions">
            <button type="button" onClick={() => setBuild(DEFAULT_BUILD)}>Reset</button>
            <button type="button" className="primary" disabled={meetingHoursBackwards}
              onClick={() => { autoBuild(buildSettings); setShowSettings(false); }}>
              <Sparkles size={15} /> Build with these rules
            </button>
          </div>
        </section>
      )}

      <section className="filter-toolbar">
        <label><span>Team</span>
          <select value={team} onChange={(event) => setTeam(event.target.value)}>
            <option value="all">All teams</option>
            {teams.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <span className="filter-summary">{rows.length} people · {today} highlighted</span>
      </section>

      <section className="report-panel">
        <div className="section-head">
          <div><span className="eyebrow">Whole office</span><h3>Saturday to Thursday</h3></div>
          <span className="black-badge">
            {canManageAll ? "Drag shifts from the builder below"
              : canEditOwn ? "You can change your own row" : "Read only"}
          </span>
        </div>
        <div className="data-table-wrap">
          <table className="data-table schedule-table">
            <thead><tr><th>Employee</th>{OFFICE_WEEK.map((day) => (
              <th key={day} className={day === today ? "is-today" : ""}>{day.slice(0, 3)}</th>
            ))}<th>Hours</th></tr></thead>
            <tbody>
              {rows.map((user) => {
                const mine = user.id === viewer?.id;
                const total = OFFICE_WEEK.reduce((sum, day) => sum + shiftHours(entriesFor(user.id, day)), 0);
                return (
                  <tr key={user.id} className={mine ? "is-me" : ""}>
                    <td><b>{mine ? `${user.name} (you)` : user.name}</b><small>{user.department || user.role || ""}</small></td>
                    {OFFICE_WEEK.map((day) => {
                      const cellKey = `${user.id}|${day}`;
                      const entries = entriesFor(user.id, day);
                      const editable = mayEditRow(user.id);
                      return (
                        <td key={day}
                          className={[day === today ? "is-today" : "", editable ? "droppable" : "", hover === cellKey ? "drag-over" : ""].filter(Boolean).join(" ")}
                          onDragOver={(event) => {
                            if (!editable || !(dragRef.current || dragCode)) return;
                            event.preventDefault(); setHover(cellKey);
                          }}
                          onDragLeave={() => setHover((value) => (value === cellKey ? "" : value))}
                          onDrop={(event) => { event.preventDefault(); drop(user.id, day); }}
                          onClick={() => { if (editable) setPicker((value) => (value === cellKey ? "" : cellKey)); }}
                        >
                          {entries.length
                            ? entries.map((entry, index) => chip(entry, index, editable ? () => removeShift(user.id, day, index) : undefined))
                            : <span className="shift-chip tone-none"><b>OFF</b><em>—</em></span>}
                          {picker === cellKey && editable && (
                            <div className="cell-picker" role="menu" onClick={(event) => event.stopPropagation()}>
                              <div className="cell-picker-head">
                                <b>{user.name.split(/\s+/)[0]} · {day.slice(0, 3)}</b>
                                <button type="button" onClick={() => setPicker("")} aria-label="Close"><X size={14} /></button>
                              </div>
                              <div className="cell-picker-list">
                                {Object.entries(catalogue).map(([code, meta]) => {
                                  const background = shiftColour(code, colours);
                                  const active = entries.some((entry) => String(entry.code || "").toUpperCase() === code);
                                  return (
                                    <button
                                      type="button"
                                      key={code}
                                      className={active ? "active" : ""}
                                      onClick={() => { setShift(user.id, day, code); setPicker(""); }}
                                    >
                                      <i style={{ background }} />
                                      <span><b>{code}</b><small>{meta.label} · {meta.time}</small></span>
                                    </button>
                                  );
                                })}
                              </div>
                              <button type="button" className="cell-picker-clear" onClick={() => { saveSchedule(user.id, day, []); setPicker(""); }}>
                                Clear this day
                              </button>
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="hours-cell"><b>{total.toFixed(1)}</b></td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={OFFICE_WEEK.length + 2}><div className="empty compact">No one is listed for this team.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {canEdit && (
        <section className="shift-builder">
          <div className="section-head">
            <div><span className="eyebrow">Shift builder</span>
              <h3>{canManageAll ? "Drag a shift onto any day above" : "Drag a shift onto your own row above"}</h3></div>
            <div className="builder-head-actions">
              {canManageAll && (
                <button type="button" onClick={() => {
                  setShowTypes((open) => !open);
                  setEditingCode("");
                  setTypeDraft({ code: "", label: "", start: "", end: "", time: "", tone: "office" });
                }}><SlidersHorizontal size={15} /> {showTypes ? "Close shift types" : "New / edit shifts"}</button>
              )}
              {canManageAll && <button type="button" onClick={() => autoBuild(build)}><Sparkles size={15} /> Auto Build Week</button>}
            </div>
          </div>

          {canManageAll && showTypes && (
            <div className="type-editor">
              <div className="type-form">
                <label><span>Code</span>
                  <input value={typeDraft.code} maxLength={6} placeholder="NIGHT"
                    onChange={(event) => setTypeDraft({ ...typeDraft, code: event.target.value.toUpperCase() })} />
                </label>
                <label><span>Name</span>
                  <input value={typeDraft.label} maxLength={40} placeholder="Night shift"
                    onChange={(event) => setTypeDraft({ ...typeDraft, label: event.target.value })} />
                </label>
                <label><span>Starts</span>
                  <input type="time" value={typeDraft.start}
                    onChange={(event) => setTypeDraft({ ...typeDraft, start: event.target.value })} />
                </label>
                <label><span>Ends</span>
                  <input type="time" value={typeDraft.end}
                    onChange={(event) => setTypeDraft({ ...typeDraft, end: event.target.value })} />
                </label>
                <label><span>Counts as</span>
                  <select value={typeDraft.tone}
                    onChange={(event) => setTypeDraft({ ...typeDraft, tone: event.target.value as ShiftMeta["tone"] })}>
                    <option value="office">Office</option>
                    <option value="online">Online</option>
                    <option value="site">Site</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <div className="type-form-actions">
                  {editingCode && (
                    <button type="button" onClick={() => {
                      setEditingCode("");
                      setTypeDraft({ code: "", label: "", start: "", end: "", time: "", tone: "office" });
                    }}>Cancel</button>
                  )}
                  <button type="button" className="primary" onClick={() => {
                    if (saveShiftType(typeDraft, editingCode)) {
                      setEditingCode("");
                      setTypeDraft({ code: "", label: "", start: "", end: "", time: "", tone: "office" });
                    }
                  }}><Save size={15} /> {editingCode ? "Save changes" : "Add shift"}</button>
                </div>
              </div>
              <div className="type-list">
                {Object.entries(catalogue).map(([code, meta]) => {
                  const saved = savedTypes.find((row) => String(row.code).toUpperCase() === code);
                  const builtIn = Boolean(SHIFT_CODES[code]);
                  return (
                    <div className={editingCode === code ? "type-row editing" : "type-row"} key={code}>
                      <i style={{ background: shiftColour(code, colours) }} aria-hidden="true" />
                      <span><b>{code}</b><small>{meta.label} · {meta.time}</small></span>
                      {saved && builtIn && <em>edited</em>}
                      {saved && !builtIn && <em>added</em>}
                      <button type="button" onClick={() => {
                        const times = shiftTimesFor(code, store);
                        setEditingCode(code);
                        setTypeDraft({
                          code, label: meta.label, start: times[0], end: times[1],
                          time: meta.time, tone: meta.tone,
                        });
                      }}><Pencil size={13} /> Edit</button>
                      {saved && (
                        <button type="button" className="danger" onClick={() => removeShiftType(code)}>
                          {builtIn ? "Reset" : "Delete"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="builder-note">
                A code already on the roster cannot be deleted — clear it from the week first.
                Editing a built-in shift only overrides its hours, so past schedules still read correctly.
              </p>
            </div>
          )}
          <div className="builder-palette">
            {Object.entries(catalogue).map(([code, meta]) => {
              const background = shiftColour(code, colours);
              return (
                <div className="builder-shift" key={code}>
                  <span className="shift-chip custom draggable" draggable
                    onDragStart={(event) => {
                      beginDrag(code);
                      try { event.dataTransfer?.setData("text/plain", code); } catch { /* not all engines expose it */ }
                    }}
                    onDragEnd={endDrag}
                    style={{ background, color: readableInk(background) }}>
                    <b>{code}</b><em>{meta.time}</em>
                  </span>
                  <label title={`Colour for ${meta.label}`}>
                    <input type="color" value={background}
                      onChange={(event) => saveColours({ ...colours, [code]: event.target.value })}
                      aria-label={`Colour for ${code}`} />
                  </label>
                  <small>{meta.label}</small>
                </div>
              );
            })}
          </div>
          <p className="builder-note">
            Drag a shift onto a cell to assign it. Drag <b>OFF</b> onto a cell to clear the day, or use the × on a shift.
            {canManageAll
              ? ` Every colour is yours to set and is used across the clock, schedule, and reports. Auto Build fills the week to the Larsa coverage rule${build.teamMeetingDay ? ` and keeps the team meeting for everyone on ${build.teamMeetingDay} at ${meetingStart}` : ""}.`
              : " You can adjust your own row. Rearranging other people needs the Manage permission on Weekly Schedule."}
          </p>
        </section>
      )}

      <section className="schedule-lower">
        <article className="report-panel">
          <div className="section-head"><div><span className="eyebrow">Coverage</span><h3>People in per day</h3></div></div>
          <div className="coverage-bars">
            {coverage.map((row) => (
              <div className={row.day === today ? "coverage-day is-today" : "coverage-day"} key={row.day} title={row.names.join(", ")}>
                <span style={{ height: `${Math.max(6, (row.count / peak) * 100)}%`, background: row.count < 5 ? "#b4341f" : undefined }} />
                <b>{row.count}</b><small>{row.day.slice(0, 3)}</small>
              </div>
            ))}
          </div>
          <p className="builder-note">Target is 6 to 7 people in the office, 5 at quiet times. Days under 5 are marked red.</p>
        </article>
        <article className="report-panel">
          <div className="section-head"><div><span className="eyebrow">Reference</span><h3>Shift codes</h3></div></div>
          <div className="code-legend">
            {Object.entries(catalogue).map(([code, meta]) => {
              const background = shiftColour(code, colours);
              return (
                <div className="code-row" key={code}>
                  <span className="shift-chip custom" style={{ background, color: readableInk(background) }}><b>{code}</b></span>
                  <div><b>{meta.label}</b><small>{meta.time}</small></div>
                </div>
              );
            })}
          </div>
        </article>
      </section>
    </div>
  );
}

function QuickClock({
  user, sessions, summary, punch, go, method, week, development, store,
  punchBreak, submitCorrection, users, trimSession, resetSession,
}: {
  user: StaffUser | null;
  sessions: ClockSession[];
  summary: HomeSummary;
  punch: (mode: string, note?: string) => boolean;
  punchBreak: (note?: string) => boolean;
  submitCorrection: (draft: {
    kind: "Missed Clock" | "Missed Break" | "Extra Hours";
    date: string; from: string; to: string; reason: string; mode: string;
  }) => boolean;
  users: StaffUser[];
  trimSession: (uid: string, clockIn: string, newClockOut: string) => boolean;
  resetSession: (uid: string, clockIn: string) => boolean;
  go: (id: string) => void;
  method: SignInMethod | null;
  week: { day: string; codes: string[]; entries: { start?: string; end?: string; code?: string; name?: string }[] }[];
  development: DevelopmentRecord[];
  store: Record<string, unknown> | null;
}) {
  const dialog = useDialog();
  // Shares the schedule's catalogue so an edited shift reads the same here.
  const catalogue = useMemo(() => shiftCatalogue(store), [store]);
  // Same hand-picked shift colours the schedule grid honours.
  const shiftInks = (store?.shiftColours || {}) as Record<string, string>;
  const [mode, setMode] = useState("Office");
  const [note, setNote] = useState("");
  const [showCorrection, setShowCorrection] = useState(false);
  const [correction, setCorrection] = useState({
    kind: "Missed Clock" as "Missed Clock" | "Missed Break" | "Extra Hours",
    date: dateInputValue(new Date()), from: "09:00", to: "17:00", reason: "", mode: "Office",
  });
  const [showTrim, setShowTrim] = useState(false);
  const [trimming, setTrimming] = useState<{ uid: string; clockIn: string } | null>(null);
  const [trimValue, setTrimValue] = useState("");
  /* datetime-local reads local wall time with no zone, so the stored ISO stamp
     has to be shifted by the offset or the field shows the wrong hour. */
  const toLocalInput = (iso: string) => {
    const at = new Date(iso);
    return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  // Break state is read from the same log stream, so it survives a reload and
  // is identical whichever device the person is on.
  const logs = useMemo(() => {
    const raw = store?.logs;
    return Array.isArray(raw) ? raw as ClockLog[] : [];
  }, [store]);
  const onBreak = useMemo(() => {
    if (!user) return null;
    const last = logs
      .filter((log) => log.uid === user.id && (log.status === "Break Start" || log.status === "Break End"))
      .sort((left, right) => new Date(right.time || 0).getTime() - new Date(left.time || 0).getTime())[0];
    return last?.status === "Break Start" ? last : null;
  }, [logs, user]);

  const mayAdjustHours = Boolean(user && (() => {
    const item = ITEMS.find((row) => row.id === "staff-clock");
    return item ? hasItemPermission(user, item, "manage") : false;
  })());
  /* Who may trim OTHER people: clock managers (staff-clock "manage" — a
     Super Admin) and Admin accounts. Their reach is their data scope —
     everyone for a Super Admin or a company-scoped Admin, narrower where a
     Super Admin has narrowed it — and the handler in Home() enforces the
     same wall, so this flag only decides what the panel offers. Removal
     (Reset) stays with the manage capability alone. */
  const mayTrimOthers = mayAdjustHours || Boolean(user && user.access === "Admin");
  /* Everyone who can use the clock may trim their OWN sessions — the trim
     path only ever shortens (see trimSession), so self-service cannot
     inflate hours. Managers keep the team-wide panel; removal stays theirs. */
  const maySelfTrim = Boolean(!mayTrimOthers && user && (() => {
    const item = ITEMS.find((row) => row.id === "staff-clock");
    return item ? hasItemPermission(user, item, "edit") || hasItemPermission(user, item, "add") : false;
  })());
  /* Whose sessions the trim panel may LIST for this viewer: exactly the
     people the handler would accept — themselves for everyone, plus their
     data scope for a manager or an Admin. Nobody browses records the rules
     would refuse to change; two colleagues never see each other's sessions
     here. */
  const trimScope = useMemo(
    () => (user && mayTrimOthers ? scopedUsers(user, users) : []),
    [user, users, mayTrimOthers],
  );
  const trimScopeIds = useMemo(() => new Set(trimScope.map((row) => row.id)), [trimScope]);
  /* The manager flow the correction spec asks for: pick the employee, then
     pick that person's exact session. "" lists the scope's recent sessions
     so a forgotten clock-out still jumps out at a glance. */
  const [trimUser, setTrimUser] = useState("");
  const [trimShown, setTrimShown] = useState(12);
  /* Every session stays reachable, not just the recent window: pick a month
     (or any range of days) and EVERY session in it is laid out to choose
     from — the way an old record is actually found: by when it happened.
     "Recent" keeps the compact newest-first window; a period lists all of
     its sessions with no cap, because a cap inside a chosen period is
     exactly the "which twelve?" guessing the correction rules forbid. */
  const [trimPreset, setTrimPreset] = useState<"recent" | "this-month" | "last-month" | "all" | "custom">("recent");
  const [trimFrom, setTrimFrom] = useState("");
  const [trimTo, setTrimTo] = useState("");
  const pickTrimPreset = (preset: "recent" | "this-month" | "last-month" | "all") => {
    setTrimPreset(preset);
    setTrimming(null);
    setTrimShown(12);
    if (preset === "this-month") {
      setTrimFrom(`${currentMonthKey()}-01`);
      setTrimTo(dateInputValue(new Date()));
    } else if (preset === "last-month") {
      const now = new Date();
      const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      setTrimFrom(dateInputValue(previous));
      setTrimTo(monthEnd(currentMonthKey(previous)));
    } else {
      // "recent" and "all" carry no date bounds; they differ only in the cap.
      setTrimFrom("");
      setTrimTo("");
    }
  };
  /* One row per SESSION. The session builder splits a midnight-crossing
     session into per-day segments for the reports; the trim panel corrects
     PUNCHES, so those segments fold back into the one record they came
     from (same uid + clockIn identity trim and reset key on), worked hours
     summed across its days. */
  const trimRows = useMemo(() => {
    const visible = mayTrimOthers
      ? sessions.filter((session) => {
        /* Even the people who can trim the whole team live in their OWN
           record first: the panel opens on "My sessions", and the team is
           an explicit choice — a mixed team-wide list is where the wrong
           row gets picked. "__team__" is the deliberate everyone view; a
           Super Admin's everyone additionally includes sessions whose
           account has since been removed, because attendance history
           outlives accounts here and those records still need closing. */
        if (trimUser === "") return session.uid === user?.id;
        if (trimUser === "__team__") return (user ? isAdmin(user) : false) || trimScopeIds.has(session.uid);
        return session.uid === trimUser;
      })
      : sessions.filter((session) => session.uid === user?.id);
    const folded = new Map<string, ClockSession & { spanDays: number }>();
    visible.forEach((session) => {
      const key = `${session.uid}|${session.clockIn}`;
      const kept = folded.get(key);
      if (!kept) {
        folded.set(key, { ...session, spanDays: 1 });
        return;
      }
      kept.spanDays += 1;
      kept.hours += session.hours;
      kept.presenceHours += session.presenceHours;
      kept.breakHours += session.breakHours;
      kept.open = kept.open || session.open;
      kept.adjusted = kept.adjusted || session.adjusted;
      kept.stale = kept.stale || session.stale;
      kept.unclosed = kept.unclosed || session.unclosed;
      if (session.date < kept.date) kept.date = session.date;
    });
    return [...folded.values()]
      /* A session belongs to the day it started; a chosen period keeps every
         session whose clock-in day falls inside it. */
      .filter((session) => (!trimFrom || session.date >= trimFrom) && (!trimTo || session.date <= trimTo))
      .sort((left, right) => new Date(right.clockIn).getTime() - new Date(left.clockIn).getTime());
  }, [sessions, mayTrimOthers, trimUser, trimScopeIds, user, trimFrom, trimTo]);
  /* Only the "Recent" window is capped; a chosen period shows everything. */
  const visibleTrimRows = trimPreset === "recent" ? trimRows.slice(0, trimShown) : trimRows;
  const [now, setNow] = useState<Date | null>(null);
  const [period, setPeriod] = useState("week");
  const monthStart = new Date(); monthStart.setDate(1);
  const [from, setFrom] = useState(dateInputValue(monthStart));
  const [to, setTo] = useState(dateInputValue(new Date()));
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const open = summary.openClock;
  const mine = sessions.filter((session) => session.uid === user?.id);
  const todayKey = dateInputValue(new Date());
  const todaySessions = mine.filter((session) => session.date === todayKey);
  const todayHours = todaySessions.reduce((sum, session) => sum + session.hours, 0);
  const todayPresence = todaySessions.reduce((sum, session) => sum + session.presenceHours, 0);
  const todayBreak = todaySessions.reduce((sum, session) => sum + session.breakHours, 0);
  const weekHours = mine
    .filter((session) => isoWeekLabel(new Date(`${session.date}T12:00:00`)) === isoWeekLabel())
    .reduce((sum, session) => sum + session.hours, 0);
  const elapsed = open && now
    ? Math.max(0, now.getTime() - new Date(open.clockIn).getTime())
    : 0;
  const pad = (value: number) => String(Math.floor(value)).padStart(2, "0");
  const timer = `${pad(elapsed / 3600000)}:${pad((elapsed % 3600000) / 60000)}:${pad((elapsed % 60000) / 1000)}`;
  const recent = mine.slice(-6).reverse();

  // Hours split by where the work happened, over the chosen period.
  const breakdown = (() => {
    const today = dateInputValue(new Date());
    const inPeriod = mine.filter((session) => {
      const date = session.date;
      if (period === "week") return isoWeekLabel(new Date(`${session.date}T12:00:00`)) === isoWeekLabel();
      if (period === "month") return date.slice(0, 7) === today.slice(0, 7);
      return withinDates(date, from, to);
    });
    const bucket = { office: 0, online: 0, site: 0, other: 0 };
    inPeriod.forEach((session) => { bucket[modeTone(session.mode)] += session.hours; });
    return {
      ...bucket,
      total: inPeriod.reduce((sum, session) => sum + session.hours, 0),
      count: inPeriod.length,
      days: new Set(inPeriod.map((session) => session.date)).size,
    };
  })();

  return (
    <div className="native-scroll clock-scroll">
      <section className="overview-hero home-hero clock-hero">
        <span className="home-hero-mark" aria-hidden="true" />
        <div>
          <span className="eyebrow">{greeting()}</span>
          <h2>{user?.name?.split(/\s+/)[0] || "Welcome"}</h2>
          <p>{open
            ? `Clocked in since ${new Date(open.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${open.mode}`
            : "You are not clocked in. Choose where you are working, then tap the button."}</p>
        </div>
        <span className={open ? `access-pill live tone-${modeTone(open.mode)}` : "access-pill"}>
          <Radio size={16} /> {open ? `On the clock · ${open.mode}` : "Off the clock"}
        </span>
      </section>

      <section className="clock-face">
        <div className="clock-readout compact">
          <small>{open ? "Time on shift" : "Current time"}</small>
          <b>{open ? timer : now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--"}</b>
          <em>{now ? now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) : ""}</em>
        </div>
        <div className="clock-modes" role="group" aria-label="Where are you working">
          {WORK_MODES.map((item) => (
            <button
              type="button"
              key={item.id}
              className={`mode-${item.tone}${mode === item.id ? " active" : ""}`}
              onClick={() => setMode(item.id)}
              disabled={Boolean(open)}
            ><i aria-hidden="true" />{item.label}</button>
          ))}
        </div>
        <label className="clock-note">
          <span>Note <em>(optional)</em></span>
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Running late, leaving early, working from a job site…"
          />
        </label>
        <button
          type="button"
          className={`clock-punch ${open ? "out" : `in tone-${modeTone(mode)}`}`}
          onClick={() => { if (punch(open ? open.mode : mode, note)) setNote(""); }}
        >
          <Timer size={22} />
          {open ? "Clock Out" : "Clock In"}
        </button>
        <div className="clock-totals">
          <div><small>Today worked</small><b>{formatHours(todayHours)}</b></div>
          <div><small>Today in office</small><b>{formatHours(todayPresence)}</b></div>
          <div><small>This week worked</small><b>{formatHours(weekHours)}</b></div>
          <div><small>Sessions</small><b>{mine.length}</b></div>
        </div>
        {todayBreak > 0 && (
          <p className="clock-break-note">
            {formatHours(todayBreak)} of break deducted today. In-office time counts it, worked hours do not.
          </p>
        )}
      </section>

      {/* Breaks belong inside a shift, so the option only appears once the
          person is actually clocked in. An open break still shows its End
          button even if the shift somehow closed, so nobody gets stuck. */}
      {onBreak ? (
        <section className="break-banner on">
          <span>
            <Coffee size={16} /> On break since{" "}
            {new Date(onBreak.time || "").toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            {onBreak.note ? ` · ${onBreak.note}` : ""}
          </span>
          <button type="button" onClick={() => { if (punchBreak(note)) setNote(""); }}>End Break</button>
        </section>
      ) : open ? (
        <section className="break-banner">
          <span><Coffee size={16} /> Taking lunch or a coffee break?</span>
          <button type="button" onClick={() => { if (punchBreak(note)) setNote(""); }}>Start Break</button>
        </section>
      ) : null}

      <section className="correction-block">
        {!showCorrection && (
          <button type="button" className="correction-open" onClick={() => setShowCorrection(true)}>
            <ClipboardCheck size={18} />
            <span>
              <b>Add or fix past hours</b>
              <small>Forgot to clock in yesterday, missed a break, or worked hours the clock never caught</small>
            </span>
          </button>
        )}

        {/* Sits beside the request button on purpose: same place, opposite
            rule. Adding time needs approval; taking it away does not, because
            nobody can inflate their own attendance by removing hours. */}
        {(mayTrimOthers || maySelfTrim) && !showCorrection && (
          <button type="button" className="correction-open trim-open" onClick={() => setShowTrim((open) => !open)}>
            <Scissors size={18} />
            <span>
              <b>{mayAdjustHours ? "Trim or remove recorded hours" : mayTrimOthers ? "Trim recorded hours" : "Trim your recorded hours"}</b>
              <small>{mayAdjustHours
                ? "Close a forgotten clock-out or delete a session — applies straight away, no approval"
                : mayTrimOthers
                  ? "Close a forgotten clock-out or shorten a session for anyone you manage — applies straight away, and only ever shorter"
                  : "Close a forgotten clock-out or shorten a session — applies straight away, your own records only, and only ever shorter"}</small>
            </span>
          </button>
        )}

        {(mayTrimOthers || maySelfTrim) && showTrim && !showCorrection && (
          <div className="report-panel trim-panel">
            <div className="section-head">
              <div><span className="eyebrow">{mayTrimOthers ? "Direct change · no approval" : "Your sessions · only ever shorter"}</span><h3>{mayTrimOthers ? "Clock sessions" : "Your recent sessions"}</h3></div>
              <button type="button" className="btn small" onClick={() => { setShowTrim(false); setTrimming(null); }}>Close</button>
            </div>
            {/* The flow the correction rules ask managers to follow: choose
                the employee first, then the exact session — never guess a
                record from a mixed team-wide list. */}
            {mayTrimOthers && (
              <label className="trim-employee">
                Employee
                <select
                  value={trimUser}
                  onChange={(event) => { setTrimUser(event.target.value); setTrimming(null); setTrimShown(12); }}
                  aria-label="Whose sessions to show"
                >
                  <option value="">My sessions</option>
                  <option value="__team__">{isAdmin(user!) ? "Everyone — team view" : "People I manage — team view"}</option>
                  {trimScope.filter((row) => row.id !== user?.id).map((row) => (
                    <option key={row.id} value={row.id}>{row.name}</option>
                  ))}
                </select>
              </label>
            )}
            {/* Which sessions to lay out: the compact recent window, a whole
                month, all history, or any range of days — so the exact old
                session can be found by when it happened, then picked. */}
            <div className="trim-range" role="group" aria-label="Which sessions to show">
              {([["recent", "Recent"], ["this-month", "This month"], ["last-month", "Last month"], ["all", "All history"]] as const).map(([id, label]) => (
                <button key={id} type="button" className={trimPreset === id ? "on" : ""} onClick={() => pickTrimPreset(id)}>{label}</button>
              ))}
              <label>From<input type="date" value={trimFrom} max={dateInputValue(new Date())} onChange={(event) => { setTrimFrom(event.target.value); setTrimPreset("custom"); setTrimming(null); }} aria-label="Show sessions from" /></label>
              <label>To<input type="date" value={trimTo} max={dateInputValue(new Date())} onChange={(event) => { setTrimTo(event.target.value); setTrimPreset("custom"); setTrimming(null); }} aria-label="Show sessions up to" /></label>
            </div>
            {!trimRows.length && (
              <div className="empty compact">
                {trimFrom || trimTo ? "No sessions in this period." : "No sessions recorded yet."}
              </div>
            )}
            {(trimFrom || trimTo) && trimRows.length > 0 && (
              <p className="trim-range-note">
                {trimRows.length} session{trimRows.length === 1 ? "" : "s"}
                {trimFrom ? ` from ${new Date(`${trimFrom}T12:00:00`).toLocaleDateString()}` : ""}
                {trimTo ? ` to ${new Date(`${trimTo}T12:00:00`).toLocaleDateString()}` : ""}
                {" · "}{formatHours(trimRows.reduce((sum, row) => sum + row.hours, 0))} worked — all shown, pick any to trim.
              </p>
            )}
            {(() => {
              /* Sessions read best the way people remember them: day by day.
                 Every row sits under its calendar day, and the day carries
                 its own summary — how many sessions, how many hours — so a
                 chosen month scans like a timesheet, not a jumble of rows. */
              const days: { date: string; rows: typeof visibleTrimRows }[] = [];
              visibleTrimRows.forEach((session) => {
                const last = days[days.length - 1];
                if (last && last.date === session.date) last.rows.push(session);
                else days.push({ date: session.date, rows: [session] });
              });
              return days.map((day) => (
                <div className="trim-day" key={day.date}>
                  <div className="trim-day-head">
                    <b>{new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</b>
                    <small>
                      {day.rows.length} session{day.rows.length === 1 ? "" : "s"} · {formatHours(day.rows.reduce((sum, row) => sum + row.hours, 0))} worked
                    </small>
                  </div>
                  {day.rows.map((session) => {
              const active = trimming && trimming.uid === session.uid && trimming.clockIn === session.clockIn;
              const liveOpen = session.open && !session.stale && !session.unclosed;
              return (
                <div className="trim-row" key={`${session.uid}-${session.clockIn}`}>
                  <div className="trim-who">
                    {/* In the deliberate team view every row is named; a
                        single person's list (mine, or a picked employee) is
                        already named by the picker, so rows stay clean. */}
                    {trimUser === "__team__" && <b>{session.employee}</b>}
                    <small>
                      {new Date(session.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {" – "}
                      {liveOpen
                        ? "clocked in — active session"
                        : session.open || session.stale || session.unclosed
                          ? "no clock-out"
                          : new Date(session.clockOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {session.spanDays > 1 ? ` (${session.spanDays} days)` : ""}
                      {" · "}{session.stale || session.unclosed
                        ? `open ${formatHours(session.openHours || 0)} — needs correction, not counted`
                        : liveOpen
                          ? `${formatHours(session.hours)} so far`
                          : `${formatHours(session.hours)} worked`}
                      {session.adjusted ? " · adjusted earlier" : ""}
                    </small>
                  </div>
                  {active ? (
                    <div className="session-edit">
                      <input type="datetime-local" value={trimValue} max={toLocalInput(new Date().toISOString())} onChange={(event) => setTrimValue(event.target.value)} aria-label="New clock-out time" />
                      <button type="button" className="primary" onClick={() => {
                        if (trimSession(session.uid, session.clockIn, new Date(trimValue).toISOString())) setTrimming(null);
                      }}>Save</button>
                      <button type="button" onClick={() => setTrimming(null)}>Cancel</button>
                      {(session.open || session.stale || session.unclosed) && (
                        <small className="trim-close-note">
                          {liveOpen
                            ? "This session is still running: saving clocks it out at the time you picked. Other sessions are untouched."
                            : "Saving records the missing clock-out at the time you picked. It has to sit before the next clock-in."}
                        </small>
                      )}
                    </div>
                  ) : (
                    <div className="session-edit">
                      <button type="button" onClick={() => {
                        setTrimming({ uid: session.uid, clockIn: session.clockIn });
                        /* A sensible starting value: a live shift closes "now",
                           a closed session starts from its own clock-out, and
                           an abandoned one starts a minute inside its hard
                           ceiling (its clockOut holds the NEXT clock-in, which
                           the rules must refuse verbatim). */
                        setTrimValue(toLocalInput(liveOpen
                          ? new Date().toISOString()
                          : session.unclosed
                            ? new Date(Math.max(new Date(session.clockIn).getTime() + 60000, new Date(session.clockOut).getTime() - 60000)).toISOString()
                            : session.clockOut));
                      }}>Trim</button>
                      {/* Removal erases the record outright, so it stays a
                          manager's tool; self-service and Admin trimming get
                          the one-way trim alone. */}
                      {mayAdjustHours && (
                        <button type="button" className="danger" onClick={async () => {
                          if (await dialog.confirm(`Remove ${session.employee}'s session starting ${new Date(session.clockIn).toLocaleString()}? This cannot be undone.`)) resetSession(session.uid, session.clockIn);
                        }}>Reset</button>
                      )}
                    </div>
                  )}
                </div>
              );
                  })}
                </div>
              ));
            })()}
            {trimPreset === "recent" && trimRows.length > trimShown && (
              <button type="button" className="btn small trim-more" onClick={() => setTrimShown((count) => count + 12)}>
                Show older sessions ({trimRows.length - trimShown} more)
              </button>
            )}
            <p className="panel-footnote">
              Trim only accepts an earlier clock-out, so this can reduce recorded time but never create it. To add hours, use Add or fix past hours above — that goes for approval. Every trim is recorded in the audit trail with the before and after times.
            </p>
          </div>
        )}

        {showCorrection && (
          <div className="report-panel">
            <div className="section-head">
              <div><span className="eyebrow">Needs approval</span><h3>Attendance correction</h3></div>
              <button type="button" className="btn small" onClick={() => setShowCorrection(false)}>Close</button>
            </div>
            <div className="correction-types">
              {([
                ["Missed Clock", "Missed clock in / out", "You worked but never clocked"],
                ["Missed Break", "Unrecorded break", "Took a break without logging it"],
                ["Extra Hours", "Add hours worked", "Hours the clock never captured"],
              ] as const).map(([kind, label, blurb]) => (
                <button
                  type="button"
                  key={kind}
                  className={correction.kind === kind ? "on" : ""}
                  onClick={() => setCorrection((current) => ({ ...current, kind }))}
                ><b>{label}</b><small>{blurb}</small></button>
              ))}
            </div>
            <div className="correction-fields">
              <label>Date<input type="date" value={correction.date} onChange={(event) => setCorrection((c) => ({ ...c, date: event.target.value }))} /></label>
              {correction.kind !== "Missed Break" && (
                <label>
                  Mode
                  <select value={correction.mode} onChange={(event) => setCorrection((c) => ({ ...c, mode: event.target.value }))}>
                    {WORK_MODES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                  </select>
                </label>
              )}
              <label>{correction.kind === "Missed Break" ? "Break started" : "From"}<input type="time" value={correction.from} onChange={(event) => setCorrection((c) => ({ ...c, from: event.target.value }))} /></label>
              <label>{correction.kind === "Missed Break" ? "Break ended" : "To"}<input type="time" value={correction.to} onChange={(event) => setCorrection((c) => ({ ...c, to: event.target.value }))} /></label>
              <label className="wide">Reason<textarea value={correction.reason} onChange={(event) => setCorrection((c) => ({ ...c, reason: event.target.value }))} placeholder="Explain briefly — your approver sees exactly this." /></label>
            </div>
            <div className="correction-actions">
              <span>Goes to your approval chain. Your hours only change once it is approved.</span>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  if (submitCorrection(correction)) {
                    setShowCorrection(false);
                    setCorrection((c) => ({ ...c, reason: "" }));
                  }
                }}
              >Submit for Approval</button>
            </div>
          </div>
        )}
      </section>

      <section className="hours-breakdown">
        <div className="section-head">
          <div><span className="eyebrow">My hours</span><h3>Office, online, and site</h3></div>
          <div className="period-picker">
            {([["week", "This week"], ["month", "This month"], ["custom", "Custom"]] as [string, string][]).map(([value, label]) => (
              <button type="button" key={value} className={period === value ? "active" : ""} onClick={() => setPeriod(value)}>{label}</button>
            ))}
          </div>
        </div>
        {period === "custom" && (
          <div className="filter-toolbar">
            <label><span>From</span><input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
            <label><span>To</span><input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
          </div>
        )}
        <div className="hours-grid">
          <article className="hours-total">
            <small>Total</small><b>{formatHours(breakdown.total)}</b>
            <em>{breakdown.count} session{breakdown.count === 1 ? "" : "s"} · {breakdown.days} day{breakdown.days === 1 ? "" : "s"}</em>
          </article>
          {(["office", "online", "site", "other"] as const).map((tone) => {
            const value = breakdown[tone];
            if (!value && tone === "other") return null;
            const share = breakdown.total ? Math.round((value / breakdown.total) * 100) : 0;
            return (
              <article className="hours-mode" key={tone}>
                <span className={`mode-chip tone-${tone}`}>{tone === "office" ? "Office" : tone === "online" ? "Online / home" : tone === "site" ? "Site" : "Other"}</span>
                <b>{formatHours(value)}</b>
                <div className="mode-bar"><span style={{ width: `${share}%`, background: TONE_COLOURS[tone] }} /></div>
                <em>{share}% of the period</em>
              </article>
            );
          })}
        </div>
      </section>

      <section className="clock-portals" aria-label="Other areas you can open">
        <button type="button" className="portal-green" onClick={() => go("week-schedule")}>
          <span className="module-orb"><CalendarDays size={22} /></span>
          <span className="module-copy"><b>Weekly Schedule</b><small>Your shifts and who else is in</small></span>
          <ArrowRight size={16} />
        </button>
        <button type="button" className="portal-violet" onClick={() => go(method === "pin" ? "my-points" : "performance-center")}>
          <span className="module-orb"><TrendingUp size={22} /></span>
          <span className="module-copy"><b>{method === "pin" ? "Add My Points" : "Points & Targets"}</b><small>Record and submit your own work</small></span>
          <ArrowRight size={16} />
        </button>
        <button type="button" className="portal-amber" onClick={() => go("my-requests")}>
          <span className="module-orb"><ClipboardCheck size={22} /></span>
          <span className="module-copy"><b>Leave & Requests</b><small>Submit leave or a schedule change</small></span>
          <ArrowRight size={16} />
        </button>
        <button type="button" className="portal-rose" onClick={() => go("staff-development")}>
          <span className="module-orb"><BookOpen size={22} /></span>
          <span className="module-copy"><b>Development Portal</b><small>Hours, presentations, and evidence</small></span>
          <ArrowRight size={16} />
        </button>
      </section>

      <section className="clock-week">
        <div className="section-head">
          <div><span className="eyebrow">This week</span><h3>Your shifts</h3></div>
          <button type="button" className="secondary" onClick={() => go("week-schedule")}>Open schedule</button>
        </div>
        <div className="week-strip">
          {week.map((day) => {
            const isToday = day.day === WEEKDAY_NAMES[new Date().getDay()];
            return (
              <div className={isToday ? "week-day today" : "week-day"} key={day.day}>
                <small>{day.day.slice(0, 3)}</small>
                {day.entries.length ? day.entries.map((entry, index) => {
                  const code = String(entry.code || "").toUpperCase();
                  const meta = catalogue[code];
                  /* Coloured the same way as the shared schedule grid rather
                     than by tone class, so one shift is never two different
                     greens depending on which screen you opened. */
                  const background = shiftColour(code, shiftInks);
                  return (
                    <span className="shift-chip" key={index}
                      style={{ background, color: readableInk(background) }}
                      title={meta ? `${meta.label} · ${meta.time}` : entry.name || code}>
                      <b>{code || entry.name || "Shift"}</b>
                      <em>{entry.start && entry.end ? `${entry.start}–${entry.end}` : meta?.time || ""}</em>
                    </span>
                  );
                }) : <span className="shift-chip tone-none"><b>OFF</b><em>—</em></span>}
              </div>
            );
          })}
        </div>
      </section>

      {development.length > 0 && (
        <section className="clock-development">
          <div className="section-head">
            <div><span className="eyebrow">Development</span><h3>Your open activities</h3></div>
            <button type="button" className="secondary" onClick={() => go("staff-development")}>Open portal</button>
          </div>
          <div className="dev-strip">
            {development.slice(0, 4).map((record) => {
              const hourPart = record.targetHours ? record.completedHours / record.targetHours : 1;
              const showPart = record.targetPresentations ? record.completedPresentations / record.targetPresentations : 1;
              const parts = [
                ...(record.targetHours ? [hourPart] : []),
                ...(record.targetPresentations ? [showPart] : []),
              ];
              const percent = parts.length
                ? Math.max(0, Math.min(100, Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100)))
                : 0;
              const overdue = Boolean(record.dueDate && record.dueDate < dateInputValue(new Date()));
              return (
                <button type="button" className="dev-card" key={record.id} onClick={() => go("staff-development")}>
                  <span className={`record-status ${record.status.toLowerCase().replace(/\s+/g, "-")}`}>{record.status}</span>
                  <b>{record.title}</b>
                  <small>{formatHours(record.completedHours)} / {formatHours(record.targetHours)} · {record.completedPresentations}/{record.targetPresentations} presentations</small>
                  <div className="dev-meter" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={`${record.title} progress`}>
                    <span style={{ width: `${percent}%` }} />
                  </div>
                  <em className={overdue ? "due" : ""}>{record.dueDate ? (overdue ? `Overdue ${record.dueDate}` : `Due ${record.dueDate}`) : record.month}</em>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <section className="report-panel">
        <div className="section-head"><div><span className="eyebrow">Attendance</span><h3>Your recent sessions</h3></div>
          <span className="black-badge">{recent.length}</span></div>
        <div className="data-table-wrap">
          <table className="data-table compact-table">
            <thead><tr><th>Date</th><th>Mode</th><th>In</th><th>Out</th><th>Hours</th></tr></thead>
            <tbody>
              {recent.map((session, index) => (
                <tr key={`${session.clockIn}-${index}`}>
                  <td>{session.date}</td>
                  <td><span className={`mode-chip tone-${modeTone(session.mode)}`}>{session.mode}</span></td>
                  <td>{new Date(session.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{session.open ? "Open now" : new Date(session.clockOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{formatHours(session.hours)}</td>
                </tr>
              ))}
              {!recent.length && <tr><td colSpan={5}><div className="empty compact">No attendance recorded yet.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function MyPoints({
  user,
  save,
  store,
}: {
  user: StaffUser | null;
  save: (draft: PerformanceDraft, submit: boolean) => boolean;
  store: Record<string, unknown> | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const emptyDraft: PerformanceDraft = {
    workDate: today,
    lateReason: "",
    jobNumber: "",
    clientCode: "",
    workCategory: "Design",
    discipline: user?.department || "",
    hoursSpent: "",
    assignedPoints: "",
    submittedPoints: "",
    notes: "",
  };
  const [draft, setDraft] = useState<PerformanceDraft>(emptyDraft);
  const update = (field: keyof PerformanceDraft, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));
  const submit = (event: { preventDefault: () => void }, sendForApproval: boolean) => {
    event.preventDefault();
    if (save(draft, sendForApproval)) setDraft({ ...emptyDraft, workDate: draft.workDate, discipline: user?.department || "" });
  };

  /* Which week this entry lands in, and whether it is closed. Both follow the
     completion date, so changing the date changes the answer -- that is the
     whole point of asking for a date rather than assuming today. */
  const week = weekOfDate(draft.workDate || today);
  const lock = weekLockFor(store, week);
  const locked = Boolean(lock);
  const waiting = (Array.isArray(store?.approvals) ? store.approvals as LeaveRequest[] : [])
    .filter((row) => row.type === "Points Unlock" && row.uid === user?.id && row.week === week && row.status === "Pending");

  return (
    <div className="native-scroll points-scroll">
      <section className="points-hero">
        <div>
          <span className="eyebrow">Personal performance</span>
          <h2>Add My Points</h2>
          <p>Record your work, then save it as a draft or send it to your manager for approval. Closed weeks still accept an entry — it travels for approval with every detail on it.</p>
        </div>
        <div className="identity-chip">
          <PersonAvatar person={user} />
          <div><small>Adding points for</small><b>{user?.name}</b></div>
          <ShieldCheck size={18} />
        </div>
      </section>
      {/* A closed week is the normal state for anything older than the last
          Saturday. It does not take the form away -- the entry is filled in
          exactly as always and travels to the approver complete, so the
          decision is made on the real job, hours and points. */}
      {locked && (
        <section className="lock-banner">
          <div className="lock-banner-head">
            <Lock size={18} />
            <div>
              <b>Week {week} is closed</b>
              <small>
                Locked by {lock?.lockedBy} on {(lock?.lockedAt || "").slice(0, 10)}
                {lock?.note ? ` · ${lock.note}` : ""}
              </small>
            </div>
          </div>
          <p>
            Fill the entry in as usual and add a reason at the end. It goes to your
            approver with every detail on it, and lands in the week once accepted.
            Choosing a date in an open week saves the trip.
          </p>
          {Boolean(waiting.length) && (
            <span className="lock-pending">
              <Timer size={15} /> {waiting.length} {waiting.length === 1 ? "entry" : "entries"} for {week} waiting for a decision
            </span>
          )}
        </section>
      )}

      <form className="points-form" onSubmit={(event) => submit(event, true)}>
        <div className="points-section-head">
          <div><span className="eyebrow">Work details</span><h3>What did you work on?</h3></div>
          <span className={locked ? "kept locked" : "kept"}>{locked ? `Week ${week} closed` : `Week ${week}`}</span>
        </div>
        <div className="points-fields">
          {/* The day the work was FINISHED, not the day it was started and not
              the day it is being typed. A job spread across three days is one
              entry, and it counts in the week it was completed. Defaulting to
              today keeps the common case one field shorter, while still letting
              somebody log Friday's finished work on Monday -- into Friday's
              week, not Monday's.

              Kept under workDate, the key it has always used. Every entry on
              record, every week lock and every report reads that key; renaming
              it would orphan all of them. What changed is what we ask for. */}
          <label>Completion Date<input required type="date" max={today} value={draft.workDate} onChange={(event) => update("workDate", event.target.value)} /></label>
          {/* The job number identifies the work now that the project name is
              gone, so it carries the requirement the project name used to. */}
          <label>Job Number<input required value={draft.jobNumber} onChange={(event) => update("jobNumber", event.target.value)} placeholder="Example: 26-104" /></label>
          <label>Client Code<input value={draft.clientCode} onChange={(event) => update("clientCode", event.target.value)} placeholder="Optional" /></label>
          <label>
            Work Category
            {/* Switching away from Review drops any hours already typed, so a
                stale figure can never ride along on a non-review entry. */}
            <select
              value={draft.workCategory}
              onChange={(event) => {
                const next = event.target.value;
                setDraft((current) => ({
                  ...current,
                  workCategory: next,
                  hoursSpent: next === "Review" ? current.hoursSpent : "",
                }));
              }}
            >
              <option>Design</option>
              <option>Analysis</option>
              <option>Structural Drawing</option>
              <option>Architectural Drawing</option>
              <option>Review</option>
              <option>Coordination</option>
              <option>Site Work</option>
              <option>Other</option>
            </select>
          </label>
          <label>Discipline<input value={draft.discipline} onChange={(event) => update("discipline", event.target.value)} placeholder="Structural, Architecture…" /></label>
          {/* Hours are only asked for on a review. Reviewing someone else's job
              is charged by time spent, not by the points the work is worth --
              design and drawing work is measured by points alone. */}
          {draft.workCategory === "Review" && (
            <label>Hours Spent<input required type="number" min="0.25" step="0.25" inputMode="decimal" value={draft.hoursSpent} onChange={(event) => update("hoursSpent", event.target.value)} placeholder="e.g. 3.5" /></label>
          )}
          {/* Total first, then Assigned. The total is the figure somebody
              actually knows when they sit down to log the work; the assigned
              figure is what it was estimated at, and is optional. Asking for
              the estimate first made people stop and go looking for it before
              they could record what they had done. */}
          <label>Total Points<input required type="number" min="0.5" step="0.5" inputMode="decimal" value={draft.submittedPoints} onChange={(event) => update("submittedPoints", event.target.value)} placeholder="0" /></label>
          <label>Assigned Points<input type="number" min="0" step="0.5" inputMode="decimal" value={draft.assignedPoints} onChange={(event) => update("assignedPoints", event.target.value)} placeholder="0" /></label>
          <label className="wide">Notes<textarea value={draft.notes} onChange={(event) => update("notes", event.target.value)} placeholder="Add a short description of the completed work." /></label>
          {/* Asked for only on a closed week. This is the one thing the approver
              cannot read off the entry itself: why it missed the week. */}
          {locked && (
            <label className="wide">Reason for the late entry
              <textarea required value={draft.lateReason} onChange={(event) => update("lateReason", event.target.value)}
                placeholder={`Week ${week} was already closed. Explain why this is arriving now.`} />
            </label>
          )}
        </div>
        {/* A closed week has one action, not two: a draft would sit in a week
            nobody is counting any more. */}
        <div className="points-actions">
          {locked ? (
            <button type="submit" className="primary">Send to approver with details</button>
          ) : (
            <>
              <button type="button" className="secondary" onClick={(event) => submit(event, false)}>Save Draft</button>
              <button type="submit" className="primary">Submit for Approval</button>
            </>
          )}
        </div>
      </form>
    </div>
  );
}

function DataCenter({
  storage,
  backup,
  restore,
  sync,
  openStaffTools,
  canExport,
  canManage,
  runCheck,
}: {
  storage: { key: string; size: string }[];
  backup: (scope: BackupScope) => void;
  restore: () => void;
  sync: () => void;
  openStaffTools?: () => void;
  canExport: boolean;
  canManage: boolean;
  runCheck: () => CheckRow[];
}) {
  const [checks, setChecks] = useState<CheckRow[] | null>(null);
  const checkTone: Record<CheckRow["state"], string> = {
    ready: "ok", permission: "warn", missing: "bad", loading: "muted",
  };
  const checkWord: Record<CheckRow["state"], string> = {
    ready: "Reachable", permission: "No permission", missing: "Missing", loading: "Loading",
  };
  const scopeIcons: Record<BackupScope, LucideIcon> = {
    all: Database,
    staff: Timer,
    hr: UserRoundSearch,
    accounting: BadgeDollarSign,
  };
  return (
    <div className="native-scroll data-scroll">
      <section className="data-title">
        <div>
          <span className="eyebrow">Administration</span>
          <h2>Data Center</h2>
          <p>Choose exactly what to back up, restore a saved file, or synchronize the staff master record.</p>
        </div>
        <span className="black-badge">{storage.length} active stores</span>
      </section>

      <section className="panel backup-center">
        <div className="section-head">
          <div><span className="eyebrow">Backup center</span><h3>What would you like to back up?</h3></div>
          <span className="access-pill"><ShieldCheck size={15} /> One reliable backup path</span>
        </div>
        <div className="backup-scope-grid">
          {(Object.keys(BACKUP_SCOPES) as BackupScope[]).map((scope) => {
            const Icon = scopeIcons[scope];
            const config = BACKUP_SCOPES[scope];
            return (
              <button type="button" key={scope} className={`backup-scope ${scope}`} onClick={() => backup(scope)} disabled={!canExport}>
                <span><Icon size={21} /></span>
                <div><b>{config.label}</b><small>{config.description}</small></div>
                <ArrowRight size={17} />
              </button>
            );
          })}
        </div>
        {!canExport && <p className="permission-note"><LockKeyhole size={14} /> Backup export is not enabled for this account.</p>}
      </section>

      <section className="data-actions">
        <article>
          <span><Import size={23} /></span>
          <div><h3>Restore a backup</h3><p>Restore either a complete backup or one selected work area. Only matching records are replaced.</p></div>
          <button type="button" className="secondary" onClick={restore} disabled={!canManage}>Choose Backup</button>
        </article>
        <article>
          <span><UsersRound size={23} /></span>
          <div><h3>Staff identity sync</h3><p>Match the staff master record into HR and payroll without replacing existing skills or payroll history.</p></div>
          <button type="button" className="secondary" onClick={sync} disabled={!canManage}>Sync Staff</button>
        </article>
        {openStaffTools && (
          <article>
            <span><FileSpreadsheet size={23} /></span>
            <div><h3>Staff CSV & import tools</h3><p>Open the specialized staff page for CSV import, printable output, and staff-only exports.</p></div>
            <button type="button" className="secondary" onClick={openStaffTools}>Open Tools</button>
          </article>
        )}
      </section>
      {!canManage && <p className="permission-note"><LockKeyhole size={14} /> Restore and synchronization require Manage data permission.</p>}

      <section className="panel">
        <div className="section-head">
          <div><span className="eyebrow">Diagnostics</span><h3>System check</h3></div>
          <button type="button" className="secondary" onClick={() => setChecks(runCheck())}>Run check</button>
        </div>
        {checks ? (
          <>
            <div className="check-summary">
              {(["ready", "permission", "loading"] as CheckRow["state"][]).map((state) => (
                <span key={state} className={`check-pill ${checkTone[state]}`}>
                  {checks.filter((row) => row.state === state).length} {checkWord[state].toLowerCase()}
                </span>
              ))}
            </div>
            <div className="table-wrap"><table><thead><tr><th>Work area</th><th>Module</th><th>Status</th><th>Detail</th></tr></thead>
              <tbody>{checks.map((row) => (
                <tr key={row.id}><td><b>{row.label}</b></td><td>{row.area}</td>
                  <td><span className={`check-pill ${checkTone[row.state]}`}>{checkWord[row.state]}</span></td>
                  <td>{row.note}</td></tr>
              ))}</tbody></table></div>
          </>
        ) : (
          <div className="empty compact">Run the check to confirm every work area opens for this account, and to see which are hidden by permissions rather than missing.</div>
        )}
      </section>

      <section className="panel">
        <div className="section-head"><div><span className="eyebrow">Local application data</span><h3>Active stores on this device</h3></div></div>
        {storage.length ? (
          <div className="table-wrap"><table><thead><tr><th>Store</th><th>Area</th><th>Size</th><th>Status</th></tr></thead><tbody>{storage.map((row) => {
            const area = backupAreaForKey(row.key);
            return <tr key={row.key}><td>{row.key}</td><td>{area ? BACKUP_SCOPES[area].label : "Application preference"}</td><td>{row.size}</td><td><span className="kept">Available</span></td></tr>;
          })}</tbody></table></div>
        ) : <div className="empty">Open each module once to initialize its data on this device.</div>}
      </section>
    </div>
  );
}
