export function ownershipRefusalClass(message) {
  const value = String(message);
  if (/\bnot found\b/i.test(value)) return "not-found";
  if (/\bdifferent owner\b/i.test(value)) return "different-owner";
  if (/\bwrong-owner\b/i.test(value)) return "wrong-owner";
  return undefined;
}
