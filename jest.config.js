module.exports = {
  preset: 'react-native',
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    // Type-only modules — no runtime JS emitted, nothing for coverage to track.
    '!src/pluginApi.ts',
  ],
  // Per-file thresholds enforce high coverage on each implemented module.
  // Files not yet implemented are excluded from the threshold check via the
  // global setting; individual files are added here as they reach production
  // quality. Remaining gaps below 100 % are documented inline on each entry.
  coverageThreshold: {
    './src/geometry.ts': {
      branches: 100, functions: 100, lines: 100, statements: 100,
    },
    './src/layout/constants.ts': {
      branches: 100, functions: 100, lines: 100, statements: 100,
    },
    './src/model/tree.ts': {
      branches: 97, functions: 100, lines: 97, statements: 97,
    },
    './src/layout/radial.ts': {
      branches: 97, functions: 100, lines: 97, statements: 97,
    },
    './src/pluginRouter.ts': {
      branches: 97, functions: 100, lines: 97, statements: 97,
    },
    // Phase 4+ modules added in the insert implementation. The marker
    // codec, edit-mode, and stroke-association modules were removed in
    // 2da4e72 ("chore: fixed issues with inserting the mindmap to
    // notes and clear map") along with their tests; their threshold
    // entries went with them.
    './src/rendering/nodeFrame.ts': {
      branches: 100, functions: 100, lines: 100, statements: 100,
    },
    './src/rendering/emitGeometries.ts': {
      branches: 100, functions: 100, lines: 100, statements: 100,
    },
    './src/insert.ts': {
      // Line 363: roundGeometryPoints' GEO_circle / GEO_ellipse case is
      // defensive — emitGeometries only produces polygons and
      // straightLines today, so the ellipseCenterPoint rounding path
      // is structurally unreachable from the full insert pipeline.
      // Kept so that future callers emitting circles or ellipses don't
      // silently skip the integer-rounding the native firmware
      // requires.
      branches: 91, functions: 100, lines: 99, statements: 99,
    },
  },
};
