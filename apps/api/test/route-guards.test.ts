/**
 * Safety net: no route is open by default. Every HTTP route of every controller must say so
 * explicitly with a permission decorator, @Public() or @SelfService(), and every route that is not
 * public must be behind JwtAuthGuard and PermissionsGuard. A new route that forgets all of these
 * fails here instead of silently going live without a permission check.
 */
import 'reflect-metadata';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { NestFactory, ModulesContainer } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../src/app.module.ts';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator.ts';
import { PERMISSIONS_ANY_KEY, PERMISSIONS_KEY } from '../src/common/decorators/permissions.decorator.ts';
import { SELF_SERVICE_KEY } from '../src/common/decorators/self-service.decorator.ts';
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../src/common/guards/permissions.guard.ts';

type Fn = (...args: unknown[]) => unknown;
const GUARDS = '__guards__';
const PATH = 'path';
const METHOD = 'method';

interface Route { id: string; handler: Fn; controller: Function }

describe('Every route declares how it is protected', () => {
  let ctx: INestApplicationContext;
  const routes: Route[] = [];

  before(async () => {
    process.env.JOBS_ENABLED = 'false';
    process.env.MAIL_TRANSPORT = 'memory';
    ctx = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const wrappers = [...ctx.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()]);
    for (const wrapper of wrappers) {
      const controller = wrapper.metatype;
      if (!controller || !wrapper.instance) continue;
      const proto = Object.getPrototypeOf(wrapper.instance) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = proto[name];
        if (name === 'constructor' || typeof handler !== 'function') continue;
        if (Reflect.getMetadata(METHOD, handler) === undefined || Reflect.getMetadata(PATH, handler) === undefined) continue;
        routes.push({ id: `${controller.name}.${name}`, handler: handler as Fn, controller });
      }
    }
  });

  after(async () => { await ctx?.close(); });

  const meta = (key: string, r: Route): unknown => Reflect.getMetadata(key, r.handler) ?? Reflect.getMetadata(key, r.controller);
  const guards = (r: Route): unknown[] => [...(Reflect.getMetadata(GUARDS, r.controller) ?? []), ...(Reflect.getMetadata(GUARDS, r.handler) ?? [])];

  it('finds the routes (the scan itself works)', () => {
    assert.ok(routes.length > 200, `only ${routes.length} routes found`);
  });

  it('each route has a permission decorator, @Public() or @SelfService()', () => {
    const open = routes.filter((r) => {
      const perms = meta(PERMISSIONS_KEY, r) as unknown[] | undefined;
      const any = meta(PERMISSIONS_ANY_KEY, r) as unknown[] | undefined;
      return !(perms?.length || any?.length) && !meta(IS_PUBLIC_KEY, r) && !meta(SELF_SERVICE_KEY, r);
    });
    assert.deepEqual(open.map((r) => r.id), [], 'routes with no permission, @Public() or @SelfService()');
  });

  it('a route is not both public and permission-protected, or both public and self-service', () => {
    const muddled = routes.filter((r) => {
      const isPublic = !!meta(IS_PUBLIC_KEY, r);
      const perms = (meta(PERMISSIONS_KEY, r) as unknown[] | undefined)?.length || (meta(PERMISSIONS_ANY_KEY, r) as unknown[] | undefined)?.length;
      return isPublic && (perms || meta(SELF_SERVICE_KEY, r));
    });
    assert.deepEqual(muddled.map((r) => r.id), []);
  });

  it('every non-public route is behind JwtAuthGuard and PermissionsGuard', () => {
    const unguarded = routes.filter((r) => {
      if (meta(IS_PUBLIC_KEY, r)) return false;
      const g = guards(r);
      return !(g.includes(JwtAuthGuard) && g.includes(PermissionsGuard));
    });
    assert.deepEqual(unguarded.map((r) => r.id), [], 'protected routes without JwtAuthGuard + PermissionsGuard');
  });
});
