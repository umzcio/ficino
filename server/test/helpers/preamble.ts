// The one deliberate divergence of SYSTEM_PREAMBLE from the Python constant the goldens recorded.
// Python's sentence prescribed a {"posts": [{"text", "type"}]} reply, contradicting every user prompt's
// single-object format; local models followed it about half the time and those posts were lost.
export const PYTHON_OUTPUT_SENTENCE =
  'Your output is JSON: {"posts": [{"text": "...", "type": "standalone|thread|quote_tweet|reply|figure_post"}]}.';
export const TS_OUTPUT_SENTENCE = 'Your output is a single JSON object in exactly the format the request specifies.';

/** A Python-recorded system prompt as the TS port now sends it. Throws unless the sentence occurs exactly once. */
export function fromPythonSystemPrompt(s: string): string {
  const parts = s.split(PYTHON_OUTPUT_SENTENCE);
  if (parts.length !== 2) throw new Error(`expected the Python output sentence once, found ${parts.length - 1}`);
  return parts.join(TS_OUTPUT_SENTENCE);
}
