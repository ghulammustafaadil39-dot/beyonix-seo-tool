'use client';

import { useEffect, useState } from 'react';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockMembers,
  mockActivity,
  mockWorkspaces,
  ROLE_DESCRIPTIONS,
  type TeamMember,
  type ActivityEntry,
  type ClientWorkspace,
  type TeamRole,
} from '@/lib/mock/team';
import { useErrorReporter } from '@/components/ErrorBanner';
import MockBanner from '@/components/MockBanner';

/**
 * F-09 — Agency & team page: members with roles, invitations by email,
 * client workspaces under one agency account, activity log.
 * Fully mock-backed (bannered) until the endpoints land.
 */
export default function TeamPage() {
  const { report } = useErrorReporter();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [workspaces, setWorkspaces] = useState<ClientWorkspace[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TeamRole>('editor');
  const [inviteErr, setInviteErr] = useState('');
  const [wsName, setWsName] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const [m, a, w] = await Promise.all([
          withMockFallback(() => notLandedYet<TeamMember[]>(), mockMembers),
          withMockFallback(() => notLandedYet<ActivityEntry[]>(), mockActivity),
          withMockFallback(() => notLandedYet<ClientWorkspace[]>(), mockWorkspaces),
        ]);
        setMembers(m.data);
        setActivity(a.data);
        setWorkspaces(w.data);
      } catch (e) {
        report(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteEmail)) {
      setInviteErr('Enter a valid email address.');
      return;
    }
    setInviteErr('');
    setMembers((prev) => [
      ...prev,
      {
        id: `local_${Date.now()}`,
        name: '—',
        email: inviteEmail,
        role: inviteRole,
        status: 'invited',
        joined_at: new Date().toISOString(),
      },
    ]);
    setInviteEmail('');
  };

  const addWorkspace = (e: React.FormEvent) => {
    e.preventDefault();
    const name = wsName.trim();
    if (!name) return;
    setWorkspaces((prev) => [
      ...prev,
      { id: `local_${Date.now()}`, name, sites: 0, plan: 'starter', members: 1 },
    ]);
    setWsName('');
  };

  const changeRole = (id: string, role: TeamRole) =>
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, role } : m)));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="bx-micro mb-1">~/ team</p>
        <h1 className="bx-h1">Team & workspaces</h1>
      </div>
      <div><MockBanner label="team & agency" /></div>

      {/* Members */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ members</p>
        <h2 className="text-base font-bold text-white">Team members</h2>
        <div className="bx-table-wrap mt-3">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="border-b border-white/10">
                <th className="bx-th">Name</th>
                <th className="bx-th">Email</th>
                <th className="bx-th">Role</th>
                <th className="bx-th">Status</th>
              </tr>
            </thead>
            <tbody className="bx-tbody">
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-3 text-white/85">{m.name}</td>
                  <td className="px-4 py-3 font-mono text-white/60">{m.email}</td>
                  <td className="px-4 py-3">
                    <select
                      value={m.role}
                      onChange={(e) => changeRole(m.id, e.target.value as TeamRole)}
                      className="bx-input !w-auto !px-2 !py-1 !text-xs"
                      aria-label={`Role for ${m.email}`}
                      disabled={m.role === 'owner'}
                    >
                      {Object.keys(ROLE_DESCRIPTIONS).map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`bx-pill ${m.status === 'active' ? 'bx-pill-ok' : 'bx-pill-warn'}`}>
                      <span className="bx-dot" />
                      {m.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(ROLE_DESCRIPTIONS) as TeamRole[]).map((r) => (
            <p key={r} className="font-mono text-[11px] text-white/40">
              <span className="font-semibold text-white/60">{r}</span> — {ROLE_DESCRIPTIONS[r]}
            </p>
          ))}
        </div>
      </div>

      {/* Invite */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ invite</p>
        <h2 className="text-base font-bold text-white">Invite by email</h2>
        <form onSubmit={invite} className="mt-3 flex flex-wrap gap-2">
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="colleague@company.com"
            className="bx-input min-w-[220px] flex-1"
            aria-label="Email to invite"
          />
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as TeamRole)}
            className="bx-input !w-auto"
            aria-label="Role for invitee"
          >
            <option value="admin">admin</option>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
          <button type="submit" className="bx-btn-primary">
            Send invite
          </button>
        </form>
        {inviteErr && <p className="bx-alert-err mt-3" role="alert">{inviteErr}</p>}
      </div>

      {/* Client workspaces */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ agency</p>
        <h2 className="text-base font-bold text-white">Client workspaces</h2>
        <p className="bx-body mt-1">
          One agency account, separate workspaces per client — each with its own sites, limits, and reports.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {workspaces.map((w) => (
            <div key={w.id} className="bx-panel">
              <p className="text-sm font-semibold text-white">{w.name}</p>
              <p className="mt-1 font-mono text-xs text-white/40">
                {w.sites} sites · {w.plan} · {w.members} members
              </p>
              <button className="bx-link mt-2 text-xs">Open workspace →</button>
            </div>
          ))}
        </div>
        <form onSubmit={addWorkspace} className="mt-4 flex gap-2">
          <input
            value={wsName}
            onChange={(e) => setWsName(e.target.value)}
            placeholder="New client workspace name"
            className="bx-input"
            aria-label="New client workspace name"
          />
          <button type="submit" className="bx-btn-secondary shrink-0">
            Create
          </button>
        </form>
      </div>

      {/* Activity log */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ audit trail</p>
        <h2 className="text-base font-bold text-white">Activity log</h2>
        <ul className="mt-3 space-y-2">
          {activity.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 bx-panel">
              <div>
                <p className="text-sm text-white/85">
                  <span className="font-semibold">{a.actor}</span> {a.action}
                </p>
                <p className="font-mono text-xs text-white/40">{a.detail}</p>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-white/30">
                {new Date(a.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
