import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
} from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private schema?: ZodSchema<any>) {}

  transform(value: unknown, metadata: ArgumentMetadata) {
    if (!this.schema || metadata?.type === 'custom') {
      return value;
    }

    if (metadata?.type === 'param' && typeof value === 'string' && 'shape' in (this.schema as any)) {
      return value;
    }

    const result = this.schema.safeParse(value);
    if (!result.success) {
      const error = result.error as ZodError;
      throw new BadRequestException({
        type: 'https://tools.ietf.org/html/rfc7807',
        title: 'Validation Error',
        status: 400,
        detail: 'Request payload failed schema validation',
        errors: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return result.data;
  }
}
