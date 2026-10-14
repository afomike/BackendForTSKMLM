import { z } from "zod";

export type PlaybackPosition = {
  positionSeconds: number;
  durationSeconds: number;
  furthestSeconds: number;
  capturedAt: string;
  savedAt: string;
};

export const SavePlaybackBody = z.object({
  positionSeconds: z.number().finite().min(0).max(604800),
  durationSeconds: z.number().finite().min(1).max(604800),
  capturedAt: z.string().datetime(),
  lessonUpdatedAt: z.string().datetime(),
}).refine(value => value.positionSeconds <= value.durationSeconds, "Position cannot exceed duration");

export function mergePlayback(
  positions: Record<string, PlaybackPosition>, partId: string,
  incoming: { positionSeconds: number; durationSeconds: number; capturedAt: string },
  now = new Date(),
): Record<string, PlaybackPosition> {
  const previous = Object.prototype.hasOwnProperty.call(positions, partId) ? positions[partId] : undefined;
  if (previous && Date.parse(previous.capturedAt) > Date.parse(incoming.capturedAt)) return positions;
  return { ...positions, [partId]: {
    ...incoming,
    furthestSeconds: Math.min(incoming.durationSeconds, Math.max(previous?.furthestSeconds ?? 0, incoming.positionSeconds)),
    savedAt: now.toISOString(),
  } };
}
