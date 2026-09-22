import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

/**
 * Walks every `*.controller.ts` file under `backend/src` **as source** (a
 * TypeScript AST parse, not a `require()` — several controllers transitively
 * pull in ESM-only packages like `sanitize-html`, which jest's CJS transform
 * can't load just to reflect decorator metadata) and fails the build if any
 * route acting on a specific server doesn't carry both `@UseGuards(...)`
 * naming `ServerPermissionGuard` and `@RequireServerPermission(...)`. This is
 * the regression test described in PERMISSIONS_NOTES.md: a new route added
 * later under `/servers/:id` (or one of the explicit resolver-based
 * exceptions below) that forgets the guard fails this test on the next build
 * instead of shipping silently unguarded.
 *
 * Two detection strategies, combined:
 *  1. Path-based: any route whose joined path (class `@Controller()` prefix
 *     + method's own decorator argument) contains a `servers` segment
 *     immediately followed by a `:param` segment — covers every controller
 *     mounted under `/servers/:id/...`.
 *  2. `EXPLICIT_ROSTER`: routes that act on a server named somewhere other
 *     than that path segment (a backup id, a blueprint/schedule/world-library
 *     request body, the differently-prefixed `/map/:id` proxy). These can't
 *     be found by the path heuristic, so they're listed by hand — a reviewer
 *     adding a new one of these has exactly one list to update, not the
 *     whole heuristic.
 */

const SRC_ROOT = path.join(__dirname, '..');
const HTTP_DECORATORS = new Set([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'All',
]);

interface RouteCase {
  id: string;
  hasRequireServerPermission: boolean;
  hasServerPermissionGuard: boolean;
}

function findControllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findControllerFiles(full));
    else if (entry.name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function joinPaths(...segments: string[]): string {
  const joined = segments
    .filter((s) => s.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
  return `/${joined}`.replace(/\/+/g, '/');
}

function actsOnServerByPath(fullPath: string): boolean {
  const segments = fullPath.split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === 'servers' && segments[i + 1]?.startsWith(':')) {
      return true;
    }
  }
  return false;
}

/** First string-literal argument of a decorator call, or '' for a bare one. */
function decoratorArgString(expr: ts.CallExpression): string {
  const arg = expr.arguments[0];
  if (arg && ts.isStringLiteral(arg)) return arg.text;
  return '';
}

/** Every decorator call's callee name on a node, e.g. ['Get', 'UseGuards']. */
function decoratorCalls(
  node: ts.HasDecorators,
): { name: string; expr: ts.CallExpression }[] {
  const out: { name: string; expr: ts.CallExpression }[] = [];
  for (const d of ts.getDecorators(node) ?? []) {
    const expr = d.expression;
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
      out.push({ name: expr.expression.text, expr });
    }
  }
  return out;
}

/** Raw source text of a decorator's argument list, for identifier scanning. */
function decoratorArgsText(
  expr: ts.CallExpression,
  sourceText: string,
): string {
  return (
    expr.arguments.map((a) => a.getText()).join(', ') || sourceText.slice(0, 0)
  );
}

/**
 * Routes that act on a specific server but whose id doesn't appear as a
 * `/servers/:id` path segment. `ClassName#methodName`.
 */
const EXPLICIT_ROSTER = new Set<string>([
  'BackupsController#download',
  'BackupsController#remove',
  'BlueprintsController#export',
  'BlueprintsController#clone',
  'SchedulesController#create',
  'SchedulesController#toggle',
  'SchedulesController#remove',
  'WorldsController#extract',
  'WorldsController#install',
  'MapProxyController#proxy',
]);

function collectCases(): RouteCase[] {
  const cases: RouteCase[] = [];

  for (const file of findControllerFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );

    ts.forEachChild(source, (node) => {
      if (!ts.isClassDeclaration(node) || !node.name) return;
      const className = node.name.text;
      const classDecorators = decoratorCalls(node);
      const controllerDecorator = classDecorators.find(
        (d) => d.name === 'Controller',
      );
      if (!controllerDecorator) return; // not a @Controller class
      const basePath = decoratorArgString(controllerDecorator.expr);

      const classGuardsText = classDecorators
        .filter((d) => d.name === 'UseGuards')
        .map((d) => decoratorArgsText(d.expr, text))
        .join(', ');
      const classHasGuard = classGuardsText.includes('ServerPermissionGuard');

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.name) continue;
        if (!ts.isIdentifier(member.name)) continue;
        const methodName = member.name.text;
        const methodDecorators = decoratorCalls(member);
        const httpDecorator = methodDecorators.find((d) =>
          HTTP_DECORATORS.has(d.name),
        );
        if (!httpDecorator) continue; // not a route handler
        const subPath = decoratorArgString(httpDecorator.expr);
        const fullPath = joinPaths(basePath, subPath);

        const rosterKey = `${className}#${methodName}`;
        const mustGuard =
          actsOnServerByPath(fullPath) || EXPLICIT_ROSTER.has(rosterKey);
        if (!mustGuard) continue;

        const methodGuardsText = methodDecorators
          .filter((d) => d.name === 'UseGuards')
          .map((d) => decoratorArgsText(d.expr, text))
          .join(', ');
        const hasServerPermissionGuard =
          classHasGuard || methodGuardsText.includes('ServerPermissionGuard');
        const hasRequireServerPermission = methodDecorators.some(
          (d) => d.name === 'RequireServerPermission',
        );

        cases.push({
          id: `${rosterKey} (${fullPath}) [${path.relative(SRC_ROOT, file)}]`,
          hasRequireServerPermission,
          hasServerPermissionGuard,
        });
      }
    });
  }

  return cases;
}

describe('server-scoped route audit', () => {
  const cases = collectCases();

  it('found a non-trivial number of server-scoped routes (sanity check the scan itself works)', () => {
    expect(cases.length).toBeGreaterThan(30);
  });

  it.each(cases.map((c) => [c.id, c] as const))(
    '%s has @RequireServerPermission and ServerPermissionGuard',
    (_id, c) => {
      expect(c.hasRequireServerPermission).toBe(true);
      expect(c.hasServerPermissionGuard).toBe(true);
    },
  );
});
