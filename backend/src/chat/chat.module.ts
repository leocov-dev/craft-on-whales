import { Module } from '@nestjs/common';
import { DockerModule } from '../docker/docker.module';
import { PlayersModule } from '../players/players.module';
import { ServersModule } from '../servers/servers.module';
import { ChatService } from './chat.service';
import { ChatCommandsService } from './chat-commands.service';
import { ChatCommandsCacheService } from './chat-commands-cache.service';
import { ChatCommandsRuntimeService } from './chat-commands-runtime.service';
import { ChatCommandsController } from './chat-commands.controller';
import { AdminChatController } from './admin-chat.controller';

@Module({
  imports: [DockerModule, PlayersModule, ServersModule],
  controllers: [ChatCommandsController, AdminChatController],
  providers: [
    ChatService,
    ChatCommandsCacheService,
    ChatCommandsService,
    ChatCommandsRuntimeService,
  ],
  exports: [ChatService, ChatCommandsService, ChatCommandsRuntimeService],
})
export class ChatModule {}
