import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { EmergencyActions } from '@/components/emergency-actions';
import { Button, Card, Disclaimer, Row, Screen, T } from '@/components/ui';
import { Colors, SeverityColors, Spacing } from '@/constants/theme';
import { finishIncident, useIsTestReport } from '@/lib/flow';
import { BODY_PART_LABELS, ESCALATE_IF, firstAidCardsFor } from '@/lib/injury';
import { actions, useApp } from '@/lib/store';

export default function FirstAid() {
  const { reportId } = useLocalSearchParams<{ reportId: string }>();
  const report = useApp((s) => s.reports.find((r) => r.id === reportId));
  const isTest = useIsTestReport(reportId);
  if (!report) return null;

  const cards = firstAidCardsFor(report.affectedAreas);

  function escalate() {
    actions.updateReport(reportId, { outcomePath: 'hospital' });
    router.replace({ pathname: '/outcome/hospitals', params: { reportId } });
  }

  return (
    <Screen edges={['bottom', 'left', 'right']}>
      <EmergencyActions reportId={reportId} crashId={report.crashEventId} isTest={isTest} />
      <Row>
        <Ionicons name="bandage" size={28} color={SeverityColors.minor} />
        <View style={{ flex: 1 }}>
          <T.H2>Looks like first aid should do</T.H2>
          <T.Dim>{report.affectedAreas.map((a) => BODY_PART_LABELS[a.bodyPart]).join(' · ')}</T.Dim>
        </View>
      </Row>

      {cards.map((card) => (
        <Card key={card.title}>
          <T.H2>{card.title}</T.H2>
          {card.steps.map((step, i) => (
            <Row key={i} style={{ alignItems: 'flex-start' }}>
              <T.Body style={{ color: Colors.accent, fontWeight: '800', width: 20 }}>{i + 1}</T.Body>
              <T.Body style={{ flex: 1 }}>{step}</T.Body>
            </Row>
          ))}
        </Card>
      ))}

      <Card style={{ borderColor: SeverityColors.moderate }}>
        <Row>
          <Ionicons name="alert-circle" size={20} color={SeverityColors.moderate} />
          <T.H2>Get help if you notice</T.H2>
        </Row>
        {ESCALATE_IF.map((s) => (
          <Row key={s} style={{ alignItems: 'flex-start' }} gap={Spacing.sm}>
            <T.Body style={{ color: SeverityColors.moderate }}>•</T.Body>
            <T.Body style={{ flex: 1 }}>{s}</T.Body>
          </Row>
        ))}
      </Card>

      <Button label="Mark as handled" icon="checkmark" variant="ok" size="lg" onPress={() => finishIncident(reportId)} />
      <Button label="Actually, I need more help" icon="arrow-up-circle" variant="secondary" size="lg" onPress={escalate} />
      <Disclaimer />
    </Screen>
  );
}
