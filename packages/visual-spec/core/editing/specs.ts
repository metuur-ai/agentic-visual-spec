/**
 * specs.ts — the spec dialect vocabulary. The @vs-spec marker-authoring machinery
 * was retired; this union survives because a comment may optionally be authored in
 * a formal dialect (see comment-doc.ts / use-comments.ts).
 */
export type SpecDialect = 'ears' | 'openspec' | 'speckit';
