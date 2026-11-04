import { Module } from '@nestjs/common';
import { PulseController } from './pulse.controller';
import { BudgetsController } from '../banking/budgets.controller';

@Module({ controllers: [PulseController], providers: [BudgetsController] })
export class DashboardModule {}
