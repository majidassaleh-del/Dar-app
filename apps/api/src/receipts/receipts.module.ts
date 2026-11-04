import { Module } from '@nestjs/common';
import { ReceiptsController } from './receipts.controller';
import { OcrService } from './ocr.service';

@Module({ controllers: [ReceiptsController], providers: [OcrService], exports: [OcrService] })
export class ReceiptsModule {}
