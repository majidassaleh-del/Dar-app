import { Global, Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { StorageService } from './storage.service';

@Global()
@Module({ controllers: [FilesController], providers: [StorageService], exports: [StorageService] })
export class FilesModule {}
