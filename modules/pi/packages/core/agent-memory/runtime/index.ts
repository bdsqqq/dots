import type { NoteRef, NoteRevision, ProjectionReadiness, RecallIntent, SearchIndex } from './contracts.js';

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
export function noteBody(note: NoteRevision): string {
  return note.markdown.replace(/^<!-- pi-memory .* -->\n/, '');
}

/** rebuildable lexical + one-hop link projection. this does not claim semantic search. */
export class LinkedSearchIndex implements SearchIndex {
  private notes: readonly NoteRevision[] = [];
  async project(notes: readonly NoteRevision[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.notes = notes;
  }
  async readiness(): Promise<ProjectionReadiness> {
    return { kind: 'unavailable', reason: 'semantic adapter unavailable; lexical and linked recall enabled' };
  }
  async search(intent: RecallIntent, signal: AbortSignal): Promise<readonly NoteRef[]> {
    signal.throwIfAborted();
    const query = words(intent.query);
    const scored = this.notes.map(note => {
      // aliases/topics in editable text participate without a second metadata schema.
      const tokens = words(`${note.path} ${noteBody(note)}`);
      return { note, score: [...query].filter(word => tokens.has(word)).length };
    });
    const seeds = new Set(scored.filter(x => x.score > 0).map(x => x.note.noteId));
    const links = new Set(this.notes.filter(n => seeds.has(n.noteId)).flatMap(n => n.links));
    return scored.map(x => ({ ...x, score: x.score || (links.has(x.note.noteId) || x.note.links.some(id => seeds.has(id)) ? 0.5 : 0) }))
      .filter(x => x.score > 0).sort((a,b) => b.score-a.score || a.note.noteId.localeCompare(b.note.noteId))
      .map(({ note }) => ({ noteId: note.noteId, revisionId: note.revisionId }));
  }
}
