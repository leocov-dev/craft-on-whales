import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { SessionSecretProvider } from './session-secret.provider';
import { ResourceDefaultsResolver } from './resource-defaults.resolver';

@Global()
@Module({
  providers: [ConfigService, SessionSecretProvider, ResourceDefaultsResolver],
  exports: [ConfigService],
})
export class ConfigModule {}
