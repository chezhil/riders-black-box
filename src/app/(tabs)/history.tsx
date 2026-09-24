import { router } from 'expo-router';
import { useState } from 'react';

import { ListItem, Screen, Segmented, T } from '@/components/ui';
import { Colors, SeverityColors } from '@/constants/theme';
import { formatDateTime, formatDistance, formatDuration } from '@/lib/geo';
import { BODY_PART_LABELS, OUTCOME_LABELS, highestSeverity } from '@/lib/injury';
import { useApp } from '@/lib/store';
import type { CrashEvent, InjuryReport } from '@/lib/types';

export default function History() {
  const rides = useApp((s) => s.rides);
  const reports = useApp((s) => s.reports);
  const crashes = useApp((s) => s.crashes);
  const [tab, setTab] = useState<'rides' | 'incidents'>('rides');

  return (
    <Screen>
      <T.Title>History</T.Title>
      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'rides', label: `Rides (${rides.length})` },
          { value: 'incidents', label: `Incidents (${crashes.length + reports.length})` },
        ]}
      />

      {tab === 'rides' &&
        (rides.length === 0 ? (
          <T.Dim>No rides recorded yet.</T.Dim>
        ) : (
          rides.map((r) => {
            const flagged = crashes.some((c) => c.rideId === r.id) || reports.some((x) => x.rideId === r.id);
            return (
              <ListItem
                key={r.id}
                icon={flagged ? 'warning' : 'bicycle'}
                iconColor={flagged ? Colors.danger : Colors.accent}
                title={formatDateTime(r.startTime)}
                subtitle={`${formatDistance(r.distanceM)} · ${formatDuration(r.endTime - r.startTime)}${
                  r.hardBrakeEvents.length ? ` · ${r.hardBrakeEvents.length} hard brakes` : ''
                }`}
                onPress={() => router.push({ pathname: '/ride/[id]', params: { id: r.id } })}
              />
            );
          })
        ))}

      {tab === 'incidents' && (
        <>
          <T.Dim>Timestamped log of crash alerts and injury check-ins. Useful for insurance claims.</T.Dim>
          {crashes.length === 0 && reports.length === 0 && <T.Dim>No incidents. Long may it last.</T.Dim>}
          {mergeIncidents(crashes, reports).map((item) =>
            item.kind === 'crash' ? (
              <ListItem
                key={item.data.id}
                icon="pulse"
                iconColor={item.data.response === 'confirmed_fine' ? Colors.ok : Colors.danger}
                title={`Crash alert${item.data.detectedVia === 'simulated' ? ' (simulated)' : ''}`}
                subtitle={`${formatDateTime(item.data.timestamp)} · ${RESPONSE_LABELS[item.data.response]}${
                  item.data.peakG ? ` · ${item.data.peakG} g` : ''
                }${item.data.contactsNotified ? ' · contacts alerted' : ''}`}
              />
            ) : (
              <ListItem
                key={item.data.id}
                icon="medkit"
                iconColor={SeverityColors[highestSeverity(item.data.affectedAreas)]}
                title={item.data.affectedAreas.map((a) => BODY_PART_LABELS[a.bodyPart]).join(', ')}
                subtitle={`${formatDateTime(item.data.timestamp)} · ${OUTCOME_LABELS[item.data.outcomePath]}${
                  item.data.handled ? ' · handled' : ''
                }`}
              />
            ),
          )}
        </>
      )}
    </Screen>
  );
}

const RESPONSE_LABELS = {
  pending: 'Awaiting response',
  confirmed_fine: 'Rider was fine',
  no_response: 'No response',
  needs_help: 'Asked for help',
} as const;

type Incident = { kind: 'crash'; t: number; data: CrashEvent } | { kind: 'report'; t: number; data: InjuryReport };

function mergeIncidents(crashes: CrashEvent[], reports: InjuryReport[]): Incident[] {
  return [
    ...crashes.map((c) => ({ kind: 'crash' as const, t: c.timestamp, data: c })),
    ...reports.map((r) => ({ kind: 'report' as const, t: r.timestamp, data: r })),
  ].sort((a, b) => b.t - a.t);
}
