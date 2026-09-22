import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service';
import { SessionSecretProvider } from './session-secret.provider';
import { SecretKeyProvider } from './secret-key.provider';
import { ResourceDefaultsResolver } from './resource-defaults.resolver';

@Global()
@Module({
  providers: [
    ConfigService,
    SessionSecretProvider,
    SecretKeyProvider,
    ResourceDefaultsResolver,
  ],
  exports: [ConfigService],
})
export class ConfigModule {}
