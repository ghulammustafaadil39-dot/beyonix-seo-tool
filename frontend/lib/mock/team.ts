/**
 * lib/mock/team.ts — F-09 Agency & team UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead):
 *   GET/POST/DELETE /api/v1/team/members, /invites, /activity
 *   GET/POST /api/v1/team/workspaces (client workspaces)
 * Rendered with <MockBanner/>.
 */

export type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  status: 'active' | 'invited';
  joined_at: string;
}

export interface ActivityEntry {
  id: string;
  actor: string;
  action: string;
  detail: string;
  at: string;
}

export interface ClientWorkspace {
  id: string;
  name: string;
  sites: number;
  plan: string;
  members: number;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockMembers(): Promise<TeamMember[]> {
  await delay(250);
  return [
    { id: 'tm_1', name: 'A. Khan', email: 'owner@example.com', role: 'owner', status: 'active', joined_at: '2026-06-01T10:00:00Z' },
    { id: 'tm_2', name: 'S. Ahmed', email: 'editor@example.com', role: 'editor', status: 'active', joined_at: '2026-08-14T10:00:00Z' },
    { id: 'tm_3', name: '—', email: 'viewer@example.com', role: 'viewer', status: 'invited', joined_at: '2026-10-09T10:00:00Z' },
  ];
}

export async function mockActivity(): Promise<ActivityEntry[]> {
  await delay(250);
  return [
    { id: 'a1', actor: 'S. Ahmed', action: 'approved content', detail: '“Invoicing software guide” → approved', at: '2026-10-10T15:32:00Z' },
    { id: 'a2', actor: 'A. Khan', action: 'started audit', detail: 'example.com — 59 pages', at: '2026-10-10T09:12:00Z' },
    { id: 'a3', actor: 'system', action: 'rank alert', detail: '3 keywords dropped >5 positions', at: '2026-10-09T08:00:00Z' },
  ];
}

export async function mockWorkspaces(): Promise<ClientWorkspace[]> {
  await delay(250);
  return [
    { id: 'w1', name: 'Acme Corp', sites: 2, plan: 'growth', members: 3 },
    { id: 'w2', name: 'Bakery Ltd', sites: 1, plan: 'starter', members: 1 },
  ];
}

export const ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  owner: 'Full control, billing, and team management.',
  admin: 'Manage sites, team, and settings. No billing.',
  editor: 'Create and edit content, audits, keywords.',
  viewer: 'Read-only access to dashboards and reports.',
};
