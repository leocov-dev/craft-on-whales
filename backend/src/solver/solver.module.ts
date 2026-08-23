import { Module } from '@nestjs/common';
import { ModsModule } from '../mods/mods.module';
import { ServersModule } from '../servers/servers.module';
import { SolverService } from './solver.service';
import { SolverController } from './solver.controller';

@Module({
  imports: [ModsModule, ServersModule],
  controllers: [SolverController],
  providers: [SolverService],
  exports: [SolverService],
})
export class SolverModule {}
