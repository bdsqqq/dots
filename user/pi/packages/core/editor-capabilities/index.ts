import type { AutocompleteProvider } from "@mariozechner/pi-tui";

export interface EditorAutocompleteContext {
  cwd: string;
}

/**
 * package-local editor autocomplete contributor.
 *
 * contributors decorate the editor's base autocomplete provider rather than
 * replacing the editor host itself. that keeps domain semantics out of the ui
 * host while preserving normal fallback behavior like @file completion.
 */
export interface EditorAutocompleteContributor {
  id: string;
  priority?: number;
  enhance(
    provider: AutocompleteProvider,
    context: EditorAutocompleteContext,
  ): AutocompleteProvider;
}

const contributors = new Map<string, EditorAutocompleteContributor>();
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

export function registerEditorAutocompleteContributor(
  contributor: EditorAutocompleteContributor,
): () => void {
  const previous = contributors.get(contributor.id);
  contributors.set(contributor.id, contributor);
  if (previous !== contributor) emitChange();

  return () => {
    if (contributors.get(contributor.id) !== contributor) return;
    contributors.delete(contributor.id);
    emitChange();
  };
}

export function subscribeEditorAutocompleteContributors(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function listEditorAutocompleteContributors(): EditorAutocompleteContributor[] {
  return [...contributors.values()].sort((a, b) => {
    const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return a.id.localeCompare(b.id);
  });
}

export function composeEditorAutocompleteProvider(
  baseProvider: AutocompleteProvider,
  context: EditorAutocompleteContext,
): AutocompleteProvider {
  let provider = baseProvider;
  for (const contributor of listEditorAutocompleteContributors()) {
    provider = contributor.enhance(provider, context);
  }
  return provider;
}
