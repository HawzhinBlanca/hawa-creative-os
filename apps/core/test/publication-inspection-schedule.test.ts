import { afterEach,expect,it,vi } from 'vitest';
import { createDb } from '@hawa/db';
import { PublicationInspectionService,inspectionFailureCause,startPublicationInspectionSchedule } from '../src/services/publication-inspections.js';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
it('bounds local scheduling, prevents overlapping passes and resumes after errors',async()=>{
  vi.useFakeTimers();const db=createDb(process.env.TEST_DATABASE_URL!);
  const service=new PublicationInspectionService(db,{inspectPublication:async()=>{throw new Error('Not used');}});
  let resolve:((r:{claimed:number;finished:number})=>void)|undefined;
  const pass=vi.spyOn(service,'runPass').mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockRejectedValueOnce(new Error('private provider details')).mockResolvedValue({claimed:0,finished:0});
  const onError=vi.fn(),stop=startPublicationInspectionSchedule(service,'tenant',onError);
  try {
    await vi.advanceTimersByTimeAsync(30_000);expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(90_000);expect(pass).toHaveBeenCalledTimes(1);
    resolve!({claimed:1,finished:1});await vi.advanceTimersByTimeAsync(60_000);expect(pass).toHaveBeenCalledTimes(2);
    // The cause is passed on for the log (ADR-158): "not confirmed" alone hid why a pass failed.
    expect(onError).toHaveBeenCalledWith('Error: private provider details');
    await vi.advanceTimersByTimeAsync(60_000);expect(pass).toHaveBeenCalledTimes(3);
    stop();await vi.advanceTimersByTimeAsync(120_000);expect(pass).toHaveBeenCalledTimes(3);
  } finally {stop();await db.destroy();}
});
it('names the cause of a failed pass without addresses or token-like strings',()=>{
  const pg=Object.assign(new Error('Connection terminated unexpectedly\n    at Connection.<anonymous>'),{code:'ECONNRESET'});
  expect(inspectionFailureCause(pg)).toBe('Error ECONNRESET: Connection terminated unexpectedly');
  const signed=new TypeError(`Drive answered 403 for https://www.googleapis.com/drive/v3/files/x?access_token=${'a'.repeat(40)} with ${'b'.repeat(48)}`);
  expect(inspectionFailureCause(signed)).toBe('TypeError: Drive answered 403 for <url> with <redacted>');
  expect(inspectionFailureCause('boom')).toBe('non-error string');
  expect(inspectionFailureCause(new Error('x'.repeat(400))).length).toBeLessThanOrEqual(170);
});
