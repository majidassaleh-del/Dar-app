import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { DocumentQueriesController, StaffDocumentsController } from './documents.controller';
import { ContractsController } from './contracts.controller';
import { SalaryPaymentsController } from './salary.controller';
import { AttendanceController } from './attendance.controller';
import { LeaveController } from './leave.controller';
import { PayrollController } from './payroll.controller';
import { PayslipsController } from './payslips.controller';
import { TasksController } from './tasks.controller';

// DocumentQueriesController first: its static "/staff/documents/…" routes must win over "/staff/:id".
@Module({ controllers: [DocumentQueriesController, StaffDocumentsController, ContractsController, SalaryPaymentsController,
  AttendanceController, LeaveController, PayrollController, PayslipsController, TasksController, StaffController] })
export class StaffModule {}
