import { Module } from '@nestjs/common';
import { ServersModule } from '../servers/servers.module';
import { PathGuardModule } from '../storage/path-guard.module';
import { ItemRegistryService } from './item-registry.service';
import { ItemsController } from './items.controller';

@Module({
  imports: [ServersModule, PathGuardModule],
  controllers: [ItemsController],
  providers: [ItemRegistryService],
  exports: [ItemRegistryService],
})
export class ItemsModule {}
