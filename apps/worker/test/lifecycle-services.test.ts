import { describe, expect, it } from 'vitest';
import { WORKER_SERVICES } from '../../../scripts/restate-bluegreen.js';
import { createDeliveryWorkflow } from '../src/lifecycle/delivery.js';
import { createTelegramSender, telegramSenderDepsFromEnv } from '../src/lifecycle/telegram-sender.js';

/**
 * A service the worker build hosts is never removed from it, and the blue/green deploy checks each
 * one moved to the new colour (PHASE2_DESIGN.md section 4, rule 3; scripts/restate-bluegreen.ts). The
 * slice 2.2 services are on that list under the names Restate knows them by.
 */
describe('slice 2.2 services and the blue/green list', () => {
  it('Delivery and TelegramSender are in WORKER_SERVICES under their Restate names', () => {
    const names = [createDeliveryWorkflow().name, createTelegramSender(telegramSenderDepsFromEnv(undefined)).name];
    expect(names).toEqual(['Delivery', 'TelegramSender']);
    for (const name of names) expect(WORKER_SERVICES).toContain(name);
  });

  it('keeps every service bound before', () => {
    expect(WORKER_SERVICES).toEqual(expect.arrayContaining(['TaskWorkflow', 'TaskService']));
  });
});
