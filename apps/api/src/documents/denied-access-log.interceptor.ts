import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { catchError, from, mergeMap, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import { PrismaService } from '../common/prisma.service.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { logAccess } from './access-log.ts';
import { DocumentForbiddenError, DocumentNotVisibleError } from './documents.sql.ts';

interface Req {
  method?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  route?: { path?: string };
}

/**
 * AC-11 "denied and logged". A refusal rolls back the transaction it happened in, so it cannot
 * log itself; this writes the row in a fresh transaction, then rethrows the unchanged 404 / 403.
 * The log row never changes what the caller sees, and a failing log write never replaces the
 * refusal.
 */
@Injectable()
export class DeniedAccessLogInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (!(err instanceof DocumentNotVisibleError || err instanceof DocumentForbiddenError)) return throwError(() => err);
        const req = context.switchToHttp().getRequest<Req>();
        const user = req.user;
        if (!user) return throwError(() => err);
        const ua = req.headers['user-agent'];
        return from(this.record(user, err, req, typeof ua === 'string' ? ua.slice(0, 400) : null)).pipe(mergeMap(() => throwError(() => err)));
      }),
    );
  }

  private async record(user: AuthenticatedUser, err: DocumentNotVisibleError | DocumentForbiddenError, req: Req, userAgent: string | null): Promise<void> {
    try {
      await this.prisma.runWithTenantContext(user.orgId, (db) =>
        logAccess(db, {
          orgId: user.orgId, documentId: err.documentId, userId: user.id, action: 'ACCESS_DENIED',
          ctx: { ip: req.ip || req.socket?.remoteAddress || null, userAgent },
          // The id is stored in the detail as well: it may not name a document at all.
          detail: { requestedId: err.documentId, method: req.method ?? null, route: req.route?.path ?? null, status: err.getStatus() },
        }));
    } catch (e) {
      console.error('writing the denied-access log entry failed', e instanceof Error ? e.message : 'unknown error');
    }
  }
}
