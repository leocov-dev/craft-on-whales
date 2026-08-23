import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeysService } from './api-keys.service';

@Module({
  imports: [AuthModule],
  providers: [ApiKeysService],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
