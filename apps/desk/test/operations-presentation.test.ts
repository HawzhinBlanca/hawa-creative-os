import { expect, it } from 'vitest';
import { formatElapsedHours } from '../src/services/operationsPresentation.js';
it('distinguishes missing observations and short durations without pretending zero hours',()=>{
 expect(formatElapsedHours(null)).toBe('—');expect(formatElapsedHours(NaN)).toBe('—');expect(formatElapsedHours(-1)).toBe('—');
 expect(formatElapsedHours(0)).toBe('<1s');expect(formatElapsedHours(0.001)).toBe('3s');expect(formatElapsedHours(1/60)).toBe('1m');expect(formatElapsedHours(1.5)).toBe('1h 30m');
});
