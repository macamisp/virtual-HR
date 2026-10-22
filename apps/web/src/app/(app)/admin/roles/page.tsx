'use client';

import { useId, useMemo, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { CUSTOM_ROLE_BASES, PERMISSION_GROUPS, ROLE_DESCRIPTION, ROLE_LABEL, ROLE_PERMISSIONS, visibleAreas } from '@hrvo/shared';
import type { AdminUserRow, CustomRole, Permission, UserRole } from '@hrvo/shared';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useAdminUsers, useAssignRole, useDeleteRole, useRoles, useSaveRole } from '@/lib/admin-queries';
import { useAuthStore } from '@/lib/auth-store';

const LABEL = new Map<string, string>(PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => [i.permission, i.label] as const)));
const label = (p: string) => LABEL.get(p) ?? p;
/** Mirrors the API: an x.all permission covers x.team. */
const holds = (held: readonly string[], p: string) => held.includes(p) || (p.endsWith('.team') && held.includes(`${p.slice(0, -5)}.all`));

interface Draft {
  id: string | null;
  version?: number;
  name: string;
  description: string;
  baseRole: UserRole;
  /** The effective set the admin is building; additions and removals are derived from it. */
  permissions: Set<Permission>;
}

function RoleEditor({ draft, grantable, onClose }: { draft: Draft; grantable: Permission[]; onClose: () => void }) {
  const ids = { name: useId(), desc: useId(), base: useId() };
  const [d, setD] = useState(draft);
  const save = useSaveRole();
  const base = ROLE_PERMISSIONS[d.baseRole];
  const added = [...d.permissions].filter((p) => !base.includes(p));
  const removed = base.filter((p) => !d.permissions.has(p));
  const toggle = (p: Permission) => {
    const next = new Set(d.permissions);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setD({ ...d, permissions: next });
  };
  return (
    <Card data-testid="role-editor">
      <CardHeader><CardTitle className="text-base">{d.id ? `Edit ${draft.name}` : 'New custom role'}</CardTitle></CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ id: d.id, dto: { name: d.name, description: d.description, baseRole: d.baseRole, addedPermissions: added, removedPermissions: removed, version: d.version } }, { onSuccess: onClose });
        }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor={ids.name}>Name</Label><Input id={ids.name} value={d.name} maxLength={80} required onChange={(e) => setD({ ...d, name: e.target.value })} /></div>
            <div className="space-y-1.5"><Label htmlFor={ids.base}>Based on</Label>
              <NativeSelect id={ids.base} value={d.baseRole} onChange={(e) => {
                const b = e.target.value as UserRole;
                setD({ ...d, baseRole: b, permissions: new Set(ROLE_PERMISSIONS[b]) });
              }}>
                {CUSTOM_ROLE_BASES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </NativeSelect>
            </div>
          </div>
          <div className="space-y-1.5"><Label htmlFor={ids.desc}>Description</Label><Textarea id={ids.desc} value={d.description} maxLength={500} rows={2} onChange={(e) => setD({ ...d, description: e.target.value })} /></div>
          <p className="text-sm text-muted-foreground" role="status">{added.length} added, {removed.length} removed compared with {ROLE_LABEL[d.baseRole]}.</p>
          <details className="rounded border p-3" data-testid="role-preview" open>
            <summary className="cursor-pointer text-sm font-medium">Preview: what this role can see</summary>
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {visibleAreas([...d.permissions]).map((a) => <li key={a.key} className={a.visible ? '' : 'text-muted-foreground line-through'}>{a.visible ? '✓' : '✗'} {a.label}</li>)}
            </ul>
          </details>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {PERMISSION_GROUPS.map((g) => (
              <fieldset key={g.group} className="rounded border p-3">
                <legend className="px-1 text-sm font-medium">{g.group}</legend>
                <ul className="space-y-1">
                  {g.items.map((i) => {
                    const on = d.permissions.has(i.permission);
                    const changed = on !== base.includes(i.permission);
                    // You may always remove; you may only add what you hold yourself.
                    const disabled = !on && !holds(grantable, i.permission);
                    return (
                      <li key={i.permission}>
                        <label className="flex items-start gap-2 text-sm">
                          <input type="checkbox" className="mt-0.5" checked={on} disabled={disabled} onChange={() => toggle(i.permission)} />
                          <span className={changed ? 'font-medium' : undefined}>{i.label}{changed ? <span className="sr-only"> (changed)</span> : null}{disabled ? <span className="text-xs text-muted-foreground"> (you do not hold this)</span> : null}<span className="block text-xs font-normal text-muted-foreground">{i.description}</span></span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            ))}
          </div>
          {save.isError ? <Alert variant="destructive"><AlertDescription>{save.error.message}</AlertDescription></Alert> : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending || d.name.trim().length < 2}>{d.id ? 'Save role' : 'Create role'}</Button>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function AssignCell({ row, custom, self }: { row: AdminUserRow; custom: CustomRole[]; self: boolean }) {
  const current = row.customRoleId ? `custom:${row.customRoleId}` : `role:${row.role}`;
  const [value, setValue] = useState(current);
  const assign = useAssignRole();
  const id = useId();
  if (self) return <span className="text-sm text-muted-foreground">You cannot change your own role</span>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="sr-only">Role for {row.displayName ?? row.email}</label>
      <NativeSelect id={id} value={value} onChange={(e) => setValue(e.target.value)}>
        <optgroup label="Built-in">
          {(Object.keys(ROLE_LABEL) as UserRole[]).map((r) => <option key={r} value={`role:${r}`}>{ROLE_LABEL[r]}</option>)}
        </optgroup>
        {custom.length > 0 ? (
          <optgroup label="Custom">
            {custom.map((c) => <option key={c.id} value={`custom:${c.id}`}>{c.name}</option>)}
          </optgroup>
        ) : null}
      </NativeSelect>
      <Button size="sm" variant="outline" disabled={value === current || assign.isPending} onClick={() => {
        const [kind, v] = value.split(':') as ['role' | 'custom', string];
        const c = custom.find((x) => x.id === v);
        assign.mutate({ userId: row.id, dto: kind === 'custom' && c ? { role: c.baseRole, customRoleId: c.id } : { role: v as UserRole, customRoleId: null } });
      }}>Apply</Button>
      {assign.isError ? <span role="alert" className="text-xs text-destructive">{assign.error.message}</span> : null}
    </div>
  );
}

/** FR-ADM-002: built-in roles, custom roles (base + changes) and who holds which. */
export default function RolesPage() {
  const roles = useRoles();
  const users = useAdminUsers();
  const remove = useDeleteRole();
  const me = useAuthStore((s) => s.user?.id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const custom = useMemo(() => roles.data?.custom ?? [], [roles.data]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Roles and permissions</h1>
        {roles.data && !draft ? (
          <Button onClick={() => setDraft({ id: null, name: '', description: '', baseRole: 'EMPLOYEE', permissions: new Set(ROLE_PERMISSIONS.EMPLOYEE) })}><Plus aria-hidden="true" /> New custom role</Button>
        ) : null}
      </div>
      {roles.isPending ? <LoadingState label="Loading roles" rows={4} /> : null}
      {roles.isError ? <ErrorState error={roles.error} onRetry={() => void roles.refetch()} /> : null}
      {draft && roles.data ? <RoleEditor key={draft.id ?? 'new'} draft={draft} grantable={roles.data.grantable} onClose={() => setDraft(null)} /> : null}

      {roles.data ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Custom roles</CardTitle>
            <CardDescription>A built-in role with permissions added or removed. Changes apply to everyone holding the role within seconds.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {custom.length === 0 ? <EmptyState title="No custom roles yet" description="Create one when a built-in role is almost, but not quite, right." /> : null}
            {custom.map((c) => (
              <div key={c.id} className="rounded border p-3" data-testid="custom-role">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{c.name} <span className="text-sm font-normal text-muted-foreground">· based on {ROLE_LABEL[c.baseRole]} · {c.userCount} user{c.userCount === 1 ? '' : 's'}</span></p>
                    {c.description ? <p className="text-sm text-muted-foreground">{c.description}</p> : null}
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setDraft({ id: c.id, version: c.version, name: c.name, description: c.description, baseRole: c.baseRole, permissions: new Set(c.permissions) })}><Pencil aria-hidden="true" /> Edit</Button>
                    <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => { if (window.confirm(`Delete the role “${c.name}”?`)) remove.mutate(c.id); }}><Trash2 aria-hidden="true" /> Delete</Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.addedPermissions.map((p) => <Badge key={p} variant="success">+ {label(p)}</Badge>)}
                  {c.removedPermissions.map((p) => <Badge key={p} variant="destructive">− {label(p)}</Badge>)}
                </div>
              </div>
            ))}
            {remove.isError ? <Alert variant="destructive"><AlertDescription>{remove.error.message}</AlertDescription></Alert> : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">People</CardTitle>
          <CardDescription>You can only give roles whose permissions you hold yourself. Roles that need two-factor authentication sign the person out until they set it up.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {users.isPending ? <div className="p-4"><LoadingState label="Loading people" rows={3} /></div> : null}
          {users.isError ? <div className="p-4"><ErrorState error={users.error} onRetry={() => void users.refetch()} /></div> : null}
          {users.data ? (
            <Table data-testid="role-assignments">
              <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Current role</TableHead><TableHead>Change to</TableHead></TableRow></TableHeader>
              <TableBody>
                {users.data.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell><div className="font-medium">{u.displayName ?? u.email}</div><div className="text-xs text-muted-foreground">{u.email}{u.status !== 'ACTIVE' ? ` · ${u.status.toLowerCase()}` : ''}</div></TableCell>
                    <TableCell>{u.customRoleName ? <>{u.customRoleName} <span className="text-xs text-muted-foreground">({ROLE_LABEL[u.role]})</span></> : ROLE_LABEL[u.role]}</TableCell>
                    <TableCell><AssignCell key={`${u.id}:${u.role}:${u.customRoleId ?? ''}`} row={u} custom={custom} self={u.id === me} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </CardContent>
      </Card>

      {roles.data ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Built-in roles</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {roles.data.builtIn.map((b) => (
              <details key={b.role} className="rounded border p-2">
                <summary className="cursor-pointer text-sm font-medium">{ROLE_LABEL[b.role]} <span className="font-normal text-muted-foreground">· {b.permissions.length} permissions · {ROLE_DESCRIPTION[b.role]}</span></summary>
                <ul className="mt-2 grid gap-x-4 text-sm sm:grid-cols-2">{b.permissions.map((p) => <li key={p}>{label(p)}</li>)}</ul>
              </details>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
