'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  teamApi,
  workspacesApi,
  ApiError,
  type TeamMember,
  type Invitation,
  type Workspace,
  type ActivityEntry,
  type TeamRole,
} from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';

const ROLE_DESCRIPTIONS: Record<TeamRole, string> = {
  owner: 'Full control, billing, and team management.',
  admin: 'Manage sites, team, and settings. No billing.',
  editor: 'Create and edit content, audits, keywords.',
  viewer: 'Read-only access to dashboards and reports.',
};

const ASSIGNABLE_ROLES: Array<Exclude<TeamRole, 'owner'>> = ['admin', 'editor', 'viewer'];

function humanAction(a: ActivityEntry): string {
  return a.action.replace(/[._]/g, ' ');
}

/**
 * F-09 — Agency & team page (WIRED, Wave 2): members with roles,
 * email invitations (202 anti-enumeration semantics), client workspaces,
 * activity log. All data is real, from /api/v1/account/*.
 */
export default function TeamPage() {
  const { report } = useErrorReporter();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<TeamRole, 'owner'>>('editor');
  const [inviteErr, setInviteErr] = useState('');
  const [inviteNotice, setInviteNotice] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [wsName, setWsName] = useState('');
  const [wsBusy, setWsBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const loadAll = useCallback(async () => {
    const [m, inv, w, act] = await Promise.allSettled([
      teamApi.members(),
      teamApi.invitations(),
      workspacesApi.list(),
      teamApi.activity(),
    ]);
    if (m.status === 'fulfilled') setMembers(m.value.data);
    else report(m.reason);
    // Invitations/activity require owner/admin; a 403 for editors/viewers
    // is an honest empty state, not a page error.
    if (inv.status === 'fulfilled') setInvitations(inv.value.data);
    else if (inv.reason instanceof ApiError && inv.reason.status === 403) setInvitations([]);
    else report(inv.reason);
    if (w.status === 'fulfilled') setWorkspaces(w.value.data);
    else report(w.reason);
    if (act.status === 'fulfilled') setActivity(act.value.data);
    else if (act.reason instanceof ApiError && act.reason.status === 403) setActivity([]);
    else report(act.reason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviteEmail)) {
      setInviteErr('Enter a valid email address.');
      return;
    }
    setInviteErr('');
    setInviteNotice('');
    setInviteLink('');
    setInviteBusy(true);
    try {
      const res = await teamApi.invite(inviteEmail.trim(), inviteRole);
      // 202 semantics: the API deliberately does not confirm whether the
      // email belongs to an existing account. Show the generic outcome;
      // only in mock-mail mode does the response carry a one-time token.
      if (res.token) {
        setInviteLink(
          `${window.location.origin}/dashboard/team/accept?token=${encodeURIComponent(res.token)}`,
        );
        setInviteNotice(
          'Invitation created. Mail is in dev/mock mode, so the accept link is shown here once — copy it now.',
        );
      } else {
        setInviteNotice(res.message || 'Invitation sent.');
      }
      setInviteEmail('');
      const inv = await teamApi.invitations().catch(() => null);
      if (inv) setInvitations(inv.data);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'USER_EXISTS') {
        setInviteErr('This email is already a member of your workspace.');
      } else {
        report(err);
      }
    } finally {
      setInviteBusy(false);
    }
  };

  const changeRole = async (member: TeamMember, role: Exclude<TeamRole, 'owner'>) => {
    try {
      await teamApi.updateRole(member.id, role);
      setMembers((prev) =>
        prev ? prev.map((m) => (m.id === member.id ? { ...m, role } : m)) : prev,
      );
    } catch (e) {
      report(e);
      const m = await teamApi.members().catch(() => null);
      if (m) setMembers(m.data);
    }
  };

  const removeMember = async (member: TeamMember) => {
    if (!confirm(`Remove ${member.email} from this workspace? They lose access immediately.`)) return;
    try {
      await teamApi.removeMember(member.id);
      setMembers((prev) => (prev ? prev.filter((m) => m.id !== member.id) : prev));
    } catch (e) {
      report(e);
    }
  };

  const revokeInvite = async (inv: Invitation) => {
    try {
      await teamApi.revokeInvitation(inv.id);
      setInvitations((prev) =>
        prev
          ? prev.map((i) => (i.id === inv.id ? { ...i, revoked_at: new Date().toISOString() } : i))
          : prev,
      );
    } catch (e) {
      report(e);
    }
  };

  const addWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = wsName.trim();
    if (!name) return;
    setWsBusy(true);
    try {
      const ws = await workspacesApi.create(name);
      setWorkspaces((prev) => (prev ? [...prev, { ...ws, sites: 0 }] : [ws]));
      setWsName('');
    } catch (err) {
      report(err);
    } finally {
      setWsBusy(false);
    }
  };

  const renameWorkspace = async (ws: Workspace) => {
    if (!renaming || renaming.id !== ws.id || !renaming.name.trim()) return;
    try {
      const updated = await workspacesApi.update(ws.id, renaming.name.trim());
      setWorkspaces((prev) =>
        prev ? prev.map((w) => (w.id === ws.id ? { ...updated, sites: w.sites } : w)) : prev,
      );
      setRenaming(null);
    } catch (e) {
      report(e);
    }
  };

  const deleteWorkspace = async (ws: Workspace) => {
    if (!confirm(`Delete workspace “${ws.name}”? Its sites become agency-level (they are not deleted).`)) return;
    try {
      await workspacesApi.remove(ws.id);
      setWorkspaces((prev) => (prev ? prev.filter((w) => w.id !== ws.id) : prev));
    } catch (e) {
      report(e);
    }
  };

  const pendingInvites = (invitations ?? []).filter((i) => !i.accepted_at && !i.revoked_at);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="bx-micro mb-1">~/ team</p>
        <h1 className="bx-h1">Team & workspaces</h1>
      </div>

      {/* Members */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ members</p>
        <h2 className="text-base font-bold text-white">Team members</h2>
        {members === null ? (
          <p className="mt-3 font-mono text-sm text-white/40">$ loading members…</p>
        ) : members.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">No members found.</p>
        ) : (
          <div className="bx-table-wrap mt-3">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="bx-th">Name</th>
                  <th className="bx-th">Email</th>
                  <th className="bx-th">Role</th>
                  <th className="bx-th">Joined</th>
                  <th className="bx-th">Actions</th>
                </tr>
              </thead>
              <tbody className="bx-tbody">
                {members.map((m) => (
                  <tr key={m.id}>
                    <td className="px-4 py-3 text-white/85">{m.name ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-white/60">{m.email}</td>
                    <td className="px-4 py-3">
                      {m.role === 'owner' ? (
                        <span className="bx-pill bx-pill-ok">
                          <span className="bx-dot" />
                          owner
                        </span>
                      ) : (
                        <select
                          value={m.role}
                          onChange={(e) =>
                            changeRole(m, e.target.value as Exclude<TeamRole, 'owner'>)
                          }
                          className="bx-input !w-auto !px-2 !py-1 !text-xs"
                          aria-label={`Role for ${m.email}`}
                        >
                          {ASSIGNABLE_ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-white/40">
                      {new Date(m.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      {m.role !== 'owner' && (
                        <button onClick={() => removeMember(m)} className="bx-btn-xs-danger">
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
            onChange={(e) => setInviteRole(e.target.value as Exclude<TeamRole, 'owner'>)}
            className="bx-input !w-auto"
            aria-label="Role for invitee"
          >
            <option value="admin">admin</option>
            <option value="editor">editor</option>
            <option value="viewer">viewer</option>
          </select>
          <button type="submit" disabled={inviteBusy} className="bx-btn-primary">
            {inviteBusy ? 'Sending…' : 'Send invite'}
          </button>
        </form>
        {inviteErr && <p className="bx-alert-err mt-3" role="alert">{inviteErr}</p>}
        {inviteNotice && <p className="bx-alert-ok mt-3">{inviteNotice}</p>}
        {inviteLink && (
          <div className="bx-alert-warn mt-3" role="alert">
            <p className="font-semibold">Invite link (dev only — shown once)</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="bx-input font-mono !text-xs">{inviteLink}</code>
              <button
                onClick={() => navigator.clipboard.writeText(inviteLink).catch(() => {})}
                className="bx-btn-xs-secondary"
              >
                Copy
              </button>
            </div>
          </div>
        )}

        {invitations === null ? (
          <p className="mt-4 font-mono text-sm text-white/40">$ loading invitations…</p>
        ) : pendingInvites.length > 0 ? (
          <div className="mt-4">
            <p className="bx-label">Pending invitations</p>
            <ul className="space-y-2">
              {pendingInvites.map((inv) => (
                <li key={inv.id} className="bx-panel flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-mono text-sm text-white/80">{inv.email}</p>
                    <p className="font-mono text-[11px] text-white/40">
                      {inv.role} · expires {new Date(inv.expires_at).toLocaleDateString()}
                    </p>
                  </div>
                  <button onClick={() => revokeInvite(inv)} className="bx-btn-xs-danger">
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-4 text-sm text-white/40">No pending invitations.</p>
        )}
      </div>

      {/* Client workspaces */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ agency</p>
        <h2 className="text-base font-bold text-white">Client workspaces</h2>
        <p className="bx-body mt-1">
          One agency account, separate workspaces per client — each with its own sites, limits, and reports.
        </p>
        {workspaces === null ? (
          <p className="mt-3 font-mono text-sm text-white/40">$ loading workspaces…</p>
        ) : workspaces.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">
            No client workspaces yet — create one below.
          </p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {workspaces.map((w) => (
              <div key={w.id} className="bx-panel">
                {renaming?.id === w.id ? (
                  <div className="flex gap-2">
                    <input
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: w.id, name: e.target.value })}
                      className="bx-input"
                      aria-label="Workspace name"
                    />
                    <button onClick={() => renameWorkspace(w)} className="bx-btn-xs-secondary shrink-0">
                      Save
                    </button>
                    <button onClick={() => setRenaming(null)} className="bx-btn-xs-secondary shrink-0">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <p className="text-sm font-semibold text-white">{w.name}</p>
                )}
                <p className="mt-1 font-mono text-xs text-white/40">
                  {w.sites ?? 0} sites
                  {w.limits?.max_sites ? ` · limit ${w.limits.max_sites} sites` : ''}
                </p>
                {renaming?.id !== w.id && (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => setRenaming({ id: w.id, name: w.name })}
                      className="bx-link text-xs"
                    >
                      Rename
                    </button>
                    <button onClick={() => deleteWorkspace(w)} className="bx-link text-xs !text-red-300">
                      Delete
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <form onSubmit={addWorkspace} className="mt-4 flex gap-2">
          <input
            value={wsName}
            onChange={(e) => setWsName(e.target.value)}
            placeholder="New client workspace name"
            className="bx-input"
            aria-label="New client workspace name"
          />
          <button type="submit" disabled={wsBusy} className="bx-btn-secondary shrink-0">
            {wsBusy ? 'Creating…' : 'Create'}
          </button>
        </form>
      </div>

      {/* Activity log */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ audit trail</p>
        <h2 className="text-base font-bold text-white">Activity log</h2>
        {activity === null ? (
          <p className="mt-3 font-mono text-sm text-white/40">$ loading activity…</p>
        ) : activity.length === 0 ? (
          <p className="mt-3 text-sm text-white/40">No activity recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {activity.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 bx-panel">
                <div>
                  <p className="text-sm text-white/85">
                    <span className="font-semibold">{a.user_email ?? 'system'}</span>{' '}
                    {humanAction(a)}
                  </p>
                  <p className="font-mono text-xs text-white/40">
                    {a.entity_type ?? ''}
                    {a.workspace_name ? ` · ${a.workspace_name}` : ''}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-white/30">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
