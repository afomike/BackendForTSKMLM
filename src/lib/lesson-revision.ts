import { randomUUID } from "node:crypto";

export type RevisionPart = {
  partId?: string;
  title?: string;
  fileUrl?: string;
  contentType?: string;
  description?: string;
  duration?: number | null;
  downloadable?: boolean;
};

// Older clients omit IDs. Match unchanged files to their previous IDs so a
// harmless save/rename does not discard students' work.
export function reconcileParts(before: RevisionPart[], incoming: RevisionPart[]): RevisionPart[] {
  const used = new Set(incoming.flatMap(part => part.partId ? [part.partId] : []));
  return incoming.map(part => {
    if (part.partId) return part;
    const previous = before.find(old => old.partId && !used.has(old.partId) &&
      old.fileUrl === part.fileUrl && old.contentType === part.contentType);
    const partId = previous?.partId ?? randomUUID();
    used.add(partId);
    return { ...part, partId };
  });
}

export function revisionProgress(before: RevisionPart[], after: RevisionPart[]) {
  const previous = new Map(before.map(part => [part.partId, part]));
  const unchanged = new Set(after.filter(part => {
    const old = previous.get(part.partId);
    return old && old.fileUrl === part.fileUrl && old.contentType === part.contentType &&
      (old.description?.trim() ?? "") === (part.description?.trim() ?? "");
  }).map(part => part.partId!));
  return { unchanged, requiresCompletion: after.some(part => !unchanged.has(part.partId!)) };
}
