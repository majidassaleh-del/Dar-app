import { Module } from '@nestjs/common';
import { FleetController } from './fleet.controller';

@Module({ controllers: [FleetController] })
export class FleetModule {}
