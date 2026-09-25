import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { Colors, Radius, Spacing } from '@/constants/theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

export function Screen({
  children,
  scroll = true,
  edges = ['top', 'left', 'right'],
  style,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  return (
    <SafeAreaView edges={edges} style={[styles.screen, style]}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.screenContent, contentStyle]}
          keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.screenContent, { flex: 1 }, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

type TextProps = { children: ReactNode; style?: StyleProp<TextStyle>; numberOfLines?: number };

export const T = {
  Title: ({ children, style }: TextProps) => <Text style={[styles.title, style]}>{children}</Text>,
  H2: ({ children, style }: TextProps) => <Text style={[styles.h2, style]}>{children}</Text>,
  Body: ({ children, style, numberOfLines }: TextProps) => (
    <Text numberOfLines={numberOfLines} style={[styles.body, style]}>
      {children}
    </Text>
  ),
  Dim: ({ children, style, numberOfLines }: TextProps) => (
    <Text numberOfLines={numberOfLines} style={[styles.dim, style]}>
      {children}
    </Text>
  ),
  Label: ({ children, style }: TextProps) => <Text style={[styles.label, style]}>{children}</Text>,
};

type ButtonVariant = 'primary' | 'danger' | 'ok' | 'secondary' | 'ghost';

const BUTTON_COLORS: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
  primary: { bg: Colors.accent, fg: '#140A02' },
  danger: { bg: Colors.danger, fg: '#FFFFFF' },
  ok: { bg: Colors.ok, fg: '#04140A' },
  secondary: { bg: Colors.surfaceRaised, fg: Colors.text, border: Colors.border },
  ghost: { bg: 'transparent', fg: Colors.textDim },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  size = 'md',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  size?: 'md' | 'lg' | 'xl';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = BUTTON_COLORS[variant];
  const height = size === 'xl' ? 88 : size === 'lg' ? 64 : 50;
  const fontSize = size === 'xl' ? 24 : size === 'lg' ? 19 : 16;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      // Always a real boolean: React Native only re-enables the native view when it receives an
      // explicit `false`. `undefined` after being disabled leaves only the label tappable.
      disabled={Boolean(disabled || loading)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: c.bg,
          minHeight: height,
          borderColor: c.border ?? 'transparent',
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={c.fg} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={fontSize + 4} color={c.fg} />}
          <Text style={[styles.buttonText, { color: c.fg, fontSize }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

export function Card({
  children,
  style,
  onPress,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.card, { opacity: pressed ? 0.85 : 1 }, style]}>
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Row({
  children,
  style,
  gap = Spacing.sm,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  gap?: number;
}) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

export function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <View style={{ flex: 1 }}>
      <T.Label>{label}</T.Label>
      <Text style={styles.statValue}>
        {value}
        {unit ? <Text style={styles.statUnit}> {unit}</Text> : null}
      </Text>
    </View>
  );
}

export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ gap: Spacing.xs }}>
      <T.Label>{label}</T.Label>
      <TextInput
        placeholderTextColor={Colors.textFaint}
        selectionColor={Colors.accent}
        {...props}
        style={[styles.input, props.multiline && { minHeight: 72, textAlignVertical: 'top' }, props.style]}
      />
      {hint ? <T.Dim style={{ fontSize: 12 }}>{hint}</T.Dim> : null}
    </View>
  );
}

export function Segmented<V extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: V; label: string }[];
  value: V;
  onChange: (v: V) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, selected && { backgroundColor: Colors.accent }]}>
            <Text style={[styles.segmentText, selected && { color: '#140A02' }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Badge({ label, color, icon }: { label: string; color: string; icon?: IconName }) {
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      {icon && <Ionicons name={icon} size={12} color={color} />}
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

export function Disclaimer({ children }: { children?: ReactNode }) {
  return (
    <Row style={styles.disclaimer} gap={Spacing.sm}>
      <Ionicons name="information-circle-outline" size={16} color={Colors.textDim} />
      <T.Dim style={{ flex: 1, fontSize: 12 }}>
        {children ??
          'First-aid guidance and hospital routing only. This app does not diagnose injuries. If in doubt, get medical help.'}
      </T.Dim>
    </Row>
  );
}

/** Shown on every screen of a simulated crash. */
export function TestBanner({ text }: { text?: string }) {
  return (
    <Row style={styles.testBanner} gap={Spacing.sm}>
      <Ionicons name="flask" size={18} color={Colors.info} />
      <Text style={styles.testBannerText}>
        {text ?? 'TEST: simulated crash. No automatic texts or calls, and 112 and hospitals are never dialled. You can still call your own contacts.'}
      </Text>
    </Row>
  );
}

export function ListItem({
  icon,
  iconColor = Colors.textDim,
  title,
  subtitle,
  right,
  onPress,
}: {
  icon?: IconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
}) {
  return (
    <Card onPress={onPress} style={{ paddingVertical: Spacing.md }}>
      <Row gap={Spacing.md}>
        {icon && (
          <View style={styles.listIcon}>
            <Ionicons name={icon} size={20} color={iconColor} />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <T.Body style={{ fontWeight: '600' }} numberOfLines={1}>
            {title}
          </T.Body>
          {subtitle ? <T.Dim numberOfLines={2}>{subtitle}</T.Dim> : null}
        </View>
        {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={Colors.textFaint} /> : null)}
      </Row>
    </Card>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.bg },
  screenContent: { padding: Spacing.lg, gap: Spacing.lg, paddingBottom: Spacing.xxl },
  title: { color: Colors.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
  h2: { color: Colors.text, fontSize: 18, fontWeight: '700' },
  body: { color: Colors.text, fontSize: 16, lineHeight: 22 },
  dim: { color: Colors.textDim, fontSize: 14, lineHeight: 20 },
  label: {
    color: Colors.textDim,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.lg,
    borderWidth: 1,
  },
  buttonText: { fontWeight: '800' },
  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: Spacing.sm,
  },
  statValue: { color: Colors.text, fontSize: 24, fontWeight: '800', marginTop: 2 },
  statUnit: { color: Colors.textDim, fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: Colors.surfaceRaised,
    borderColor: Colors.border,
    borderWidth: 1,
    borderRadius: Radius.md,
    color: Colors.text,
    fontSize: 16,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: Colors.surfaceRaised,
    borderRadius: Radius.md,
    padding: 4,
    gap: 4,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.sm + 2,
    borderRadius: Radius.sm,
  },
  segmentText: { color: Colors.text, fontWeight: '700', fontSize: 14 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 12, fontWeight: '700' },
  disclaimer: {
    alignItems: 'flex-start',
    padding: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
  },
  testBanner: {
    alignItems: 'flex-start',
    padding: Spacing.md,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.info,
    backgroundColor: '#0C2230',
  },
  testBannerText: { flex: 1, color: Colors.text, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  listIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
