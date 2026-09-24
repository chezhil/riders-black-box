export type LatLng = { lat: number; lng: number };

export type MedicalInfo = {
  bloodGroup: string;
  allergies: string;
  conditions: string;
};

export type UserProfile = {
  name: string;
  phone: string;
  medical: MedicalInfo;
};

export type EmergencyContact = {
  id: string;
  name: string;
  phone: string;
  relationship: string;
};

export type Sensitivity = 'low' | 'medium' | 'high';

export type Settings = {
  sensitivity: Sensitivity;
  countdownSeconds: number;
  /** Send follow-up location updates after an alert (needs the SMS relay). */
  liveLocation: boolean;
  includeMedicalInfo: boolean;
  emergencyNumber: string;
};

export type RoutePoint = LatLng & { t: number; speed: number | null };

export type HardBrakeEvent = LatLng & { t: number; decel: number };

export type Ride = {
  id: string;
  startTime: number;
  endTime: number;
  routePoints: RoutePoint[];
  distanceM: number;
  /** m/s, over moving time */
  avgSpeed: number;
  /** m/s */
  maxSpeed: number;
  hardBrakeEvents: HardBrakeEvent[];
};

export type CrashResponse = 'pending' | 'confirmed_fine' | 'no_response' | 'needs_help';

export type NotifyChannel = 'relay' | 'sim' | 'sms_composer' | 'none';

export type CrashEvent = {
  id: string;
  rideId: string | null;
  timestamp: number;
  location: LatLng | null;
  detectedVia: 'sensor' | 'simulated' | 'manual';
  peakG: number | null;
  response: CrashResponse;
  contactsNotified: boolean;
  notifyChannel: NotifyChannel;
};

export type Severity = 'minor' | 'moderate' | 'severe';

export type BodyPart =
  | 'head'
  | 'neck'
  | 'chest'
  | 'abdomen'
  | 'upper_back'
  | 'lower_back'
  | 'pelvis'
  | 'left_arm'
  | 'right_arm'
  | 'left_hand'
  | 'right_hand'
  | 'left_leg'
  | 'right_leg'
  | 'left_foot'
  | 'right_foot';

export type AffectedArea = {
  bodyPart: BodyPart;
  severity: Severity;
  note: string;
};

export type OutcomePath = 'first_aid' | 'hospital' | 'emergency';

export type InjuryReport = {
  id: string;
  crashEventId: string | null;
  rideId: string | null;
  timestamp: number;
  location: LatLng | null;
  affectedAreas: AffectedArea[];
  outcomePath: OutcomePath;
  handled: boolean;
  contactsNotified: boolean;
};
