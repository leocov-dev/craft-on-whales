import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DockerModule } from '../docker/docker.module';
import { AuthService } from './auth.service';
import { TotpService } from './totp.service';
import { SecretsService } from './secrets.service';
import { SessionService } from './session.service';
import { LoginRateLimitService } from './login-rate-limit.service';
import { AuthController } from './auth.controller';
import { OriginGuard } from './guards/origin.guard';
import { SessionAuthGuard } from './guards/session-auth.guard';
import { WriteGuard } from './guards/write.guard';

@Module({
  imports: [DockerModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TotpService,
    SecretsService,
    SessionService,
    LoginRateLimitService,
    // Global guards, in the same order as legacy app.ts's middleware chain:
    // origin check first (CSRF, doesn't need auth), then the session gate,
    // then the viewer-read-only write block.
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: WriteGuard },
  ],
  exports: [
    AuthService,
    TotpService,
    SecretsService,
    SessionService,
    LoginRateLimitService,
  ],
})
export class AuthModule {}
