import { Injectable } from '@nestjs/common';

export interface ParsedCrash {
  description: string;
  exception: string;
  summary: string;
  suspects: string[];
}

// Package roots that never identify a mod (JDK, Minecraft, common libraries).
const BORING_ROOTS = [
  'java.',
  'jdk.',
  'sun.',
  'javax.',
  'net.minecraft.',
  'com.mojang.',
  'io.netty.',
  'org.apache.',
  'com.google.',
  'org.spongepowered.',
  'cpw.mods.',
  'net.minecraftforge.',
  'net.neoforged.',
  'net.fabricmc.',
  'org.quiltmc.',
  'org.slf4j.',
  'org.lwjgl.',
  'it.unimi.',
  'org.joml.',
  'kotlin.',
  'scala.',
];

/**
 * Pure crash-report/hs_err text parsing — no DB/FS dependency, split out of
 * legacy `src/crashes/index.ts` so the parsing heuristics are independently
 * testable from the scan/CRUD side (`CrashesService`).
 */
@Injectable()
export class CrashParserService {
  /** Parse a Minecraft crash report into { description, exception, summary, suspects }. */
  parseCrashReport(text: string): ParsedCrash {
    const lines = text.split(/\r?\n/);

    let description = '';
    let exception = '';
    let descIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const m = /^Description:\s*(.+)$/.exec(line);
      if (m) {
        description = (m[1] ?? '').trim();
        descIdx = i;
        break;
      }
    }
    // The exception is the first non-indented, non-empty line after the
    // Description block (the "// joke" line and Time:/Description: header
    // precede it; the stacktrace follows it, indented).
    if (descIdx !== -1) {
      for (let i = descIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined || !line.trim()) continue;
        if (/^\s/.test(line)) break; // hit indented content without an exception line
        exception = line.trim();
        break;
      }
    } else {
      // No Description header — fall back to the first line that looks like a throwable.
      const m = lines.find((l) => /^[a-zA-Z_$][\w.$]*(Exception|Error)(:|$)/.test(l));
      if (m) exception = m.trim();
    }

    const suspects = new Set<string>();

    // Mod-loader-provided suspect list (Forge/NeoForge "-- Suspected Mod --"
    // section, or a "Suspected Mods:" line in system details).
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const inlineList = /^\s*Suspected Mods?:\s*(.+)$/.exec(line);
      if (inlineList && (inlineList[1] ?? '').trim().toLowerCase() !== 'none') {
        this.collectSuspectNames(inlineList[1] ?? '', suspects);
        continue;
      }
      if (/^--\s*Suspected Mods?\s*--$/.test(line.trim())) {
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j];
          if (l === undefined) continue;
          if (/^--\s.+\s--$/.test(l.trim())) break; // next section
          if (!l.trim()) continue;
          if (/^\s*(Details:\s*$|Mod File:|Stacktrace:|Failure message:|Version:)/i.test(l)) continue;
          // "Mod: NameOfMod (modid), Version: x" — drop the label before parsing.
          this.collectSuspectNames(l.replace(/^\s*Mods?:\s*/i, ''), suspects);
        }
      }
    }

    // Heuristic: scan the first 40 stack frames for non-vanilla package roots
    // and add the 2nd package segment (e.g. com.simibubi.create -> simibubi).
    let frames = 0;
    for (const line of lines) {
      const m = /^\s+at\s+([\w.$]+)/.exec(line);
      if (!m) continue;
      if (++frames > 40) break;
      const cls = m[1] ?? '';
      if (BORING_ROOTS.some((root) => cls.startsWith(root))) continue;
      const parts = cls.split('.');
      if (parts.length >= 3 && parts[1]) suspects.add(parts[1]);
    }

    const summary = exception ? exception + (description ? ` — ${description}` : '') : description || 'Crash report';
    return { description, exception, summary, suspects: [...suspects] };
  }

  private collectSuspectNames(line: string, suspects: Set<string>): void {
    // "NameOfMod (modid), Version: x" — prefer the modid in parentheses.
    const paren = /\(([\w-]+)\)/.exec(line);
    if (paren && paren[1]) {
      suspects.add(paren[1]);
      return;
    }
    const name = (line.trim().split(',')[0] ?? '').trim();
    if (name && name.length <= 64) suspects.add(name);
  }

  /** Parse a JVM fatal error log (hs_err_pid*.log). */
  parseHsErr(text: string): ParsedCrash {
    const lines = text.split(/\r?\n/).slice(0, 40);
    let problem = '';
    for (const line of lines) {
      const m = /^#\s+(\S.*)$/.exec(line);
      if (!m) continue;
      const body = (m[1] ?? '').trim();
      if (
        /fatal error has been detected|Java Runtime Environment|please submit|bug report|http|see problematic frame|if you would like/i.test(
          body
        )
      )
        continue;
      problem = body;
      break;
    }
    return {
      description: '',
      exception: 'JVM fatal error',
      summary: 'JVM fatal error' + (problem ? ` — ${problem}` : ''),
      suspects: [],
    };
  }
}
