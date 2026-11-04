import { Module } from '@nestjs/common';
import { HrController } from './hr.controller';
import { LaborController } from './labor.controller';

@Module({ controllers: [HrController, LaborController] })
export class HrModule {}
