import { Module } from '@nestjs/common';
import { AccountsController } from './accounts.controller';
import { CardsController } from './cards.controller';
import { CategoriesController } from './categories.controller';
import { TransactionsController } from './transactions.controller';
import { BudgetsController } from './budgets.controller';
import { RecurringController } from './recurring.controller';

@Module({ controllers: [AccountsController, CardsController, CategoriesController, TransactionsController, BudgetsController, RecurringController] })
export class BankingModule {}
