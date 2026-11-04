import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from './config/config.module';
import { DbModule } from './db/db.module';
import { CryptoModule } from './crypto/crypto.module';
import { StaffModule } from './staff/staff.module';
import { RequestsModule } from './requests/requests.module';
import { PettyCashModule } from './petty-cash/petty-cash.module';
import { WorkOrdersModule } from './work-orders/work-orders.module';
import { JwtGuard } from './auth/jwt.guard';
import { HouseholdGuard } from './tenancy/household.guard';
import { ProblemFilter } from './common/problem.filter';
import { HealthController } from './health/health.controller';
import { MembersController } from './members/members.controller';

@Module({
  imports: [ConfigModule, DbModule, CryptoModule, StaffModule, RequestsModule, PettyCashModule, WorkOrdersModule],
  controllers: [HealthController, MembersController],
  providers: [
    // Order matters: authenticate, then resolve the household membership.
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_GUARD, useClass: HouseholdGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class AppModule {}
