/**
 * ConfirmDialog — reusable centered-card modal over a dimmed backdrop.
 *
 * Shared by every "confirm / acknowledge" surface in the plugin so the
 * out-of-map gate (§8.1 / Phase 4.6) and the marker-capacity modal
 * (§F-PE-4 / Phase 5) have identical structure, styling, and tap
 * semantics. Renders nothing when `visible` is false — callers flip
 * visibility via state; the dialog itself never persists state.
 *
 * accessibilityLabel scheme (drives the test suite's findHostByLabel /
 * findPressable helpers):
 *
 *   ${labelPrefix}-dialog      overlay View
 *   ${labelPrefix}-backdrop    tap-outside-to-cancel Pressable
 *   ${labelPrefix}-body        body Text
 *   ${labelPrefix}-cancel      secondary button (only when secondaryLabel set)
 *   ${labelPrefix}-proceed     primary button
 *
 * Backdrop tap: invokes onSecondary when provided, otherwise a no-op.
 * Acknowledge-only dialogs (single button, no secondaryLabel) therefore
 * require an explicit primary-button tap — the user can't dismiss by
 * tapping outside, matching the "you must read this" semantics of
 * §F-PE-4 where there's no "cancel the capacity error" path.
 *
 * primaryVariant "destructive" inverts the primary button to
 * white-on-black so it reads stronger than the cancel button — used by
 * the out-of-map "Save anyway" confirmation where the primary action
 * permanently drops the user's strokes. "default" keeps both buttons
 * visually equal, appropriate for acknowledge-only dialogs.
 *
 * `body` accepts a single string OR an array of string segments so the
 * out-of-map dialog can keep its dynamic "{N} strokes fell outside…"
 * count as a separate child from the static follow-up text (matching
 * how the prior inline JSX split the two phrases). For an array body
 * React.Children treats each string as a text node; no keys needed for
 * primitive children.
 */
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';

export type ConfirmDialogProps = {
  labelPrefix: string;
  visible: boolean;
  title: string;
  body: string | readonly string[];
  primaryLabel: string;
  onPrimary: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  primaryVariant?: 'default' | 'destructive';
};

export default function ConfirmDialog({
  labelPrefix,
  visible,
  title,
  body,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  primaryVariant = 'default',
}: ConfirmDialogProps): React.JSX.Element | null {
  if (!visible) {
    return null;
  }
  // Backdrop tap dismisses via onSecondary when provided; for
  // acknowledge-only dialogs it is a no-op so the user must press the
  // primary button explicitly.
  const handleBackdrop = onSecondary ?? NOOP;
  const isDestructive = primaryVariant === 'destructive';
  // Passing an array through as children preserves the individual
  // string segments on `Text.props.children`, which is what the
  // §F-ED-5 count assertion in MindmapCanvas.test.tsx inspects. For a
  // plain string, children is just that string — simpler rendering for
  // single-message dialogs like the capacity modal.
  const bodyChildren: React.ReactNode = Array.isArray(body)
    ? (body as readonly string[]).slice()
    : body;
  return (
    <View
      accessibilityLabel={`${labelPrefix}-dialog`}
      style={styles.overlay}
      pointerEvents="box-none">
      <Pressable
        accessibilityLabel={`${labelPrefix}-backdrop`}
        style={styles.backdrop}
        onPress={handleBackdrop}
      />
      <View style={styles.card}>
        <Text style={styles.title}>{title}</Text>
        <Text
          accessibilityLabel={`${labelPrefix}-body`}
          style={styles.body}>
          {bodyChildren}
        </Text>
        <View style={styles.buttonRow}>
          {secondaryLabel !== undefined && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${labelPrefix}-cancel`}
              onPress={onSecondary}
              style={({pressed}) => [
                styles.btn,
                pressed && styles.btnPressed,
              ]}>
              <Text style={styles.btnText}>{secondaryLabel}</Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${labelPrefix}-proceed`}
            onPress={onPrimary}
            style={({pressed}) => [
              styles.btn,
              isDestructive && styles.btnPrimary,
              pressed &&
                (isDestructive ? styles.btnPrimaryPressed : styles.btnPressed),
            ]}>
            <Text
              style={[
                styles.btnText,
                isDestructive && styles.btnTextPrimary,
              ]}>
              {primaryLabel}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/**
 * Module-scoped no-op used as a stable backdrop handler when the
 * caller omits onSecondary (acknowledge-only dialogs). Declared at
 * module level so the Pressable's onPress identity doesn't change
 * between renders — avoids a needless re-render of the Pressable
 * subtree when the dialog is otherwise untouched.
 */
function NOOP(): void {}

const styles = StyleSheet.create({
  // StyleSheet.absoluteFillObject pins the overlay over the entire
  // parent; the backdrop below is a full-bleed Pressable that dims +
  // absorbs taps (except on the card itself, which sits on top).
  overlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    // Semi-transparent black — on e-ink it renders as a subtle mid-
    // gray that is still readable through but unmistakably "modal".
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  card: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#000',
    borderRadius: 6,
    paddingVertical: 20,
    paddingHorizontal: 24,
    maxWidth: 480,
    minWidth: 320,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000',
    marginBottom: 12,
  },
  body: {
    fontSize: 14,
    color: '#000',
    lineHeight: 20,
    marginBottom: 20,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  btn: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#000',
    borderRadius: 4,
    marginLeft: 12,
  },
  btnPressed: {
    backgroundColor: '#eee',
  },
  // Primary (destructive) button: inverted black-on-white → white-on-
  // black so the commit button reads as the stronger affordance next
  // to the cancel button. Matches the Clear button's armed-state
  // treatment in MindmapCanvas.
  btnPrimary: {
    backgroundColor: '#000',
    borderColor: '#000',
  },
  btnPrimaryPressed: {
    backgroundColor: '#333',
  },
  btnText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#000',
  },
  btnTextPrimary: {
    color: '#fff',
  },
});
