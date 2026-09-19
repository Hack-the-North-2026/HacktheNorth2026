import { IdentifyResult } from './types';

let lastResult: IdentifyResult | null = null;

export function setLastResult(result: IdentifyResult) {
  lastResult = result;
}

export function getLastResult(): IdentifyResult | null {
  return lastResult;
}
