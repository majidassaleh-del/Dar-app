import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { DocumentQueriesController, StaffDocumentsController } from './documents.controller';
import { ContractsController } from './contracts.controller';
import { SalaryPaymentsController } from './salary.controller';

// DocumentQueriesController first: its static "/staff/documents/…" routes must win over "/staff/:id".
@Module({ controllers: [DocumentQueriesController, StaffDocumentsController, ContractsController, SalaryPaymentsController, StaffController] })
export class StaffModule {}
