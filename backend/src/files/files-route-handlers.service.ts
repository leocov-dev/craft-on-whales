import { BadRequestException, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import * as fsp from 'node:fs/promises';
import { z } from 'zod';
import { parseBody } from '../utils/parse-body';
import { currentUser } from '../auth/current-user';
import { FilesService } from './files.service';

export const pathSchema = z.string().max(4096).default('');
export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .regex(/^[^\\/\0]+$/, 'Names cannot contain path separators');

const writeSchema = z.object({
  path: pathSchema,
  content: z
    .string()
    .max(2 * 1024 * 1024, 'Content exceeds the 2 MB editor limit'),
});
const mkdirSchema = z.object({ path: pathSchema });
const renameSchema = z.object({ path: pathSchema, newName: nameSchema });
const moveCopySchema = z.object({ path: pathSchema, dest: pathSchema });

/**
 * Shared route-handler bodies for `GlobalFilesController` (serverId: null)
 * and `ServerFilesController` (serverId: an actual id) — the two controllers
 * were ~170 lines of near-byte-for-byte duplicated schemas/handler bodies,
 * differing only in serverId, the extra `mustExist` guard on the server
 * variant, and their `@Roles` sets (admin-only vs admin+operator, a real
 * authorization-scope difference, so kept as separate `@Controller()`
 * classes rather than unified into one — see `.plan/reviews/06-docker-storage-files.md`).
 * Each controller stays a thin wrapper: its own routes/guards/roles,
 * delegating the actual body to these methods.
 */
@Injectable()
export class FilesRouteHandlersService {
  constructor(private readonly files: FilesService) {}

  async list(serverId: string | null, pathRaw: string | undefined) {
    const rel = parseBody(pathSchema, pathRaw ?? '');
    return { ok: true, ...(await this.files.list(serverId, rel)) };
  }

  async read(serverId: string | null, pathRaw: string | undefined) {
    const rel = parseBody(pathSchema, pathRaw ?? '');
    return {
      ok: true,
      path: rel,
      ...(await this.files.readText(serverId, rel)),
    };
  }

  async download(
    serverId: string | null,
    pathRaw: string | undefined,
    res: Response,
  ): Promise<void> {
    const rel = parseBody(pathSchema, pathRaw ?? '');
    const file = await this.files.statFile(serverId, rel);
    res.download(file.abs, file.name);
  }

  async write(serverId: string | null, body: unknown) {
    const { path: rel, content } = parseBody(writeSchema, body);
    return {
      ok: true,
      ...(await this.files.writeText(serverId, rel, content, {
        actor: 'system',
      })),
    };
  }

  async mkdir(serverId: string | null, body: unknown, req: Request) {
    const { path: rel } = parseBody(mkdirSchema, body);
    return {
      ok: true,
      ...(await this.files.mkdir(serverId, rel, {
        actor: currentUser(req).username,
      })),
    };
  }

  async rename(serverId: string | null, body: unknown, req: Request) {
    const { path: rel, newName } = parseBody(renameSchema, body);
    return {
      ok: true,
      ...(await this.files.rename(serverId, rel, newName, {
        actor: currentUser(req).username,
      })),
    };
  }

  async move(serverId: string | null, body: unknown, req: Request) {
    const { path: rel, dest } = parseBody(moveCopySchema, body);
    return {
      ok: true,
      ...(await this.files.move(serverId, rel, dest, {
        actor: currentUser(req).username,
      })),
    };
  }

  async copy(serverId: string | null, body: unknown, req: Request) {
    const { path: rel, dest } = parseBody(moveCopySchema, body);
    return {
      ok: true,
      ...(await this.files.copy(serverId, rel, dest, {
        actor: currentUser(req).username,
      })),
    };
  }

  async remove(
    serverId: string | null,
    pathRaw: string | undefined,
    req: Request,
  ) {
    const rel = parseBody(pathSchema, pathRaw ?? '');
    return {
      ok: true,
      ...(await this.files.remove(serverId, rel, {
        actor: currentUser(req).username,
      })),
    };
  }

  async upload(
    serverId: string | null,
    pathRaw: string | undefined,
    uploadedFiles: Express.Multer.File[] | undefined,
    req: Request,
  ) {
    try {
      const rel = parseBody(pathSchema, pathRaw ?? '');
      if (!uploadedFiles || !uploadedFiles.length)
        throw new BadRequestException('No files attached');
      const uploaded = [];
      for (const f of uploadedFiles) {
        uploaded.push(
          await this.files.acceptUpload(serverId, rel, f.path, f.originalname, {
            actor: currentUser(req).username,
          }),
        );
      }
      return { ok: true, uploaded };
    } catch (err) {
      if (uploadedFiles) {
        for (const f of uploadedFiles)
          await fsp.rm(f.path, { force: true }).catch(() => {});
      }
      throw err;
    }
  }
}
