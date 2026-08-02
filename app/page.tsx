"use client";

import Image from "next/image";
import { initLarsaSync } from "../lib/supabase/sync";
import { getSupabaseClient, supabaseConfigured } from "../lib/supabase/client";
import { subscribeToPush, sendPush } from "../lib/supabase/push";
import { sendMail } from "../lib/supabase/mail"; import { AccountAccess } from "./AccountAccess"; import { OrgStructure } from "./OrgStructure"; import { HierarchyDashboard } from "./HierarchyDashboard"; import { TeamCharts } from "./TeamCharts";import { PlatformSettings } from "./PlatformSettings"; import { canSeeOrgPortal, effectiveOrg, isResponsibleForOthers, staffIdsVisibleTo } from "../lib/org"; import { verifyPassword, hashPassword, hashPin, findByPin, needsUpgrade, isHashed, pinTakenByOther } from "../lib/password"; import { getDeviceId, describeDevice, deviceNeedsVerification, accountingNeedsVerification, verificationRemainingMs, verificationWindowHours, withDeviceRecorded, withDeviceRemoved, describeWhen } from "../lib/devices"; import type { TrustedDevice } from "../lib/devices";import { checkVerification, loadPolicy } from "../lib/verification";
import {
  ArrowLeft,
  ArrowRight,
  Award,
  BadgeDollarSign,
  Bell,
  BookOpen,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
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
  FolderLock,
  FolderKanban,
  Gauge,
  HardHat,
  History,
  IdCard,
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
  Moon,
  Network,
  Package,
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
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
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
import { ChangeEvent, FormEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  | "constructionFinancials" | "orgStructure" | "platformSettings";
type SignInMethod = "email" | "pin";
type NavChannel = "home" | "time" | "performance" | "hr" | "accounting" | "admin";
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
  role?: string;
  department?: string;
  email?: string;
  enabled?: boolean;
  permissions?: string[];
  permissionProfile?: PermissionProfile;
  notes?: string;
  phone?: string;
  location?: string;
  manager?: string;
  constraints?: unknown[];
  projectAccessMode?: ProjectAccessMode;
  projectIds?: string[];
  notifyPrefs?: NotifyPrefs;
  phoneAlt?: string;
  emailVerified?: boolean; mustResetPassword?: boolean; pendingApproval?: boolean; devices?: TrustedDevice[]; platformAdmin?: boolean;
};
type Item = {
  id: string;
  label: string;
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
];
const NOTIFY_STORE_KEY = "larsaNotificationsV1";
// Sign-in convenience. The address and the "stay signed in" session are stored;
// the password never is — the browser's own password manager handles that, so
// it stays encrypted behind the device lock instead of sitting in plain text.
const KEEP_SESSION_KEY = "larsa-control-session-keep";
const REMEMBER_EMAIL_KEY = "larsa-control-remember-email";
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
  /* The one page where time and output legitimately meet. Everywhere else
     hours belong to attendance and points belong to performance; here they sit
     together because the question being asked is productivity. The id is kept
     so existing links and saved views still resolve. */
  label: "Productivity History",
  description: "Hours worked against points and jobs delivered, for any period",
  code: "PH",
  native: "performanceHistory",
};
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
    label: "Engineering Management",    items: [      { id: "org-structure", label: "Engineering Management", description: "Departments, teams, and access", code: "EM", native: "orgStructure" },    ],  },  {    label: "Timeclock & Performance",
    items: [
      engineItem("staff", "staff-dashboard", "Performance Dashboard", "Workboard summaries, alerts, and KPIs", "DB", "dashboard"),
      PERFORMANCE_CENTER_ITEM,
      DEVELOPMENT_ITEM,
      engineItem("staff", "staff-clock", "Clock In / Out", "Daily clocking and attendance", "TC", "clock"),
      engineItem("staff", "staff-live", "Live Presence", "Office, remote, site, and out status", "LP", "live"),
      engineItem("staff", "staff-schedule", "Weekly Schedule", "Shift builder and attendance planning", "WS", "schedule"),
      engineItem("staff", "staff-performance", "Performance Workboard", "Weekly points, targets, and analytics", "PF", "performance"),
      engineItem("staff", "staff-timesheet", "Timesheet", "Sessions, hours, and timezone views", "TS", "timesheet"),
      engineItem("staff", "staff-approvals", "Leave & Requests", "Leave and schedule requests, approvals, and workflows", "LR", "approvals"),
      engineItem("staff", "staff-people", "Employee Details", "Staff profiles, roles, departments, and notes", "ED", "people"),
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
const ITEMS = [...GROUPS.flatMap((group) => group.items), SALES_ITEM, MY_POINTS_ITEM, QUICK_CLOCK_ITEM, WEEK_SCHEDULE_ITEM, ACCOUNTING_HUB_ITEM, SETTINGS_ITEM, REQUESTS_ITEM, PRESENCE_ITEM];
const DEFAULT_ITEM = ITEMS.find((item) => item.id === "overview")!;
const PIN_ALLOWED_ITEMS = new Set(["overview", "quick-clock", "week-schedule", "staff-clock", "my-points", "staff-development", "my-settings", "my-requests", "live-presence"]);
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
  "performance-history": ["view", "export"],
  "staff-timesheet": VIEW_EXPORT,
  "staff-approvals": ["view", "add", "edit", "delete", "approve", "manage"],
  "staff-reports": VIEW_EXPORT,
  "staff-people": FULL_EDIT,
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
    items: [
      PERFORMANCE_CENTER_ITEM,
      ITEMS.find((item) => item.id === "staff-dashboard")!,
      ITEMS.find((item) => item.id === "staff-performance")!,
      PERFORMANCE_REVIEW_ITEM,
      PERFORMANCE_TARGETS_ITEM,
      DEVELOPMENT_ITEM,
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
      ITEMS.find((item) => item.id === "staff-people")!,
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
    description: "Payroll, paystubs, employee records, and supplier references",
    items: ["acc-payroll", "sales-commissions", "acc-employees", "acc-refs"],
  },
  {
    id: "acc-grp-settings", tone: "rose", label: "Settings & Notices", icon: "acc-settings",
    description: "Accounting preferences, tax setup, and notifications",
    items: ["acc-settings", "acc-notifications"],
  },
];

const ICONS: Record<string, LucideIcon> = {
  overview: Gauge,
  "staff-dashboard": LayoutDashboard,
  "staff-clock": Timer,
  "staff-live": Radio,
  "staff-schedule": CalendarDays,
  "staff-performance": TrendingUp,
  "performance-center": Target,
  "staff-development": BookOpen,
  "performance-history": History,
  "my-points": TrendingUp,
  "staff-timesheet": FileClock,
  "staff-approvals": CheckCircle2,
  "staff-people": UsersRound,
  "staff-rules": SlidersHorizontal,
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
    allow("staff-people");
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
    allow("staff-people");
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
  if (can("access", "view") || can("staff-people", "view")) permissions.add("People Manage");
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
  if (item.id === "access" || item.id === "staff-people") return hasStaffPermission(user, "People Manage");
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
  if (item.id === "org-structure") return canSeeOrgPortal();
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
    "staff-people",
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
  if (!user.permissionProfile || isAdmin(user)) return {};
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
  result.settings.manageUsers = hasItemPermission(user, ACCESS_ITEM, "manage");
  return result;
}

function enginePermissionSnapshot(user: StaffUser, engine: Engine) {
  const result: Record<string, Partial<Record<PermissionAction, boolean>>> = {};
  GROUPS.flatMap((group) => group.items)
    .filter((item) => item.engine === engine && item.section)
    .forEach((item) => {
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
  if (
    item.id === "admin"
    || item.id === "access"
    || item.id === "data"
    || ["staff-people", "staff-rules", "staff-backup"].includes(item.id)
  ) return "admin";
  // Sits with payroll, because that is the permission it follows.
  if (item.id === "sales-commissions") return "accounting";
  if (item.id === "my-settings") return "home";
  if (item.id === "my-requests" || item.id === "live-presence") return "time";
  if (item.id === "quick-clock" || item.id === "week-schedule") return "time";
  if (
    item.id === "my-points"
    || item.id === "performance-center"
    || item.id === "staff-development"
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
  MON: { label: "Monday meeting", time: "16:00", tone: "office" },
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
  MON: "#0b5a34",  // Monday meeting, 16:00 — latest, so darkest
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

type BuildSettings = {
  officeDaysPerPerson: number;
  minInOffice: number;
  targetInOffice: number;
  officeHoursTarget: number;
  onlineHoursTarget: number;
  respectConstraints: boolean;
  mondayMeeting: boolean;
};
const DEFAULT_BUILD: BuildSettings = {
  officeDaysPerPerson: 3,
  minInOffice: 5,
  targetInOffice: 6,
  officeHoursTarget: 18,
  onlineHoursTarget: 6,
  respectConstraints: true,
  mondayMeeting: true,
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
      meta: `${openClock.hours.toFixed(1)} h so far`,
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
        detail: `${record.completedHours.toFixed(1)} of ${record.targetHours.toFixed(1)} h · ${record.completedPresentations}/${record.targetPresentations} presentations`,
        meta: record.dueDate ? (overdue ? `Overdue ${record.dueDate}` : `Due ${record.dueDate}`) : record.status,
        tone: overdue ? "due" : "open",
        itemId: "staff-development",
      });
    });

  // --- leave and schedule requests -------------------------------------
  const approvals = Array.isArray(store?.approvals)
    ? store.approvals as { id?: string; uid?: string; type?: string; status?: string; from?: string; to?: string; date?: string; reason?: string; flow?: string[] }[]
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
  const queue = approvals.filter((request) =>
    request.status === "Pending"
    && request.uid !== viewer.id
    && Array.isArray(request.flow)
    && request.flow.includes(viewer.id)).length;
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
    .filter((session) => session.uid === viewer.id && isoWeekLabel(new Date(session.clockIn)) === week)
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
      card("hours", "Your hours this week", `${myHoursWeek.toFixed(1)} h`, "Recorded attendance", "plain", "quick-clock"),
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
      card("hours", "Your hours this week", `${myHoursWeek.toFixed(1)} h`, "Recorded attendance", "plain", "quick-clock"),
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
      card("hours", "Your hours this week", `${myHoursWeek.toFixed(1)} h`, "Recorded attendance", "plain", "quick-clock"),
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

function buildClockSessions(store: Record<string, unknown> | null, users: StaffUser[]): ClockSession[] {
  const logs = Array.isArray(store?.logs) ? (store.logs as ClockLog[]) : [];
  const names = new Map(users.map((user) => [user.id, user.name]));
  const grouped = new Map<string, ClockLog[]>();
  logs.forEach((log) => {
    if (!log.uid || !log.time) return;
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

    const record = (start: string, end: string, mode: string, isOpen: boolean) => {
      const from = new Date(start).getTime();
      const to = new Date(end).getTime();
      const grossMs = Math.max(0, to - from);
      const breakMs = Math.min(grossMs, breakMsWithin(from, to));
      sessions.push({
        uid,
        employee: names.get(uid) || uid,
        mode,
        clockIn: start,
        clockOut: end,
        hours: Math.max(0, (grossMs - breakMs) / 3600000),
        presenceHours: grossMs / 3600000,
        breakHours: breakMs / 3600000,
        open: isOpen,
      });
    };

    rows.forEach((row) => {
        if (row.status === "In") {
          open = row;
          return;
        }
        if (row.status !== "Out" || !open?.time || !row.time) return;
        record(open.time, row.time, open.type || row.type || "Unspecified", false);
        open = null;
      });
    /* Read through a fresh binding. TypeScript narrows `open` to `never` here,
       because it cannot see that the callback above reassigns it, and a build
       with type checking on then refuses the file. */
    const stillOpen = open as ClockLog | null;
    if (stillOpen?.time) {
      record(stillOpen.time, new Date().toISOString(), stillOpen.type || "Unspecified", true);
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
// One place that raises a notification, honouring each recipient's preferences.
function raiseNotification(input: {
  event: string; title: string; body: string; itemId?: string;
  fromName: string; recipients: StaffUser[];
}) {
  if (typeof window === "undefined") return;
  const store = parseStore(NOTIFY_STORE_KEY) || { version: 1, items: [] };
  const items: AppNotification[] = Array.isArray(store.items) ? store.items : [];
  const now = new Date().toISOString();
  input.recipients.forEach((person, index) => {
    const prefs = prefsFor(person)[input.event] || {};
    if (prefs.inApp !== false) {
      items.unshift({
        id: `n${Date.now()}_${index}_${Math.random().toString(36).slice(2, 6)}`,
        event: input.event, title: input.title, body: input.body,
        at: now, toId: person.id, fromName: input.fromName, read: false, itemId: input.itemId,
      });
    }
    if (prefs.push && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try { new Notification(input.title, { body: input.body, icon: "/icons/icon-192.png" }); } catch { /* blocked */ }
      // Foreground Notification above covers this tab; sendPush additionally
      // reaches every other device/browser this person subscribed on, even
      // fully closed — the "phone" half of push that new Notification() alone
      // never could.
      sendPush(person.id, input.title, input.body);
    }
    if (prefs.email && person.email) {
      // Same fire-and-forget contract as sendPush -- a failed email should
      // never block the in-app/push notification it rides with.
      sendMail({ to: person.email, subject: input.title, html: `<p>${input.body}</p>` });
    }
  });
  localStorage.setItem(NOTIFY_STORE_KEY, JSON.stringify({ version: 1, items: items.slice(0, 400) }));
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
  const [loginPin, setLoginPin] = useState(""); const [accessMode, setAccessMode] = useState<"signup" | "forgot" | null>(null); const [accountingGate, setAccountingGate] = useState<Item | null>(null); useEffect(() => { const u = sessionUser; if (!u || !u.email || u.platformAdmin !== undefined) return; (async () => { const client = getSupabaseClient(); if (!client) return; try { const { data } = await client.functions.invoke("auth-policy", { body: { op: "amPlatformAdmin", email: u.email } }); const admin = Boolean(data && (data as { admin?: boolean }).admin); setSessionUser((prev) => { const next = prev && prev.id === u.id ? { ...prev, platformAdmin: admin } : prev; if (next) sessionUserRef.current = next; return next; }); } catch { /* the entry just stays hidden */ } })(); }, [sessionUser]);
  const [showPassword, setShowPassword] = useState(false);
  // Email verification gate: only engaged when Supabase is configured (it's
  // what actually sends the code) and the account hasn't verified its email
  // yet. Without Supabase this stays entirely out of the way, same as sync.
  const [verifyStage, setVerifyStage] = useState<{ user: StaffUser; email: string } | null>(null);
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
  const [openAccountingGroup, setOpenAccountingGroup] = useState("");
  const [dark, setDark] = useState(false);
  const [message, setMessage] = useState("");
  const [installPrompt, setInstallPrompt] = useState<InstallEvent | null>(null);
  const [installHelp, setInstallHelp] = useState(false);
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
  const [growthStore, setGrowthStore] = useState<GrowthStore>({
    version: 1,
    pointTargets: {},
    development: [],
  });
  const uploadRef = useRef<HTMLInputElement>(null);
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
    const cleanup = initLarsaSync({
      onRemoteChange: () => {
        setStorageTick((value) => value + 1);
        (Object.keys(refs) as Engine[]).forEach((engine) => {
          try { refs[engine].current?.contentWindow?.location.reload(); } catch { /* iframe not ready yet */ }
        });
      },
    });
    return cleanup;
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
            completeSignIn(currentUser, method || "email"); if (method === "email" && supabaseConfigured() && currentUser.email) { checkVerification({ id: currentUser.id, access: currentUser.access, role: currentUser.role }).then((verdict) => { if (verdict && verdict.required && verdict.policy.force_relogin) { sessionStorage.removeItem("larsa-control-session"); try { localStorage.removeItem(KEEP_SESSION_KEY); } catch { /* nothing to clear */ } sessionUserRef.current = null; setSessionUser(null); setLoginError("For security, please sign in and verify your email again."); } }); }
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
      store.users[index] = { ...store.users[index], emailVerified: verified };
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
    setVerifyStage(null);
    setVerifyCode("");
    setVerifyInfo("");
    try {
      if (rememberMe) localStorage.setItem(REMEMBER_EMAIL_KEY, rememberedEmail);
      else localStorage.removeItem(REMEMBER_EMAIL_KEY);
    } catch {
      // Remembering the address is a convenience, never a sign-in requirement.
    }
    completeSignIn(verifiedUser, "email");
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
      // Separate the two failures so people stop retyping a correct password
      // against an address that simply has no account.
      const known = loginMode === "email" && users.some((row) => emailMatches(row));
      setLoginError(loginMode === "pin"
        ? "PIN not recognized."
        : known
          ? "That password does not match this account."
          : "No account found for that email address.");
      return;
    }
    if (loginMode === "email") {
      migrateEmailVerification();
      const refreshed = readStaffUsers().find((row) => row.id === user.id) || user;
      const periodic = supabaseConfigured() && refreshed.email ? await checkVerification({ id: refreshed.id, access: refreshed.access, role: refreshed.role }) : null;      const periodicDue = periodic ? periodic.required : deviceNeedsVerification(refreshed, getDeviceId());      if (supabaseConfigured() && refreshed.email && (refreshed.emailVerified !== true || periodicDue)) {
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
    try {
      if (rememberMe && loginMode === "email") localStorage.setItem(REMEMBER_EMAIL_KEY, enteredEmail);
      else localStorage.removeItem(REMEMBER_EMAIL_KEY);
    } catch {
      // Remembering the address is a convenience, never a sign-in requirement.
    }
    if (loginMode === "email") { try { const deviceStore = parseStore("larsaStaffV8") as { users?: StaffUser[] } | null; if (deviceStore && Array.isArray(deviceStore.users)) { const seat = deviceStore.users.findIndex((row) => row.id === user.id); if (seat >= 0) { deviceStore.users[seat] = { ...deviceStore.users[seat], devices: withDeviceRecorded(deviceStore.users[seat].devices, getDeviceId(), describeDevice(), { verified: true }) }; localStorage.setItem("larsaStaffV8", JSON.stringify(deviceStore)); } } } catch { /* remembering the device is a convenience, never a requirement */ } } if (needsUpgrade(loginMode === "pin" ? user.pin : user.password)) { try { const legacyStore = parseStore("larsaStaffV8") as { users?: StaffUser[] } | null; if (legacyStore && Array.isArray(legacyStore.users)) { const at = legacyStore.users.findIndex((row) => row.id === user.id); if (at >= 0) { legacyStore.users[at] = { ...legacyStore.users[at], ...(loginMode === "pin" ? { pin: await hashPin(enteredPin) } : { password: await hashPassword(enteredPass) }) }; localStorage.setItem("larsaStaffV8", JSON.stringify(legacyStore)); } } } catch { /* Rewriting the old secret is best effort; sign-in must not fail on it. */ } } completeSignIn(readStaffUsers().find((row) => row.id === user.id) || user, loginMode);
  };

  const signOut = useCallback(() => {
    sessionStorage.removeItem("larsa-control-session");
    // Signing out is deliberate: drop the kept session too, but leave the
    // remembered address so the next sign-in is still one field shorter.
    try { localStorage.removeItem(KEEP_SESSION_KEY); } catch { /* nothing to clear */ }
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
     sign-in. When it expires, the next screen is the normal email + code flow. */
  useEffect(() => {
    if (!sessionUser || sessionMethod !== "email" || !supabaseConfigured() || !sessionUser.email) return;
    const remaining = verificationRemainingMs(sessionUser, getDeviceId()); if (remaining <= 0) { checkVerification({ id: sessionUser.id, access: sessionUser.access, role: sessionUser.role }).then((verdict) => { if (verdict && verdict.required && verdict.policy.force_relogin) signOut(); }); return; }
    const timer = window.setTimeout(signOut, Math.max(0, Math.min(remaining, 2147483647)));
    return () => window.clearTimeout(timer);
  }, [sessionMethod, sessionUser, signOut]);

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
    navigator.serviceWorker?.register("/sw.js").catch(() => undefined);
    return () => {
      clearTimeout(startupTimer);
      window.removeEventListener("larsa:installable", adopt);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
    // notify is stable for the life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active.engine || !sessionUser) return;
    const timer = window.setTimeout(() => navigateInner(active), 40);
    return () => clearTimeout(timer);
  }, [active, navigateInner, sessionUser]);

  const choose = (item: Item, channel = channelForItem(item)) => {
    if (!canOpenInSession(sessionUserRef.current, item, sessionMethodRef.current)) {
      notify("You do not have access to this area.");
      return;
    }
    /* The email-code identity gate only makes sense for accounts that HAVE an
       email. Username-only accounts (clients, trainees, interns an admin set
       up without an address) have no mailbox to verify — their access is
       already scoped and password-protected, so they pass straight through. */
    if (!previewOwner && item.engine === "accounting" && sessionUserRef.current && sessionUserRef.current.email && accountingNeedsVerification(sessionUserRef.current, getDeviceId())) { setAccountingGate(item); return; } setNavChannel(item.id === "overview" ? "home" : channel);
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

  const install = async () => {
    /* Prefer the real thing. prompt() must be reached from the click without an
       await in front of it, or the browser treats the gesture as spent and
       refuses — so the event is read straight out of state here, never waited
       for. */
    const prompt = installPrompt || (window as WindowWithInstall).__larsaInstall?.event || null;
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
    setInstallPrompt(null);
    const bridge = (window as WindowWithInstall).__larsaInstall;
    if (bridge) bridge.event = null;
  };

  /* Pushes the saved logs into the embedded engine so both views agree
     immediately rather than after the engine's next natural render. */
  const refreshStaffEngine = useCallback(() => {
    try {
      staffRef.current?.contentWindow?.eval(`
        state=JSON.parse(localStorage.getItem("larsaStaffV8"));
        if(typeof render==="function"&&currentUser)render();
      `);
    } catch {
      // The engine picks the saved log up on its next render.
    }
  }, []);

  const saveMyPoints = (draft: PerformanceDraft, submit: boolean) => {
    const user = sessionUserRef.current;
    const win = staffRef.current?.contentWindow;
    if (!user || !win) {
      notify("The performance area is still loading. Please try again.");
      return false;
    }
    /* Points belong to the week the work was done in, not the week it happens to
       be typed in -- otherwise a Monday morning catch-up lands in the wrong
       week and the lock means nothing. */
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
      const flowConfig = (store.flowConfig || {}) as Record<string, Record<string, string[]>>;
      const configured = flowConfig[user.id]?.Performance || flowConfig[user.id]?.Leave;
      const managerId = (store.users as StaffUser[])
        .find((entry) => entry.name && user.manager && entry.name.toLowerCase() === user.manager.toLowerCase())?.id;
      const flow = configured?.length ? configured : [managerId || "u1"];
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
        recipients: (store.users as StaffUser[]).filter((entry) => flow.includes(entry.id)),
      });
      setStorageTick((value) => value + 1);
      notify(`Week ${week} is closed, so this entry went to your approver with all of its details.`);
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
    const status = latest && latest.status === "In" ? "Out" : "In";
    const now = new Date().toISOString();
    // Same record shape the Timeclock engine writes, so both stay in step.
    store.logs.push({
      id: `l${Date.now()}`, uid: user.id, type: mode, status,
      time: now, active: status === "In", lastSeen: now,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
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
    const now = new Date().toISOString();
    store.logs.push({
      id: `l${Date.now()}`, uid: user.id, type: "Break",
      status: ending ? "Break End" : "Break Start",
      time: now, active: false, lastSeen: now,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify(ending ? "Break ended." : "Break started.");
    return true;
  }, [notify, refreshStaffEngine]);

  /* Clocking someone else in or out. Deliberately records who did it so the
     action is never anonymous in the attendance history. */
  const punchOther = useCallback((targetId: string, mode: string, note = "") => {
    const actor = sessionUserRef.current;
    const clockItem = ITEMS.find((item) => item.id === "staff-clock");
    if (!actor || !clockItem || !hasItemPermission(actor, clockItem, "manage")) {
      notify("Your account cannot clock other people in or out.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store) { notify("Attendance records are still loading."); return false; }
    if (!Array.isArray(store.logs)) store.logs = [];
    const target = (store.users as StaffUser[] | undefined)?.find((row) => row.id === targetId);
    if (!target) { notify("Choose who you are clocking in or out."); return false; }
    const latest = (store.logs as ClockLog[])
      .filter((log) => log.uid === targetId && (log.status === "In" || log.status === "Out"))
      .sort((left, right) => new Date(right.time || 0).getTime() - new Date(left.time || 0).getTime())[0];
    const status = latest && latest.status === "In" ? "Out" : "In";
    const now = new Date().toISOString();
    store.logs.push({
      id: `l${Date.now()}`, uid: targetId, type: mode, status,
      time: now, active: status === "In", lastSeen: now,
      clockedBy: actor.name,
      note: `${status === "In" ? "Clocked in" : "Clocked out"} by ${actor.name}${note.trim() ? ` · ${note.trim()}` : ""}`,
    });
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    raiseNotification({
      event: "clock.byManager",
      title: status === "In" ? "You were clocked in" : "You were clocked out",
      body: `${actor.name} recorded this for you · ${mode}`,
      itemId: "staff-clock", fromName: actor.name, recipients: [target],
    });
    notify(`${target.name} ${status === "In" ? "clocked in" : "clocked out"}.`);
    return true;
  // raiseNotification is a module-level function, so it is not a dependency.
  }, [notify, refreshStaffEngine]);

  /* Trimming a session an authorized person can already see. Deliberately
     one-way: the new clock-out may only move EARLIER, so this can reduce
     recorded time but never manufacture it. Adding hours stays behind the
     correction request and its approval chain, which is the whole point --
     nobody can quietly inflate their own attendance. */
  const trimSession = useCallback((uid: string, clockIn: string, newClockOut: string) => {
    const actor = sessionUserRef.current;
    const clockItem = ITEMS.find((item) => item.id === "staff-clock");
    if (!actor || !clockItem || !hasItemPermission(actor, clockItem, "manage")) {
      notify("Your account cannot adjust attendance records.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.logs)) { notify("Attendance records are still loading."); return false; }
    const logs = store.logs as ClockLog[];
    const startedAt = new Date(clockIn).getTime();
    const nextOut = new Date(newClockOut).getTime();
    if (!Number.isFinite(nextOut)) { notify("Enter a valid clock-out time."); return false; }
    if (nextOut <= startedAt) { notify("Clock-out has to be after clock-in."); return false; }
    if (nextOut > Date.now()) { notify("Clock-out cannot be in the future."); return false; }

    // The matching Out is the first one after this In for the same person.
    const ordered = logs
      .filter((log) => log.uid === uid && log.time && (log.status === "In" || log.status === "Out"))
      .sort((left, right) => new Date(left.time || 0).getTime() - new Date(right.time || 0).getTime());
    const existingOut = ordered.find((log) => log.status === "Out" && new Date(log.time || 0).getTime() > startedAt);
    if (existingOut && new Date(existingOut.time || 0).getTime() < nextOut) {
      notify("You can only bring a clock-out earlier, not later. Use a correction request to add hours.");
      return false;
    }
    const stamp = `Adjusted by ${actor.name} on ${new Date().toLocaleDateString()}`;
    if (existingOut) {
      existingOut.time = new Date(nextOut).toISOString();
      existingOut.lastSeen = existingOut.time;
      existingOut.note = existingOut.note ? `${existingOut.note} · ${stamp}` : stamp;
    } else {
      // An open session: closing it counts as trimming to the chosen time.
      const source = logs.find((log) => log.uid === uid && log.time === clockIn && log.status === "In");
      logs.push({
        id: `l${Date.now()}`, uid, type: source?.type || "Office", status: "Out",
        time: new Date(nextOut).toISOString(), active: false,
        lastSeen: new Date(nextOut).toISOString(), note: stamp, clockedBy: actor.name,
      });
      if (source) source.active = false;
    }
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Attendance record adjusted.");
    return true;
  }, [notify, refreshStaffEngine]);

  /* Removes a session outright -- the clock-in and its matching clock-out.
     For a punch that should never have existed at all. */
  const resetSession = useCallback((uid: string, clockIn: string) => {
    const actor = sessionUserRef.current;
    const clockItem = ITEMS.find((item) => item.id === "staff-clock");
    if (!actor || !clockItem || !hasItemPermission(actor, clockItem, "manage")) {
      notify("Your account cannot reset attendance records.");
      return false;
    }
    const store = parseStore("larsaStaffV8");
    if (!store || !Array.isArray(store.logs)) { notify("Attendance records are still loading."); return false; }
    const logs = store.logs as ClockLog[];
    const startedAt = new Date(clockIn).getTime();
    const ordered = logs
      .filter((log) => log.uid === uid && log.time && (log.status === "In" || log.status === "Out"))
      .sort((left, right) => new Date(left.time || 0).getTime() - new Date(right.time || 0).getTime());
    const inLog = ordered.find((log) => log.status === "In" && new Date(log.time || 0).getTime() === startedAt);
    const outLog = ordered.find((log) => log.status === "Out" && new Date(log.time || 0).getTime() > startedAt);
    const drop = new Set([inLog, outLog].filter(Boolean).map((log) => log as ClockLog));
    if (!drop.size) { notify("That session could not be found."); return false; }
    store.logs = logs.filter((log) => !drop.has(log));
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    refreshStaffEngine();
    setStorageTick((value) => value + 1);
    notify("Session removed.");
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

  const autoBuildWeek = useCallback((settings: BuildSettings = DEFAULT_BUILD) => {
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
    if (!window.confirm("Rebuild this week's schedule using the current build rules? Days you have already set will be replaced.")) return false;
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
        if (settings.mondayMeeting && day === "Monday") {
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
    const approvers = (store.users as StaffUser[]).filter((row) => flow.includes(row.id));
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
    const flowConfig = (store.flowConfig || {}) as Record<string, Record<string, string[]>>;
    const configured = flowConfig[actor.id]?.Leave;
    const managerId = (store.users as StaffUser[])
      .find((row) => row.name && actor.manager && row.name.toLowerCase() === actor.manager.toLowerCase())?.id;
    const flow = configured?.length ? configured : [managerId || "u1"];
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
      flow,
      step: 0,
      history: [],
      createdAt: new Date().toISOString(),
    };
    store.approvals.unshift(record);
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    const approvers = (store.users as StaffUser[]).filter((row) => flow.includes(row.id));
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
    store.approvals[index] = {
      ...record, status,
      decidedBy: actor.name, decidedAt: new Date().toISOString(),
      history: [...(record.history || []), { by: actor.name, action: status, at: new Date().toISOString(), note }],
    };

    /* An approved attendance correction is what actually writes the missing
       records. Guarded on `materialised` so re-approving can never double-count,
       and breaks keep their own status values so they stay out of hour totals. */
    const CORRECTIONS = ["Missed Clock", "Missed Break", "Extra Hours"];
    const updated = store.approvals[index] as LeaveRequest & { materialised?: boolean };
    if (status === "Approved" && CORRECTIONS.includes(String(record.type)) && !updated.materialised) {
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
    if (status === "Approved" && record.type === "Points Unlock" && record.entry && !updated.materialised) {
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
    if (employee) {
      const isUnlock = record.type === "Points Unlock";
      raiseNotification({
        event: "leave.decided",
        title: isUnlock
          ? `Late entry for week ${record.week} ${status.toLowerCase()}`
          : `${record.type} request ${status.toLowerCase()}`,
        body: isUnlock
          ? (status === "Approved"
            ? `${actor.name} let your ${record.entry?.["Job Number"] || record.entry?.Project || "entry"} into closed week ${record.week}. It now waits for the normal points review.${note ? ` · ${note}` : ""}`
            : `${actor.name} did not accept your late entry for week ${record.week}.${note ? ` · ${note}` : ""}`)
          : `${actor.name} ${status.toLowerCase()} your ${record.from} to ${record.to} request${note ? ` · ${note}` : ""}`,
        itemId: isUnlock && status === "Approved" ? "my-points" : "my-requests",
        fromName: actor.name, recipients: [employee],
      });
    }
    setStorageTick((value) => value + 1);
    notify(`Request ${status.toLowerCase()}.`);
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

  const deleteDevelopment = (recordId: string) => {
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
    if (!window.confirm(`Delete "${current.title}" for ${current.employeeName}?`)) return false;
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
    if (nextUser.access === "Super Admin" && existingRecord?.access !== "Super Admin") {
      notify("The protected Super Admin account already controls full access.");
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
      store.users[existingIndex] = { ...existing, ...prepared };
    } else {
      notify("That user could not be found.");
      return false;
    }
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
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

  const deleteAccessUser = (target: StaffUser) => {
    const actor = sessionUserRef.current;
    if (!actor || !hasItemPermission(actor, ACCESS_ITEM, "delete")) {
      notify("Your account cannot delete user accounts.");
      return false;
    }
    if (target.access === "Super Admin" || target.id === actor.id) {
      notify("The protected owner account cannot be deleted.");
      return false;
    }
    if (!window.confirm(`Delete the sign-in account for ${target.name}? Historical work records will be kept.`)) {
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
    store.users.splice(existingIndex, 1);
    if (store.schedule) delete store.schedule[target.id];
    if (store.flowConfig) delete store.flowConfig[target.id];
    localStorage.setItem("larsaStaffV8", JSON.stringify(store));
    try {
      staffRef.current?.contentWindow?.eval(`
        state=JSON.parse(localStorage.getItem("larsaStaffV8"));
        if(typeof render==="function"&&currentUser)render();
      `);
    } catch {
      // The saved directory will be picked up when the embedded module next renders.
    }
    setStorageTick((value) => value + 1);
    notify("User account deleted. Historical work records were kept.");
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

  const exportBackup = (scope: BackupScope) => {
    const stores: Record<string, unknown> = {};
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key?.toLowerCase().startsWith("larsa")) continue;
      if (scope !== "all" && backupAreaForKey(key) !== scope) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      try {
        stores[key] = JSON.parse(raw);
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
      if (!payload?.stores || typeof payload.stores !== "object") throw new Error();
      const validStores = Object.entries(payload.stores)
        .filter(([key]) => key.toLowerCase().startsWith("larsa"));
      if (!validStores.length) throw new Error();
      const scopeLabel = typeof payload.scopeLabel === "string" ? payload.scopeLabel : "selected";
      if (!confirm(`Restore ${scopeLabel.toLowerCase()} data from this backup? Matching records will be replaced.`)) return;
      validStores.forEach(([key, value]) =>
        localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value)),
      );
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
    (["email", "phone", "location", "password", "pin", "notifyPrefs"] as const).forEach((key) => {
      if (patch[key] !== undefined) (safe as Record<string, unknown>)[key] = patch[key];
    });
    if (safe.email) {
      const taken = store.users.some((row: StaffUser) =>
        row.id !== actor.id && row.email?.trim().toLowerCase() === String(safe.email).trim().toLowerCase());
      if (taken) { notify("That email is already used by another account."); return false; }
    }
    if (safe.pin) {
      const taken = store.users.some((row: StaffUser) => row.id !== actor.id && row.pin === safe.pin);
      if (taken) { notify("That PIN is already used by another account."); return false; }
    }
    const next = { ...store.users[index], ...safe };
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

  const saveNotifyPrefs = useCallback((prefs: NotifyPrefs) => saveOwnProfile({ notifyPrefs: prefs }), [saveOwnProfile]);

  const markNotificationRead = useCallback((id: string) => {
    const store = parseStore(NOTIFY_STORE_KEY) || { version: 1, items: [] };
    const items: AppNotification[] = Array.isArray(store.items) ? store.items : [];
    localStorage.setItem(NOTIFY_STORE_KEY, JSON.stringify({
      version: 1, items: items.map((row) => (row.id === id ? { ...row, read: true } : row)),
    }));
    setStorageTick((value) => value + 1);
  }, []);

  const clearReadNotifications = useCallback(() => {
    const actor = sessionUserRef.current;
    const store = parseStore(NOTIFY_STORE_KEY) || { version: 1, items: [] };
    const items: AppNotification[] = Array.isArray(store.items) ? store.items : [];
    localStorage.setItem(NOTIFY_STORE_KEY, JSON.stringify({
      version: 1, items: items.filter((row) => !(row.read && row.toId === actor?.id)),
    }));
    setStorageTick((value) => value + 1);
  }, []);

  const homeSummary = useMemo(
    () => buildHomeSummary(
      sessionUser, staffStore, growthStore, pointsRows, clockSessions, accessUsers,
      visibleProjectIds(sessionUser, accountingSnapshot.projects).size,
    ),
    [sessionUser, staffStore, growthStore, pointsRows, clockSessions, accessUsers, accountingSnapshot],
  );
  const homeGroup = GROUPS.find((group) => group.label === "Home")!;
  const staffItems = GROUPS.find((group) => group.label === "Timeclock & Performance")!.items;
  const channelGroups: Record<Exclude<NavChannel, "home" | "admin">, Group> = {
    time: {
      label: "Time & Attendance",
      // The native clock and schedule replace the engine's own pages, so those are
      // not listed again here — one Clock In / Out, one Weekly Schedule.
      items: [
        QUICK_CLOCK_ITEM,
        WEEK_SCHEDULE_ITEM,
        REQUESTS_ITEM,
        PRESENCE_ITEM,
        ...["staff-timesheet"]
          .map((id) => staffItems.find((item) => item.id === id)!)
          .filter(Boolean),
      ],
    },
    performance: {
      label: "Performance & Workboard",
      // staff-dashboard / staff-performance / staff-reports resolve to this channel in
      // channelForItem, so they must be listed here or they have no sidebar entry at all.
      items: [
        "performance-center",
        "staff-development",
        "performance-history",
        "staff-performance",
        "staff-dashboard",
        "staff-reports",
      ]
        .map((id) => staffItems.find((item) => item.id === id)!)
        .filter(Boolean),
    },
    hr: GROUPS.find((group) => group.label === "HR & Skills")!,
    accounting: {
      label: "Accounting",
      items: [ACCOUNTING_HUB_ITEM, ...GROUPS.find((group) => group.label === "Accounting")!.items],
    },
  };
  const unreadCount = notifications.filter((row) => row.toId === sessionUser?.id && !row.read).length;
  const adminItem = ITEMS.find((item) => item.id === "admin")!;
  const adminNavItems: Item[] = [
    adminItem,
    ACCESS_ITEM,
    { ...ITEMS.find((item) => item.id === "staff-people")!, label: "Employee Details", description: "Profiles, roles, departments, and notes" },
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
  return (
    <div className={dark ? "unified-app dark" : "unified-app"}>
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
              <span>{initials(sessionUser.name)}</span>
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
            <button type="button" className="menu-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation" aria-expanded={menuOpen} aria-controls="larsa-main-nav">
              <PanelLeftOpen size={20} />
            </button>
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
            {sessionUser && (
              <button type="button" className="theme notif-button" onClick={() => choose(SETTINGS_ITEM, "home")} aria-label={unreadCount ? `${unreadCount} unread notifications` : "Notifications and settings"}>
                <Bell size={18} />
                {unreadCount > 0 && <span className="notif-count">{unreadCount > 9 ? "9+" : unreadCount}</span>}
              </button>
            )}
            {!installed && <button type="button" className="primary" onClick={install}>Install App</button>}
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
              previewUser={startAccessPreview}
              canCreate={Boolean(sessionUser && hasItemPermission(sessionUser, ACCESS_ITEM, "add"))}
              canEdit={Boolean(sessionUser && hasItemPermission(sessionUser, ACCESS_ITEM, "edit"))}
              canDelete={Boolean(sessionUser && hasItemPermission(sessionUser, ACCESS_ITEM, "delete"))}
              openEmployeeDetails={() => {
                const item = ITEMS.find((row) => row.id === "staff-people");
                if (item) choose(item, "admin");
              }}
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
              punchOther={punchOther}
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
          <div className={active.native === "orgStructure" ? "native active" : "native"}>
            <EngineeringManagementPortal viewer={sessionUser} users={accessUsers} sessions={clockSessions} rows={pointsRows} targets={growthStore.pointTargets} go={goToItem} onSaved={() => setStorageTick((tick) => tick + 1)} />
          </div><div className={active.native === "platformSettings" ? "native active" : "native"}><PlatformSettings viewer={sessionUser} users={accessUsers} /></div><div className={active.native === "presence" ? "native active" : "native"}>
            <LivePresence viewer={sessionUser} users={accessUsers} store={staffStore} sessions={clockSessions} go={goToItem} />
          </div>
          <div className={active.native === "settings" ? "native active" : "native"}>
            <MySettings
              user={sessionUser}
              notifications={notifications}
              dark={dark}
              setDark={setDark}
              saveProfile={saveOwnProfile}
              savePrefs={saveNotifyPrefs}
              markRead={markNotificationRead}
              clearRead={clearReadNotifications}
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
              rows={pointsRows}
              sessions={clockSessions}
              targets={growthStore.pointTargets}
              openAdvanced={() => choose(ITEMS.find((item) => item.id === "staff-reports")!, "performance")}
              trimSession={trimSession}
              resetSession={resetSession}
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
            <p className="install-note">The installed app opens in its own window from your home screen, Dock, Start menu, or desktop.</p>
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
                  <label>Employee PIN<input type="password" required inputMode="numeric" value={loginPin} onChange={(event) => setLoginPin(event.target.value.replace(/\D/g, ""))} autoComplete="one-time-code" placeholder="Enter your PIN" /></label>
                  <p className="auth-hint">Quick access to your clock and personal performance points.</p>
                </>
              )}
              <div className="auth-error" role="alert">{loginError}</div>
              <button type="submit" className="auth-submit">Sign In</button><p className="auth-secondary">{loginMode === "email" ? (<button type="button" onClick={() => { setAccessMode("forgot"); setLoginError(""); }}>Forgot password?</button>) : null}{signupOpen ? (<button type="button" onClick={() => { setAccessMode("signup"); setLoginError(""); }}>Create account</button>) : null}</p>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

function EngineeringManagementPortal({
  viewer, users, sessions, rows, targets, go, onSaved,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  sessions: ClockSession[];
  rows: PerformanceRow[];
  targets: Record<string, number>;
  go: (id: string) => void;
  onSaved: () => void;
}) {
  const org = effectiveOrg(users);
  const manages = isResponsibleForOthers(org, viewer, users);
  const [tab, setTab] = useState<"dashboard" | "structure" | "time" | "performance">("dashboard");
  const today = dateInputValue(new Date());
  const start = new Date();
  start.setDate(start.getDate() - 6);
  const [from, setFrom] = useState(dateInputValue(start));
  const [to, setTo] = useState(today);
  const visibleIds = manages ? staffIdsVisibleTo(org, viewer, users) : new Set(viewer ? [viewer.id] : []);
  const visibleUsers = users.filter((user) => user.enabled !== false && visibleIds.has(user.id));
  const filteredSessions = sessions.filter((session) => visibleIds.has(session.uid) && withinDates(session.clockIn.slice(0, 10), from, to));
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
              ? <tr key={row.user.id}><td><b>{row.user.name}</b></td><td>{row.user.department || "—"}</td><td>{row.sessions}</td><td><b>{row.hours.toFixed(2)}</b></td></tr>
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
  const accountingLanding = canOpenInSession(user, ACCOUNTING_HUB_ITEM, method)
    ? ACCOUNTING_HUB_ITEM
    : GROUPS.find((group) => group.label === "Accounting")?.items
      .find((item) => canOpenInSession(user, item, method));
  const hrLanding = GROUPS.find((group) => group.label === "HR & Skills")?.items
    .find((item) => canOpenInSession(user, item, method));
  const timeLanding = ["quick-clock", "week-schedule", "my-requests", "live-presence", "staff-timesheet"]
    .map((id) => ITEMS.find((item) => item.id === id))
    .find((item): item is Item => Boolean(item && canOpenInSession(user, item, method)));
  const performanceLanding = ["performance-center", "staff-development", "performance-history"]
    .map((id) => ITEMS.find((item) => item.id === id))
    .find((item): item is Item => Boolean(item && canOpenInSession(user, item, method)));
  const fullModules = [
    { id: timeLanding?.id || "quick-clock", channel: "time" as const, title: "Time & Attendance", text: "Clock, schedule, leave", icon: Timer, color: "green" },
    { id: performanceLanding?.id || "staff-performance", channel: "performance" as const, title: "Performance", text: "Points, targets, approvals", icon: TrendingUp, color: "violet" },
    { id: "org-structure", channel: "home" as const, title: "Engineering Management", text: "Departments, teams, reports", icon: Network, color: "blue" },      { id: hrLanding?.id || "hr-dashboard", channel: "hr" as const, title: "HR & Skills", text: "People, skills, records", icon: UserRoundSearch, color: "rose" },
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
              <section className={quickAccess ? "module-grid quick-grid" : "module-grid"} aria-label="Available work areas">
        {modules.map((module) => {
          const Icon = module.icon;
          return (
            <button type="button" key={module.id} className={`module-bubble ${module.color}`} onClick={() => open(module.id, module.channel)}>
              <span className="module-blob" aria-hidden="true" />
              <span className="module-orb"><Icon size={28} strokeWidth={2} /></span>
              <span className="module-copy"><b>{module.title}</b><small>{module.text}</small></span>
              <span className="module-open">Open</span>
            </button>
          );
        })}
      </section>
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
      id: "staff-people",
      title: "Employee Details",
      text: "Review staff profiles and manage employee notes",
      icon: UsersRound,
      color: "slate",
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
      <section className="module-grid admin-grid" aria-label="Administrative tools">
        {tools.map((tool) => {
          const Icon = tool.icon;
          return (
            <button type="button" key={tool.id} className={`module-bubble ${tool.color}`} onClick={() => open(tool.id)}>
              <span className="module-orb"><Icon size={28} strokeWidth={2} /></span>
              <span className="module-copy"><b>{tool.title}</b><small>{tool.text}</small></span>
              <span className="module-open">Open</span>
            </button>
          );
        })}
      </section>
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
                    <td><b>{row.Engineer || "Unknown"}</b><small>{row.Department || ""}</small></td>
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
  deleteRecord: (recordId: string) => boolean;
}) {
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
                {canApprove && record.status !== "Approved" && <button type="button" onClick={() => reviewRecord(record.id, "Returned", window.prompt("Feedback for the employee (optional):") || "")}><RotateCcw size={15} /> Return</button>}
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

function PerformanceHistory({
  viewer,
  users,
  rows,
  sessions,
  targets,
  openAdvanced,
  trimSession,
  resetSession,
}: {
  viewer: StaffUser | null;
  users: StaffUser[];
  rows: PerformanceRow[];
  sessions: ClockSession[];
  targets: Record<string, number>;
  openAdvanced: () => void;
  trimSession: (uid: string, clockIn: string, newClockOut: string) => boolean;
  resetSession: (uid: string, clockIn: string) => boolean;
}) {
  const [editing, setEditing] = useState<{ uid: string; clockIn: string } | null>(null);
  const [editValue, setEditValue] = useState("");
  const [reportKind, setReportKind] = useState<"time" | "performance">("time");
  const mayAdjust = Boolean(viewer && (() => {
    const item = ITEMS.find((row) => row.id === "staff-clock");
    return item ? hasItemPermission(viewer, item, "manage") : false;
  })());
  /* datetime-local wants local wall time with no zone, so the ISO stamp has to
     be shifted by the offset first or the field shows the wrong hour. */
  const toLocalInput = (iso: string) => {
    const at = new Date(iso);
    return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  const today = dateInputValue(new Date());
  const prior = new Date();
  prior.setDate(prior.getDate() - 29);
  const [from, setFrom] = useState(dateInputValue(prior));
  const [to, setTo] = useState(today);
  const [employeeId, setEmployeeId] = useState("all");
  const [department, setDepartment] = useState("all");
  // The scope switch answers "whose figures am I looking at". The employee and
  // department pickers below are drill-downs, so they only appear once the
  // chosen scope actually holds more than one person or more than one team.
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
  const departments = [...new Set(visibleUsers.map((user) => user.department || "").filter(Boolean))].sort();
  const selectedUsers = visibleUsers.filter((user) =>
    (employeeId === "all" || user.id === employeeId)
    && (department === "all" || user.department === department));
  const selectedIds = new Set(selectedUsers.map((user) => user.id));
  const filteredSessions = sessions.filter((session) =>
    selectedIds.has(session.uid) && withinDates(session.clockIn.slice(0, 10), from, to));
  const filteredRows = rows.filter((row) =>
    selectedIds.has(rowUserId(row, users)) && withinDates(rowDate(row), from, to));
  const startMs = new Date(`${from || today}T00:00:00`).getTime();
  const endMs = new Date(`${to || today}T23:59:59`).getTime();
  // Whole-week rounding inflated the period target (a 15-day range billed 3 full
  // weeks). Use the real fraction so completion percentages stay honest.
  const weeksInPeriod = Math.max(
    1,
    Math.round(((Math.max(startMs, endMs) - Math.min(startMs, endMs) + 1) / (7 * 86400000)) * 100) / 100,
  );
  /* Jobs delivered comes from the same performance records as the points, so
     the two belong side by side. A job is counted once however many entries
     were logged against it. */
  const jobsIn = (entries: PerformanceRow[]) => new Set(
    entries.map((row) => String(row["Job Number"] || row.Project || "").trim().toLowerCase())
      .filter(Boolean),
  ).size;
  const summaries = selectedUsers.map((user) => {
    const employeeSessions = filteredSessions.filter((session) => session.uid === user.id);
    const employeeRows = filteredRows.filter((row) => rowUserId(row, users) === user.id);
    const hours = employeeSessions.reduce((sum, session) => sum + session.hours, 0);
    const submitted = employeeRows.reduce((sum, row) => sum + finiteNumber(row["Submitted Points"]), 0);
    const approved = employeeRows.reduce((sum, row) => sum + finiteNumber(row["Approved Points"]), 0);
    const target = Math.round((finiteNumber(targets[user.id]) || 50) * weeksInPeriod);
    return { user, hours, submitted, approved, target, jobs: jobsIn(employeeRows) };
  });
  const totalJobs = jobsIn(filteredRows);
  const totalHours = summaries.reduce((sum, row) => sum + row.hours, 0);
  const totalSubmitted = summaries.reduce((sum, row) => sum + row.submitted, 0);
  const totalApproved = summaries.reduce((sum, row) => sum + row.approved, 0);
  const totalTarget = summaries.reduce((sum, row) => sum + row.target, 0);
  const canExport = Boolean(viewer && hasItemPermission(viewer, PERFORMANCE_HISTORY_ITEM, "export"));
  const canOpenAdvanced = Boolean(
    viewer && canOpen(viewer, ITEMS.find((item) => item.id === "staff-reports")!),
  );
  const setPeriod = (period: "today" | "week" | "month" | "sixMonths" | "year") => {
    const end = new Date();
    const start = new Date(end);
    if (period === "week") start.setDate(start.getDate() - 6);
    if (period === "month") start.setDate(start.getDate() - 29);
    if (period === "sixMonths") start.setMonth(start.getMonth() - 6);
    if (period === "year") start.setFullYear(start.getFullYear() - 1);
    setFrom(dateInputValue(start));
    setTo(dateInputValue(end));
  };
  const exportHistory = () => {
    if (reportKind === "time") {
      downloadRows(`larsa-timesheets-${from}-to-${to}.csv`, [
        ["Date", "Employee", "Department", "Hours", "Presence Hours", "Break Hours", "Mode", "Status"],
        ...filteredSessions.map((session) => [
        session.clockIn.slice(0, 10),
        session.employee,
        users.find((user) => user.id === session.uid)?.department || "",
        session.hours.toFixed(2),
        session.presenceHours.toFixed(2),
        session.breakHours.toFixed(2),
        session.mode,
        session.open ? "Open" : "Closed",
        ]),
      ]);
      return;
    }
    downloadRows(`larsa-performance-${from}-to-${to}.csv`, [
      ["Date", "Employee", "Department", "Job Number", "Assigned Points", "Total Points", "Approved Points", "Status"],
      ...filteredRows.map((row) => [
        rowDate(row),
        row.Engineer || "",
        row.Department || "",
        row["Job Number"] || row.Project || "",
        finiteNumber(row["Assigned Points"] ?? row["Estimated Points"]),
        finiteNumber(row["Submitted Points"]),
        finiteNumber(row["Approved Points"]),
        row.Status || "",
      ]),
    ]);
  };

  return (
    <div className="native-scroll history-scroll">
      <section className="overview-hero history-hero">
        <div>
          <span className="eyebrow">Reports</span>
          <h2>Time & Performance</h2>
          <p>Choose one report, a team, and a period.</p>
        </div>
        <div className="hero-actions">
          {canExport && <button type="button" onClick={exportHistory}><FileSpreadsheet size={16} /> Export Records</button>}
          {canOpenAdvanced && <button type="button" className="primary" onClick={openAdvanced}>Advanced Reports <ArrowRight size={16} /></button>}
        </div>
      </section>

      <ScopeSwitch scopes={availableScopes} value={activeScope} onChange={(next) => {
        setScope(next);
        // Drill-downs belong to the scope that was open; carrying them across
        // silently empties the page.
        setEmployeeId("all");
        setDepartment("all");
      }} />

      <div className="settings-tabs history-kind" role="tablist" aria-label="Report type">
        <button type="button" role="tab" aria-selected={reportKind === "time"} className={reportKind === "time" ? "active" : ""} onClick={() => setReportKind("time")}><Timer size={16} /> Timesheets</button>
        <button type="button" role="tab" aria-selected={reportKind === "performance"} className={reportKind === "performance" ? "active" : ""} onClick={() => setReportKind("performance")}><TrendingUp size={16} /> Performance</button>
      </div>

      <div className="period-presets" aria-label="Report period">
        <button type="button" onClick={() => setPeriod("today")}>Today</button>
        <button type="button" onClick={() => setPeriod("week")}>7 days</button>
        <button type="button" onClick={() => setPeriod("month")}>30 days</button>
        <button type="button" onClick={() => setPeriod("sixMonths")}>6 months</button>
        <button type="button" onClick={() => setPeriod("year")}>Year</button>
        <span>Custom</span>
      </div>

      <section className="filter-toolbar history-filters">
        <label><span>From</span><input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
        <label><span>To</span><input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
        {visibleUsers.length > 1 && (
          <label><span>Employee</span><select value={employeeId} onChange={(event) => setEmployeeId(event.target.value)}><option value="all">Everyone in this view</option>{visibleUsers.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select></label>
        )}
        {departments.length > 1 && (
          <label><span>Department</span><select value={department} onChange={(event) => setDepartment(event.target.value)}><option value="all">All departments</option>{departments.map((value) => <option key={value}>{value}</option>)}</select></label>
        )}
      </section>

      {reportKind === "time" ? (
        <section className="metric-grid">
          <article><span><Timer size={19} /></span><small>Total hours</small><b>{totalHours.toFixed(1)}</b><p>{filteredSessions.length} sessions</p></article>
          <article><span><FileClock size={19} /></span><small>Sessions</small><b>{filteredSessions.length}</b><p>{filteredSessions.filter((row) => row.open).length} open now</p></article>
          <article><span><UsersRound size={19} /></span><small>Employees</small><b>{selectedUsers.length}</b><p>{from} to {to}</p></article>
        </section>
      ) : (
        <section className="metric-grid">
          <article><span><TrendingUp size={19} /></span><small>Submitted points</small><b>{totalSubmitted.toLocaleString()}</b><p>{filteredRows.length} entries</p></article>
          <article><span><Award size={19} /></span><small>Approved points</small><b>{totalApproved.toLocaleString()}</b><p>{totalTarget ? Math.round((totalApproved / totalTarget) * 100) : 0}% of target</p></article>
          <article><span><ClipboardCheck size={19} /></span><small>Jobs delivered</small><b>{totalJobs.toLocaleString()}</b><p>{selectedUsers.length} employees</p></article>
        </section>
      )}

      <section className="report-panel">
        <div className="section-head"><div><span className="eyebrow">Period summary</span><h3>All selected employees together</h3></div><span className="black-badge">{from} to {to}</span></div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>{reportKind === "time"
              ? <tr><th>Employee</th><th>Department</th><th>Hours</th><th>Sessions</th></tr>
              : <tr><th>Employee</th><th>Department</th><th>Jobs</th><th>Total</th><th>Approved</th><th>Period Target</th><th>Completion</th></tr>}
            </thead>
            <tbody>
              {summaries.map((row) => {
                const completion = row.target ? Math.round((row.approved / row.target) * 100) : 0;
                const sessionCount = filteredSessions.filter((session) => session.uid === row.user.id).length;
                return reportKind === "time"
                  ? <tr key={row.user.id}><td><b>{row.user.name}</b></td><td>{row.user.department || "—"}</td><td><b>{row.hours.toFixed(2)}</b></td><td>{sessionCount}</td></tr>
                  : <tr key={row.user.id}><td><b>{row.user.name}</b></td><td>{row.user.department || "—"}</td><td>{row.jobs}</td><td>{row.submitted}</td><td><b>{row.approved}</b></td><td>{row.target}</td><td><div className="progress-cell"><div role="progressbar" aria-valuenow={completion} aria-valuemin={0} aria-valuemax={100} aria-label={`${row.user.name} period completion`}><span style={{ width: `${Math.min(100, completion)}%` }} /></div><b>{completion}%</b></div></td></tr>;
              })}
              {!summaries.length && <tr><td colSpan={reportKind === "time" ? 4 : 7}><div className="empty compact">No employees match these filters.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="history-detail-grid">
        {reportKind === "time" && <article className="report-panel">
          <div className="section-head"><div><span className="eyebrow">Attendance detail</span><h3>Clock sessions</h3></div><span className="black-badge">{filteredSessions.length}</span></div>
          <div className="data-table-wrap">
            <table className="data-table compact-table">
              <thead><tr><th>Date</th><th>Employee</th><th>Mode</th><th>Clock In</th><th>Clock Out</th><th>Presence</th><th>Break</th><th>Worked</th>{mayAdjust && <th>Adjust</th>}</tr></thead>
              <tbody>
                {filteredSessions.slice(0, 250).map((session, index) => <tr key={`${session.uid}-${session.clockIn}-${index}`}><td>{session.clockIn.slice(0, 10)}</td><td><b>{session.employee}</b></td><td>{session.mode}</td><td>{new Date(session.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td>{session.open ? "Open now" : new Date(session.clockOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td>{session.presenceHours.toFixed(2)}</td><td>{session.breakHours ? session.breakHours.toFixed(2) : "—"}</td><td><b>{session.hours.toFixed(2)}</b></td>{mayAdjust && <td>
                  {editing && editing.uid === session.uid && editing.clockIn === session.clockIn ? (
                    <div className="session-edit">
                      <input type="datetime-local" value={editValue} max={toLocalInput(new Date().toISOString())} onChange={(event) => setEditValue(event.target.value)} aria-label="New clock-out time" />
                      <button type="button" className="primary" onClick={() => {
                        if (trimSession(session.uid, session.clockIn, new Date(editValue).toISOString())) setEditing(null);
                      }}>Save</button>
                      <button type="button" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="session-edit">
                      <button type="button" onClick={() => {
                        setEditing({ uid: session.uid, clockIn: session.clockIn });
                        setEditValue(toLocalInput(session.open ? new Date().toISOString() : session.clockOut));
                      }}>Trim</button>
                      <button type="button" className="danger" onClick={() => {
                        if (window.confirm(`Remove ${session.employee}'s session starting ${new Date(session.clockIn).toLocaleString()}? This cannot be undone.`)) resetSession(session.uid, session.clockIn);
                      }}>Reset</button>
                    </div>
                  )}
                </td>}</tr>)}
                {!filteredSessions.length && <tr><td colSpan={mayAdjust ? 9 : 8}><div className="empty compact">No clock sessions in this period.</div></td></tr>}
              </tbody>
            </table>
          </div>
        </article>}
        {reportKind === "performance" && <article className="report-panel">
          <div className="section-head"><div><span className="eyebrow">Performance detail</span><h3>Point records</h3></div><span className="black-badge">{filteredRows.length}</span></div>
          <div className="data-table-wrap">
            <table className="data-table compact-table">
              <thead><tr><th>Date</th><th>Employee</th><th>Job</th><th>Total</th><th>Approved</th><th>Status</th></tr></thead>
              <tbody>
                {filteredRows.slice(0, 250).map((row) => <tr key={row.id}><td>{rowDate(row)}</td><td><b>{row.Engineer || "—"}</b></td><td>{String(row["Job Number"] || row.Project || "General")}</td><td>{finiteNumber(row["Submitted Points"])}</td><td>{finiteNumber(row["Approved Points"])}</td><td><span className={`record-status ${String(row.Status || "Draft").toLowerCase().replace(/\s+/g, "-")}`}>{row.Status || "Draft"}</span></td></tr>)}
                {!filteredRows.length && <tr><td colSpan={6}><div className="empty compact">No point records in this period.</div></td></tr>}
              </tbody>
            </table>
          </div>
        </article>}
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

  const remove = (row: ChatMessage) => {
    if (!viewer || !moderator) return;
    if (row.locked) { notify("This message is locked as a permanent record. Unlock it first."); return; }
    if (!window.confirm("Remove this message for everyone? The record of the removal is kept.")) return;
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

function AccessCenter({
  users,
  projects,
  currentUser,
  saveUser,
  deleteUser,
  previewUser,
  canCreate,
  canEdit,
  canDelete,
  openEmployeeDetails,
}: {
  users: StaffUser[];
  projects: AccountingProject[];
  currentUser: StaffUser | null;
  saveUser: (user: StaffUser, isNew: boolean) => boolean;
  deleteUser: (user: StaffUser) => boolean;
  previewUser: (user: StaffUser) => void;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  openEmployeeDetails: () => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<StaffUser | null>(null);
  const [isNew, setIsNew] = useState(false); const [skipInitialVerify, setSkipInitialVerify] = useState(false);
  const [query, setQuery] = useState("");
  const [permissionQuery, setPermissionQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [formError, setFormError] = useState("");
  const [showSecret, setShowSecret] = useState(false);

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
    if (!draft.name.trim() || !draft.password || (!usernameOnly && (!email || !pin))) {
      setFormError(usernameOnly
        ? "Name and password are required."
        : "Name, work email, password, and PIN are required.");
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
    const securedUser: StaffUser = { ...nextUser, password: isHashed(nextUser.password) ? nextUser.password : await hashPassword(String(nextUser.password || "")), pin: !pin ? "" : pinAlreadyStored ? pin : await hashPin(pin) }; if (saveUser(securedUser, isNew)) {
      if (skipInitialVerify && currentUser && currentUser.email) { void (async () => { const client = getSupabaseClient(); if (!client) return; try { await client.functions.invoke("auth-code", { body: { op: "send", email: currentUser.email, purpose: "verify", name: currentUser.name } }); const code = window.prompt("Skipping email verification is a platform change. Enter the code just sent to " + currentUser.email + " to confirm."); if (!code) { setFormError("Not confirmed - " + nextUser.name + " will verify their own email at first sign-in."); return; } const { data } = await client.functions.invoke("auth-policy", { body: { op: "approveUser", actorEmail: currentUser.email, code: code.trim(), userId: nextUser.id, userEmail: nextUser.email, role: nextUser.access } }); if (!data || !(data as { ok?: boolean }).ok) { setFormError("That code was not accepted - " + nextUser.name + " will verify their own email at first sign-in."); } } catch { setFormError("Could not confirm the skip. " + nextUser.name + " will verify their own email at first sign-in."); } })(); } setSkipInitialVerify(false);      setSelectedId(nextUser.id);
      setDraft(securedUser);
      setIsNew(false);
      setFormError("");
    }
  };

  const filteredUsers = users.filter((user) =>
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
  const enabledPermissionCount = draft?.permissionProfile
    ? Object.values(draft.permissionProfile.grants)
        .flatMap((actions) => Object.values(actions))
        .filter(Boolean).length
    : 0;
  const canChangeDraft = isNew ? canCreate : canEdit;
  const removeDraft = () => {
    if (!draft || isNew || !canDelete || protectedAccount) return;
    if (deleteUser(draft)) {
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

      <section className="access-layout">
        <aside className="access-directory">
          <div className="access-directory-head">
            <div><span className="eyebrow">Directory</span><h3>{users.length} users</h3></div>
            <button type="button" className="primary icon-label" onClick={startNewUser} disabled={!canCreate}><Plus size={16} /> New User</button>
          </div>
          <label className="access-search">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search users" />
          </label>
          <div className="access-user-list">
            {filteredUsers.map((user) => (
              <button
                type="button"
                key={user.id}
                className={selectedId === user.id && !isNew ? "access-user active" : "access-user"}
                onClick={() => selectUser(user)}
              >
                <span>{initials(user.name)}</span>
                <span><b>{user.name}</b><small>{user.access || user.role} · {user.department || "No department"}</small></span>
                <i className={user.enabled === false ? "off" : ""} />
              </button>
            ))}
          </div>
          <button type="button" className="directory-link" onClick={openEmployeeDetails}>
            <span><UsersRound size={17} /> Employee details & notes</span><ArrowRight size={16} />
          </button>
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
                    <Trash2 size={14} /> Delete Account
                  </button>
                )}
                {protectedAccount && <span className="protected-badge"><ShieldCheck size={14} /> Protected owner</span>}
                <span className={draft.enabled === false ? "status-badge off" : "status-badge"}>{draft.enabled === false ? "Disabled" : "Active"}</span>
              </div>
            </div>

            <fieldset className="access-edit-fields" disabled={!canChangeDraft}>
            <section className="access-section">
              <div className="access-section-title">
                <div><KeyRound size={18} /><span><b>Sign-in & identity</b><small>Email + password and Employee PIN</small></span></div>
              </div>
              <div className="access-fields">
                <label>Full Name<input value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
                <label>{USERNAME_ONLY_PRESETS.includes(draft.access || "") ? "Email (optional)" : "Work Email"}<input type="email" value={draft.email || ""} onChange={(event) => updateDraft("email", event.target.value)} /></label>
                {USERNAME_ONLY_PRESETS.includes(draft.access || "") ? (
                  <p className="org-note">This account signs in with a username and password only — no email or verification codes. Username: <b>{(draft.username?.trim() || draft.email?.split("@")[0]?.trim() || draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "user")}</b> (PIN optional).</p>
                ) : null}
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
                <label>Job Role<input value={draft.role || ""} onChange={(event) => updateDraft("role", event.target.value)} placeholder="Accountant, Engineer, HR…" /></label>
                <label>Department<input value={draft.department || ""} onChange={(event) => updateDraft("department", event.target.value)} /></label>
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
                    {ROLE_PRESETS.map((role) => <option key={role} value={role} disabled={role === "Super Admin" && !protectedAccount}>{role}</option>)}
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

            {isNew && currentUser && currentUser.platformAdmin ? (<label className="ps-row" style={{ margin: "0 0 10px" }}><input type="checkbox" checked={skipInitialVerify} onChange={(event) => setSkipInitialVerify(event.target.checked)} /><span><b>Skip initial email verification</b><small>You confirm this address instead. They still follow the periodic policy.</small></span></label>) : null}            <div className="access-savebar">
              <div><span className="auth-error">{formError}</span><small>{canChangeDraft ? "Changes apply to menus and actions after saving." : "View-only access: preview is available, but changes are disabled."}</small></div>
              <button type="submit" className="primary icon-label" disabled={!canChangeDraft}><Save size={16} /> Save Access</button>
            </div>
          </form>
        ) : <div className="empty">Select a user to edit access.</div>}
      </section>
    </div>
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
              <span className="presence-meta"><em>{group.id === "off" ? "Not clocked in" : group.label.replace(/^In the |^On /, "")}</em></span>
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
                <th>Submitted</th><th>Type</th><th>Date</th><th>Days / points</th><th>Detail</th><th>Status</th><th>Decided by</th>
              </tr></thead><tbody>
                {mine.map((row) => (
                  <tr key={row.id}>
                    <td>{(row.createdAt || row.date || "").slice(0, 10)}</td>
                    <td><b>{row.entry ? "Late points" : row.type}</b><small>{row.requestType || ""}</small></td>
                    <td>{row.entry ? row.entry.Date : `${row.from} → ${row.to}`}</td>
                    <td>{row.entry ? `${finiteNumber(row.entry["Submitted Points"])} pts` : requestDays(row)}</td>
                    <td>{detailCell(row)}</td>
                    <td>{statusChip(row.status)}</td>
                    <td>{row.decidedBy || "—"}</td>
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
                    <td>{row.entry ? `${finiteNumber(row.entry["Submitted Points"])} pts` : requestDays(row)}</td>
                    <td>{detailCell(row)}</td>
                    <td><div className="review-actions">
                      <button type="button" className="approve" onClick={() => decide(row.id, "Approved")}>Approve</button>
                      <button type="button" onClick={() => decide(row.id, "Rejected", window.prompt("Reason for rejecting (optional):") || "")}>Reject</button>
                    </div></td>
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

function MySettings({
  user, notifications, dark, setDark, saveProfile, savePrefs, markRead, clearRead,
  sendCode, checkCode,
}: {
  user: StaffUser | null;
  notifications: AppNotification[];
  dark: boolean;
  setDark: (value: boolean) => void;
  saveProfile: (patch: Partial<StaffUser>) => boolean;
  savePrefs: (prefs: NotifyPrefs) => boolean;
  markRead: (id: string) => void;
  clearRead: () => void;
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

  const guardedSave = async (patch: Partial<StaffUser>, label: string, done: () => void) => { if (patch.password) patch = { ...patch, password: await hashPassword(patch.password) }; if (patch.pin) patch = { ...patch, pin: await hashPin(patch.pin) };
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
  const [tab, setTab] = useState<"profile" | "security" | "notifications" | "inbox">("profile");
  const [profile, setProfile] = useState({
    email: user?.email || "", phone: user?.phone || "",
    location: user?.location || "", department: user?.department || "",
  });
  const [secret, setSecret] = useState({ password: "", confirm: "", pin: "" });
  const [message, setMessage] = useState("");
  const [pushState, setPushState] = useState<string>("default");
  const prefs = prefsFor(user);

  useEffect(() => {
    setProfile({
      email: user?.email || "", phone: user?.phone || "",
      location: user?.location || "", department: user?.department || "",
    });
    if (typeof Notification !== "undefined") setPushState(Notification.permission);
  }, [user]);

  const mine = notifications.filter((row) => row.toId === user?.id);
  const unread = mine.filter((row) => !row.read).length;

  const askPush = async () => {
    if (typeof Notification === "undefined") { setMessage("This browser does not support push notifications."); return; }
    if (!user?.id) { setMessage("Sign in again before enabling push notifications."); return; }
    // subscribeToPush both asks permission and registers this device with
    // Supabase, so a notification can actually reach it later even fully
    // closed — plain Notification.requestPermission() alone only covers
    // this tab while it's open.
    const outcome = await subscribeToPush(user.id);
    if (typeof Notification !== "undefined") setPushState(Notification.permission);
    setMessage(outcome);
  };
  const toggle = (eventId: string, channel: NotifyChannel, value: boolean) => {
    savePrefs({ ...prefs, [eventId]: { ...prefs[eventId], [channel]: value } });
  };
  const setAll = (channel: NotifyChannel, value: boolean) => {
    const next: NotifyPrefs = {};
    NOTIFY_EVENTS.forEach((event) => { next[event.id] = { ...prefs[event.id], [channel]: value }; });
    savePrefs(next);
  };

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
           ["notifications", "Notifications", Bell], ["inbox", `Inbox${unread ? ` (${unread})` : ""}`, ClipboardList]] as const)
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
            <button type="button" className="primary" onClick={() => {
              const patch: Partial<StaffUser> = {};
              if (secret.password || secret.confirm) {
                if (secret.password.length < 6) { setMessage("Use at least 6 characters for a password."); return; }
                if (secret.password !== secret.confirm) { setMessage("The two passwords do not match."); return; }
                patch.password = secret.password;
              }
              if (secret.pin) {
                if (secret.pin.length < 4 || secret.pin.length > 8) { setMessage("A PIN must be 4 to 8 digits."); return; }
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

      {tab === "notifications" && (
        <section className="settings-panel">
          <div className="section-head">
            <div><span className="eyebrow">Notifications</span><h3>Choose what reaches you, and how</h3></div>
            <button type="button" className="secondary" onClick={askPush}>
              <Bell size={15} /> {pushState === "granted" ? "Push enabled" : "Enable push on this device"}
            </button>
          </div>
          <div className="data-table-wrap">
            <table className="data-table notify-table">
              <thead>
                <tr>
                  <th>Event</th>
                  {(["inApp", "email", "push"] as NotifyChannel[]).map((channel) => (
                    <th key={channel}>
                      {channel === "inApp" ? "In app" : channel === "email" ? "Email" : "Push"}
                      <button type="button" className="col-all" onClick={() => setAll(channel, !NOTIFY_EVENTS.every((event) => prefs[event.id]?.[channel]))}>
                        {NOTIFY_EVENTS.every((event) => prefs[event.id]?.[channel]) ? "None" : "All"}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {NOTIFY_EVENTS.map((event) => (
                  <tr key={event.id}>
                    <td><b>{event.label}</b><small>{event.description}</small></td>
                    {(["inApp", "email", "push"] as NotifyChannel[]).map((channel) => (
                      <td key={channel} className="notify-cell">
                        <input
                          type="checkbox"
                          aria-label={`${event.label}: ${channel}`}
                          checked={Boolean(prefs[event.id]?.[channel])}
                          onChange={(changed) => toggle(event.id, channel, changed.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="builder-note">
            In-app notices appear in your Inbox. Push uses this browser and needs permission once per device.
            Email is recorded against your address and sent by the mail connector when one is configured.
          </p>
        </section>
      )}

      {tab === "inbox" && (
        <section className="settings-panel">
          <div className="section-head">
            <div><span className="eyebrow">Inbox</span><h3>{mine.length} notification{mine.length === 1 ? "" : "s"}</h3></div>
            {mine.some((row) => row.read) && <button type="button" className="secondary" onClick={clearRead}>Clear read</button>}
          </div>
          <div className="inbox-list">
            {mine.map((row) => (
              <button type="button" key={row.id} className={row.read ? "inbox-row" : "inbox-row unread"} onClick={() => markRead(row.id)}>
                <i aria-hidden="true" />
                <span>
                  <b>{row.title}</b>
                  <small>{row.body}</small>
                  <em>{row.fromName} · {new Date(row.at).toLocaleString()}</em>
                </span>
              </button>
            ))}
            {!mine.length && <div className="empty compact">Nothing yet. Notifications appear here as work happens.</div>}
          </div>
        </section>
      )}
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
  autoBuild: (settings: BuildSettings) => boolean;
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
          {canManageAll && <button type="button" onClick={() => autoBuild(build)}><Sparkles size={16} /> Auto Build</button>}
          <button type="button" onClick={() => go("quick-clock")}>Clock In / Out</button>
        </div>
      </section>

      <section className="schedule-summary">
        <article className="home-stat">
          <span><CalendarDays size={18} /></span>
          <div><small>Your week</small><b>{myHours.toFixed(1)} h · {myDaysIn} day{myDaysIn === 1 ? "" : "s"}</b>
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
              <input type="checkbox" checked={build.mondayMeeting}
                onChange={(event) => setBuild({ ...build, mondayMeeting: event.target.checked })} />
              <span><b>Monday meeting for everyone</b><small>16:00 team meeting is mandatory</small></span></label>
          </div>
          <div className="form-actions">
            <button type="button" onClick={() => setBuild(DEFAULT_BUILD)}>Reset</button>
            <button type="button" className="primary" onClick={() => { autoBuild(build); setShowSettings(false); }}>
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
              ? " Every colour is yours to set and is used across the clock, schedule, and reports. Auto Build fills the week to the Larsa coverage rule and keeps the Monday meeting for everyone."
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
  punchBreak, punchOther, submitCorrection, users, trimSession, resetSession,
}: {
  user: StaffUser | null;
  sessions: ClockSession[];
  summary: HomeSummary;
  punch: (mode: string, note?: string) => boolean;
  punchBreak: (note?: string) => boolean;
  punchOther: (targetId: string, mode: string, note?: string) => boolean;
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
  const [otherId, setOtherId] = useState("");
  const [otherMode, setOtherMode] = useState("Office");
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

  const mayClockOthers = Boolean(user && (() => {
    const item = ITEMS.find((row) => row.id === "staff-clock");
    return item ? hasItemPermission(user, item, "manage") : false;
  })());
  const others = users.filter((row) => row.id !== user?.id && row.enabled !== false);
  /* Newest first, across the whole team, so a manager can close someone's
     forgotten clock-out without hunting through the reports. */
  const recentAll = [...sessions]
    .sort((left, right) => new Date(right.clockIn).getTime() - new Date(left.clockIn).getTime())
    .slice(0, 12);
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
  const todaySessions = mine.filter((session) => session.clockIn.slice(0, 10) === todayKey);
  const todayHours = todaySessions.reduce((sum, session) => sum + session.hours, 0);
  const todayPresence = todaySessions.reduce((sum, session) => sum + session.presenceHours, 0);
  const todayBreak = todaySessions.reduce((sum, session) => sum + session.breakHours, 0);
  const weekHours = mine
    .filter((session) => isoWeekLabel(new Date(session.clockIn)) === isoWeekLabel())
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
      const date = session.clockIn.slice(0, 10);
      if (period === "week") return isoWeekLabel(new Date(session.clockIn)) === isoWeekLabel();
      if (period === "month") return date.slice(0, 7) === today.slice(0, 7);
      return withinDates(date, from, to);
    });
    const bucket = { office: 0, online: 0, site: 0, other: 0 };
    inPeriod.forEach((session) => { bucket[modeTone(session.mode)] += session.hours; });
    return {
      ...bucket,
      total: inPeriod.reduce((sum, session) => sum + session.hours, 0),
      count: inPeriod.length,
      days: new Set(inPeriod.map((session) => session.clockIn.slice(0, 10))).size,
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
          <div><small>Today worked</small><b>{todayHours.toFixed(2)} h</b></div>
          <div><small>Today in office</small><b>{todayPresence.toFixed(2)} h</b></div>
          <div><small>This week worked</small><b>{weekHours.toFixed(2)} h</b></div>
          <div><small>Sessions</small><b>{mine.length}</b></div>
        </div>
        {todayBreak > 0 && (
          <p className="clock-break-note">
            {todayBreak.toFixed(2)} h of break deducted today. In-office time counts it, worked hours do not.
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

      {mayClockOthers && (
        <section className="report-panel clock-others">
          <div className="section-head">
            <div><span className="eyebrow">Authorised access</span><h3>Clock someone else in or out</h3></div>
          </div>
          <div className="clock-others-row">
            <label>
              Employee
              <select value={otherId} onChange={(event) => setOtherId(event.target.value)}>
                <option value="">Choose a person…</option>
                {others.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </label>
            <label>
              Mode
              <select value={otherMode} onChange={(event) => setOtherMode(event.target.value)}>
                {WORK_MODES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={!otherId}
              onClick={() => { if (punchOther(otherId, otherMode, note)) { setNote(""); setOtherId(""); } }}
            >Clock In / Out</button>
          </div>
          <p className="clock-others-hint">
            For genuine cases only — a phone left at the desk, a shared terminal. Your name is recorded on every entry.
          </p>
        </section>
      )}

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
        {mayClockOthers && !showCorrection && (
          <button type="button" className="correction-open trim-open" onClick={() => setShowTrim((open) => !open)}>
            <Scissors size={18} />
            <span>
              <b>Trim or remove recorded hours</b>
              <small>Close a forgotten clock-out or delete a session — applies straight away, no approval</small>
            </span>
          </button>
        )}

        {mayClockOthers && showTrim && !showCorrection && (
          <div className="report-panel trim-panel">
            <div className="section-head">
              <div><span className="eyebrow">Direct change · no approval</span><h3>Recent sessions</h3></div>
              <button type="button" className="btn small" onClick={() => { setShowTrim(false); setTrimming(null); }}>Close</button>
            </div>
            {!recentAll.length && <div className="empty compact">No sessions recorded yet.</div>}
            {recentAll.map((session) => {
              const active = trimming && trimming.uid === session.uid && trimming.clockIn === session.clockIn;
              return (
                <div className="trim-row" key={`${session.uid}-${session.clockIn}`}>
                  <div className="trim-who">
                    <b>{session.employee}</b>
                    <small>
                      {new Date(session.clockIn).toLocaleDateString()} ·{" "}
                      {new Date(session.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {" – "}
                      {session.open ? "still open" : new Date(session.clockOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {" · "}{session.hours.toFixed(2)} h worked
                    </small>
                  </div>
                  {active ? (
                    <div className="session-edit">
                      <input type="datetime-local" value={trimValue} max={toLocalInput(new Date().toISOString())} onChange={(event) => setTrimValue(event.target.value)} aria-label="New clock-out time" />
                      <button type="button" className="primary" onClick={() => {
                        if (trimSession(session.uid, session.clockIn, new Date(trimValue).toISOString())) setTrimming(null);
                      }}>Save</button>
                      <button type="button" onClick={() => setTrimming(null)}>Cancel</button>
                    </div>
                  ) : (
                    <div className="session-edit">
                      <button type="button" onClick={() => {
                        setTrimming({ uid: session.uid, clockIn: session.clockIn });
                        setTrimValue(toLocalInput(session.open ? new Date().toISOString() : session.clockOut));
                      }}>Trim</button>
                      <button type="button" className="danger" onClick={() => {
                        if (window.confirm(`Remove ${session.employee}'s session starting ${new Date(session.clockIn).toLocaleString()}? This cannot be undone.`)) resetSession(session.uid, session.clockIn);
                      }}>Reset</button>
                    </div>
                  )}
                </div>
              );
            })}
            <p className="clock-others-hint">
              Trim only accepts an earlier clock-out, so this can reduce recorded time but never create it. To add hours, use Add or fix past hours above — that goes for approval.
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
            <small>Total</small><b>{breakdown.total.toFixed(2)} h</b>
            <em>{breakdown.count} session{breakdown.count === 1 ? "" : "s"} · {breakdown.days} day{breakdown.days === 1 ? "" : "s"}</em>
          </article>
          {(["office", "online", "site", "other"] as const).map((tone) => {
            const value = breakdown[tone];
            if (!value && tone === "other") return null;
            const share = breakdown.total ? Math.round((value / breakdown.total) * 100) : 0;
            return (
              <article className="hours-mode" key={tone}>
                <span className={`mode-chip tone-${tone}`}>{tone === "office" ? "Office" : tone === "online" ? "Online / home" : tone === "site" ? "Site" : "Other"}</span>
                <b>{value.toFixed(2)} h</b>
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
                  <small>{record.completedHours.toFixed(1)} / {record.targetHours.toFixed(1)} h · {record.completedPresentations}/{record.targetPresentations} presentations</small>
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
                  <td>{session.clockIn.slice(0, 10)}</td>
                  <td><span className={`mode-chip tone-${modeTone(session.mode)}`}>{session.mode}</span></td>
                  <td>{new Date(session.clockIn).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{session.open ? "Open now" : new Date(session.clockOut).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td>
                  <td>{session.hours.toFixed(2)}</td>
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
     work date, so changing the date changes the answer -- that is the whole
     point of asking for a date rather than assuming today. */
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
          <span>{initials(user?.name || "")}</span>
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
          {/* Points belong to the day the work happened. Defaulting to today keeps
              the common case one field shorter, while still letting somebody log
              Friday's work on Monday -- into Friday's week, not Monday's. */}
          <label>Work Date<input required type="date" max={today} value={draft.workDate} onChange={(event) => update("workDate", event.target.value)} /></label>
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
          <label>Assigned Points<input type="number" min="0" step="0.5" inputMode="decimal" value={draft.assignedPoints} onChange={(event) => update("assignedPoints", event.target.value)} placeholder="0" /></label>
          <label>Total Points<input required type="number" min="0.5" step="0.5" inputMode="decimal" value={draft.submittedPoints} onChange={(event) => update("submittedPoints", event.target.value)} placeholder="0" /></label>
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
