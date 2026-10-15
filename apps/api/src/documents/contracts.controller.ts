import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard.ts';
import { PermissionsGuard } from '../common/guards/permissions.guard.ts';
import { CurrentUser } from '../common/decorators/current-user.decorator.ts';
import { RequirePermissions } from '../common/decorators/permissions.decorator.ts';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.ts';
import { Permission } from '../../../../packages/shared/src/auth/types.ts';
import { ContractDtoSchema, ContractUpdateDtoSchema } from '../../../../packages/shared/src/documents/types.ts';
import type { ContractDto, ContractUpdateDto } from '../../../../packages/shared/src/documents/types.ts';
import type { AuthenticatedUser } from '../../../../packages/shared/src/index.ts';
import { ContractsService } from './contracts.service.ts';

const id = new ParseUUIDPipe({ version: '4' });

/** SRS 7.4 contracts (minimal). Everyone sees their own; contracts.manage sees and edits all. */
@Controller('contracts')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  @Get()
  @RequirePermissions(Permission.DOCUMENTS_USE)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.contracts.list(user);
  }

  @Post()
  @RequirePermissions(Permission.CONTRACTS_MANAGE)
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodValidationPipe(ContractDtoSchema)) dto: ContractDto) {
    return this.contracts.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(Permission.CONTRACTS_MANAGE)
  update(@CurrentUser() user: AuthenticatedUser, @Param('id', id) contractId: string, @Body(new ZodValidationPipe(ContractUpdateDtoSchema)) dto: ContractUpdateDto) {
    return this.contracts.update(user, contractId, dto);
  }
}
