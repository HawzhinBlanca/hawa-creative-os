import { afterEach,expect,it,vi } from 'vitest';
import { createDb } from '@hawa/db';
import { PublicationInspectionService,startPublicationInspectionSchedule } from '../src/services/publication-inspections.js';
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
    resolve!({claimed:1,finished:1});await vi.advanceTimersByTimeAsync(60_000);expect(pass).toHaveBeenCalledTimes(2);expect(onError).toHaveBeenCalledWith();
    await vi.advanceTimersByTimeAsync(60_000);expect(pass).toHaveBeenCalledTimes(3);
    stop();await vi.advanceTimersByTimeAsync(120_000);expect(pass).toHaveBeenCalledTimes(3);
  } finally {stop();await db.destroy();}
});
