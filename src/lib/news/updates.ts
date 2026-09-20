/** Different event stages can warrant a follow-up even when the subject is unchanged. */
export function materialChange(next: string, previous: string): boolean {
  const stage = (s: string) => {
    if (/\b(corrects?|correction|retracts?|overturns?)\b/i.test(s)) return 'correction'
    if (/\b(confirms?|confirmed|approves?|approved|rejects?|rejected|wins?|won|resigns?|resigned|ruled out|suspended)\b/i.test(s)) return 'confirmed'
    return 'developing'
  }
  return stage(next) !== 'developing' && stage(next) !== stage(previous)
}
