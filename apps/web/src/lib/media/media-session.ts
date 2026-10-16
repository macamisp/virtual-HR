'use client';

/**
 * One LiveKit connection (ADR 016): a meeting, an office room or a proximity group. Framework-free;
 * React subscribes with subscribe/getVersion. Quality (FR-MEET-010, basic): echo cancellation,
 * noise suppression and auto gain on the microphone; simulcast, adaptive stream and dynacast;
 * a network-quality value per participant; automatic audio-only when the connection is poor.
 */
import {
  ConnectionQuality, ConnectionState, DisconnectReason, Room, RoomEvent, Track,
  type LocalTrackPublication, type Participant, type RemoteParticipant, type TrackPublication,
} from 'livekit-client';
import { MEETING_DATA_TOPIC } from '@hrvo/shared';
import type { MediaToken, MeetingDataMessage } from '@hrvo/shared';
import { usePresenceStore } from '@/heartbeat/presence-store';
import type { DevicePrefs } from './devices';

export interface Tile {
  identity: string;
  name: string;
  isLocal: boolean;
  micOn: boolean;
  camera: Track | null;
  screen: Track | null;
  speaking: boolean;
  quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
  hand: boolean;
}

export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'ended';

let active = 0;
const setInCall = () => usePresenceStore.getState().setInCall(active > 0);

export class MediaSession {
  room: Room | null = null;
  status: SessionStatus = 'idle';
  error: string | null = null;
  endedReason: string | null = null;
  token: MediaToken | null = null;
  audioOnly = false;
  hands = new Set<string>();
  private counted = false;
  private version = 0;
  private listeners = new Set<() => void>();

  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  getVersion = (): number => this.version;
  private changed(): void { this.version += 1; for (const l of this.listeners) l(); }

  async connect(token: MediaToken, prefs: DevicePrefs): Promise<void> {
    await this.disconnect();
    this.token = token;
    this.status = 'connecting';
    this.error = null;
    this.endedReason = null;
    this.changed();
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: prefs.audioInput === 'default' ? undefined : prefs.audioInput },
      videoCaptureDefaults: { deviceId: prefs.videoInput === 'default' ? undefined : prefs.videoInput, resolution: { width: 640, height: 360, frameRate: 24 } },
      publishDefaults: { simulcast: true, dtx: true, red: true },
      audioOutput: prefs.audioOutput === 'default' ? undefined : { deviceId: prefs.audioOutput },
    });
    this.room = room;
    const refresh = () => this.changed();
    room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => { this.hands.delete(p.identity); refresh(); })
      .on(RoomEvent.TrackSubscribed, refresh)
      .on(RoomEvent.TrackUnsubscribed, refresh)
      .on(RoomEvent.TrackMuted, refresh)
      .on(RoomEvent.TrackUnmuted, refresh)
      .on(RoomEvent.LocalTrackPublished, refresh)
      .on(RoomEvent.LocalTrackUnpublished, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
        if (p.isLocal && q === ConnectionQuality.Poor && !this.audioOnly) void this.setAudioOnly(true);
        refresh();
      })
      .on(RoomEvent.ConnectionStateChanged, (s: ConnectionState) => {
        this.status = s === ConnectionState.Connected ? 'connected' : s === ConnectionState.Reconnecting || s === ConnectionState.SignalReconnecting ? 'reconnecting' : this.status;
        refresh();
      })
      .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
        this.uncount();
        this.status = 'ended';
        this.endedReason = reason === DisconnectReason.PARTICIPANT_REMOVED ? 'You were removed by the host.' : reason === DisconnectReason.ROOM_DELETED ? 'The meeting has ended.' : null;
        refresh();
      })
      .on(RoomEvent.DataReceived, (payload: Uint8Array, p?: RemoteParticipant, _k?: unknown, topic?: string) => {
        if (topic !== MEETING_DATA_TOPIC || !p) return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload)) as MeetingDataMessage;
          if (msg.type === 'hand') { if (msg.raised) this.hands.add(p.identity); else this.hands.delete(p.identity); refresh(); }
        } catch { /* ignore malformed data */ }
      });
    try {
      await room.connect(token.url, token.token);
      this.status = 'connected';
      this.count();
      await room.localParticipant.setMicrophoneEnabled(prefs.micOn).catch((e: unknown) => this.fail(e, 'The microphone could not be started'));
      if (prefs.camOn) await room.localParticipant.setCameraEnabled(true).catch((e: unknown) => this.fail(e, 'The camera could not be started'));
    } catch (err) {
      this.status = 'error';
      this.error = err instanceof Error ? err.message : 'Could not connect to the call';
    }
    this.changed();
  }

  private count(): void { if (!this.counted) { this.counted = true; active += 1; setInCall(); } }
  private uncount(): void { if (this.counted) { this.counted = false; active -= 1; setInCall(); } }

  async disconnect(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.uncount();
    this.hands.clear();
    if (room) await room.disconnect().catch(() => undefined);
    if (this.status !== 'idle') { this.status = 'idle'; this.changed(); }
  }

  get connected(): boolean {
    return this.status === 'connected' || this.status === 'reconnecting';
  }

  tiles(): Tile[] {
    const room = this.room;
    if (!room) return [];
    const quality = (q: ConnectionQuality): Tile['quality'] => (q === ConnectionQuality.Excellent ? 'excellent' : q === ConnectionQuality.Good ? 'good' : q === ConnectionQuality.Poor ? 'poor' : q === ConnectionQuality.Lost ? 'lost' : 'unknown');
    const pub = (p: Participant, s: Track.Source): TrackPublication | undefined => p.getTrackPublication(s);
    const tile = (p: Participant): Tile => {
      const cam = pub(p, Track.Source.Camera);
      const screen = pub(p, Track.Source.ScreenShare);
      const mic = pub(p, Track.Source.Microphone);
      return {
        identity: p.identity, name: p.name || p.identity, isLocal: p.isLocal, micOn: !!mic && !mic.isMuted,
        camera: cam && !cam.isMuted && cam.track && (!this.audioOnly || p.isLocal) ? cam.track : null,
        screen: screen?.track ?? null, speaking: p.isSpeaking, quality: quality(p.connectionQuality),
        hand: p.isLocal ? this.hands.has('local') : this.hands.has(p.identity),
      };
    };
    return [tile(room.localParticipant), ...[...room.remoteParticipants.values()].map(tile)];
  }

  get micOn(): boolean { return !!this.room?.localParticipant.isMicrophoneEnabled; }
  get camOn(): boolean { return !!this.room?.localParticipant.isCameraEnabled; }
  get sharing(): boolean { return !!this.room?.localParticipant.isScreenShareEnabled; }

  async toggleMic(): Promise<void> { await this.room?.localParticipant.setMicrophoneEnabled(!this.micOn).catch((e: unknown) => this.fail(e)); this.changed(); }
  async toggleCam(): Promise<void> {
    if (!this.camOn && this.audioOnly) this.audioOnly = false;
    await this.room?.localParticipant.setCameraEnabled(!this.camOn).catch((e: unknown) => this.fail(e));
    this.changed();
  }
  /** FR-VO-009: screen share inside any room or meeting. */
  async toggleShare(): Promise<void> { await this.room?.localParticipant.setScreenShareEnabled(!this.sharing, { audio: true }).catch((e: unknown) => this.fail(e)); this.changed(); }

  /** FR-MEET-010: audio-only fallback (automatic on a poor connection, or by choice). */
  async setAudioOnly(on: boolean): Promise<void> {
    this.audioOnly = on;
    const room = this.room;
    if (!room) return;
    if (on && room.localParticipant.isCameraEnabled) await room.localParticipant.setCameraEnabled(false).catch(() => undefined);
    for (const p of room.remoteParticipants.values()) {
      for (const pubn of p.trackPublications.values()) if (pubn.kind === Track.Kind.Video && pubn.source === Track.Source.Camera) pubn.setEnabled(!on);
    }
    this.changed();
  }

  async raiseHand(raised: boolean): Promise<void> {
    if (!this.room) return;
    if (raised) this.hands.add('local'); else this.hands.delete('local');
    const msg: MeetingDataMessage = { type: 'hand', raised };
    await this.room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(msg)), { reliable: true, topic: MEETING_DATA_TOPIC }).catch(() => undefined);
    this.changed();
  }

  /** FR-VO-005: volume falls off with distance (1 near, 0.15 at the edge of the group). */
  setVolumes(byIdentity: Map<string, number>): void {
    for (const p of this.room?.remoteParticipants.values() ?? []) {
      const v = byIdentity.get(p.identity);
      if (v !== undefined) p.setVolume(Math.max(0.15, Math.min(1, v)));
    }
  }

  async switchDevice(kind: MediaDeviceKind, deviceId: string): Promise<void> {
    await this.room?.switchActiveDevice(kind, deviceId).catch((e: unknown) => this.fail(e));
  }

  private fail(e: unknown, what = 'Device error'): void {
    this.error = e instanceof Error ? `${what}: ${e.message}` : what;
    this.changed();
  }

  localScreen(): LocalTrackPublication | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare) as LocalTrackPublication | undefined;
  }
}
