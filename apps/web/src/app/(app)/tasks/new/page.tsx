'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/state-views';
import { TaskForm } from '@/components/tasks/task-form';
import { useTask } from '@/lib/task-queries';

function NewTask() {
  const router = useRouter();
  const params = useSearchParams();
  const parentId = params.get('parent');
  const planned = params.get('planned') ?? undefined;
  return parentId ? <NewSubtask parentId={parentId} /> : (
    <Card>
      <CardHeader><CardTitle>New task</CardTitle></CardHeader>
      <CardContent>
        <TaskForm defaultPlannedDate={planned} onCreated={(t) => router.push(`/tasks/${t.id}`)} onCancel={() => router.back()} />
      </CardContent>
    </Card>
  );
}

function NewSubtask({ parentId }: { parentId: string }) {
  const router = useRouter();
  const parent = useTask(parentId);
  if (parent.isPending) return <LoadingState label="Loading parent task" />;
  if (parent.isError) return <ErrorState error={parent.error} />;
  return (
    <Card>
      <CardHeader><CardTitle>New subtask of “{parent.data.title}”</CardTitle></CardHeader>
      <CardContent>
        <TaskForm parent={parent.data} onCreated={() => router.push(`/tasks/${parentId}`)} onCancel={() => router.back()} />
      </CardContent>
    </Card>
  );
}

export default function NewTaskPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <Suspense fallback={<LoadingState />}>
        <NewTask />
      </Suspense>
    </div>
  );
}
