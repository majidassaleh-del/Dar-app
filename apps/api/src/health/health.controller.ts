import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../db/prisma.service';
import { Public } from '../common/decorators';

@Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService) {}

  @Public()
  @Get()
  async check() {
    await this.db.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}
