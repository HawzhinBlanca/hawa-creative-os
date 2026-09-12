import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function resolveWorkspaceFile(relativePath: string): string {
  const candidates = [
    resolve(process.cwd(), relativePath),
    resolve(process.cwd(), '../../', relativePath),
    resolve(process.cwd(), '../', relativePath),
    resolve(__dirname, '../../../', relativePath),
    resolve(__dirname, '../../', relativePath),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return resolve(process.cwd(), relativePath);
}

export interface MigrationResult {
  success: boolean;
  tableCount: number;
  statementCount: number;
  durationMs: number;
  appliedToDb: boolean;
  error?: string;
}

export function parseSchemaSql(sqlContent: string): {
  statements: string[];
  tables: string[];
  enums: string[];
  triggers: string[];
  policies: string[];
} {
  const statements: string[] = [];
  const tables: string[] = [];
  const enums: string[] = [];
  const triggers: string[] = [];
  const policies: string[] = [];

  const lines = sqlContent.split('\n');
  let currentStatement = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('--') || trimmed.length === 0) continue;

    currentStatement += line + '\n';
    if (trimmed.endsWith(';')) {
      statements.push(currentStatement.trim());
      currentStatement = '';
    }
  }

  // Extract metadata
  for (const stmt of statements) {
    const tableMatch = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:hawa\.)?([a-zA-Z0-9_]+)/i);
    if (tableMatch) tables.push(tableMatch[1]);

    const enumMatch = stmt.match(/CREATE\s+TYPE\s+(?:hawa\.)?([a-zA-Z0-9_]+)\s+AS\s+ENUM/i);
    if (enumMatch) enums.push(enumMatch[1]);

    const triggerMatch = stmt.match(/CREATE\s+TRIGGER\s+([a-zA-Z0-9_]+)/i);
    if (triggerMatch) triggers.push(triggerMatch[1]);

    const policyMatch = stmt.match(/CREATE\s+POLICY\s+([a-zA-Z0-9_]+)/i);
    if (policyMatch) policies.push(policyMatch[1]);
  }

  return { statements, tables, enums, triggers, policies };
}

export async function runMigrations(options: {
  connectionString?: string;
  schemaPath?: string;
  dryRun?: boolean;
} = {}): Promise<MigrationResult> {
  const start = Date.now();
  const filePath = options.schemaPath || resolveWorkspaceFile('db/schema.sql');
  const sqlContent = readFileSync(filePath, 'utf-8');

  const { statements, tables, enums, triggers, policies } = parseSchemaSql(sqlContent);

  if (options.dryRun || !options.connectionString && !process.env.DATABASE_URL) {
    return {
      success: true,
      tableCount: tables.length,
      statementCount: statements.length,
      durationMs: Date.now() - start,
      appliedToDb: false,
    };
  }

  const connStr = options.connectionString || process.env.DATABASE_URL!;
  const client = new pg.Client({ connectionString: connStr });

  try {
    await client.connect();
    await client.query(sqlContent);
    return {
      success: true,
      tableCount: tables.length,
      statementCount: statements.length,
      durationMs: Date.now() - start,
      appliedToDb: true,
    };
  } catch (err: any) {
    return {
      success: false,
      tableCount: tables.length,
      statementCount: statements.length,
      durationMs: Date.now() - start,
      appliedToDb: false,
      error: err.message,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Running Hawa Creative OS database migrations...');
  runMigrations().then((res) => {
    if (res.success) {
      console.log(`Verified db/schema.sql (${res.tableCount} tables, ${res.statementCount} statements). Applied to DB: ${res.appliedToDb}. Database migration completed successfully.`);
    } else {
      console.error(`Migration failed: ${res.error}`);
      process.exit(1);
    }
  });
}

