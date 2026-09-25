/**
 * The Restate services every worker build hosts. A service is never removed from the build (ADR-034,
 * PHASE2_DESIGN.md section 4 rule 3): Restate keeps routing one a new build does not host to the old
 * deployment, and the blue/green drain then never finishes. It can only become a shim.
 *
 * index.ts refuses to start when what it binds differs from this list, and
 * packages/testkit/test/worker-services.test.ts keeps scripts/restate-bluegreen.ts's WORKER_SERVICES
 * equal to it.
 */
export const WORKER_SERVICE_NAMES = ['TaskWorkflow', 'TaskService', 'ChatInbox', 'Delivery', 'TelegramSender', 'RequestLifecycle', 'DesignRun'] as const;
