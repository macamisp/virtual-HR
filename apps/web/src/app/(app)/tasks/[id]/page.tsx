'use client';

import Link from 'next/link';
import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink, Trash2 } from 'lucide-react';
import { TASK_PRIORITIES, TASK_STATUS_LABEL, TASK_TRANSITIONS } from '@hrvo/shared';
import type { TaskActivity, TaskDetail, TaskPriority, TaskStatus } from '@hrvo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FormField } from '@/components/form-field';
import { Markdown } from '@/components/markdown';
import { MarkdownEditor } from '@/components/markdown-editor';
import { EmptyState, ErrorState, LoadingState } from '@/components/state-views';
import { AcceptanceBadge, PriorityBadge, StatusBadge, isOverdue, minutesLabel } from '@/components/tasks/badges';
import { MentionComposer } from '@/components/tasks/mention-composer';
import { TaskTimerCard } from '@/components/timesheets/timer';
import {
  useAddComment,
  useAssignable,
  useDeleteTask,
  useMentionable,
  useProjects,
  useTask,
  useTaskAction,
  useTaskActivity,
  useTaskComments,
  useUpdateTask,
} from '@/lib/task-queries';
import { formatDateTime, toWorkDate } from '@/lib/format';
import { useAuthStore } from '@/lib/auth-store';
import { cn } from '@/lib/utils';

export default function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const task = useTask(id);
  if (task.isPending) return <LoadingState label="Loading task" rows={6} />;
  if (task.isError) {
    return (
      <div className="space-y-4">
        <BackLink />
        <ErrorState error={task.error} onRetry={() => void task.refetch()} />
      </div>
    );
  }
  return <TaskView task={task.data} />;
}

function BackLink() {
  return (
    <Link href="/tasks" className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline">
      <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to tasks
    </Link>
  );
}

function TaskView({ task }: { task: TaskDetail }) {
  const router = useRouter();
  const p = task.permissions;
  const update = useUpdateTask(task.id);
  const del = useDeleteTask();
  const today = toWorkDate(new Date());
  const overdue = isOverdue(task.dueDate, task.status, today);
  const me = useAuthStore((st) => st.user?.id);

  return (
    <div className="space-y-4">
      <BackLink />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold" data-testid="task-title">{task.title}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={task.status} />
            <PriorityBadge priority={task.priority} />
            <AcceptanceBadge status={task.acceptanceStatus} />
            {task.projectCode ? <span className="text-muted-foreground">{task.projectCode}</span> : null}
            {overdue ? <span className="font-medium text-destructive">Overdue</span> : null}
          </div>
        </div>
        {p.canDelete ? (
          <Button
            variant="outline"
            onClick={() => {
              if (window.confirm(`Delete “${task.title}”${task.subtaskCount ? ' and its subtasks' : ''}?`)) {
                del.mutate(task.id, { onSuccess: () => router.push('/tasks') });
              }
            }}
          >
            <Trash2 aria-hidden="true" /> Delete
          </Button>
        ) : null}
      </div>

      {update.isError ? (
        <Alert variant="destructive"><AlertDescription>{update.error.message}</AlertDescription></Alert>
      ) : null}
      <AcceptancePanel task={task} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <DescriptionCard task={task} />
          <ChecklistCard task={task} />
          <SubtasksCard task={task} />
          <AttachmentsCard task={task} />
          <CommentsCard task={task} />
          <ActivityCard taskId={task.id} />
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Status</CardTitle></CardHeader>
            <CardContent>
              <Label htmlFor="status-select" className="sr-only">Change status</Label>
              <NativeSelect
                id="status-select"
                value={task.status}
                disabled={!p.canChangeStatus || update.isPending}
                onChange={(e) => update.mutate({ version: task.version, status: e.target.value })}
              >
                <option value={task.status}>{TASK_STATUS_LABEL[task.status]}</option>
                {TASK_TRANSITIONS[task.status].map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}
              </NativeSelect>
              {!p.canChangeStatus && (task.acceptanceStatus === 'PENDING' || task.acceptanceStatus === 'DECLINED') ? (
                <p className="mt-2 text-xs text-muted-foreground">Accept the task to start working on it.</p>
              ) : null}
            </CardContent>
          </Card>
          <TaskTimerCard
            taskId={task.id}
            canLog={!(task.assignee?.id === me && (task.acceptanceStatus === 'PENDING' || task.acceptanceStatus === 'DECLINED'))}
            blockedReason="Accept the task before logging time on it."
          />
          <DetailsCard task={task} />
          <Card>
            <CardHeader><CardTitle className="text-base">Estimate vs actual</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p>Estimate: <span className="font-medium">{minutesLabel(task.estimateMinutes)}</span></p>
              <p className={cn(task.overrun && 'font-medium text-destructive')}>
                Actual: {task.actualMinutes === null ? <span className="text-muted-foreground">no time logged yet</span> : minutesLabel(task.actualMinutes)}
                {task.overrun ? ' (over estimate)' : ''}
              </p>
              <p className="text-xs text-muted-foreground">Actual = finished timer and manual time on this task.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function AcceptancePanel({ task }: { task: TaskDetail }) {
  const action = useTaskAction(task.id);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  if (task.permissions.canRespond) {
    return (
      <Alert variant="warning" data-testid="acceptance-panel">
        <AlertTitle>{task.reporter.displayName ?? task.reporter.email} assigned this task to you</AlertTitle>
        <AlertDescription className="space-y-3">
          <p>Accept it to start work, or decline with a reason so it can be reassigned.</p>
          {declining ? (
            <div className="space-y-2">
              <Label htmlFor="decline-reason">Reason for declining</Label>
              <Textarea id="decline-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" disabled={reason.trim().length < 5 || action.isPending}
                  onClick={() => action.mutate({ path: '/decline', body: { reason: reason.trim() } })}>Decline task</Button>
                <Button variant="ghost" size="sm" onClick={() => setDeclining(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button size="sm" disabled={action.isPending} onClick={() => action.mutate({ path: '/accept' })}>Accept task</Button>
              <Button size="sm" variant="outline" onClick={() => setDeclining(true)}>Decline…</Button>
            </div>
          )}
          {action.isError ? <p className="font-medium text-destructive">{action.error.message}</p> : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (task.acceptanceStatus === 'DECLINED') {
    return (
      <Alert variant="destructive">
        <AlertTitle>Declined by {task.assignee?.displayName ?? task.assignee?.email}</AlertTitle>
        <AlertDescription>
          “{task.declineReason}”{task.permissions.canAssign ? ' Choose another assignee in Details.' : ''}
        </AlertDescription>
      </Alert>
    );
  }
  if (task.acceptanceStatus === 'PENDING') {
    return (
      <Alert>
        <AlertDescription>
          Waiting for {task.assignee?.displayName ?? task.assignee?.email} to accept.
          {task.escalatedAt ? ` Escalated ${formatDateTime(task.escalatedAt)}.` : ''}
        </AlertDescription>
      </Alert>
    );
  }
  return null;
}

function DescriptionCard({ task }: { task: TaskDetail }) {
  const update = useUpdateTask(task.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.description);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Description</CardTitle>
        {task.permissions.canEdit && !editing ? (
          <Button size="sm" variant="ghost" onClick={() => { setDraft(task.description); setEditing(true); }}>Edit</Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="space-y-2">
            <MarkdownEditor label="Description" value={draft} onChange={setDraft} rows={8} maxLength={20_000} />
            <div className="flex gap-2">
              <Button size="sm" disabled={update.isPending}
                onClick={() => update.mutate({ version: task.version, description: draft }, { onSuccess: () => setEditing(false) })}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : task.description.trim() ? (
          <Markdown source={task.description} />
        ) : (
          <p className="text-sm text-muted-foreground">No description.</p>
        )}
      </CardContent>
    </Card>
  );
}

function DetailsCard({ task }: { task: TaskDetail }) {
  const p = task.permissions;
  const update = useUpdateTask(task.id);
  const projects = useProjects();
  const assignable = useAssignable(task.projectId ?? undefined);
  const myId = useAuthStore((s) => s.user?.id);
  const isAssignee = !!task.assignee && task.assignee.id === myId;
  const save = (patch: Record<string, unknown>) => update.mutate({ version: task.version, ...patch });

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-1.5">
          <Label htmlFor="d-assignee">Assignee</Label>
          {p.canAssign ? (
            <NativeSelect id="d-assignee" value={task.assignee?.id ?? ''} onChange={(e) => save({ assigneeId: e.target.value || null })}>
              <option value="">Unassigned</option>
              {task.assignee && !(assignable.data ?? []).some((u) => u.id === task.assignee!.id) ? (
                <option value={task.assignee.id}>{task.assignee.displayName ?? task.assignee.email}</option>
              ) : null}
              {(assignable.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.displayName ?? u.email}</option>)}
            </NativeSelect>
          ) : (
            <p id="d-assignee">{task.assignee ? task.assignee.displayName ?? task.assignee.email : 'Unassigned'}</p>
          )}
        </div>
        <p><span className="text-muted-foreground">Reporter:</span> {task.reporter.displayName ?? task.reporter.email}</p>
        <div className="space-y-1.5">
          <Label htmlFor="d-priority">Priority</Label>
          <NativeSelect id="d-priority" value={task.priority} disabled={!p.canEdit} onChange={(e) => save({ priority: e.target.value as TaskPriority })}>
            {TASK_PRIORITIES.map((pr) => <option key={pr} value={pr}>{pr.charAt(0) + pr.slice(1).toLowerCase()}</option>)}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="d-project">Project</Label>
          <NativeSelect id="d-project" value={task.projectId ?? ''} disabled={!p.canEdit || !!task.parentTaskId} onChange={(e) => save({ projectId: e.target.value || null })}>
            <option value="">No project</option>
            {(projects.data ?? []).map((pr) => <option key={pr.id} value={pr.id}>{pr.code} · {pr.name}</option>)}
          </NativeSelect>
        </div>
        <DateField label="Due date" value={task.dueDate} disabled={!p.canEdit} onSave={(v) => save({ dueDate: v })} />
        <DateField label="Planned for" value={task.plannedDate} disabled={!p.canEdit && !isAssignee} onSave={(v) => save({ plannedDate: v })} />
        <EstimateField value={task.estimateMinutes} disabled={!p.canEdit} onSave={(v) => save({ estimateMinutes: v })} />
        <LabelsField value={task.labels} disabled={!p.canEdit} onSave={(v) => save({ labels: v })} />
        {task.parentTaskId ? <p><Link className="text-primary underline" href={`/tasks/${task.parentTaskId}`}>Open parent task</Link></p> : null}
        <p className="text-xs text-muted-foreground">Created {formatDateTime(task.createdAt)} · updated {formatDateTime(task.updatedAt)}</p>
      </CardContent>
    </Card>
  );
}

function DateField({ label, value, disabled, onSave }: { label: string; value: string | null; disabled: boolean; onSave: (v: string | null) => void }) {
  return (
    <FormField label={label} type="date" defaultValue={value ?? ''} key={value ?? ''} disabled={disabled}
      onBlur={(e) => { const v = e.target.value || null; if (v !== value) onSave(v); }} />
  );
}

function EstimateField({ value, disabled, onSave }: { value: number | null; disabled: boolean; onSave: (v: number | null) => void }) {
  return (
    <FormField label="Estimate (hours)" type="number" min={0} step={0.25} key={String(value)} defaultValue={value === null ? '' : String(value / 60)} disabled={disabled}
      onBlur={(e) => {
        const raw = e.target.value.trim();
        const minutes = raw === '' ? null : Math.round(Number(raw) * 60);
        if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0)) return;
        if (minutes !== value) onSave(minutes);
      }} />
  );
}

function LabelsField({ value, disabled, onSave }: { value: string[]; disabled: boolean; onSave: (v: string[]) => void }) {
  return (
    <FormField label="Labels" key={value.join(',')} defaultValue={value.join(', ')} disabled={disabled} hint="Comma-separated"
      onBlur={(e) => {
        const next = e.target.value.split(',').map((l) => l.trim()).filter(Boolean);
        if (next.join(',') !== value.join(',')) onSave(next);
      }} />
  );
}

function ChecklistCard({ task }: { task: TaskDetail }) {
  const action = useTaskAction(task.id);
  const [text, setText] = useState('');
  const canTick = task.permissions.canEdit || task.permissions.canChangeStatus;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Checklist {task.checklistTotal > 0 ? `(${task.checklistDone}/${task.checklistTotal})` : ''}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {task.checklist.length === 0 ? <p className="text-sm text-muted-foreground">No checklist items.</p> : null}
        <ul className="space-y-1" data-testid="checklist">
          {task.checklist.map((item) => (
            <li key={item.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" id={`cl-${item.id}`} className="h-4 w-4" checked={item.done} disabled={!canTick || action.isPending}
                onChange={(e) => action.mutate({ path: `/checklist/${item.id}`, method: 'PATCH', body: { done: e.target.checked } })} />
              <label htmlFor={`cl-${item.id}`} className={cn(item.done && 'text-muted-foreground line-through')}>{item.text}</label>
              {canTick ? (
                <Button size="sm" variant="ghost" className="ml-auto h-7" aria-label={`Remove “${item.text}”`}
                  onClick={() => action.mutate({ path: `/checklist/${item.id}`, method: 'DELETE' })}>Remove</Button>
              ) : null}
            </li>
          ))}
        </ul>
        {canTick ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) action.mutate({ path: '/checklist', body: { text: text.trim() } }, { onSuccess: () => setText('') }); }}>
            <Label htmlFor="cl-new" className="sr-only">New checklist item</Label>
            <Input id="cl-new" placeholder="Add an item" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} />
            <Button type="submit" variant="secondary" disabled={!text.trim() || action.isPending}>Add</Button>
          </form>
        ) : null}
        {action.isError ? <p className="text-sm font-medium text-destructive">{action.error.message}</p> : null}
      </CardContent>
    </Card>
  );
}

function SubtasksCard({ task }: { task: TaskDetail }) {
  if (task.parentTaskId) return null;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Subtasks</CardTitle>
        {task.permissions.canEdit ? (
          <Button asChild size="sm" variant="secondary"><Link href={`/tasks/new?parent=${task.id}`}>Add subtask</Link></Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {task.subtasks.length === 0 ? <p className="text-sm text-muted-foreground">No subtasks.</p> : (
          <ul className="divide-y">
            {task.subtasks.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <Link href={`/tasks/${s.id}`} className="text-primary underline-offset-4 hover:underline">{s.title}</Link>
                <span className="flex items-center gap-2"><StatusBadge status={s.status} />{s.assignee?.displayName ?? ''}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AttachmentsCard({ task }: { task: TaskDetail }) {
  const action = useTaskAction(task.id);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const canAdd = task.permissions.canEdit || task.permissions.canChangeStatus;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Attachments</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">Links to files (https). Uploading files arrives with the Documents module.</p>
        {task.attachments.length === 0 ? <p className="text-sm text-muted-foreground">No attachments.</p> : (
          <ul className="space-y-1">
            {task.attachments.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-primary underline">
                  {a.name} <ExternalLink className="h-3 w-3" aria-hidden="true" /><span className="sr-only">(opens in a new tab)</span>
                </a>
                <span className="text-xs text-muted-foreground">by {a.addedBy.displayName ?? a.addedBy.email}</span>
                {canAdd ? (
                  <Button size="sm" variant="ghost" className="ml-auto h-7" aria-label={`Remove attachment ${a.name}`}
                    onClick={() => action.mutate({ path: `/attachments/${a.id}`, method: 'DELETE' })}>Remove</Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canAdd ? (
          <form className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]" onSubmit={(e) => {
            e.preventDefault();
            action.mutate({ path: '/attachments', body: { name: name.trim(), url: url.trim() } }, { onSuccess: () => { setName(''); setUrl(''); } });
          }}>
            <div><Label htmlFor="att-name" className="sr-only">Attachment name</Label><Input id="att-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div><Label htmlFor="att-url" className="sr-only">Attachment link</Label><Input id="att-url" type="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} /></div>
            <Button type="submit" variant="secondary" disabled={!name.trim() || !url.trim() || action.isPending}>Add link</Button>
          </form>
        ) : null}
        {action.isError ? <p className="text-sm font-medium text-destructive">{action.error.message}</p> : null}
      </CardContent>
    </Card>
  );
}

function CommentsCard({ task }: { task: TaskDetail }) {
  const comments = useTaskComments(task.id);
  const mentionable = useMentionable(task.id);
  const add = useAddComment(task.id);
  const [body, setBody] = useState('');
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Comments</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {comments.isPending ? <LoadingState label="Loading comments" rows={2} /> : null}
        {comments.isError ? <ErrorState error={comments.error} onRetry={() => void comments.refetch()} /> : null}
        {comments.data && comments.data.length === 0 ? <EmptyState title="No comments yet" /> : null}
        <ol className="space-y-3" data-testid="comments">
          {(comments.data ?? []).map((c) => (
            <li key={c.id} className="rounded-md border p-3">
              <p className="mb-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{c.author.displayName ?? c.author.email}</span> · {formatDateTime(c.createdAt)}
              </p>
              <Markdown source={c.body} />
            </li>
          ))}
        </ol>
        {task.permissions.canComment ? (
          <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(body.trim(), { onSuccess: () => setBody('') }); }}>
            <MentionComposer label="Add a comment" value={body} onChange={setBody} candidates={mentionable.data ?? []} />
            {add.isError ? <p className="text-sm font-medium text-destructive">{add.error.message}</p> : null}
            <Button type="submit" disabled={!body.trim() || add.isPending}>{add.isPending ? 'Posting…' : 'Comment'}</Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

function describe(a: TaskActivity): string {
  const d = a.data;
  switch (a.type) {
    case 'CREATED': return 'created the task';
    case 'STATUS_CHANGED': return `moved it from ${TASK_STATUS_LABEL[d.from as TaskStatus] ?? d.from} to ${TASK_STATUS_LABEL[d.to as TaskStatus] ?? d.to}`;
    case 'ASSIGNED': return d.to ? 'changed the assignee' : 'unassigned the task';
    case 'ACCEPTED': return 'accepted the task';
    case 'DECLINED': return `declined: “${String(d.reason ?? '')}”`;
    case 'ESCALATED': return 'escalated the unaccepted task';
    case 'COMMENTED': return Number(d.mentions) > 0 ? 'commented and mentioned someone' : 'commented';
    case 'CHECKLIST_CHANGED': return d.added ? `added “${String(d.added)}” to the checklist` : d.removed ? `removed “${String(d.removed)}” from the checklist` : `${d.done ? 'ticked' : 'unticked'} “${String(d.item)}”`;
    case 'ATTACHMENT_ADDED': return `attached “${String(d.name)}”`;
    case 'ATTACHMENT_REMOVED': return `removed attachment “${String(d.name)}”`;
    case 'UPDATED': return `updated ${Object.keys((d.changes as Record<string, unknown>) ?? {}).join(', ') || 'the task'}`;
    case 'DELETED': return 'deleted the task';
    default: return a.type.toLowerCase();
  }
}

function ActivityCard({ taskId }: { taskId: string }) {
  const activity = useTaskActivity(taskId);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Activity</CardTitle></CardHeader>
      <CardContent>
        {activity.isPending ? <LoadingState label="Loading activity" rows={2} /> : null}
        {activity.isError ? <ErrorState error={activity.error} onRetry={() => void activity.refetch()} /> : null}
        <ol className="space-y-2 text-sm" data-testid="activity">
          {(activity.data ?? []).slice().reverse().map((a) => (
            <li key={String(a.id)}>
              <span className="font-medium">{a.actor.displayName ?? a.actor.email}</span> {describe(a)}
              <span className="block text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</span>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
