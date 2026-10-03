/**
 * Which files in packages/db/migrations are migrations. A forward migration is `NNN_name.sql`; a
 * `NNN_name_down.sql` is its rollback and never part of the sequence. Dependency-free so the
 * numbering check (scripts/check_numbers.ts) applies exactly the rule discoverMigrations does.
 */
export const MIGRATION_FILE_PATTERN = /^\d{3}_(?!.*_down\.sql$).*\.sql$/;

export function isForwardMigration(fileName: string): boolean {
  return MIGRATION_FILE_PATTERN.test(fileName);
}
