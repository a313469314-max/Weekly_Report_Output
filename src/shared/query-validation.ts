import { parsePidInput } from '../domain/pid';

export interface QueryValidationSnapshot {
  gameId: string;
  gameVersionId: string;
  pids: string[];
}

export function createQueryValidationSnapshot(gameId: string, gameVersionId: string, pidInput: string): QueryValidationSnapshot {
  return {
    gameId: gameId.trim(),
    gameVersionId: gameVersionId.trim(),
    pids: parsePidInput(pidInput),
  };
}

export function isQueryValidationSnapshotCurrent(
  snapshot: QueryValidationSnapshot | null,
  gameId: string,
  gameVersionId: string,
  pidInput: string,
): boolean {
  if (!snapshot) return false;
  const current = createQueryValidationSnapshot(gameId, gameVersionId, pidInput);
  return snapshot.gameId === current.gameId
    && snapshot.gameVersionId === current.gameVersionId
    && snapshot.pids.length === current.pids.length
    && snapshot.pids.every((pid, index) => pid === current.pids[index]);
}
