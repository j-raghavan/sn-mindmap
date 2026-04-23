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
    // Phase 4+ modules added in the insert / marker / strokes implementation.
    './src/rendering/nodeFrame.ts': {
      branches: 100, functions: 100, lines: 100, statements: 100,
    },
    './src/rendering/emitGeometries.ts': {
      // Line 429: unionRectOfGeometries empty-input guard (callers always
      // provide at least one geometry, so the Infinity sentinel is never hit
      // in production, but the export is tested standalone with an empty array).
      branches: 98, functions: 100, lines: 99, statements: 99,
    },
    './src/model/strokes.ts': {
      // Lines 234-235: TypeScript exhaustiveness guard — unreachable because
      // strokeCentroid always throws first for unknown stroke types.
      branches: 91, functions: 100, lines: 96, statements: 96,
    },
    './src/marker/encode.ts': {
      // Line 203: defensive BFS guard is unreachable (BFS only visits existing
      // nodes, so the Map.get always succeeds).
      branches: 85, functions: 100, lines: 98, statements: 98,
    },
    './src/marker/decode.ts': {
      // Lines 295, 451: dead-code defensive guards (N > cap already rejected
      // above; RS post-correction verify error is beyond any correction
      // capability).
      branches: 93, functions: 100, lines: 98, statements: 98,
    },
    './src/marker/rs.ts': {
      // Lines 76, 79, 90, 128: polyMul/polyShift empty-input guards that the
      // public API never triggers. Lines 335, 386, 448 ff: Forney/post-
      // correction error throws that only fire on data beyond RS correction
      // capability.
      branches: 86, functions: 100, lines: 94, statements: 95,
    },
    './src/insert.ts': {
      // Lines 182, 275, 284, 298: error / early-return paths tested via mock
      // failures; line 637: lassoRes?.success false-branch is a network
      // non-response path that cannot be exercised without firmware cooperation.
      branches: 89, functions: 100, lines: 100, statements: 100,
    },
  },
};
