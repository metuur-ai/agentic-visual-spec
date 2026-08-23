/*
 * One scale for every surface that stacks at the document root.
 *
 * The inspector surfaces have to beat arbitrary rendered spec content, so they
 * sit near the `2147483647` ceiling rather than on a human-sized scale. That is
 * what made floating UI unreliable: a popover at `zIndex: 41` cannot win against
 * a selection frame at `2147483000` no matter how the header nests it. Anything
 * that must appear *over* the inspector therefore has to live on the same scale.
 *
 * Order, lowest first:
 *   INSPECT_INDICATORS  comment badges painted onto the content
 *   INSPECT_OVERLAY     hover/selection frames — above the badges so an active
 *                       inspector still wins hit-testing
 *   FLOATING            transient UI anchored to content (comment pill, composer)
 *   CHROME              persistent app chrome and its popovers: header, drawers
 *   MODAL               blocking dialogs and their backdrops
 *
 * Values are spaced by 100 so a surface can slot between two tiers locally
 * (`Z.FLOATING + 1`) without a new constant.
 */
export const Z = {
  INSPECT_INDICATORS: 2147482000,
  INSPECT_OVERLAY: 2147483000,
  FLOATING: 2147483100,
  CHROME: 2147483200,
  MODAL: 2147483300,
} as const;
