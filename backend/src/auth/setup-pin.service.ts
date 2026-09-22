import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { ConfigService } from '../config/config.service';
import { AuthService } from './auth.service';

const PIN_DIGITS = 6;

/**
 * First-run setup-PIN gate. See AUTH_NOTES.md's "Setup-PIN gate" section for
 * the full threat model. Short version: on a loopback-only bind, nothing off
 * the host can reach `/setup` at all, so there's nothing to gate — but the
 * moment `PANEL_HOST` is a LAN/0.0.0.0 address, anyone who can reach the port
 * before the real operator finishes clicking through the wizard can claim the
 * first admin account. Requiring a PIN that's only ever printed to the
 * server's own console/log output (never sent over the network to anyone)
 * proves the caller has access the network alone doesn't give them.
 */
@Injectable()
export class SetupPinService implements OnModuleInit {
  private readonly logger = new Logger('SetupPin');
  private pin: string | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly authService: AuthService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.isExposedBind) return; // loopback-only: nothing to protect
    if (!(await this.authService.firstRunNeeded())) return; // already set up
    this.pin = crypto
      .randomInt(0, 10 ** PIN_DIGITS)
      .toString()
      .padStart(PIN_DIGITS, '0');
    this.logger.warn(
      `First-run setup PIN: ${this.pin}\n` +
        `The panel is bound to ${this.config.host}, which is reachable from ` +
        'outside localhost. Enter this PIN on the /setup page to create the ' +
        'first admin account — it is only ever shown here, never sent over ' +
        'the network to anyone.',
    );
  }

  /** Whether the current first-run bind requires a PIN at all. */
  required(): boolean {
    return this.pin !== null;
  }

  /** Constant-time compare against the generated PIN (always false once consumed). */
  verify(candidate: string): boolean {
    if (this.pin === null) return false;
    const a = Buffer.from(String(candidate || '').padEnd(PIN_DIGITS, ' '));
    const b = Buffer.from(this.pin.padEnd(PIN_DIGITS, ' '));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /** One-shot: the PIN stops being valid the moment the first admin account exists. */
  consume(): void {
    this.pin = null;
  }
}
