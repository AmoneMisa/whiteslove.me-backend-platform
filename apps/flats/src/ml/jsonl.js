import { createReadStream } from 'node:fs';

/**
 * Lines of a JSONL file, split on LF only. readline also breaks on CR, U+2028
 * and U+2029, which jsonb output leaves unescaped inside strings, and would cut
 * records in two.
 */
export async function* lines(file) {
  let tail = '';
  for await (const chunk of createReadStream(file, 'utf8')) {
    const parts = (tail + chunk).split('\n');
    tail = parts.pop();
    yield* parts;
  }
  if (tail) yield tail;
}
