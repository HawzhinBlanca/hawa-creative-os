import { expect, it } from 'vitest';
import { formatElapsedHours } from '../src/services/operationsPresentation.js';
it('distinguishes missing observations and short durations without pretending zero hours',()=>{
 expect(formatElapsedHours(null)).toBe('—');expect(formatElapsedHours(NaN)).toBe('—');expect(formatElapsedHours(-1)).toBe('—');
 expect(formatElapsedHours(0)).toBe('<1s');expect(formatElapsedHours(0.001)).toBe('3s');expect(formatElapsedHours(1/60)).toBe('1m');expect(formatElapsedHours(1.5)).toBe('1h 30m');
});

import { cancelledBeforeDraftSummary, northStarSummary, parseNorthStar } from '../src/services/operationsPresentation.js';
it('shows the north-star numbers Core reports, and nothing for a malformed report (ADR-288)',()=>{
 const n=parseNorthStar({days:7,deliveredDesigns:3,approvals:3,approvedFirstDraft:2,firstDraftApprovalRate:2/3,medianBriefToDeliveryHours:6.5,briefToDeliverySamples:3});
 expect(n&&northStarSummary(n)).toBe('Last 7 days: 3 designs delivered · 67% approved on the first draft (2 of 3) · median brief → delivery 6h 30m (3 delivered)');
 const none=parseNorthStar({days:7,deliveredDesigns:0,approvals:0,approvedFirstDraft:0,firstDraftApprovalRate:null,medianBriefToDeliveryHours:null,briefToDeliverySamples:0});
 expect(none&&northStarSummary(none)).toBe('Last 7 days: 0 designs delivered · no approvals yet · no delivery to time');
 expect(parseNorthStar({days:7,deliveredDesigns:1,approvals:1,approvedFirstDraft:2,firstDraftApprovalRate:1,medianBriefToDeliveryHours:1,briefToDeliverySamples:1})).toBeNull();
 expect(parseNorthStar(undefined)).toBeNull();
 expect(cancelledBeforeDraftSummary({total:3,requesterWithdrew:1,officeCancelled:0,systemFailed:2,other:0})).toBe('Ended before a draft: 3 (1 withdrawn by the requester, 2 ended without a draft (system))');
 expect(cancelledBeforeDraftSummary({total:0,requesterWithdrew:0,officeCancelled:0,systemFailed:0,other:0})).toBeNull();
 expect(cancelledBeforeDraftSummary(null)).toBeNull();
});
