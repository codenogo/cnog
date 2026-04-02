export const PROMPT_PATTERNS = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure)\b.*\? *$/im,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
];

export function looksInteractivePrompt(content: string | null | undefined): boolean {
  const text = content?.trimEnd();
  if (!text) return false;
  return PROMPT_PATTERNS.some((pattern) => pattern.test(text));
}
