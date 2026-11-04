import { Module } from '@nestjs/common';
import { PettyCashController } from './petty-cash.controller';

@Module({ controllers: [PettyCashController] })
export class PettyCashModule {}
