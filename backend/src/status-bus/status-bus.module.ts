import { Module } from '@nestjs/common';
import { StatusBusService } from './status-bus.service';

@Module({
  providers: [StatusBusService],
  exports: [StatusBusService],
})
export class StatusBusModule {}
