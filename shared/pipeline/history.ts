import type { ContextLine } from './translate/types.ts';

/** The last few utterances of a conversation, given to the translator as context. */
export class ConversationHistory {
  private readonly limit: number;
  private lines: ContextLine[] = [];

  constructor(limit = 10) {
    this.limit = limit;
  }

  add(line: ContextLine): void {
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.shift();
  }

  /** Snapshot, oldest first. */
  recent(): readonly ContextLine[] {
    return [...this.lines];
  }
}
