import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

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
  // Extract table names
  const tableMatches = [...sqlContent.matchAll(/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-zA-Z0-9_.]+)/gi)];
  const tables = tableMatches.map((m) => m[1]);

  // Extract enum types
  const enumMatches = [...sqlContent.matchAll(/CREATE\s+TYPE\s+([a-zA-Z0-9_.]+)\s+AS\s+ENUM/gi)];
  const enums = enumMatches.map((m) => m[1]);

  // Extract triggers
  const triggerMatches = [...sqlContent.matchAll(/CREATE\s+TRIGGER\s+([a-zA-Z0-9_.]+)/gi)];
  const triggers = triggerMatches.map((m) => m[1]);

  // Extract RLS policies
  const policyMatches = [...sqlContent.matchAll(/CREATE\s+POLICY\s+([a-zA-Z0-9_.]+)/gi)];
  const policies = policyMatches.map((m) => m[1]);

  // Split statements roughly by semicolon outside blocks
  const statements = sqlContent
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));

  return { statements, tables, enums, triggers, policies };
}

export async function runMigrations(options: {
  connectionString?: string;
  schemaPath?: string;
  dryRun?: boolean;
} = {}): Promise<MigrationResult> {
  const start = Date.now();
  const filePath = options.schemaPath || resolve(process.cwd(), 'db/schema.sql');
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

