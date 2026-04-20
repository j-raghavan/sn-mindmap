/**
 * Shared narrow types for the sn-plugin-lib firmware bridge.
 *
 * The SDK declares most PluginCommAPI / PluginFileAPI methods as
 * returning the generic `Object` type, so TypeScript doesn't know
 * about the `{success, result, error}` envelope the firmware actually
 * returns. Every call site has to cast into that shape before it can
 * read the envelope fields — this module is the single place where
 * that shape is defined.
 *
 * Historical note: this type used to live in two copies (insert.ts
 * and EditMindmap.tsx) back when only two modules talked to the
 * firmware bridge. Phase 5 consolidated the two copies here so every
 * new call site (e.g. the §F-PE-4 capacity-modal flow) reuses a single
 * source of truth.
 */

/**
 * Firmware API response envelope. `success` is the universal
 * discriminator; `result` carries a call-specific payload on success
 * (typed by the generic parameter); `error` carries an optional
 * diagnostic message on failure.
 *
 * Callers must treat `null` / `undefined` as a failure — the SDK
 * occasionally returns a bare object or null when the native bridge
 * rejects a call before the firmware can populate the envelope.
 */
export type ApiRes<T> =
  | {success: boolean; result?: T; error?: {message?: string}}
  | null
  | undefined;
