import { Module } from '@nestjs/common';
import { HrController } from './hr.controller';

@Module({ controllers: [HrController] })
export class HrModule {}
