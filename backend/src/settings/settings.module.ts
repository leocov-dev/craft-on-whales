import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { PanelUpdateService } from './panel-update.service';

@Module({
  providers: [SettingsService, PanelUpdateService],
  exports: [SettingsService, PanelUpdateService],
})
export class SettingsModule {}
