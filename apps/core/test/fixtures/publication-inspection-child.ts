import { createDb } from '@hawa/db';
import { PublicationInspectionService } from '../../src/services/publication-inspections.js';

const db=createDb(process.env.TEST_DATABASE_URL!);
const service=new PublicationInspectionService(db,{inspectPublication:async()=>{throw new Error('Not dispatched in claim drill');}});
const claim=await service.claim(process.env.INSPECTION_TENANT_ID!,process.env.INSPECTION_PUBLICATION_ID!);
if(!claim)throw new Error('Claim not acquired');
process.send?.(claim);
// Parent kills the process with the committed lease still outstanding.
setInterval(()=>{},1000);
