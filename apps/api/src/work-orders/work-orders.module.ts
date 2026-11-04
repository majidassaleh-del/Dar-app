import { Module } from '@nestjs/common';
import { WorkOrdersController } from './work-orders.controller';

@Module({ controllers: [WorkOrdersController] })
export class WorkOrdersModule {}
